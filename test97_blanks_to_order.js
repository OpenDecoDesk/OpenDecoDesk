const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Inventory → Blanks to Order: what to buy from each supplier for the open orders — each line resolved
// to its blank / color / size, added up, priced, totalled per supplier — and what's left off it and why.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { getBlanksToOrder, createBlank, createProduct, setBlankLink, insertOrder, receiveBlanks };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1), ('club','club','Club','t','t',1);`);
  const sz = (list) => list.map(([size, purchasePrice]) => ({ size, purchasePrice, quantity: 0 }));
  // SanMar: a polo in two colors; a cap (one size). S&S: a hoodie. One blank with no vendor.
  const polo = (await lib.createBlank(d1, { name: "Micropique Polo", productType: "shirt", vendor: "SanMar", brand: "Sport-Tek", sku: "ST650", color: "",
    colors: [{ color: "Navy", sizes: sz([["M", 11.50], ["L", 11.50], ["2XL", 12.50]]) }, { color: "Black", sizes: sz([["M", 11.50], ["L", 11.50]]) }] })).id;
  const cap = (await lib.createBlank(d1, { name: "Mesh Cap", productType: "cap", vendor: "SanMar", brand: "Sport-Tek", sku: "STC71", color: "", colors: [{ color: "", sizes: sz([["OSFA", 5.5]]) }] })).id;
  const hood = (await lib.createBlank(d1, { name: "Heavy Hoodie", productType: "sweatshirt", vendor: "S&S Activewear", brand: "Gildan", sku: "18500", color: "", colors: [{ color: "Black", sizes: sz([["L", 12.76], ["XL", 0]]) }] })).id;
  const noVendor = (await lib.createBlank(d1, { name: "Mystery Tee", productType: "shirt", vendor: "", brand: "", sku: "", color: "", colors: [{ color: "", sizes: sz([["M", 4]]) }] })).id;
  const prod = (org, productId, extra) => lib.createProduct(d1, org, Object.assign({ productId, type: "shirt", name: productId, pricingMode: "sized", sizePricing: { M: 20, L: 20, XL: 20, "2XL": 22 }, visible: true }, extra));
  await prod("league", "polo", { configurable: true, garmentColors: ["Navy", "Black"], locations: [] });
  await prod("league", "cap", { type: "cap", pricingMode: "flat", flatPrice: 16, sizePricing: {} });
  await prod("league", "hoodie", { type: "sweatshirt" });
  await prod("league", "tee");
  await prod("league", "unlinked");
  await prod("club", "polo", { configurable: true, garmentColors: ["Navy"], locations: [] });
  for (const [color, size] of [["Navy", "M"], ["Navy", "L"], ["Navy", "2XL"], ["Black", "M"], ["Black", "L"]]) await lib.setBlankLink(d1, "league", "polo", color, size, polo, color, size);
  await lib.setBlankLink(d1, "club", "polo", "Navy", "M", polo, "Navy", "M");
  await lib.setBlankLink(d1, "league", "cap", "", "OSFA", cap, "", "OSFA");
  await lib.setBlankLink(d1, "league", "hoodie", "", "L", hood, "Black", "L");
  await lib.setBlankLink(d1, "league", "hoodie", "", "XL", hood, "Black", "XL");
  await lib.setBlankLink(d1, "league", "tee", "", "M", noVendor, "", "M");

  let n = 0;
  const order = async (org, items, { paid = true } = {}) => {
    const orderId = "O" + (++n);
    await lib.insertOrder(d1, { orderId, orgId: org, customerName: "Cust " + n, contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date(Date.now() + n * 1000).toISOString() },
      items.map(([productId, size, qty, color]) => Object.assign({ productId, name: productId, type: "shirt", size, qty, unitPrice: 20 }, color ? { config: { garmentColor: color, locations: [] } } : {})));
    if (paid) await d1.prepare("UPDATE orders SET paid=1 WHERE orderId=?").bind(orderId).run();
    return orderId;
  };
  const sql = (q, ...b) => d1.prepare(q).bind(...b).run();

  const o1 = await order("league", [["polo", "M", 3, "Navy"], ["polo", "L", 2, "Black"], ["cap", "OSFA", 4]]);
  const o2 = await order("club", [["polo", "M", 5, "Navy"]]);                       // another shop, same blank/color/size
  const o3 = await order("league", [["hoodie", "L", 2], ["hoodie", "XL", 1], ["tee", "M", 6]]);
  const o4 = await order("league", [["polo", "2XL", 7, "Navy"]], { paid: false });    // unpaid
  const o5 = await order("league", [["polo", "M", 9, "Navy"]]);                        // blanks already ordered
  await sql("UPDATE order_items SET blankOrderedAt='2026-10-01T00:00:00Z' WHERE orderId=?", o5);
  const o6 = await order("league", [["polo", "L", 4, "Black"]]);                       // blanks received (spoken for)
  await sql("UPDATE order_items SET blankOrderedAt='2026-10-01T00:00:00Z', blankReceivedAt='2026-10-03T00:00:00Z' WHERE orderId=?", o6);
  const o7 = await order("league", [["unlinked", "M", 2], ["polo", "XL", 1, "Navy"]]); // no link for either
  await lib.insertOrder(d1, { orderId: "LOCAL1", orgId: "league", customerName: "Local", contact: "l@x.com", paymentMethod: "Cash", placedAt: new Date().toISOString() },
    [{ productId: "", name: "Custom patch", type: "other", size: "", qty: 3, unitPrice: 5 }]);
  await sql("UPDATE orders SET paid=1 WHERE orderId='LOCAL1'");
  // Not on the list at all: voided, test, completed, fully made, a cancelled line, a partly-made line.
  const oV = await order("league", [["cap", "OSFA", 50]]); await sql("UPDATE orders SET voidedAt='2026-10-01T00:00:00Z', voidReason='x' WHERE orderId=?", oV);
  const oT = await order("league", [["cap", "OSFA", 50]]); await sql("UPDATE orders SET isTest=1 WHERE orderId=?", oT);
  const oC = await order("league", [["cap", "OSFA", 50]]); await sql("UPDATE orders SET completedAt='2026-10-01T00:00:00Z' WHERE orderId=?", oC);
  const oM = await order("league", [["cap", "OSFA", 50]]); await sql("UPDATE orders SET manufacturedAt='2026-10-01T00:00:00Z' WHERE orderId=?", oM);
  const oX = await order("league", [["cap", "OSFA", 50], ["cap", "OSFA", 5]]);
  await sql("UPDATE order_items SET cancelDate='2026-10-01' WHERE orderId=? AND qty=50", oX);
  await sql("UPDATE order_items SET manufacturedQty=2 WHERE orderId=? AND qty=5", oX);   // 3 left to make

  console.log("=== The list ===");
  let rep = await lib.getBlanksToOrder(d1);
  const sup = (v) => rep.suppliers.find(s => s.vendor === v);
  const row = (v, sku, color, size) => (sup(v) || { rows: [] }).rows.find(r => r.sku === sku && r.color === color && r.size === size);
  ok("grouped by supplier, alphabetical, blanks with no vendor last", rep.suppliers.map(s => s.vendor).join("|") === "S&S Activewear|SanMar|");
  ok("the same blank/color/size from two shops is one line (3 + 5 = 8 Navy M)", row("SanMar", "ST650", "Navy", "M").needed === 8 && row("SanMar", "ST650", "Navy", "M").orders.join() === [o1, o2].join());
  ok("each row carries blank, brand, SKU, color, size and the blank's price", (() => { const r = row("SanMar", "ST650", "Navy", "M"); return r.blank === "Micropique Polo" && r.brand === "Sport-Tek" && r.price === 11.50 && r.onHand === 0; })());
  ok("a configurable line uses its chosen garment color (Black L = 2)", row("SanMar", "ST650", "Black", "L").needed === 2);
  ok("a one-size product is on the list (4 caps + 3 left of a partly-made line)", row("SanMar", "STC71", "", "OSFA").needed === 7);
  ok("a plain product's line resolves through its link to the blank's color", row("S&S Activewear", "18500", "Black", "L").needed === 2 && row("S&S Activewear", "18500", "Black", "XL").needed === 1);
  ok("blanks already ordered aren't listed, and are counted (9 pieces)", rep.onOrderPieces === 9 && row("SanMar", "ST650", "Navy", "M").needed === 8);
  ok("blanks already received are held back as reserved, not needed", row("SanMar", "ST650", "Black", "L").reserved === 4);
  ok("unpaid orders are left out by default and counted", !row("SanMar", "ST650", "Navy", "2XL") && rep.unpaidPieces === 7 && rep.unpaidOrders === 1);
  ok("voided, test, completed and made orders and cancelled lines add nothing", row("SanMar", "STC71", "", "OSFA").needed === 7);
  ok("lines with no blank link are listed separately with the reason, not dropped", rep.unlinked.length === 3 &&
    rep.unlinked.filter(u => u.reason === "notLinked").map(u => u.name + ":" + u.size + ":" + u.qty).sort().join("|") === "polo:XL:1|unlinked:M:2" &&
    rep.unlinked.find(u => u.reason === "custom").qty === 3);
  rep = await lib.getBlanksToOrder(d1, { includeUnpaid: true });
  ok("with unpaid orders included they're on the list", row("SanMar", "ST650", "Navy", "2XL").needed === 7 && rep.unpaidPieces === 0);

  console.log("\n=== Stock on hand ===");
  await lib.receiveBlanks(d1, { blankId: polo, vendor: "SanMar", lines: [{ color: "Black", size: "L", qty: 5, unitCost: 11.50 }, { color: "Navy", size: "M", qty: 3, unitCost: 11.50 }] });
  rep = await lib.getBlanksToOrder(d1);
  ok("on-hand stock is reported per size", row("SanMar", "ST650", "Black", "L").onHand === 5 && row("SanMar", "ST650", "Navy", "M").onHand === 3);

  console.log("\n=== The admin API ===");
  const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}), request: { url: "https://admin.example.com/api/orders", json: async () => ({ key: "x", action: "getBlanksToOrder" }), headers: { get: () => null } } });
  const body = JSON.parse(await res.text());
  ok("getBlanksToOrder returns the report", res.status === 200 && body.suppliers.length === 3 && body.includeUnpaid === false);

  // ---- The screen ----
  console.log("\n=== The screen ===");
  const html = read("public/index.html"), adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b);
        const r = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}), request: { url: "https://admin.example.com/api/orders", json: async () => b, headers: { get: () => null } } });
        const text = await r.text(); return { ok: r.status < 400, status: r.status, json: async () => JSON.parse(text) }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(r => setTimeout(r, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie";`);
  ok("it's in the Inventory menu", /\["blankorder", "Blanks to order"\]/.test(adminJs) && /raw === "blankorder"/.test(adminJs));
  // The arithmetic, on its own.
  const R = (needed, onHand, reserved, price) => w.blanksToOrderRow_({ needed, onHand, reserved, price }, true);
  ok("to order = needed − free stock, never below zero", R(8, 3, 0, 11.50).toOrder === 5 && R(2, 5, 4, 11.50).toOrder === 1 && R(2, 9, 0, 1).toOrder === 0 && R(2, 1, 4, 1).toOrder === 2);
  ok("cost = to order × price, to the cent", R(8, 3, 0, 11.50).cost === 57.5 && R(3, 0, 0, 0.335).cost === 1.01);
  ok("with 'use stock' off, everything needed is ordered", w.blanksToOrderRow_({ needed: 8, onHand: 3, reserved: 0, price: 2 }, false).toOrder === 8);

  await w.renderBlanksToOrder(d.getElementById("app"));
  const sups = () => [...d.querySelectorAll(".bto-supplier")];
  const cells = (tr) => [...tr.querySelectorAll("td")].map(td => td.textContent.replace(/\s+/g, " ").trim());
  const rowsOf = (v) => [...sups().find(s => s.dataset.supplier === v).querySelectorAll("tbody tr")].map(cells);
  const totalOf = (v) => sups().find(s => s.dataset.supplier === v).querySelector(".bto-supplier-total").textContent.trim();
  ok("one table per supplier", sups().map(s => s.dataset.supplier).join("|") === "S&S Activewear|SanMar|");
  ok("columns: Blank, Brand, SKU, Color, Size, Needed, On hand, To order, Price, Cost", [...sups()[1].querySelectorAll("thead th")].map(t => t.textContent).join("|") === "Blank|Brand|SKU|Color|Size|Needed|On hand|To order|Price|Cost");
  const sm = rowsOf("SanMar");
  ok("SanMar's lines in blank / color / size order", sm.map(r => r[2] + " " + r[3] + " " + r[4]).join("|") === "STC71 — OSFA|ST650 Black L|ST650 Navy M");
  ok("Navy M: 8 needed, 3 on hand → order 5 at $11.50 = $57.50", sm[2].slice(5).join("|") === "8|3|5|$11.50|$57.50");
  ok("Black L: 2 needed, 5 on hand but 4 spoken for → 1 free → order 1", sm[1].slice(5).join("|") === "2|1 of 5|1|$11.50|$11.50");
  ok("a total cost per supplier", totalOf("SanMar") === "$107.50" && totalOf("S&S Activewear") === "$25.52" && totalOf("") === "$24.00");
  ok("a size with no price is flagged and the supplier's total says it's low", /no price/.test(rowsOf("S&S Activewear").map(r => r.join(" ")).join(" ")) && /no price on the blank, so this total is low/.test(sups()[0].textContent));
  ok("blanks with no vendor are grouped under 'No supplier set' with how to fix it", /No supplier set/.test(sups()[2].textContent) && /set it on the blank/.test(sups()[2].textContent));
  ok("a grand total across suppliers", d.getElementById("btoGrand").textContent.replace(/\s+/g, " ").includes("3 suppliers · 22 pieces") && /Total \$157\.02/.test(d.getElementById("btoGrand").textContent));
  ok("what's left off is explained (unpaid, already on order)", /7 pieces on 1 unpaid order are left out/.test(d.getElementById("btoBody").textContent) && /9 pieces are already on a supplier order/.test(d.getElementById("btoBody").textContent));
  ok("unlinked lines are listed with why", /3 order lines aren't on this list/.test(d.getElementById("btoUnlinked").textContent) && /custom line with no product/.test(d.getElementById("btoUnlinked").textContent));

  d.getElementById("btoStock").checked = false; d.getElementById("btoStock").dispatchEvent(new w.Event("change"));
  ok("unticking 'Use stock on hand first' orders everything needed and drops the stock columns", rowsOf("SanMar")[2].slice(5).join("|") === "8|$11.50|$92.00" && totalOf("SanMar") === "$153.50" &&
    [...sups()[1].querySelectorAll("thead th")].length === 8);
  d.getElementById("btoStock").checked = true; d.getElementById("btoStock").dispatchEvent(new w.Event("change"));
  d.getElementById("btoUnpaid").checked = true; d.getElementById("btoUnpaid").dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 100 && !sent.some(b => b.action === "getBlanksToOrder" && b.includeUnpaid === true); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 60));
  ok("ticking 'Include unpaid orders' reloads with them (7 Navy 2XL at $12.50)", rowsOf("SanMar").some(r => r[4] === "2XL" && r.slice(5).join("|") === "7|0|7|$12.50|$87.50") && totalOf("SanMar") === "$195.00");

  // Copy list.
  let copied = "";
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
  sups()[0].querySelector(".bto-copy").click();
  await new Promise(r => setTimeout(r, 30));
  const lines = copied.split("\n");
  ok("Copy list gives a tab-separated list with a header and the supplier's total", lines[0] === "Blank\tBrand\tSKU\tColor\tSize\tQty\tPrice\tCost" && lines[1] === "Heavy Hoodie\tGildan\t18500\tBlack\tL\t2\t12.76\t25.52" && lines[lines.length - 1] === "Total\t\t\t\t\t3\t\t25.52");

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
