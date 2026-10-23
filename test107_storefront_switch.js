const fs = require("fs");
const { JSDOM } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Global settings → Features → Storefront (the fifth switch; the other four are in test106).
// ON (the default): customers browse shops and order online. OFF: the install is back office only —
// every shop address and the root domain show a short "online ordering isn't available" page,
// /api/catalog serves no shop, and a customer's order, card checkout and rate quote are refused.
// Everything the admin does keeps working: orders entered in the admin, payment links, design
// proofs, Publish. Real SQL (sql.js), real db.js / orders.js / catalog.js / checkout.js /
// shipping.js / verify.js, and the real page in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), httpSrc = strip(read("functions/_lib/http.js")), hostSrc = strip(read("functions/_lib/hostConfig.js"));
const emailSrc = strip(read("functions/_lib/email.js")), ordersJs = read("functions/api/orders.js");
const lib = new Function(dbSrc + "\nreturn { FEATURES, getFeatures, getPublicCatalogData, createProduct, getOrderById, setBusinessProfile };")();
const SUBS = { acme: "acme" };
const api = new Function("catalogData", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async (env, host, key) => (host.kind === 'admin' && key === 'x') ? null : jsonResponse({ status: 'error', message: 'Unauthorized' }, 401); const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = (env) => catalogData(env);\n" +
  "const ensureOrgDomain = async () => ({ status: 'ok', hostname: 'x' }), getOrgDomainStatus = async () => ({ status: 'ok' });\n" +
  "const checkShippedDeliveries = async () => ({}), checkBlankShipments = async () => ({});\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(ordersJs) + "\nreturn { post: onRequestPost };");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(res => setTimeout(res, ms || 40));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Acme League','t','t',1,1);`);
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Secret Tee", pricingMode: "sized", sizePricing: { M: 23.45 }, visible: true });
  await lib.setBusinessProfile(d1, { name: "Thread & Needle", supportEmail: "hello@threadneedle.example" });
  const env = { DB: d1, QUOTE_SIGNING_SECRET: "q".repeat(40), SIGNING_SECRET: "s".repeat(40), STRIPE_SECRET_KEY: "sk_test_x", ...MAIL_ENV };
  const catalogData = async () => ({ ...(await lib.getPublicCatalogData(d1)), subdomainMap: SUBS });
  const A = api(catalogData);
  let emails = [], stripeCalls = 0, shippoCalls = 0;
  global.fetch = async (url, init) => {
    if (captureMail(url, init, emails)) return MAIL_OK;
    if (/api\.stripe\.com/.test(String(url))) { stripeCalls++; return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.test/s/1", id: "cs_1" }) }; }
    if (/goshippo/.test(String(url))) { shippoCalls++; return { ok: true, status: 200, json: async () => ({ rates: [{ amount: "9.00", provider: "USPS", servicelevel: { name: "Ground" } }] }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const hostname = (h) => h === "root" ? "example.com" : `${h}.example.com`;
  const post = async (host, body) => {
    const res = await A.post({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `https://${hostname(host)}/api/orders`, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => post("admin", Object.assign({ key: "x" }, body));
  const setF = async (features) => { const r = await admin({ action: "updateFeatures", features }); await tick(20); return r; };
  const place = (id, host) => post(host || "acme", { orderId: id, orgId: "acme", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "tee", size: "M", qty: 1 }] });
  const catalog = new Function(hostSrc + "\n" + httpSrc + "\nconst getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\nlet getCatalogData;\n" + strip(read("functions/api/catalog.js")) + "\nreturn { get: onRequestGet, set: (f) => { getCatalogData = f; } };")();
  catalog.set(catalogData);
  const cat = async (host) => { const res = await catalog.get({ request: { url: `https://${hostname(host)}/api/catalog` }, env }); return { status: res.status, text: await res.text() }; };
  const catJ = async (host) => JSON.parse((await cat(host)).text);
  const { orderTokenFor } = require("./testlib/order-token");
  const checkout = new Function("getCatalogData", hostSrc + "\n" + httpSrc + "\nconst rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    dbSrc + "\n" + strip(read("functions/api/checkout.js")) + "\nreturn onRequestPost;")(catalogData);
  const pay = async (host, orderId) => { const res = await checkout({ env, request: { url: `https://${hostname(host)}/api/checkout`, json: async () => ({ orderId, orgId: "acme", checkoutToken: await orderTokenFor(env, orderId) }), headers: { get: () => null } } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  const g = { rateLimited: async () => ({ blocked: false }), getBoxPresets: async () => null, selectBox: () => ({ box: {}, packing: 0, boxWeightOz: 0 }), getProductsByOrg: async () => [{ productId: "tee", type: "shirt", weightOz: 6 }], getShipFromAddress: async () => ({ zip: "43004" }), ...new Function(dbSrc + "\nreturn { lineQty, QTY_MESSAGE };")() };
  const shipping = new Function("g", "getCatalogData", "const { rateLimited, getBoxPresets, selectBox, getProductsByOrg, getShipFromAddress, lineQty, QTY_MESSAGE } = g; const rateLimitResponse = () => null;\n" +
    hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/api/shipping.js")) + "\nreturn onRequestPost;")(g, catalogData);
  const quote = async (host) => { const res = await shipping({ env: { ...env, SHIPPO_API_KEY: "k" }, request: { url: `https://${hostname(host)}/api/shipping`, json: async () => ({ zip: "43004", items: [{ productId: "tee", qty: 1 }] }), headers: { get: () => null } } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  let r, c;

  console.log("=== The switch ===");
  const f = lib.FEATURES.find(x => x.key === "storefront");
  ok("there is a Storefront feature, described in a plain sentence that says what OFF does", !!f && f.label === "Storefront" && /Customers can browse shops and place orders online\./.test(f.description) && /Off:/.test(f.description));
  ok("a new install has it on", (await lib.getFeatures(d1)).storefront === true && (await lib.getFeatures(null)).storefront === true);
  ok("it owns no admin action: nothing in the admin is switched off with it", !/\n  storefront: \[/.test(ordersJs.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1]));

  console.log("\n=== On: the storefront works ===");
  c = await catJ("acme");
  ok("a shop's address gets its catalog", c.status === "ok" && c.catalog.name === "Acme League" && c.catalog.products[0].name === "Secret Tee" && c.features.storefront === true);
  ok("a customer's order is taken", (await place("ON-1")).body.status === "ok" && !!(await lib.getOrderById(d1, "ON-1")));
  r = await pay("acme", "ON-1");
  ok("…and can be paid by card", r.status === 200 && /^https:/.test(r.body.url) && stripeCalls === 1);
  r = await quote("acme");
  ok("…and a rate is quoted", r.status === 200 && r.body.rates.length === 1 && shippoCalls === 1);

  console.log("\n=== Off: the public side is closed ===");
  r = await post("acme", { action: "updateFeatures", key: "x", features: { storefront: false } });
  ok("only the admin host can turn it off", r.status === 401 && (await lib.getFeatures(d1)).storefront === true);
  r = await setF({ storefront: false });
  ok("turning it off saves, leaves the other switches on, and is audited", r.status === 200 && r.body.features.storefront === false && r.body.features.production === true &&
    /"storefront":\{"from":true,"to":false\}/.test(d1.q("SELECT detail FROM audit_log WHERE action='settings.features_set' ORDER BY id DESC LIMIT 1")[0].detail));
  r = await cat("acme"); c = JSON.parse(r.text);
  ok("a shop's address: \"closed\", with who runs the site and the switches — and no shop", r.status === 200 && c.status === "closed" && /Online ordering isn't available here/.test(c.message) &&
    c.business.name === "Thread & Needle" && c.business.supportEmail === "hello@threadneedle.example" && c.features.storefront === false && c.country === "US" && !("catalog" in c) && !("orgId" in c));
  ok("…nothing of the shop is in the answer: not its name, a product or a price", !/Acme|Secret Tee|23\.45|acme/.test(r.text));
  r = await cat("root");
  ok("the root domain answers the same", r.status === 200 && JSON.parse(r.text).status === "closed" && !/Acme|Secret Tee/.test(r.text));
  ok("the admin host is still the admin", (await catJ("admin")).status === "admin" && (await catJ("admin")).features.storefront === false);
  r = await cat("nobody");
  ok("an unknown host is still refused as unknown", r.status === 404 && JSON.parse(r.text).status === "error");
  const orders0 = d1.q("SELECT count(*) n FROM orders")[0].n;
  r = await place("OFF-1");
  ok("a customer's order is refused with a plain message, and nothing is saved", r.status === 403 && r.body.status === "error" && r.body.feature === "storefront" && r.body.message === "Online ordering isn't available here." &&
    !(await lib.getOrderById(d1, "OFF-1")) && d1.q("SELECT count(*) n FROM orders")[0].n === orders0);
  ok("…from the root domain too", (await place("OFF-2", "root")).status === 403 && !(await lib.getOrderById(d1, "OFF-2")));
  ok("the message tells a customer nothing about settings", !/Global settings|Features/.test(r.body.message));
  const s0 = stripeCalls;
  r = await pay("acme", "ON-1");
  ok("the storefront's card checkout is refused, without calling Stripe", r.status === 403 && r.body.feature === "storefront" && stripeCalls === s0 && (await pay("root", "ON-1")).status === 403);
  const q0 = shippoCalls;
  r = await quote("acme");
  ok("a customer's rate quote is refused, without calling the carrier", r.status === 403 && r.body.feature === "storefront" && shippoCalls === q0 && (await quote("root")).status === 403);

  console.log("\n=== Off: the back office carries on ===");
  r = await admin({ action: "createLocalSale", org: "acme", customerName: "Walk-in", contact: "w@x.com", paymentMethod: "Cash", items: [{ productId: "tee", name: "Secret Tee", type: "shirt", size: "M", qty: 2 }] });
  const localId = r.body.orderId;
  ok("the admin enters an order (local sale)", r.status === 200 && !!localId && (await lib.getOrderById(d1, localId)).total > 0);
  r = await admin({ action: "getOrders", org: "acme" });
  ok("the admin sees the shop's orders, old and new", r.status === 200 && r.body.orders.some(o => o.orderId === "ON-1") && r.body.orders.some(o => o.orderId === localId));
  r = await admin({ action: "listProducts", org: "acme" });
  ok("the admin still manages the catalog", r.status === 200 && JSON.stringify(r.body).includes("Secret Tee"));
  r = await admin({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Secret Tee", pricingMode: "sized", sizePricing: { M: 24 }, visible: true, images: [], features: [] });
  const r2 = await admin({ action: "publish" });
  ok("…and Publish still works", r2.status === 200 && r2.body.status === "ok");
  r = await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme League", ready: false });
  ok("a shop's \"ready\" box can still be changed", r.status === 200 && (await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme League", ready: true })).status === 200);
  ok("custom-domain setup is still offered", (await admin({ action: "setupOrgDomain", orgId: "acme" })).status !== 403 && (await admin({ action: "getOrgDomainStatus", orgId: "acme" })).status !== 403);
  const s1 = stripeCalls; emails = [];
  r = await admin({ action: "createShippingPaymentLink", orderId: localId, shippingCost: 7.5 });
  ok("a payment link the admin sends a customer is still made and emailed", r.status === 200 && stripeCalls === s1 + 1 && emails.length === 1);
  r = await admin({ action: "markPaidManual", org: "acme", orderId: localId });
  ok("an order can be marked paid", r.status === 200 && (await lib.getOrderById(d1, localId)).paid === true);
  r = await admin({ action: "createTestTransaction", org: "acme", amount: 1 });
  ok("the admin's Stripe test transaction still runs", r.status === 200);
  r = await quote("admin");
  ok("the admin's own rate quotes still work", r.status === 200 && shippoCalls === q0 + 1);
  ok("the card checkout isn't closed on the admin host", (await pay("admin", "ON-1")).status !== 403);
  // A customer's design-approval link.
  r = await admin({ action: "sendDesignVerification", orderIds: ["ON-1"], message: "Please check." });
  const token = (d1.q("SELECT token FROM design_verifications WHERE orderId='ON-1'")[0] || {}).token;
  ok("a design proof can still be emailed to a customer", r.status === 200 && r.body.sent === 1 && !!token);
  const verify = new Function(httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/verifyLinks.js")) + "\n" + strip(read("functions/api/verify.js")) + "\nreturn { get: onRequestGet };")();
  const vres = await verify.get({ env, request: { url: "https://acme.example.com/api/verify?token=" + token } });
  ok("a design proof the customer was emailed still opens", JSON.parse(await vres.text()).status === "ok");
  ok("the Stripe webhook, the verification endpoints, the morning roll-up and the image / receipt / design files don't look at this switch at all",
    ["stripe-webhook.js", "verify.js", "upload-verify.js", "daily-digest.js", "upload.js", "receipt.js", "design.js", "shippo-label.js", "admin-session.js", "admin-2fa.js", "agent.js", "image-proxy.js"]
      .every(n => !/storefront/.test(read("functions/api/" + n).replace(/storefront'?s? /gi, ""))) && !/features/.test(read("functions/api/stripe-webhook.js")));
  ok("only four places read it: the catalog, order submission, card checkout and rate quotes", ["catalog.js", "orders.js", "checkout.js", "shipping.js"].every(n => /storefront\b.*=== false|featureOn\("storefront"\)/.test(read("functions/api/" + n))));

  console.log("\n=== Off: what a customer sees ===");
  const page = async (url, answers) => {
    const d = new JSDOM(read("public/index.html"), { runScripts: "dangerously", url, pretendToBeVisual: true,
      beforeParse(win){ win.__calls = []; win.fetch = async (u) => { win.__calls.push(String(u)); const a = answers(String(u)); return { ok: (a.http || 200) < 400, status: a.http || 200, json: async () => a.body }; }; } });
    await tick(180); return d.window; };
  const closedAnswer = await catJ("acme");
  let w = await page("https://acme.example.com/", () => ({ body: closedAnswer })), text = w.document.getElementById("app").textContent;
  ok("a shop's address shows the short page: not available, the business name and its contact email", /Online ordering isn't available here\./.test(text) && /Thread & Needle/.test(text) && /hello@threadneedle\.example/.test(text) &&
    !!w.document.querySelector('#storefrontOff a[href="mailto:hello@threadneedle.example"]'));
  ok("…no shop, no products, no cart, no order form", !/Acme|Secret Tee|Place order/.test(text) && !w.document.getElementById("custContact") && !w.document.querySelector(".product-card, .cart") && w.eval("currentOrg") === null);
  ok("…and it asked only who it is — it never loaded the admin", w.__calls.length === 1 && /\/api\/catalog/.test(w.__calls[0]) && !w.document.querySelector('script[src*="admin.js"]'));
  w = await page("https://example.com/", () => ({ body: closedAnswer }));
  ok("the root domain shows the same page", /Online ordering isn't available here\./.test(w.document.getElementById("app").textContent) && !/Looking for your organization/.test(w.document.getElementById("app").textContent));
  w = await page("https://acme.example.com/", () => ({ body: { status: "closed", business: {}, features: { storefront: false }, country: "US" } }));
  ok("with no business profile filled in, it is just the one sentence", /Online ordering isn't available here\./.test(w.document.getElementById("app").textContent) && !w.document.querySelector("#storefrontOff a"));
  w = await page("https://acme.example.com/?stripe=success&orderId=" + localId + "&org=acme", () => ({ body: closedAnswer }));
  text = w.document.getElementById("app").textContent;
  ok("a customer returning from a payment link is told the payment went through (and the address bar is cleaned)", /Payment confirmed/.test(text) && text.includes(localId) && !/isn't available/.test(text) && w.location.search === "");
  w = await page("https://acme.example.com/?verify=abc", (u) => u.includes("/api/verify") ? { body: { status: "invalid" } } : { body: closedAnswer });
  ok("a design-approval link still goes to the approval page, not the closed page", w.__calls.some(u => /\/api\/verify\?token=abc/.test(u)) && !w.document.getElementById("storefrontOff"));
  w = await page("https://admin.example.com/", (u) => u.includes("/api/catalog") ? { body: { status: "admin", business: {}, features: { storefront: false }, country: "US" } } : { body: { status: "error" } });
  ok("the admin host still opens the admin", w.eval("route.view") === "admin" && !w.document.getElementById("storefrontOff"));

  console.log("\n=== The admin's Features section ===");
  const adminJs = read("public/admin.js");
  ok("it explains that Storefront off hides nothing in the admin and what customers see", /<strong>Storefront<\/strong> is the one switch that hides nothing here/.test(adminJs) && /online ordering isn't available/.test(adminJs));
  ok("no admin page belongs to it (nothing leaves the menu)", !/:\s*"storefront"/.test(adminJs.match(/const ADMIN_PAGE_FEATURE = \{[\s\S]*?\};/)[0]) && /storefront: "Storefront"/.test(adminJs));

  console.log("\n=== Back on ===");
  r = await setF({ storefront: true });
  c = await catJ("acme");
  ok("the shop is served again, exactly as it was (with the price changed meanwhile)", r.status === 200 && c.status === "ok" && c.catalog.name === "Acme League" && c.catalog.products[0].sizePricing.M === 24);
  ok("the root domain is the generic page again", (await catJ("root")).status === "error");
  ok("orders, card checkout and quotes are taken again", (await place("BACK-1")).body.status === "ok" && (await pay("acme", "BACK-1")).status === 200 && (await quote("acme")).status === 200);
  ok("the order refused while it was off was never recorded", !(await lib.getOrderById(d1, "OFF-1")));
  w = await page("https://acme.example.com/", () => ({ body: c }));
  ok("the shop's page is the shop again", /Acme League/.test(w.document.getElementById("app").textContent) && !w.document.getElementById("storefrontOff"));

  console.log("\n=== README ===");
  ok("the README says what turning the storefront off does", /\*\*Storefront\*\*/.test(read("README.md")) && /back office/i.test(read("README.md")));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("test107 crashed:", e); console.log("test107 crashed: false"); process.exit(1); });
