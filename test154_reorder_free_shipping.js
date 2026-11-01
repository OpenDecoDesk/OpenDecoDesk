const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Reorder points (migrations/0074) and "Get me to free shipping" (2026-10). A blank size can say "keep at least N"
// free; Blanks to Order tops it back up. Each vendor (by the blank's Vendor name, connected or not) can ship free over
// a dollar amount or at a piece count; Blanks to Order shows how far each vendor's order is from it, and "Get me to
// free shipping" suggests restock and best sellers, lets you add any blank on file (or, for a connected vendor, a style
// looked up live), then copies the list, records it as ordered by hand, or continues to a Purchase Order. Real db.js +
// orders.js on sql.js with every migration; the admin page in jsdom; the supplier's SOAP mocked.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const psSrc = strip(read("functions/_lib/promostandards.js")), credSrc = strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/vendorLog.js")), soSrc = strip(read("functions/_lib/supplierOrders.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, updateBlank, getAllBlanks, mergeBlanks, createProduct, setBlankLink, insertOrder, getBlanksToOrder, getBlankUsage, vendorShippingFor, getFreeShippingCandidates };`)();
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
const wait = async (fn, n = 400) => { for (let i = 0; i < n && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return fn(); };

// ---- The supplier (SanMar's PromoStandards, recorded shapes — see test139) ----
const env = (body) => `<?xml version="1.0" encoding="UTF-8"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>${body}</S:Body></S:Envelope>`;
const P = 'xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"';
const part = (id, color, size) => `<ns2:ProductPart><ns2:partId>${id}</ns2:partId><ns2:ColorArray><ns2:Color><ns2:colorName>${color}</ns2:colorName></ns2:Color></ns2:ColorArray><ns2:ApparelSize><ns2:labelSize>${size}</ns2:labelSize></ns2:ApparelSize></ns2:ProductPart>`;
const PRODUCT = env(`<GetProductResponse ${P}><Product><ns2:productId>K540</ns2:productId><ns2:productName>Silk Touch Polo</ns2:productName><ns2:productBrand>Port Authority</ns2:productBrand>
  <ns2:ProductPartArray>${part("1001", "Black", "S")}${part("1002", "Black", "2XL")}${part("1003", "Navy", "S")}</ns2:ProductPartArray></Product></GetProductResponse>`);
const I = 'xmlns:ns2="http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/Inventory/2.0.0/"';
const INVENTORY = env(`<GetInventoryLevelsResponse ${I}><ns2:Inventory><ns2:productId>K540</ns2:productId><ns2:PartInventoryArray>${[["1001", 100], ["1002", 50], ["1003", 80]].map(([id, n]) =>
  `<ns2:PartInventory><ns2:partId>${id}</ns2:partId><ns2:mainPart>false</ns2:mainPart><ns2:quantityAvailable><ns2:Quantity><ns2:uom>EA</ns2:uom><ns2:value>${n}</ns2:value></ns2:Quantity></ns2:quantityAvailable><ns2:manufacturedItem>false</ns2:manufacturedItem><ns2:buyToOrder>false</ns2:buyToOrder></ns2:PartInventory>`).join("")}</ns2:PartInventoryArray></ns2:Inventory></GetInventoryLevelsResponse>`);
const PO_OK = env(`<ns2:SendPOResponse xmlns:ns2="http://www.promostandards.org/WSDL/PO/1.0.0/" xmlns="http://www.promostandards.org/WSDL/PO/1.0.0/SharedObjects/"><ns2:transactionId>TX-1</ns2:transactionId></ns2:SendPOResponse>`);
const soapSent = [];
global.fetch = async (url, init = {}) => {
  const body = String(init.body || "");
  soapSent.push(body);
  if (/GetProductRequest/.test(body)) return new Response(PRODUCT, { status: 200 });
  if (/GetInventoryLevelsRequest/.test(body)) return new Response(INVENTORY, { status: 200 });
  if (/SendPORequest/.test(body)) return new Response(PO_OK, { status: 200 });
  return new Response("", { status: 404 });
};
const URLS = { product: "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2", ppc: "https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding",
  inv: "https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final", po: "https://ws.sanmar.com:8080/promostandards/POServiceBinding" };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('shipFrom', '{"name":"Shop","street1":"1 Main St","city":"Springfield","state":"IL","zip":"62701","phone":"2175550100","email":"o@x.com"}');`);
  const keyEnv = { VENDOR_CREDENTIALS_KEY: "a-long-random-master-key-for-tests-0123456789" };
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1, ...keyEnv }, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const sizes = (list) => list.map(([size, vendorPrice, quantity, reorderPoint]) => ({ size, vendorPrice, quantity, ...(reorderPoint !== undefined ? { reorderPoint } : {}) }));

  console.log("=== Reorder points: kept through edits, vendor refreshes and merges ===");
  const tee = (await lib.createBlank(d1, { name: "Core Tee", productType: "shirt", vendor: "SanMar", brand: "Port & Company", sku: "PC54", color: "",
    colors: [{ color: "Navy", sizes: sizes([["S", 4, 2], ["M", 4, 2], ["L", 4, 2, 6]]) }] })).id;
  const teeFields = { name: "Core Tee", productType: "shirt", vendor: "SanMar", brand: "Port & Company", sku: "PC54", color: "" };
  const upd = (colors) => lib.updateBlank(d1, tee, { ...teeFields, colors });
  const sizeOf = async (id, color, size) => (await lib.getAllBlanks(d1)).find(b => b.id === id).sizes.find(z => z.color === color && z.size === size);
  ok("a new blank keeps the Keep typed for a size (others have none)", (await sizeOf(tee, "Navy", "L")).reorderPoint === 6 && (await sizeOf(tee, "Navy", "S")).reorderPoint === null);
  await upd([{ color: "Navy", sizes: sizes([["S", 4, 2], ["M", 4, 2], ["L", 4.25, 2]]) }]);
  ok("an edit that doesn't send it keeps it", (await sizeOf(tee, "Navy", "L")).reorderPoint === 6 && (await sizeOf(tee, "Navy", "L")).vendorPrice === 4.25);
  await upd([{ color: "Navy", sizes: sizes([["S", 4, 2, 3], ["M", 4, 2], ["L", 4.25, 2, ""]]) }]);
  ok("sending a number sets it, sending empty clears it", (await sizeOf(tee, "Navy", "S")).reorderPoint === 3 && (await sizeOf(tee, "Navy", "L")).reorderPoint === null);
  await upd([{ color: "Navy", sizes: sizes([["S", 4, 2, ""], ["M", 4, 2], ["L", 4.25, 2, 6]]) }]);
  const product = { vendor: "SanMar", style: "PC54", name: "Core Tee", brand: "Port & Company", colors: [{ color: "Navy" }], sizes: ["S", "M", "L"], prices: { "*": { S: 4.1, M: 4.1, L: 4.4 } } };
  let r = await call({ action: "previewVendorBlanks", products: [product] });
  const plan = r.body.plans[0];
  r = await call({ action: "applyVendorBlanks", products: [product], selections: [{ key: plan.key, blankId: plan.blankId, colors: ["Navy"] }] });
  ok("a refresh from the vendor changes the price and keeps the reorder point", r.status === 200 && (await sizeOf(tee, "Navy", "L")).vendorPrice === 4.4 && (await sizeOf(tee, "Navy", "L")).reorderPoint === 6);
  const copy = (await lib.createBlank(d1, { name: "Core Tee (dup)", productType: "shirt", vendor: "SanMar", sku: "PC54", color: "", colors: [{ color: "Navy", sizes: sizes([["L", 4, 0, 9], ["XL", 4, 0, 2]]) }] })).id;
  await lib.mergeBlanks(d1, { targetId: tee, sourceIds: [copy] });
  ok("merging blanks moves reorder points over — the larger wins, a size only the other had comes too", (await sizeOf(tee, "Navy", "L")).reorderPoint === 9 && (await sizeOf(tee, "Navy", "XL")).reorderPoint === 2);
  await upd([{ color: "Navy", sizes: sizes([["S", 4, 2], ["M", 4, 2], ["L", 4.4, 2, 6], ["XL", 4, 0, ""]]) }]);

  console.log("\n=== Blanks to Order: restock rows, restock on order ===");
  let bto = await lib.getBlanksToOrder(d1);
  let row = bto.suppliers.flatMap(s => s.rows).find(x => x.blankId === tee && x.size === "L");
  ok("a size below its reorder point is listed with no order waiting on it", row && row.needed === 0 && row.reorderPoint === 6 && row.restockOnOrder === 0 && row.onHand === 2);
  ok("…sizes without one aren't", !bto.suppliers.flatMap(s => s.rows).some(x => x.blankId === tee && x.size === "M"));
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { L: 20 }, visible: true, configurable: true, garmentColors: ["Navy"], locations: [] });
  await lib.setBlankLink(d1, "acme", "tee", "Navy", "L", tee, "Navy", "L");
  await lib.insertOrder(d1, { orderId: "O1", orgId: "acme", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date().toISOString() },
    [{ productId: "tee", name: "Tee", type: "shirt", size: "L", qty: 3, unitPrice: 20, config: { garmentColor: "Navy", locations: [] } }]);
  await d1.prepare("UPDATE orders SET paid=1 WHERE orderId='O1'").run();
  r = await call({ action: "recordRestockOrder", vendor: "SanMar", reference: "WEB-1", lines: [{ blankId: tee, color: "Navy", size: "L", qty: 4 }] });
  const rso = r.body.id;
  bto = await lib.getBlanksToOrder(d1);
  row = bto.suppliers.flatMap(s => s.rows).find(x => x.blankId === tee && x.size === "L");
  ok("a restock ordered by hand counts as on order", r.status === 200 && row.needed === 3 && row.restockOnOrder === 4);
  const purchaseAt = new Date(Date.now() + 5000).toISOString();
  d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (?, 'Core Tee', 'Navy', 'L', 4, 440, 'purchase', ?, ?)", [tee, purchaseAt, purchaseAt]);
  bto = await lib.getBlanksToOrder(d1);
  row = bto.suppliers.flatMap(s => s.rows).find(x => x.blankId === tee && x.size === "L");
  ok("…until a purchase of that blank / color / size is recorded after it", row.restockOnOrder === 0);
  r = await call({ action: "getBlanksToOrder" });
  ok("Blanks to Order lists restock orders and each vendor's free shipping (SanMar's default $200), and every vendor on a blank", r.status === 200 && r.body.restockOrders.some(o => o.id === rso && o.reference === "WEB-1" && !o.waiting) &&
    r.body.suppliers.find(s => s.vendor === "SanMar").freeShipping.overCents === 20000 && r.body.vendors.some(v => v.vendor === "SanMar"));
  r = await call({ action: "recordRestockOrder", vendor: "SanMar", lines: [{ blankId: tee, color: "Navy", size: "M", qty: 2 }] });
  const rso2 = r.body.id;
  ok("a second restock order counts…", (await lib.getFreeShippingCandidates(d1, "SanMar")).find(c => c.size === "M").onOrder === 2);
  r = await call({ action: "cancelRestockOrder", id: rso2 });
  ok("…and cancelling it stops it counting", r.status === 200 && (await lib.getFreeShippingCandidates(d1, "SanMar")).find(c => c.size === "M").onOrder === 0);
  r = await call({ action: "recordRestockOrder", vendor: "SanMar", lines: [{ blankId: 0, qty: 2 }] });
  ok("a restock order with no real line is refused", r.status === 400);
  r = await call({ action: "getBlanks" });
  ok("the Blanks screen gets the sizes below their reorder point", r.body.lowStock[`${tee}|Navy|L`] && r.body.lowStock[`${tee}|Navy|L`].keep === 6 && !r.body.lowStock[`${tee}|Navy|M`]);

  console.log("\n=== Usage and free-shipping thresholds ===");
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  for (const [size, qty, at] of [["M", 10, daysAgo(20)], ["S", 3, daysAgo(200)], ["S", 1, daysAgo(400)]]) d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (?, 'Core Tee', 'Navy', ?, ?, 400, 'consume', ?, ?)", [tee, size, -qty, at, at]);
  d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt, voidedAt) VALUES (?, 'Core Tee', 'Navy', 'M', -5, 400, 'consume', ?, ?, ?)", [tee, daysAgo(5), daysAgo(5), daysAgo(4)]);
  const u90 = await lib.getBlankUsage(d1, daysAgo(90)), u365 = await lib.getBlankUsage(d1, daysAgo(365));
  ok("usage counts consume movements in the window, voided ones left out", u90.get(`${tee}\u0001Navy\u0001M`) === 10 && !u90.has(`${tee}\u0001Navy\u0001S`) && u365.get(`${tee}\u0001Navy\u0001S`) === 3);
  const vf = lib.vendorShippingFor;
  // OpenDecoDesk ships only SanMar's and S&S's published thresholds as defaults; any other vendor is set by the shop.
  ok("defaults: SanMar and S&S (either name) $200, others none", vf({}, "SanMar").overCents === 20000 && vf({}, "S&S Activewear").overCents === 20000 && vf({}, "S & S").overCents === 20000 &&
    vf({}, "Otto Cap") === null && vf({}, "Amazon") === null && vf({}, "SanMar").isDefault);
  const amazon = (await lib.createBlank(d1, { name: "Canvas Tote", productType: "bag", vendor: "Amazon", sku: "B0TOTE", color: "", colors: [{ color: "Natural", sizes: sizes([["OS", 5, 0]]) }] })).id;
  r = await call({ action: "setVendorShipping", vendor: "Amazon", over: "25" }, { role: "manager" });
  ok("a manager sets a vendor's free shipping", r.status === 200 && r.body.freeShipping.overCents === 2500 && !r.body.freeShipping.isDefault);
  ok("…a worker can't", (await call({ action: "setVendorShipping", vendor: "Amazon", over: "30" }, { role: "staff" })).status === 403);
  ok("…nonsense is refused", (await call({ action: "setVendorShipping", vendor: "Amazon", over: "-1" })).status === 400);
  r = await call({ action: "setVendorShipping", vendor: "SanMar", over: "", minQty: "" });
  ok("0 / empty on both means no free shipping (not the default)", r.body.freeShipping === null && (await call({ action: "getVendorShipping" })).body.vendors.find(v => v.vendor === "SanMar").freeShipping === null);
  r = await call({ action: "setVendorShipping", vendor: "SanMar", reset: true });
  ok("Use default brings the default back", r.body.freeShipping.overCents === 20000 && r.body.freeShipping.isDefault);
  ok("…and every change is audited", d1.q("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.vendor_shipping'")[0].n >= 3);
  r = await call({ action: "freeShippingSuggestions", vendor: "SanMar" }, { role: "staff" });
  const m = r.body.candidates.find(c => c.blankId === tee && c.size === "M");
  ok("suggestions: only that vendor's blanks, with price, stock, reorder point and use", r.status === 200 && !r.body.candidates.some(c => c.blankId === amazon) && m.used90 === 10 && m.price === 4 && m.onHand === 2 &&
    r.body.candidates.find(c => c.size === "L").reorderPoint === 6 && r.body.candidates.find(c => c.size === "L").needed === 3 && r.body.freeShipping.overCents === 20000);

  console.log("\n=== The admin page ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sentUi = [];
  let copied = "", promptAnswer = null;
  const LOOKUP = { vendor: "SanMar", style: "K540", name: "Silk Touch Polo", brand: "Port Authority", colors: [{ color: "Black" }, { color: "Navy" }], sizes: ["S", "2XL"], prices: { "*": { S: 8.93, "2XL": 9.93 } } };
  let cid = 0;
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#blankorder", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.prompt = () => promptAnswer; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) {
        const b = JSON.parse(init.body); sentUi.push(b);
        // The live style look-up is mocked (its SOAP + pricing is test129's job).
        if (b.action === "fetchVendorProducts") return { ok: true, status: 200, json: async () => ({ status: "ok", products: [{ ...LOOKUP, connectionId: cid }], errors: [] }) };
        const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body };
      }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" };');

  // The pure parts.
  const row0 = { blankId: 1, color: "Navy", size: "L", needed: 3, reserved: 0, onHand: 2, reorderPoint: 6, restockOnOrder: 0, price: 4 };
  const a = w.blanksToOrderRow_(row0, true, true), b2 = w.blanksToOrderRow_(row0, false, true), c0 = w.blanksToOrderRow_(row0, true, false);
  ok("a row's restock tops it back up to its Keep after the order: use stock first → 1 for orders + 6 restock", a.base === 1 && a.restock === 6 && a.toOrder === 7);
  ok("…buying fresh for orders → 3 + 4 restock (the 2 on hand stay)", b2.base === 3 && b2.restock === 4 && b2.toOrder === 7);
  const ed = w.blanksToOrderRow_(row0, true, true, { "1|Navy|L": 2 }), out = w.blanksToOrderRow_(row0, true, true, { "1|Navy|L": 0 });
  ok("the admin's own restock count replaces the suggestion; 0 leaves it out (the order lines stay)", ed.restock === 2 && ed.suggestedRestock === 6 && ed.restockEdited && ed.toOrder === 3 &&
    out.restock === 0 && out.toOrder === 1 && w.blanksToOrderRow_(row0, true, true, { "9|x|y": 1 }).restock === 6);
  const onlyRestock = { ...row0, needed: 0 };
  const tt = w.blanksToOrderTotals_({ suppliers: [{ vendor: "V", rows: [onlyRestock] }] }, true, true, { "1|Navy|L": 0 });
  ok("…a row left with nothing to order is still shown (to add it back) but isn't in the order or the totals", tt.suppliers.length === 1 && tt.suppliers[0].shown.length === 1 && !tt.suppliers[0].rows.length && tt.grandQty === 0);
  ok("…restock off → just the orders; restock already on order counts", c0.toOrder === 1 && w.blanksToOrderRow_({ ...row0, restockOnOrder: 4 }, true, true).restock === 2);
  const fill = w.fillToFreeShipping_;
  const cand = (o) => ({ blankId: 1, color: "Navy", size: "M", price: 4, onHand: 0, reserved: 0, needed: 0, onOrder: 0, reorderPoint: null, used90: 0, used365: 0, ...o });
  let f = fill([], [cand({ size: "L", reorderPoint: 6, onHand: 2 }), cand({ size: "M", used90: 10 }), cand({ size: "S", used90: 1 })], { overCents: 2000 });
  ok("fill: reorder-point shortfalls first, then the best seller, stopping at the dollar amount", f.met && f.cents === 2000 && f.lines[0].size === "L" && f.lines[0].qty === 4 && /reorder point/.test(f.lines[0].reason) &&
    f.lines.find(l => l.size === "M").qty === 1 && !f.lines.some(l => l.size === "S"));
  f = fill([{ blankId: 9, color: "", size: "OS", qty: 20, price: 1 }], [cand({ used90: 3 }), cand({ size: "S", used365: 40 })], { minQty: 25 });
  ok("fill: a piece count counts what's already in the order; last year's use when the last 90 days are empty", f.met && f.pieces === 25 && f.lines.reduce((n, l) => n + l.qty, 0) === 5 && f.lines.some(l => l.size === "S"));
  f = fill([], [cand({}), cand({ size: "S", forTesting: true, used90: 9 })], { overCents: 20000 });
  ok("fill: no history and no reorder points → nothing suggested, said so; blanks for testing aren't suggested", !f.met && !f.lines.length && f.noHistory);
  f = fill([], [cand({ used90: 2 })], { overCents: 100000 });
  ok("fill: stops at about a year's use per size rather than piling on", !f.met && f.lines[0].qty === Math.ceil(2 * 365 / 90));
  ok("progress wording", w.freeShipProgress_({ overCents: 20000 }, 18340, 3).label === "$16.60 to go" && w.freeShipProgress_({ minQty: 25 }, 0, 21).label === "4 pieces to go" &&
    w.freeShipProgress_({ overCents: 20000 }, 20000, 1).met && w.freeShipText_({ overCents: 20000, minQty: 25 }) === "at $200 or at 25 pieces");

  // Blanks to Order.
  const app = d.getElementById("app");
  await w.renderBlanksToOrder(app);
  await wait(() => d.querySelector('.bto-supplier[data-supplier="SanMar"]'));
  const sanmar = () => d.querySelector('.bto-supplier[data-supplier="SanMar"]');
  ok("the SanMar block shows its free shipping, how far off it is, and the button", /Free shipping at \$200 — \$\d+\.\d\d to go/.test(sanmar().textContent) && sanmar().querySelector(".bto-free"));
  ok("…the restock shows on its row, as a count you can change", /restock \(keep 6\)/.test(sanmar().textContent) && Number(sanmar().querySelector(".bto-rs-qty").value) > 0);
  ok("Start an order for… lists every vendor on a blank, with its free shipping", [...d.querySelectorAll("#btoStartVendor option")].some(o => o.value === "Amazon" && /free at \$25/.test(o.textContent)));
  await call({ action: "setVendorShipping", vendor: "SanMar", over: "10" });
  d.getElementById("btoRefresh").click();
  await wait(() => sanmar() && /✓ Free shipping/.test(sanmar().textContent));
  ok("over the amount: ✓ Free shipping and no button", /✓ Free shipping/.test(sanmar().textContent) && !sanmar().querySelector(".bto-free"));
  await call({ action: "setVendorShipping", vendor: "SanMar", reset: true });
  d.getElementById("btoRestock").click();
  await wait(() => !sanmar() || !/restock \(keep/.test(sanmar().textContent));
  ok("Include restock off drops the restock", !sanmar() || !/restock \(keep/.test(sanmar().textContent));
  d.getElementById("btoRestock").click();
  await wait(() => sanmar() && sanmar().querySelector(".bto-rs-qty"));
  const lRow = () => [...sanmar().querySelectorAll("tbody tr")].find(tr => tr.querySelector(".bto-rs-qty, .bto-rs-reset"));
  const toOrderOf = () => Number(lRow().querySelectorAll("td")[7].firstChild.textContent);
  const suggested = Number(lRow().querySelector(".bto-rs-qty").value), before = toOrderOf();
  const qtyIn = lRow().querySelector(".bto-rs-qty"); qtyIn.value = "1"; qtyIn.dispatchEvent(new w.Event("change"));
  await wait(() => toOrderOf() === before - suggested + 1);
  ok("the order screen: a row's restock count can be changed (To order follows, ↺ offered)", toOrderOf() === before - suggested + 1 && lRow().querySelector(".bto-rs-reset"));
  lRow().querySelector(".bto-rs-skip").click();
  await wait(() => /restock left out/.test(lRow().textContent));
  ok("…✕ leaves the restock out of the order (the order lines stay)", /restock left out \(keep 6\)/.test(lRow().textContent) && toOrderOf() === before - suggested);
  lRow().querySelector(".bto-rs-reset").click();
  await wait(() => lRow().querySelector(".bto-rs-qty"));
  ok("…Add back returns to the suggested count", Number(lRow().querySelector(".bto-rs-qty").value) === suggested && toOrderOf() === before);

  // An unconnected vendor (Amazon, $25).
  const modal = () => [...d.querySelectorAll("h3")].find(h => /Get me to free shipping/.test(h.textContent));
  w.showFreeShipping_("Amazon", [], { onDone: () => {} });
  await wait(() => d.getElementById("fsTally"));
  ok("an unconnected vendor with no history: nothing suggested, said so, and no live look-up", /No sales history/.test(d.getElementById("fsNote").textContent) && !d.getElementById("fsLookup") && /Order \$0\.00 of \$25/.test(d.getElementById("fsTally").textContent));
  d.getElementById("fsQ").value = "tote"; d.getElementById("fsQ").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  await wait(() => d.querySelector("#fsFound .fs-add"));
  d.querySelector("#fsFound .fs-add-qty").value = "5"; d.querySelector("#fsFound .fs-add").click();
  ok("+ Add item finds the vendor's blank on file and adds it; the tally reaches free shipping", /Canvas Tote/.test(d.getElementById("fsLines").textContent) && /Free shipping ✓/.test(d.getElementById("fsTally").textContent));
  d.getElementById("fsQ").value = "core tee"; d.getElementById("fsQ").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  await wait(() => /\(SanMar\)/.test(d.getElementById("fsFound").textContent));
  ok("…nothing from this vendor matches → any blank in the system, labelled with its vendor", /\(SanMar\)/.test(d.getElementById("fsFound").textContent));
  d.getElementById("fsCopy").click();
  await wait(() => copied);
  ok("Copy order list: tab-separated style, description, color, size, qty, unit, total", /^Style\tDescription\tColor\tSize\tQty\tUnit\tTotal\nB0TOTE\tCanvas Tote\tNatural\tOS\t5\t5\.00\t25\.00$/.test(copied));
  promptAnswer = "AMZ-1";
  d.getElementById("fsMark").click();
  await wait(() => !modal());
  const rec = d1.q("SELECT * FROM blank_restock_orders WHERE vendor='Amazon'")[0];
  ok("Mark as ordered records the restock (with the vendor's order #) so it isn't suggested again", rec && rec.reference === "AMZ-1" && JSON.parse(rec.linesJson)[0].qty === 5 && JSON.parse(rec.linesJson)[0].blankId === amazon);
  ok("…and it's on order now", (await lib.getFreeShippingCandidates(d1, "Amazon"))[0].onOrder === 5);

  // A connected vendor that takes orders (SanMar): look a style up, it becomes a blank, continue to the order.
  r = await call({ action: "saveVendorConnection", companyCode: "SanMar", name: "SanMar", endpoints: URLS, credentials: { id: "u", password: "p" } });
  cid = r.body.id;
  await call({ action: "linkVendorConnectionBlanks", id: cid, blankIds: [tee] });
  const sup = (await call({ action: "listSupplierOrders" })).body;
  const t = w.blanksToOrderTotals_((await call({ action: "getBlanksToOrder" })).body, true, true);
  const sm = t.suppliers.find(s => s.vendor === "SanMar");
  w.showFreeShipping_("SanMar", sm.rows, { supplier: sup, onDone: () => {} });
  await wait(() => d.getElementById("fsTally"));
  ok("SanMar: the block's lines are the base, suggestions follow (Navy M — the best seller)", /Already in the order/.test(d.getElementById("fsLines").textContent) && /used in the last 90 days/.test(d.getElementById("fsLines").textContent));
  ok("…a connected vendor offers the live look-up and Continue to order", d.getElementById("fsLookup") && d.getElementById("fsOrder").style.display !== "none");
  d.getElementById("fsQ").value = "K540";
  d.getElementById("fsLookup").click();
  await wait(() => d.getElementById("fsLkAdd"));
  d.getElementById("fsLkColor").value = "Navy"; d.getElementById("fsLkSize").value = "S"; d.getElementById("fsLkQty").value = "2";
  d.getElementById("fsLkAdd").click();
  ok("a looked-up style that isn't a blank is added as a New blank at the vendor's price", /New blank/.test(d.getElementById("fsLines").textContent) && /\$8\.93/.test(d.getElementById("fsLines").textContent));
  d.getElementById("fsOrder").click();
  await wait(() => d.getElementById("soLines") && d.getElementById("soPlace") && !d.getElementById("soPlace").disabled);
  const k540 = d1.q("SELECT id, vendorConnectionId FROM blanks WHERE sku='K540'")[0];
  ok("Continue to order makes the blank (linked to the connection) and opens the Order window with every line, checked with the supplier", k540 && k540.vendorConnectionId === cid &&
    /Silk Touch Polo/.test(d.getElementById("soLines").textContent) && sentUi.some(x => x.action === "previewSupplierOrder" && x.lines.some(l => l.blankId === k540.id && l.restockQty === 2)));
  ok("…the Order window shows the free-shipping tally too", /Free shipping at \$200/.test(d.getElementById("soFree").textContent));
  // Place only the looked-up line (the others are fine too, but keep the check simple).
  d.querySelectorAll("#soLines .so-on").forEach(cb => { const tr = cb.closest("tr"); if (!/Silk Touch Polo/.test(tr.textContent)) { cb.checked = false; cb.dispatchEvent(new w.Event("change")); } });
  d.getElementById("soCheck").click();
  await wait(() => !d.getElementById("soPlace").disabled && sentUi.filter(x => x.action === "previewSupplierOrder").length >= 2);
  d.getElementById("soPlace").click();
  await wait(() => d.getElementById("soDone"));
  const so = d1.q("SELECT linesJson, status FROM supplier_orders ORDER BY id DESC LIMIT 1")[0];
  ok("the placed order keeps each line's restock part, so it counts as on its way", so && so.status === "placed" && JSON.parse(so.linesJson)[0].restockQty === 2);
  ok("…and the candidates see it on order", (await lib.getFreeShippingCandidates(d1, "SanMar")).find(c => c.blankId === k540.id && c.color === "Navy" && c.size === "S").onOrder === 2);

  // The Blanks screen.
  w.renderAdminBlanks(app);
  await wait(() => d.querySelector(".blank-size-low"));
  ok("Blanks: a size below its Keep is amber with a tooltip", d.querySelector(".blank-size-low") && /keep 6/.test(d.querySelector(".blank-size-low").textContent) && /Below its reorder point/.test(d.querySelector(".blank-size-low").getAttribute("title")));
  ok("…and there's a Below reorder point filter", [...d.querySelectorAll("#blankGroup option")].some(o => o.value === "low"));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test142 crashed: false"); process.exit(1); });
