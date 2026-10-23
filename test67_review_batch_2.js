const fs = require("fs");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { createD1 } = require("./testlib/d1-shim.js");

// Assorted behaviours:
//   - catalog/price edits are audited with what changed (org/product create/edit/hide)
//   - signed file links never use the admin passphrase as their HMAC key (SIGNING_SECRET first)
//   - email/webhook failures are recorded and reported in the 6 AM roll-up (a reason to send), then cleared
//   - the Orders page only loads its date window from the server (getOrdersByOrg range, padded a day)
//   - Package sizes Save reports a failed save; storefront buttons on the shop colour get readable text
// (Rate limiting through a D1 outage is in test26, the root domain ignoring ?org= in test9.)
// Real SQL (sql.js) + real db.js / email.js / orders.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), emailSrc = strip(read("functions/_lib/email.js"));
const L = new Function(dbSrc + "\n" + emailSrc + `\nreturn { insertOrder, getOrdersByOrg, recordSystemIssue, getSystemIssues, clearSystemIssues,
  sendDailyDigestEmail, getDigestState, setDigestState };`)();
const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const checkShippedDeliveries = async () => ({ checked: 0, delivered: [], inTransit: [], pickedUp: [], awaitingPickup: [] });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  try {
    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('prime','prime','Example League',1,'t','t');`);
    const env = { DB: d1, ...MAIL_ENV };
    const call = async (body) => {
      const waits = [];
      const res = await api({ env, waitUntil: (p) => waits.push(p),
        request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      await Promise.all(waits);
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    const audits = (action) => d1.q(`SELECT detail FROM audit_log WHERE action='${action}' ORDER BY id`).map(r => JSON.parse(r.detail));

    console.log("=== L-2: catalog & price edits are audited ===");
    await call({ action: "createProduct", org: "prime", productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true, images: [] });
    console.log("creating a product is audited with its starting values:",
      audits("product.created").length === 1 && audits("product.created")[0].productId === "cap" && audits("product.created")[0].changes.flatPrice.to === 20);
    await call({ action: "updateProduct", org: "prime", productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 22, visible: true, images: [] });
    const up = audits("product.updated");
    console.log("a price change records just that field, from → to:", up.length === 1 && JSON.stringify(up[0].changes) === JSON.stringify({ flatPrice: { from: 20, to: 22 } }));
    await call({ action: "updateProduct", org: "prime", productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 22, visible: true, images: [] });
    console.log("saving with nothing changed adds no entry:", audits("product.updated").length === 1);
    await call({ action: "setProductVisible", org: "prime", productId: "cap", visible: false });
    console.log("hiding a product is audited:", audits("product.hidden").length === 1 && audits("product.hidden")[0].productId === "cap");
    await call({ action: "updateOrg", orgId: "prime", subdomain: "prime", name: "Example League renamed", ready: true });
    const ou = audits("org.updated");
    console.log("a shop edit records the name change:", ou.length === 1 && ou[0].changes.name.from === "Example League" && ou[0].changes.name.to === "Example League renamed");
    const adminJs = read("public/admin.js");
    console.log("the Audit Log screen labels and summarises them:", /"product\.updated":\s+"Product edited"/.test(adminJs) && /case "product\.updated":/.test(adminJs));

    {
      // One secret for everything signed: quotes too, and a quote signature isn't a link signature.
      const q = read("functions/_lib/quoteToken.js");
      const body = q.slice(q.indexOf("function signingSecret(env)"), q.indexOf("}", q.indexOf("function signingSecret(env)")) + 1);
      const quoteSecret = new Function(body + "\nreturn signingSecret;")();
      console.log("shipping quotes use SIGNING_SECRET first, then the old secrets:", quoteSecret({ SIGNING_SECRET: "ONE", QUOTE_SIGNING_SECRET: "Q", STRIPE_SECRET_KEY: "S" }) === "ONE" &&
        quoteSecret({ QUOTE_SIGNING_SECRET: "Q", STRIPE_SECRET_KEY: "S" }) === "Q" && quoteSecret({}) === "");
      console.log("each use keeps its own label, so sharing the secret can't mix signatures up:", /"odd-shipping-quote-v1:"/.test(q) &&
        /"odd-receipt-view:" \+ secret/.test(read("functions/api/receipt.js")) && /"odd-design-view:" \+ secret/.test(read("functions/api/design.js")));
    }
    console.log("\n=== L-5: signed file links never use the admin passphrase ===");
    for (const f of ["functions/api/receipt.js", "functions/api/design.js"]) {
      const src = read(f);
      const body = src.slice(src.indexOf("function linkSecret(env)"), src.indexOf("}", src.indexOf("function linkSecret(env)")) + 1);
      const linkSecret = new Function(body + "\nreturn linkSecret;")();
      console.log(f + ": LINK_SIGNING_SECRET first, never PROXY_ADMIN_PASSPHRASE:",
        linkSecret({ LINK_SIGNING_SECRET: "L", QUOTE_SIGNING_SECRET: "Q", STRIPE_SECRET_KEY: "S" }) === "L" &&
        linkSecret({ STRIPE_SECRET_KEY: "S", PROXY_ADMIN_PASSPHRASE: "P" }) === "S" &&
        linkSecret({ PROXY_ADMIN_PASSPHRASE: "P" }) === "");
      console.log(f + ": the single SIGNING_SECRET wins over the older per-purpose secrets:",
        linkSecret({ SIGNING_SECRET: "ONE", LINK_SIGNING_SECRET: "L", QUOTE_SIGNING_SECRET: "Q", STRIPE_SECRET_KEY: "S" }) === "ONE");
    }

    console.log("\n=== A-5: problems are recorded and reported in the roll-up ===");
    await L.recordSystemIssue(d1, "email_failed", "Your order has been received — PRIME-1");
    await L.recordSystemIssue(d1, "email_failed", "Your order is confirmed — PRIME-2");
    await L.recordSystemIssue(d1, "webhook_failed", "checkout.session.completed evt_1 (order PRIME-3)");
    let issues = await L.getSystemIssues(d1);
    const fb = issues.find(x => x.kind === "email_failed");
    console.log("counted per kind, with a readable label and sample subjects:",
      issues.length === 2 && fb.count === 2 && /couldn't be sent at all/.test(fb.label) && fb.samples.length === 2);
    console.log("recording never throws, even with no database:", await L.recordSystemIssue(null, "email_failed", "x").then(() => true, () => false));
    mail.length = 0;
    const sent = await L.sendDailyDigestEmail(env, { issues, orgNames: { prime: "PRIME" } });
    console.log("problems alone are a reason to send the roll-up, flagged in the subject and listed first:",
      sent === true && /⚠️ 3 problems/.test(mail[0].subject) && /Problems since the last roll-up/.test(mail[0].htmlBody) && /Stripe webhook updates that failed[^<]*: 1/.test(mail[0].htmlBody));
    const dd = new Function(strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/adminAuth.js")) + "\n" +
      "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
      "const checkShippedDeliveries = async () => ({ delivered: [], inTransit: [], pickedUp: [], awaitingPickup: [] });\n" +
      dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/api/daily-digest.js")) + "\nreturn onRequestPost;")();
    await L.setDigestState(d1, { afterRowid: 999, sentAt: new Date().toISOString() });
    mail.length = 0;
    const res = await dd({ env: { ...env, CRON_SECRET: "gk" }, request: { json: async () => ({ key: "gk" }), headers: { get: () => null } } });
    const rj = JSON.parse(await res.text());
    console.log("the 6 AM run sends for problems even with nothing else new:", rj.sent === true && mail.length === 1);
    console.log("…and clears them once sent:", (await L.getSystemIssues(d1)) === null);
    console.log("Communications shows them too:", /Problems since the last roll-up/.test(adminJs) && /issues: issues \|\| \[\]/.test(read("functions/api/orders.js")));

    console.log("\n=== P2: the Orders page loads only its date window ===");
    const mk = async (id, placedAt) => L.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "C", contact: "c@x.com", placedAt },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
    await mk("OLD", "2026-01-15T12:00:00Z"); await mk("IN1", "2026-09-10T03:00:00Z"); await mk("IN2", "2026-09-30T23:30:00Z"); await mk("NEW", "2026-10-05T12:00:00Z");
    let o = (await L.getOrdersByOrg(d1, "prime", { from: "2026-09-10", to: "2026-09-30" })).map(x => x.orderId);
    console.log("only orders in (or a day around) the window come back:", o.includes("IN1") && o.includes("IN2") && !o.includes("OLD") && !o.includes("NEW"));
    console.log("no window → everything (other callers unchanged):", (await L.getOrdersByOrg(d1, "prime")).length === 4);
    console.log("a malformed date is ignored, not an error:", (await L.getOrdersByOrg(d1, "prime", { from: "nope", to: "2026-13-99" })).length === 4);
    const r2 = await call({ action: "getOrders", org: "prime", dateFrom: "2026-09-10", dateTo: "2026-09-30" });
    console.log("the getOrders action passes the window through:", r2.status === 200 && r2.body.orders.length === 2);
    console.log("the admin page sends its filter dates:", /dateFrom: \(window\._ordersFilter \|\| \{\}\)\.from/.test(adminJs));

    console.log("\n=== UI: Package sizes Save failure, readable storefront buttons ===");
    console.log("a failed Package sizes save shows 'Not saved' instead of a success toast:",
      /if\(err\)\{ errEl\.textContent = "Not saved: " \+ err;/.test(adminJs) && /return \(d && d\.message\) \|\| "Could not save\.";/.test(adminJs));
    const html = read("public/index.html");
    const fnSrc = (name) => html.slice(html.indexOf("function " + name + "("), html.indexOf("\n}\n", html.indexOf("function " + name + "(")) + 2);
    const vars = new Function(fnSrc("readableInkOn") + fnSrc("orgAccentVars") + fnSrc("escapeHtml") + "\nreturn orgAccentVars;")();
    console.log("REC's orange gets dark text, Example League's green keeps white:",
      /--org-accent-ink:#232323/.test(vars("#F6921E")) && /--org-accent-ink:#fff/.test(vars("#1E7A4C")));
    console.log("the shop-colour buttons (Add, Place order, category hover, deadline badge) use that text colour:",
      (html.match(/background:var\(--org-accent[^;]*\); color:var\(--org-accent-ink,#fff\)/g) || []).length >= 4 && !/style="--org-accent:\$\{escapeHtml\(org\.accent\)\}"/.test(html));
  } catch (e) {
    console.log("test67 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
