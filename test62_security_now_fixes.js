const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Security behaviours:
//   - server-side validation of admin-supplied org/product fields (image URLs, ids, accent)
//     — functions/_lib/catalogValidation.js, wired into orders.js; catalog.js read-side allowlist
//   - card checkout charges the BALANCE due (after discounts and other payments), refuses
//     voided orders, and takes name/email from the order row
//   - 2FA can't be replaced while on (a hijacked session can't swap in its own secret);
//     enabling/disabling is audited first
//   - the order-received email is sent in waitUntil, after the response
// (The local send-agent's lockdown is covered by the send-agent's own tests, in its separate repository.)
// Real SQL (sql.js), real db.js and orders.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const valSrc = strip(read("functions/_lib/catalogValidation.js"));
const V = new Function(valSrc + "\nreturn { cleanImageUrl, isValidAccent, validateOrgFields, validateProductImages };")();
const lib = new Function(dbSrc + "\nreturn { insertOrder, getOrderCheckoutState, setOrderDiscount, addOrderPayment, getOrderById };")();

// Order-received email mock: resolves only when the test says so, so we can see whether the
// response waited for it.
let releaseEmail, emailSentFor = [];
const emailGate = () => new Promise((r) => { releaseEmail = r; });
global.__sendReceived = async (env, order) => { await emailGate(); emailSentFor.push(order.orderId); return true; };

const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { prime: 'prime' }, orgs: {} });\n" +
  "const ensureOrgDomain = async () => ({ configured: false }); const getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const sendOrderReceivedEmail = (...a) => global.__sendReceived(...a), sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + valSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  try {
    console.log("=== M-1: cleanImageUrl / isValidAccent ===");
    const ok = (u) => typeof V.cleanImageUrl(u) === "string" && V.cleanImageUrl(u) !== "";
    console.log("https, http and site paths are accepted:",
      ok("https://images.example.com/uploads/x.png") && ok("http://example.com/a.jpg") && ok("images/foo.jpg") && ok("/images/foo.jpg"));
    console.log("blank is allowed (no image):", V.cleanImageUrl("") === "" && V.cleanImageUrl(null) === "");
    console.log("javascript:/data:/vbscript: are refused:",
      [ "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x" ].every(u => V.cleanImageUrl(u) === null));
    console.log("schemes hidden behind whitespace/control chars are refused (the old blocklist missed these):",
      V.cleanImageUrl(" javascript:alert(1)") === null && V.cleanImageUrl("\n\tjavascript:alert(1)") === null);
    console.log("java<TAB>script: is refused:", V.cleanImageUrl("java\tscript:alert(1)") === null);
    console.log("protocol-relative //host and /\\host are refused:", V.cleanImageUrl("//evil.example/x.png") === null && V.cleanImageUrl("/\\evil.example/x.png") === null);
    console.log("quotes/angle brackets are refused:", V.cleanImageUrl('https://x.example/a"onerror=alert(1)') === null && V.cleanImageUrl("images/<b>.png") === null);
    console.log("accent: hex, names and numeric rgb()/hsl() pass:",
      ["#1E7A4C", "#abc", "navy", "rgb(30, 122, 76)", "rgba(0,0,0,.5)", "hsl(120 50% 40%)"].every(V.isValidAccent));
    console.log("accent: anything that could escape a style is refused:",
      !["red;}body{display:none", "rgb(1,2,3);x", "url(javascript:x)", "expression(alert(1))", "\"red\""].some(V.isValidAccent));

    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('prime','prime','PRIME',1,'t','t');
      INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
        ('polo','prime','shirt','Polo','flat',16,'{}','t','t');`);
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
    const pending = [];
    const call = async (body, url = "https://admin.example.com/api/orders") => {
      const res = await api({ env: { DB: d1 }, waitUntil: (p) => { pending.push(p); },
        request: { url, json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    const org = (o) => Object.assign({ action: "createOrg", orgId: "new-org", subdomain: "neworg", name: "New Org", accent: "#1E7A4C" }, o);

    console.log("\n=== M-1: orders.js refuses unsafe org fields ===");
    let r = await call(org({ designImageShirtUrl: " javascript:alert(document.cookie)" }));
    console.log("createOrg with a whitespace-hidden javascript: image → 400:", r.status === 400);
    r = await call(org({ orgId: "Bad Org!" }));
    console.log("createOrg with an invalid orgId → 400:", r.status === 400);
    r = await call(org({ subdomain: "new-org" }));
    console.log("createOrg with a hyphenated subdomain → 400:", r.status === 400);
    r = await call(org({ accent: "red;}body{display:none" }));
    console.log("createOrg with a CSS-escaping accent → 400:", r.status === 400);
    console.log("nothing was written for any refused create:", d1.q("SELECT count(*) n FROM orgs WHERE orgId='new-org'")[0].n === 0);
    r = await call(org({ designImageShirtUrl: "  https://images.example/a.png  " }));
    const created = d1.q("SELECT subdomain, designImageShirt FROM orgs WHERE orgId='new-org'")[0];
    console.log("a valid createOrg succeeds and stores the trimmed URL:", r.status === 200 && created && created.designImageShirt === "https://images.example/a.png");
    r = await call({ action: "updateOrg", orgId: "new-org", name: "New Org", subdomain: "", designImageCapUrl: "images/cap.jpg" });
    console.log("updateOrg with a blank subdomain keeps the current one:",
      r.status === 200 && d1.q("SELECT subdomain FROM orgs WHERE orgId='new-org'")[0].subdomain === "neworg");
    r = await call({ action: "updateOrg", orgId: "new-org", name: "New Org", subdomain: "neworg", designImageDetailUrl: "data:image/svg+xml,<svg onload=alert(1)>" });
    console.log("updateOrg with a data: image → 400:", r.status === 400);
    d1._raw.exec("UPDATE orgs SET subdomain='legacy-sub' WHERE orgId='prime'");
    r = await call({ action: "updateOrg", orgId: "prime", name: "PRIME", subdomain: "legacy-sub", ready: true });
    console.log("an org saved before these checks (hyphenated subdomain) can still be edited unchanged:", r.status === 200);
    r = await call({ action: "updateOrg", orgId: "prime", name: "PRIME", subdomain: "bad-new-sub", ready: true });
    console.log("…but changing to an invalid subdomain is refused:", r.status === 400);
    d1._raw.exec("UPDATE orgs SET subdomain='prime', ready=1 WHERE orgId='prime'");
    r = await call({ action: "updateOrg", orgId: "nope", name: "X" });
    console.log("updateOrg on an unknown org → 404:", r.status === 404);

    console.log("\n=== M-1: orders.js refuses unsafe product fields ===");
    const prod = (o) => Object.assign({ action: "createProduct", org: "prime", productId: "tee", type: "shirt", name: "Tee",
      pricingMode: "flat", flatPrice: 20, visible: true, images: ["images/tee.jpg"] }, o);
    r = await call(prod({ productId: "Tee<script>" }));
    console.log("createProduct with an invalid productId → 400:", r.status === 400);
    r = await call(prod({ images: ["images/ok.jpg", "java\tscript:alert(1)"] }));
    console.log("createProduct with a java<TAB>script: image → 400, nothing written:",
      r.status === 400 && d1.q("SELECT count(*) n FROM products WHERE productId='tee'")[0].n === 0);
    r = await call(prod({}));
    console.log("a valid createProduct succeeds:", r.status === 200);
    r = await call(prod({ action: "updateProduct", images: ["//evil.example/x.png"] }));
    console.log("updateProduct with a protocol-relative image → 400:", r.status === 400);
    console.log("…and the stored images are untouched:", d1.q("SELECT imagesJson FROM products WHERE productId='tee'")[0].imagesJson === '["images/tee.jpg"]');
    r = await call(prod({ action: "updateProduct", images: "not-a-list" }));
    console.log("updateProduct with images that aren't a list → 400:", r.status === 400);

    console.log("\n=== M-1: catalog.js read-side allowlist ===");
    const normSrc = read("functions/api/catalog.js").match(/function normImageUrl\(url\)\{[\s\S]*?\n\}/)[0];
    const normImageUrl = new Function(normSrc + "\nreturn normImageUrl;")();
    console.log("stored unsafe URLs render as nothing:",
      [" javascript:alert(1)", "java\tscript:alert(1)", "vbscript:x", "data:text/html,x", "//evil.example/x"].every(u => normImageUrl(u) === ""));
    console.log("safe URLs pass (and bare domains still get https://):",
      normImageUrl("images/a.jpg") === "images/a.jpg" && normImageUrl("https://x.example/a.png") === "https://x.example/a.png"
      && normImageUrl("images.example.com/uploads/a.png") === "https://images.example.com/uploads/a.png");

    console.log("\n=== M-4: checkout charges the balance due ===");
    await lib.insertOrder(d1, { orderId: "PRIME-1", orgId: "prime", customerName: "Ann", contact: "ann@example.com", paymentMethod: "Card",
      placedAt: "2026-09-02T00:00:00Z" }, [{ productId: "polo", name: "Polo", type: "shirt", qty: 2, unitPrice: 16 }]);
    let cs = await lib.getOrderCheckoutState(d1, "PRIME-1");
    console.log("an unpaid $32 order: balance $32, name/email from the row, not voided:",
      cs.total === 32 && cs.customerName === "Ann" && cs.contact === "ann@example.com" && cs.voided === false && cs.paid === false);
    await lib.setOrderDiscount(d1, "PRIME-1", 2);
    await lib.addOrderPayment(d1, "PRIME-1", 15, "Venmo deposit", "", { method: "venmo" });
    cs = await lib.getOrderCheckoutState(d1, "PRIME-1");
    console.log("after a $2 discount and a $15 Venmo deposit, card is charged only the $15 left (was $32):", cs.total === 15);
    d1._raw.exec("UPDATE orders SET voidedAt='2026-09-05T00:00:00Z' WHERE orderId='PRIME-1'");
    cs = await lib.getOrderCheckoutState(d1, "PRIME-1");
    console.log("a voided order is reported as voided:", cs.voided === true);

    console.log("\n=== P1: order-received email doesn't hold up the response ===");
    emailSentFor = []; pending.length = 0;
    const resP = call({ orderId: "PRIME-2", orgId: "prime", customerName: "Bea", contact: "bea@example.com", paymentMethod: "Venmo",
      items: [{ productId: "polo", qty: 1 }] }, "https://prime.example.com/api/orders");
    const res = await Promise.race([resP, new Promise((r) => setTimeout(() => r("timeout"), 2000))]);
    console.log("the order response returns while the email is still sending:", res !== "timeout" && res.status === 200 && emailSentFor.length === 0);
    console.log("the order is saved before the email goes out:", !!(await lib.getOrderById(d1, "PRIME-2")));
    console.log("receivedEmailAt isn't stamped until the send succeeds:", !(await lib.getOrderById(d1, "PRIME-2")).receivedEmailAt);
    releaseEmail();
    await Promise.all(pending);
    console.log("the send finishes under waitUntil and stamps receivedEmailAt:",
      emailSentFor.includes("PRIME-2") && !!(await lib.getOrderById(d1, "PRIME-2")).receivedEmailAt);

    console.log("\n=== M-3: 2FA can't be silently replaced; changes are audited first ===");
    const audits = [];
    let activeSecret = null, auditFails = false;
    // The secret is the signed-in user's own now (users.totpSecret); the stand-ins below keep it
    // in `activeSecret` so the rest of this section reads as before.
    const tfa = new Function(strip(read("functions/_lib/http.js")) + "\n" +
      "const getCatalogData = async () => ({ subdomainMap: {} }); const classifyHost = () => ({ kind: 'admin' });\n" +
      "const requireAdmin = async () => null; const adminActor = () => 'owner@myshop.com'; const adminUser = () => ({ id: 1, role: 'admin' });\n" +
      "const require2fa = async () => false; const refreshPending = async () => null;\n" +
      "const rateLimitCheck = async () => ({ blocked: false }), rateLimitHit = async () => {}, rateLimitResponse = () => null, deleteUserSessions = async () => {};\n" +
      "const generateRecoveryCodes = () => ['aaaaa-bbbbb']; const saveRecoveryCodes = async () => {}; const recoveryCodesLeft = () => 0;\n" +
      "const looksLikeRecoveryCode = () => false; const spendRecoveryCode = async () => false;\n" +
      "const getUserById = async () => ({ id: 1, email: 'owner@myshop.com', totpSecret: __s.activeSecret() });\n" +
      "const updateUser = async (db, id, patch) => { if ('totpSecret' in patch) { if (patch.totpSecret) __s.save(patch.totpSecret); else __s.clear(); } };\n" +
      "const claimUserTotpCounter = async () => true;\n" +
      "const verifyTOTP = async (secret, code) => ({ valid: code === '123456', counter: 1 });\n" +
      "const insertAuditLog = async (db, row) => __s.audit(row);\n" +
      strip(read("functions/api/admin-2fa.js")) + "\nreturn onRequestPost;");
    const tfaPost = tfa.call(null);
    global.__s = { activeSecret: () => activeSecret, save: (v) => { activeSecret = v; }, clear: () => { activeSecret = null; }, audit: (row) => { if (auditFails) throw new Error("D1 down"); audits.push(row); } };
    const tcall = async (body) => {
      const res = await tfaPost({ env: { DB: {} }, request: { url: "https://admin.example.com/api/admin-2fa",
        json: async () => Object.assign({ key: "cookie" }, body), headers: { get: (h) => h === "CF-Connecting-IP" ? "203.0.113.9" : null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    r = await tcall({ action: "activate", proposedSecret: "OWNERSECRET", code: "123456" });
    console.log("first activation works:", r.status === 200 && activeSecret === "OWNERSECRET");
    console.log("…and is audited with who and from where:",
      audits.length === 1 && audits[0].action === "security.2fa_enabled" && audits[0].actor === "owner@myshop.com" && audits[0].actorUserId === 1 && audits[0].ip === "203.0.113.9");
    console.log("…and recovery codes are handed over once, at that moment:", Array.isArray(r.body.recoveryCodes) && r.body.recoveryCodes.length === 1);
    r = await tcall({ action: "activate", proposedSecret: "ATTACKERSECRET", code: "123456" });
    console.log("activating a NEW secret while 2FA is on is refused (409), secret unchanged:", r.status === 409 && activeSecret === "OWNERSECRET");
    console.log("…and nothing is audited for the refusal:", audits.length === 1);
    r = await tcall({ action: "disable", code: "000000" });
    console.log("disable with a wrong current code is refused:", r.status === 400 && activeSecret === "OWNERSECRET");
    auditFails = true;
    r = await tcall({ action: "disable", code: "123456" });
    console.log("if the audit row can't be written, 2FA is NOT disabled (503):", r.status === 503 && activeSecret === "OWNERSECRET");
    auditFails = false;
    r = await tcall({ action: "disable", code: "123456" });
    console.log("disable with the current code works and is audited:",
      r.status === 200 && activeSecret === null && audits.at(-1).action === "security.2fa_disabled");
  } catch (e) {
    console.log("test62 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
