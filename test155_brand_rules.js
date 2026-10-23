const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Brand rules (migrations/0075): brands a supplier restricts (SanMar: The North Face, Carhartt, Nike, …) are flagged on
// products (decorated only; SanMar's logo approval), on orders with a large number of one style, and on Blanks to
// Order; Order from SanMar is refused for a large quantity until the approval (with SanMar's reply attached) is on the
// product — an admin can override it with a reason. `fetch` is mocked for the supplier's SOAP.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const psSrc = strip(read("functions/_lib/promostandards.js")), credSrc = strip(read("functions/_lib/vendorCredentials.js")), soSrc = strip(read("functions/_lib/supplierOrders.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, insertOrder, getBlanksToOrder, getCatalogIssues, getOrdersByOrg, getOrderById, brandKey_, brandRuleFor_, getBrandRules, DEFAULT_BRAND_RULES };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + psSrc + "\n" + credSrc + "\n" + soSrc + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// ---- The supplier (SanMar-shaped PromoStandards answers) ----
const env = (body) => `<?xml version="1.0" encoding="UTF-8"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>${body}</S:Body></S:Envelope>`;
const P = 'xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"';
const part = (id, color, size) => `<ns2:ProductPart><ns2:partId>${id}</ns2:partId><ns2:ColorArray><ns2:Color><ns2:colorName>${color}</ns2:colorName></ns2:Color></ns2:ColorArray><ns2:ApparelSize><ns2:labelSize>${size}</ns2:labelSize></ns2:ApparelSize></ns2:ProductPart>`;
const PRODUCT = env(`<GetProductResponse ${P}><Product><ns2:productId>CT104</ns2:productId><ns2:productName>Carhartt Hoodie</ns2:productName><ns2:ProductPartArray>${part("2001", "Brown", "L")}</ns2:ProductPartArray></Product></GetProductResponse>`);
const PO_OK = env(`<ns2:SendPOResponse xmlns:ns2="http://www.promostandards.org/WSDL/PO/1.0.0/"><ns2:transactionId>TX-1</ns2:transactionId></ns2:SendPOResponse>`);
const calls = [];
const vendorFetch = async (url, init = {}) => {
  const body = String(init.body || "");
  calls.push({ url: String(url), body });
  if (/GetProductRequest/.test(body)) return new Response(PRODUCT, { status: 200 });
  if (/SendPORequest/.test(body)) return new Response(PO_OK, { status: 200 });
  return new Response("", { status: 404 });
};
const URLS = { product: "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2", ppc: "https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding",
  po: "https://ws.sanmar.com:8080/promostandards/POServiceBinding" };

(async () => {
  console.log("=== The rules ===");
  // OpenDecoDesk seeds only what the suppliers publish — no notes from a rep (The North Face has none).
  ok("the seeded rules: 100 pieces by default, the brands SanMar and S&S publish as restricted", lib.DEFAULT_BRAND_RULES.largeQty === 100 && lib.DEFAULT_BRAND_RULES.brands.length === 20 &&
    lib.DEFAULT_BRAND_RULES.brands.find(b => b.brand === "The North Face").note === "" && ["adidas", "Columbia", "Oakley", "Puma", "DRI DUCK"].every(n => lib.DEFAULT_BRAND_RULES.brands.some(b => b.brand === n)));
  ok("…no supplier is named in the notes, and DRI DUCK may be sold plain with no approval needed", !lib.DEFAULT_BRAND_RULES.brands.some(b => /sanmar|s&s/i.test(b.note)) &&
    (d => d.mustDecorate === false && d.largeNeedsApproval === false && /MAP/.test(d.note))(lib.DEFAULT_BRAND_RULES.brands.find(b => b.brand === "DRI DUCK")));
  ok("brands match ignoring case, spaces, punctuation and ®", lib.brandKey_("The North Face®") === lib.brandKey_("the-north face") && lib.brandRuleFor_(lib.DEFAULT_BRAND_RULES, "CARHARTT").brand === "Carhartt" &&
    lib.brandRuleFor_(lib.DEFAULT_BRAND_RULES, "Port Authority") === null);

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('shipFrom', '{"name":"Shop","street1":"1 Main St","city":"Anytown","state":"CO","zip":"80202"}');`);
  const bucket = new Set(["receipts/2026/" + "a".repeat(32) + ".pdf"]);
  const RECEIPTS = { head: async (k) => bucket.has(k) ? {} : null };
  const keyEnv = { VENDOR_CREDENTIALS_KEY: "a-long-random-master-key-for-tests-0123456789", RECEIPTS };
  global.fetch = vendorFetch;
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1, ...keyEnv }, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };

  let r = await call({ action: "getBrandRules" }, { role: "manager" });
  ok("a manager can read the rules (the seeded ones until saved)", r.status === 200 && r.body.rules.brands.length === 20);
  const rules = r.body.rules;
  ok("…but only an admin can change them", (await call({ action: "updateBrandRules", rules }, { role: "manager" })).status === 403);
  r = await call({ action: "updateBrandRules", rules: Object.assign({}, rules, { brands: rules.brands.concat([{ brand: "the north face" }]) }) });
  ok("a brand listed twice is refused", r.status === 400 && /listed twice/.test(r.body.message));
  r = await call({ action: "updateBrandRules", rules: Object.assign({}, rules, { largeQty: 0 }) });
  ok("…and a default large quantity that isn't a whole number from 1", r.status === 400);
  const tnf = rules.brands.find(b => b.brand === "The North Face");
  tnf.largeQty = 24;
  r = await call({ action: "updateBrandRules", rules });
  ok("a per-brand large quantity is saved (The North Face at 24), audited", r.status === 200 && r.body.rules.brands.find(b => b.brand === "The North Face").largeQty === 24 &&
    d1.q("SELECT 1 FROM audit_log WHERE action='settings.brand_rules_set'").length === 1);
  ok("…and used for that brand only", lib.brandRuleFor_(r.body.rules, "The North Face").threshold === 24 && lib.brandRuleFor_(r.body.rules, "Carhartt").threshold === 100);

  console.log("\n=== Products ===");
  const sz = (list) => list.map(([size, purchasePrice]) => ({ size, purchasePrice, quantity: 0 }));
  const ct = (await lib.createBlank(d1, { name: "Carhartt Midweight Hoodie", productType: "sweatshirt", vendor: "SanMar", brand: "Carhartt®", sku: "CT104", color: "", colors: [{ color: "Brown", sizes: sz([["L", 40]]) }] })).id;
  const tee = (await lib.createBlank(d1, { name: "Core Tee", productType: "shirt", vendor: "SanMar", brand: "Port & Co", sku: "PC54", color: "", colors: [{ color: "Navy", sizes: sz([["L", 3]]) }] })).id;
  await lib.createProduct(d1, "acme", { productId: "hood", type: "sweatshirt", name: "Acme Hoodie", pricingMode: "sized", sizePricing: { L: 60 }, visible: true, personalizationPrice: 5 });
  await lib.createProduct(d1, "acme", { productId: "plain", type: "sweatshirt", name: "Plain Carhartt", pricingMode: "sized", sizePricing: { L: 55 }, visible: true, noDesignNeeded: true });
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { L: 20 }, visible: true });
  await lib.setBlankLink(d1, "acme", "hood", "", "L", ct, "Brown", "L");
  await lib.setBlankLink(d1, "acme", "plain", "", "L", ct, "Brown", "L");
  await lib.setBlankLink(d1, "acme", "tee", "", "L", tee, "Navy", "L");
  let issues = (await lib.getCatalogIssues(d1, "acme")).orgs.acme.products;
  const rule = (pid) => (issues[pid] || []).find(x => x.code === "brandRule");
  ok("a product on a restricted brand says what to verify with the supplier — decorated only, approval for 100+, the logo concerns", rule("hood") && /Carhartt \(a restricted brand — verify with the supplier\): must be decorated · orders of 100\+ of one style need the supplier's logo approval — none on file · avoid logos with: guns \/ firearms/.test(rule("hood").text) && !/SanMar/.test(rule("hood").text));
  ok("…one on another brand isn't flagged", !rule("tee"));
  ok("a restricted brand with nothing decorating it is an error", (issues.plain || []).some(x => x.code === "brandUndecorated" && x.level === "error") && !(issues.hood || []).some(x => x.code === "brandUndecorated"));
  r.body.rules.brands.find(b => b.brand === "Carhartt").exceptCategories = ["sweatshirt"];
  await call({ action: "updateBrandRules", rules: r.body.rules });
  issues = (await lib.getCatalogIssues(d1, "acme")).orgs.acme.products;
  ok("…unless its category may be sold plain (Carhartt's jeans / accessories)", !(issues.plain || []).some(x => x.code === "brandUndecorated"));
  r.body.rules.brands.find(b => b.brand === "Carhartt").exceptCategories = [];
  await call({ action: "updateBrandRules", rules: r.body.rules });

  console.log("\n=== Approvals ===");
  const FILE = "receipts/2026/" + "a".repeat(32) + ".pdf";
  const today = new Date().toISOString().slice(0, 10);
  const add = (x, opts) => call(Object.assign({ action: "addBrandApproval", org: "acme", productIds: ["hood"], brand: "Carhartt", approvedOn: today, fileKey: FILE, fileName: "sanmar.pdf" }, x), opts);
  ok("an approval needs SanMar's reply attached", (await add({ fileKey: "" })).status === 400);
  ok("…a file that's really in the bucket", (await add({ fileKey: "receipts/2026/" + "b".repeat(32) + ".pdf" })).status === 400);
  ok("…a date that isn't in the future", (await add({ approvedOn: "2999-01-01" })).status === 400);
  ok("…a brand on the list and a real product", (await add({ brand: "Port & Co" })).status === 400 && (await add({ productIds: ["nope"] })).status === 400);
  ok("…and a manager (a worker can't add one)", (await add({}, { role: "staff" })).status === 403);
  ok("a worker can list approvals", (await call({ action: "listBrandApprovals", org: "acme" }, { role: "staff" })).status === 200);

  console.log("\n=== Orders ===");
  let n = 0;
  const order = async (items) => {
    const orderId = "O" + (++n);
    await lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Cust " + n, contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date(Date.now() + n * 1000).toISOString() },
      items.map(([productId, size, qty]) => ({ productId, name: productId, type: "sweatshirt", size, qty, unitPrice: 60 })));
    await d1.prepare("UPDATE orders SET paid=1 WHERE orderId=?").bind(orderId).run();
    return orderId;
  };
  const big = await order([["hood", "L", 60], ["plain", "L", 60]]);   // 120 of one style (two products), at the 100 line
  const small = await order([["hood", "L", 30]]);
  const tees = await order([["tee", "L", 500]]);
  let byId = Object.fromEntries((await lib.getOrdersByOrg(d1, "acme")).map(o => [o.orderId, o]));
  ok("an order with 100+ of one restricted style is flagged — the brand, style and pieces, not approved", byId[big].brandReview.length === 1 && byId[big].brandReview[0].brand === "Carhartt" &&
    byId[big].brandReview[0].style === "CT104" && byId[big].brandReview[0].pieces === 120 && byId[big].brandReview[0].approved === false);
  ok("…one under the line isn't, nor 500 of an unrestricted brand", !byId[small].brandReview.length && !byId[tees].brandReview.length);
  r = await add({ productIds: ["hood", "plain"], maxQty: 100, note: "Lance, left-chest logo" });
  ok("an approval is saved for each product it covers, audited", r.status === 200 && r.body.ids.length === 2 && d1.q("SELECT 1 FROM audit_log WHERE action='brand.approval_added'").length === 1);
  byId = Object.fromEntries((await lib.getOrdersByOrg(d1, "acme")).map(o => [o.orderId, o]));
  ok("…one approved up to 100 doesn't cover 120", byId[big].brandReview[0].approved === false);
  await add({ productIds: ["hood", "plain"] });
  const one = await lib.getOrderById(d1, big);
  ok("…one with no limit does — and a single order loads it too", one.brandReview[0].approved === true);
  issues = (await lib.getCatalogIssues(d1, "acme")).orgs.acme.products;
  ok("the product now says the approval is on file", /supplier logo approval on file \(/.test(rule("hood").text));
  const approvals = (await call({ action: "listBrandApprovals", org: "acme", productId: "hood" })).body.approvals;
  r = await call({ action: "revokeBrandApproval", id: approvals[0].id, note: "" });
  ok("revoking needs a reason", r.status === 400);
  r = await call({ action: "revokeBrandApproval", id: approvals[0].id, note: "Logo changed" });
  ok("…is kept on record, struck, and audited", r.status === 200 && r.body.approvals.find(a => a.id === approvals[0].id).revokedAt && d1.q("SELECT 1 FROM audit_log WHERE action='brand.approval_revoked'").length === 1);
  ok("…and can't be done twice", (await call({ action: "revokeBrandApproval", id: approvals[0].id, note: "again" })).status === 409);
  for (const a of (await call({ action: "listBrandApprovals", org: "acme" })).body.approvals.filter(a => !a.revokedAt)) await call({ action: "revokeBrandApproval", id: a.id, note: "reset" });

  console.log("\n=== Blanks to Order and Order from SanMar ===");
  const bto = await lib.getBlanksToOrder(d1);
  const ctRow = bto.suppliers[0].rows.find(x => x.blankId === ct);
  ok("Blanks to Order rows carry the brand rule and each product's approval", ctRow.brandRule.brand === "Carhartt" && ctRow.brandRule.threshold === 100 && ctRow.approvals["acme|hood"] === false && ctRow.approvals["acme|plain"] === false);
  r = await call({ action: "saveVendorConnection", companyCode: "SanMar", name: "SanMar", endpoints: URLS, credentials: { id: "u", password: "p" } });
  const cid = r.body.id;
  await call({ action: "linkVendorConnectionBlanks", id: cid, blankIds: [ct, tee] });
  const itemIds = ctRow.items;
  const lines = [{ blankId: ct, color: "Brown", size: "L", qty: 150 }];
  r = await call({ action: "previewSupplierOrder", connectionId: cid, lines, itemIds });
  ok("the order window is told what needs an approval (and which products)", r.status === 200 && r.body.brandCheck.needsApproval.length === 1 &&
    r.body.brandCheck.needsApproval[0].missing.map(m => m.productId).sort().join() === "hood,plain");
  calls.length = 0;
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines, itemIds, carrier: "UPS", service: "GROUND", poNumber: "BR-1" });
  ok("ordering 150 with no approval on file is refused, and nothing is sent", r.status === 409 && r.body.code === "needsApproval" && !calls.some(c => /SendPORequest/.test(c.body)) && !d1.q("SELECT 1 FROM supplier_orders").length);
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines, itemIds, carrier: "UPS", service: "GROUND", poNumber: "BR-1", overrideApproval: { reason: "x" } });
  ok("…an override needs a real reason", r.status === 409);
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines, itemIds, carrier: "UPS", service: "GROUND", poNumber: "BR-1", overrideApproval: { reason: "SanMar approved by phone; email to follow" } });
  ok("…an admin override with a reason places it, and is audited", r.status === 200 && r.body.order.status === "placed" &&
    d1.q("SELECT detail FROM audit_log WHERE action='supplier_order.approval_overridden'").some(a => /approved by phone/.test(a.detail) && /CT104/.test(a.detail)));
  await d1.prepare("UPDATE order_items SET blankOrderedAt=NULL, blankVendor='', blankVendorOrderId=''").run();
  await d1.prepare("UPDATE orders SET blankOrderedAt=NULL").run();
  await add({ productIds: ["hood", "plain"] });
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines, itemIds, carrier: "UPS", service: "GROUND", poNumber: "BR-2" });
  ok("with SanMar's approval on file it's placed without an override", r.status === 200 && r.body.order.status === "placed");
  r = await call({ action: "previewSupplierOrder", connectionId: cid, lines, itemIds: [] });
  ok("a large quantity with no order behind it (restock) is shown, not blocking", r.body.brandCheck.needsApproval.length === 0 && r.body.brandCheck.restockOnly.length === 1);
  r = await call({ action: "previewSupplierOrder", connectionId: cid, lines: [{ blankId: ct, color: "Brown", size: "L", qty: 99 }], itemIds });
  ok("…and under the line there's nothing to check", !r.body.brandCheck.needsApproval.length && !r.body.brandCheck.restockOnly.length);
  for (const a of ["getBrandRules", "addBrandApproval", "revokeBrandApproval"]) ok(`${a}: a worker is refused`, (await call({ action: a }, { role: "staff" })).status === 403);
  ok("updateBrandRules: a manager is refused", (await call({ action: "updateBrandRules", rules }, { role: "manager" })).status === 403);

  console.log("\n=== A brand that may be sold plain; rules saved before the S&S brands ===");
  const dd = (await lib.createBlank(d1, { name: "DRI DUCK Cap", productType: "cap", vendor: "S&S Activewear", brand: "DRI DUCK", sku: "3352", color: "", colors: [{ color: "Black", sizes: sz([["OSFA", 8]]) }] })).id;
  await lib.createProduct(d1, "acme", { productId: "ddcap", type: "cap", name: "DD Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "acme", "ddcap", "", "OSFA", dd, "Black", "OSFA");
  const ddOrder = await order([["ddcap", "OSFA", 300]]);
  issues = (await lib.getCatalogIssues(d1, "acme")).orgs.acme.products;
  ok("DRI DUCK: the product says to check its MAP, isn't an error when plain, and asks for no approval", /DRI DUCK \(a restricted brand — verify with the supplier\): .*MAP/.test(rule("ddcap").text) &&
    !/approval/.test(rule("ddcap").text) && !(issues.ddcap || []).some(x => x.code === "brandUndecorated") && rule("ddcap").needsApproval === false);
  ok("…and 300 of it on an order isn't flagged for review", !(await lib.getOrderById(d1, ddOrder)).brandReview.length);
  const v1 = { largeQty: 100, concerns: ["Guns"], brands: [
    { brand: "The North Face", largeQty: null, mustDecorate: true, exceptCategories: [], note: "" },
    { brand: "Carhartt", largeQty: 50, mustDecorate: true, exceptCategories: [], note: "my own note" } ] };   // Nike etc. removed by hand
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('brandRules', '${JSON.stringify(v1).replace(/'/g, "''")}')`);
  const up = await lib.getBrandRules(d1);
  ok("rules saved before the S&S brands get them added, and keep what was removed or changed by hand",
    ["adidas", "Columbia", "Oakley", "Puma", "DRI DUCK"].every(n => up.brands.some(b => b.brand === n)) && !up.brands.some(b => b.brand === "Nike") &&
    up.brands.find(b => b.brand === "Carhartt").largeQty === 50 && up.brands.find(b => b.brand === "Carhartt").note === "my own note" &&
    up.seedVersion === 2);
  d1._raw.exec("DELETE FROM global_settings WHERE key='brandRules'");
  const fresh = (await call({ action: "getBrandRules" })).body.rules;
  fresh.brands.find(b => b.brand === "The North Face").largeQty = 24;
  await call({ action: "updateBrandRules", rules: fresh });

  console.log("\n=== The screens ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#brandrules", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" };');
  const wait = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return fn(); };
  await w.renderBrandRules(d.getElementById("app"));
  await wait(() => d.querySelector(".br-row"));
  ok("Tools → Brand rules lists the brands with their large quantity, and is in the Tools menu", d.querySelectorAll(".br-row").length === 20 && w.eval("ADMIN_NAV_TOOLS").some(x => x[0] === "brandrules") &&
    [...d.querySelectorAll(".br-row")].find(tr => tr.querySelector(".br-brand").value === "The North Face").querySelector(".br-qty").value === "24");
  d.getElementById("brQty").value = "120";
  d.getElementById("brSave").click();
  await wait(() => (JSON.parse((d1.q("SELECT value FROM global_settings WHERE key='brandRules'")[0] || { value: "{}" }).value).largeQty === 120));
  ok("…Save writes the change", JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='brandRules'")[0].value).largeQty === 120);
  w.eval('adminMe = { role: "manager", name: "M", email: "m@x" };');
  await w.renderBrandRules(d.getElementById("app"));
  await wait(() => d.querySelector(".br-row"));
  ok("…a manager sees them read-only", d.getElementById("brQty").disabled && !d.getElementById("brSave"));
  w.eval('adminMe = { role: "admin", name: "A", email: "a@x" };');
  const pills = w.brandReviewPills_({ brandReview: [{ brand: "Carhartt", style: "CT104", blank: "Hoodie", pieces: 120, threshold: 100, approved: false }, { brand: "Nike", style: "NKX", blank: "Polo", pieces: 200, threshold: 100, approved: true }] });
  ok("the Orders pill: ⚠ Supplier review for an unapproved style, ✓ approved for an approved one", /⚠ Supplier review: Carhartt CT104 ×120/.test(pills) && /✓ Nike approved/.test(pills) && !/SanMar/.test(pills));
  const note = w.brandApprovalNeededHtml_([{ blankId: 1, blank: "Hoodie", sku: "CT104", toOrder: 120, brandRule: { brand: "Carhartt", threshold: 100 }, approvals: { "acme|hood": false } }]);
  ok("Blanks to Order: a style over its large quantity without approval is named under the table", /Needs the supplier's logo approval before ordering: Carhartt CT104 ×120/.test(note) &&
    w.brandApprovalNeededHtml_([{ blankId: 1, blank: "H", sku: "CT104", toOrder: 120, brandRule: { brand: "Carhartt", threshold: 100 }, approvals: { "acme|hood": null } }]) === "");
  const box = d.createElement("div"); box.id = "prodFormBrandApprovals"; d.body.appendChild(box);
  await w.loadBrandApprovalBox_("acme", { productId: "hood" }, ["Carhartt"]);
  ok("the product form's supplier approval box lists the approvals with View and Revoke, and offers Add", /Supplier logo approval/.test(box.textContent) && box.querySelector(".ba-view") && box.querySelector(".ba-revoke") && d.getElementById("baAdd"));
  d.getElementById("baAdd").click();
  await wait(() => d.getElementById("baSave"));
  d.getElementById("baSave").click();
  ok("…Add refuses to save without the supplier's reply attached", /Attach the supplier's approval/.test(d.getElementById("baErr").textContent));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test143 crashed: false"); process.exit(1); });
