const fs = require("fs");
const { JSDOM } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Business profile: who runs the install — the name on the storefront, in emails and on labels, where
// notices go, how customers pay by Venmo / Zelle / check — is a setting, not text in the code.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { getBusinessProfile, setBusinessProfile, publicBusinessProfile, getPublicCatalogData };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => { global.__invalidated = (global.__invalidated || 0) + 1; }; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };

  console.log("=== Stored in the database, nothing made up ===");
  let p = await lib.getBusinessProfile(d1);
  ok("a new install has an empty profile", Object.values(p).every(v => v === "") && "ownerEmail" in p && "venmo" in p);
  let r = await call({ action: "updateBusinessProfile", business: { name: "  Northside Stitch Co.  ", supportEmail: "hello@northside.test", ownerEmail: "owner@northside.test",
    receiptsEmail: "copies@northside.test", venmo: "@NorthsideStitch", zelle: "pay@northside.test", legalName: "Northside Stitch LLC", mailingAddress: "1 Main St, Anytown, OH 44000", footer: "Made to order.", junk: "x" } });
  await new Promise(res => setTimeout(res, 20));
  ok("saving trims, drops the @ from the Venmo name and ignores unknown fields", r.status === 200 && r.body.business.name === "Northside Stitch Co." && r.body.business.venmo === "NorthsideStitch" && !("junk" in r.body.business));
  ok("it's audited with what changed, and the storefront's cached catalog is refreshed", Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.business_set'")[0].n) === 1 && global.__invalidated >= 1);
  r = await call({ action: "updateBusinessProfile", business: { name: "X", ownerEmail: "not-an-email" } });
  ok("a bad email is refused and nothing changes", r.status === 400 && /valid email/.test(r.body.message) && (await lib.getBusinessProfile(d1)).name === "Northside Stitch Co.");
  r = await call({ action: "updateBusinessProfile", business: { name: "X", venmo: "bad name!" } });
  ok("a bad Venmo name is refused", r.status === 400);

  console.log("\n=== What visitors are told ===");
  const pub = (await lib.getPublicCatalogData(d1)).business;
  ok("the catalog carries the name, contact and payment details", pub.name === "Northside Stitch Co." && pub.venmo === "NorthsideStitch" && pub.zelle === "pay@northside.test" && pub.mailingAddress.startsWith("1 Main St"));
  ok("…but never the owner's or the receipts inbox", !("ownerEmail" in pub) && !("receiptsEmail" in pub) && !JSON.stringify(pub).includes("owner@") && !JSON.stringify(pub).includes("copies@"));
  const cat = read("functions/api/catalog.js");
  ok("every catalog answer includes it — a shop, the admin host, and an unrecognized host", (cat.match(/business: catalogData\.business \|\| \{\}/g) || []).length >= 5);

  console.log("\n=== Storefront ===");
  const html = read("public/index.html");
  const page = async (answer, url) => { const dom = new JSDOM(html, { runScripts: "dangerously", url, pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: answer.status !== "error" || !answer._404, status: 200, json: async () => answer }); } });
    await new Promise(res => setTimeout(res, 150)); return dom.window; };
  let w = await page({ status: "error", message: "Unknown org", business: pub }, "https://example.com/");
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
  ok("the generic page, header, footer and tab title use the business name and contact", /Northside Stitch Co\./.test(text(w.document.getElementById("app"))) && w.document.getElementById("brandName").textContent === "Northside Stitch Co." &&
    /Made to order\..*hello@northside\.test/.test(text(w.document.getElementById("siteFooter"))) && w.document.title === "Northside Stitch Co.");
  ok("the Venmo link is built from the profile", w.venmoPayLink({ orgId: "o", orderId: "A-1", total: 12 }).startsWith("https://venmo.com/u/NorthsideStitch?"));
  w = await page({ status: "error", message: "Unknown org", business: {} }, "https://example.com/");
  ok("with nothing set the page still reads sensibly, with no stray contact line or broken link", /Our shop/.test(text(w.document.getElementById("app"))) && text(w.document.getElementById("siteFooter")) === "" && w.venmoPayLink({ orgId: "o", orderId: "A-1", total: 12 }) === null);
  ok("no business name, address or email is written into the page source", /<title>Order shop<\/title>/.test(html) && !/[a-z0-9._%+-]+@(?!example\.)[a-z0-9-]+\.(com|net|org)\b/i.test(html));

  console.log("\n=== Emails ===");
  let sent = [];
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) }; };
  const mail = new Function(dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\nreturn { sendOrderReceivedEmail, sendDigestHeartbeatEmail };")();
  const env = { DB: d1, CF_EMAIL_API_TOKEN: "t", CF_ACCOUNT_ID: "a", ROOT_DOMAIN: "northside.test" };
  await mail.sendOrderReceivedEmail(env, { orderId: "A-1", orgId: "o", customerName: "Pat <b>", contact: "pat@example.com", paymentMethod: "Check", items: [{ name: "Polo", size: "L", qty: 1, unitPrice: 20, lineTotal: 20 }], total: 20 }, "Shop");
  const m = sent[sent.length - 1];
  ok("a customer email is from the business, replies go to the owner, the receipts inbox gets a copy", m && m.from.name === "Northside Stitch Co." && m.from.address === "orders@northside.test" && m.reply_to === "owner@northside.test" && JSON.stringify(m.bcc) === '["copies@northside.test"]');
  ok("its footer names the business and the site, with no placeholder left behind", /Northside Stitch Co\. — northside\.test/.test(m.html) && !/%%/.test(m.html + m.text + m.subject));
  await mail.sendDigestHeartbeatEmail(env, {});
  ok("the owner's roll-up goes to the owner's inbox and links to this install's admin", sent[sent.length - 1].to === "owner@northside.test" && /https:\/\/admin\.northside\.test/.test(sent[sent.length - 1].html));
  d1._raw.run("DELETE FROM global_settings WHERE key='business'");
  await mail.sendDigestHeartbeatEmail({ ...env, OWNER_EMAIL: "boss@northside.test" }, {});
  ok("with no profile: OWNER_EMAIL, a plain sender name, and no hidden copy", sent[sent.length - 1].to === "boss@northside.test" && sent[sent.length - 1].from.name === "Our shop" && sent[sent.length - 1].bcc === undefined);
  await mail.sendDigestHeartbeatEmail(env, {});
  ok("…and with neither, owner@ the root domain", sent[sent.length - 1].to === "owner@northside.test");

  console.log("\n=== Admin ===");
  const adm = read("public/admin.js");
  ok("Global settings has a Business profile form saved with the rest", /<h2 style="margin-bottom:12px;">Business profile<\/h2>/.test(adm) && /action: "updateBusinessProfile"/.test(adm) && /id="gBizName"|bizField\("gBizName"/.test(adm));
  ok("page titles, the printed receipt and the label byline use the profile", /function adminTitle_\(page\)\{ return bizName_\(\) \+ " — "/.test(adm) && /by \$\{escapeHtml\(bizName_\(\)\)\}/.test(adm));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
