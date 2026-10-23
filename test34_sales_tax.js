const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Sales tax (migrations/0007): tax-INCLUSIVE prices, 6% (the configured rate) backed out
// once per LINE item. $16.00 -> $15.09 product + $0.91 tax. Real SQL (sql.js)
// + the real db.js + the real orders.js admin API — no database mocks.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { splitTaxInclusive, insertOrder, getOrderById, addOrderItem, updateOrderItem,
  cancelLineItem, setOrderDiscount, getSalesTaxSettings, setSalesTaxSettings, setOrgTaxExemption, getSalesTaxReport,
  getAllOrgs, updateOrg, recalcOrderTotals };`)();

async function migratedDb(){
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t'),('rec','rec','REC','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
      ('polo','prime','shirt','Polo','sized',NULL,'{"M":16,"XL":18.5}','t','t'),('cap','prime','cap','Cap','flat',25,'{}','t','t'),
      ('hood','rec','sweatshirt','Hoodie','flat',40,'{}','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, discountAmount, placedAt, shippingAddress) VALUES
      ('OLD1','prime','Ann','a@x','Venmo',1,64,64,0,'2026-08-10T00:00:00Z','{"state":"OH","zip":"43601"}'),
      ('OLD2','prime','Bob','b@x','Card',0,25,25,5,'2026-08-20T00:00:00Z',NULL);
    INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPrice, lineTotal, cancelDate) VALUES
      ('OLD1','prime','polo','Polo','shirt','M',1,16,16,''),('OLD1','prime','polo','Polo','shirt','M',3,16,48,''),
      ('OLD2','prime','cap','Cap','cap','',1,25,25,'');
    INSERT INTO order_payments (orderId, amount, note, receivedAt) VALUES ('OLD1', 64, 'venmo', '2026-08-10T00:00:00Z');
  `);
  const before = d1.q("SELECT sum(CAST(round(total*100) AS INT)) t, sum(CAST(round(lineTotal*100) AS INT)) l FROM orders, order_items WHERE order_items.orderId = orders.orderId")[0];
  // Every migration from 0006 on, so this keeps working as later ones land.
  for(const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return { d1, before };
}

(async () => {
  console.log("=== The rule: back the tax out of each line ===");
  const S = lib.splitTaxInclusive;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  console.log("$16.00 at 6% → $15.09 + $0.91:", eq(S(1600, 600), { netCents: 1509, taxCents: 91 }));
  console.log("3 × $16 line ($48) → $45.28 + $2.72 (one rounding per line, not 3 × $0.91):", eq(S(4800, 600), { netCents: 4528, taxCents: 272 }));
  console.log("$25.00 → $23.58 + $1.42:", eq(S(2500, 600), { netCents: 2358, taxCents: 142 }));
  console.log("0% (exempt) → all product, no tax:", eq(S(1600, 0), { netCents: 1600, taxCents: 0 }));
  console.log("net + tax always equals the price charged (1¢..$1,000):",
    Array.from({ length: 100000 }, (_, i) => i + 1).every(g => { const r = S(g, 600); return r.netCents + r.taxCents === g && r.taxCents >= 0; }));

  console.log("\n=== The SQL backfill and the JS helper agree on every amount ===");
  {
    const d1 = await createD1();
    const rows = d1.q(`WITH RECURSIVE n(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM n WHERE g < 100000)
      SELECT g, g - CAST(round(g * 10000.0 / 10600) AS INTEGER) AS tax FROM n`);
    const bad = rows.filter(r => S(r.g, 600).taxCents !== r.tax);
    console.log("all 100,000 amounts from 1¢ to $1,000 match:", rows.length === 100000 && bad.length === 0);
  }

  console.log("\n=== Migration 0007 backfill ===");
  const { d1, before } = await migratedDb();
  const lines = d1.q("SELECT orderId, lineTotalCents, taxCents, taxRateBps FROM order_items ORDER BY id");
  console.log("every existing line backfilled at 6%:", lines.every(l => l.taxRateBps === 600 && l.taxCents === S(l.lineTotalCents, 600).taxCents));
  console.log("$16 line → $0.91 tax; $48 line → $2.72; $25 line → $1.42:", eq(lines.map(l => l.taxCents), [91, 272, 142]));
  const after = d1.q("SELECT sum(totalCents) t, sum(lineTotalCents) l FROM orders, order_items WHERE order_items.orderId = orders.orderId")[0];
  console.log("totals charged unchanged:", before.t === after.t && before.l === after.l);
  console.log("existing $5 discount's tax backed out ($0.28):", d1.q("SELECT discountTaxCents d FROM orders WHERE orderId='OLD2'")[0].d === 28);
  console.log("existing orders snapshot 6%, not exempt:", d1.q("SELECT count(*) n FROM orders WHERE taxRateBps=600 AND taxExempt=0")[0].n === 2);
  // 0007 seeded a rate; 0051 takes that seed out of a database that was never used and
  // leaves one with history exactly as it was.
  console.log("a database with orders keeps the setting it had:", eq(JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='salesTax'")[0].value), { rateBps: 600, taxShipping: false, jurisdiction: "" }));
  {
    const fresh = await createD1();
    fresh._raw.exec(read("testlib/schema-pre-0006.sql"));
    fresh._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');`);
    for(const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) fresh.execFile(read("migrations/" + f));
    console.log("a NEW database has no sales tax configured: rate 0, no home state:", eq(await lib.getSalesTaxSettings(fresh), { rateBps: 0, taxShipping: false, jurisdiction: "", taxMode: "inclusive" }));
    await lib.insertOrder(fresh, { orderId: "F1", orgId: "prime", customerName: "Fay", contact: "f@x", placedAt: "2026-09-05T00:00:00Z" },
      [{ productId: "x", name: "Polo", type: "shirt", size: "M", qty: 1, unitPrice: 16 }]);
    const f1 = await lib.getOrderById(fresh, "F1");
    console.log("…so an order there carries no tax until the admin sets a rate:", f1.salesTax === 0 && f1.netSales === 16 && f1.total === 16);
    const changed = await createD1();
    changed._raw.exec(read("testlib/schema-pre-0006.sql"));
    for(const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < "0051").sort()) changed.execFile(read("migrations/" + f));
    await lib.setSalesTaxSettings(changed, { rateBps: 725, jurisdiction: "CA" });
    changed.execFile(read("migrations/0051_sales_tax_unset_default.sql"));
    console.log("a setting the admin already saved survives 0051 even with no orders yet:", (await lib.getSalesTaxSettings(changed)).rateBps === 725);
  }
  // This shop's home state is Ohio — a setting, like the rate.
  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH" });
  let o = await lib.getOrderById(d1, "OLD1");
  console.log("order OLD1: $64 = $60.37 net + $3.63 tax; lines expose tax/net:",
    o.salesTax === 3.63 && o.netSales === 60.37 && o.items[1].tax === 2.72 && o.items[1].netAmount === 45.28 && o.items[0].taxRate === 6);

  console.log("\n=== New orders ===");
  await lib.insertOrder(d1, { orderId: "N1", orgId: "prime", customerName: "Cy", contact: "c@x", placedAt: "2026-09-05T00:00:00Z",
    shippingCost: 8.35, shippingAddress: { state: "oh", zip: "43601" } },
    [{ productId: "polo", name: "Polo", type: "shirt", size: "M", qty: 3, unitPrice: 16, personalizationFee: 0 },
     { productId: "polo", name: "Polo", type: "shirt", size: "XL", qty: 1, unitPrice: 18.5, personalizationFee: 5 }]);
  o = await lib.getOrderById(d1, "N1");
  console.log("per-line tax: 3×$16 → $2.72; $23.50 → $1.33:", o.items[0].tax === 2.72 && o.items[1].tax === 1.33);
  console.log("order tax = sum of lines ($4.05); shipping NOT taxed:", o.salesTax === 4.05 && o.total === 79.85 && o.netSales === 67.45);
  console.log("customer is charged exactly the listed prices (tax inside, not added):", o.total === 48 + 23.5 + 8.35);

  await lib.setOrgTaxExemption(d1, "rec", { taxExempt: true, certificate: "EX-12345", expires: "2027-12-31" });
  await lib.insertOrder(d1, { orderId: "E1", orgId: "rec", customerName: "Base", contact: "m@x", placedAt: "2026-09-06T00:00:00Z" },
    [{ productId: "hood", name: "Hoodie", type: "sweatshirt", size: "", qty: 2, unitPrice: 40 }]);
  o = await lib.getOrderById(d1, "E1");
  console.log("tax-exempt org: $0 tax, full $80 is product revenue:", o.taxExempt === true && o.salesTax === 0 && o.netSales === 80 && o.items[0].tax === 0);

  console.log("\n=== Rate snapshot: changing the rate never rewrites history ===");
  await lib.setSalesTaxSettings(d1, { rateBps: 500, jurisdiction: "OH" });
  o = await lib.getOrderById(d1, "N1");
  console.log("existing order still at 6%:", o.taxRate === 6 && o.salesTax === 4.05);
  const addedId = await lib.addOrderItem(d1, "N1", "prime", { productId: "polo", name: "Polo", type: "shirt", size: "M", qty: 1, unitPrice: 16 });
  o = await lib.getOrderById(d1, "N1");
  console.log("an item added to that order later uses ITS 6% ($0.91), not today's 5%:", o.items.find(i => i.id === addedId).tax === 0.91);
  await lib.insertOrder(d1, { orderId: "N2", orgId: "prime", customerName: "Dee", contact: "d@x", placedAt: "2026-09-07T00:00:00Z" },
    [{ productId: "polo", name: "Polo", type: "shirt", size: "M", qty: 1, unitPrice: 16 }]);
  console.log("a new order uses the new 5% ($16 → $0.76):", (await lib.getOrderById(d1, "N2")).items[0].tax === 0.76);
  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH" });
  await lib.addOrderItem(d1, "E1", "rec", { productId: "hood", name: "Hoodie", type: "sweatshirt", qty: 1, unitPrice: 40 });
  console.log("item added to an exempt order stays untaxed:", (await lib.getOrderById(d1, "E1")).salesTax === 0);

  console.log("\n=== Edits, cancellations, discounts ===");
  o = await lib.getOrderById(d1, "N1");
  await lib.updateOrderItem(d1, o.items[0].id, { productId: "polo", name: "Polo", type: "shirt", size: "M", qty: 2, unitPrice: 16 });
  o = await lib.getOrderById(d1, "N1");
  console.log("editing qty 3→2 recomputes that line ($32 → $1.81):", o.items[0].tax === 1.81);
  await lib.cancelLineItem(d1, addedId);
  o = await lib.getOrderById(d1, "N1");
  console.log("cancelled line's tax no longer counted (1.81 + 1.33 = $3.14):", o.salesTax === 3.14);
  await lib.setOrderDiscount(d1, "N1", 10, "loyalty");
  o = await lib.getOrderById(d1, "N1");
  console.log("a $10 discount removes its $0.57 of tax → $2.57:", o.salesTax === 2.57);
  console.log("net sales = goods − discount − tax ($55.50 − $10 − $2.57 = $42.93):", o.netSales === 42.93);
  await lib.setOrderDiscount(d1, "E1", 10, "x");
  console.log("discount on an exempt order has no tax portion:", d1.q("SELECT discountTaxCents d FROM orders WHERE orderId='E1'")[0].d === 0);

  console.log("\n=== Sales-tax report ===");
  const rep = await lib.getSalesTaxReport(d1, "2026-08-01T00:00:00Z", "2026-09-30T23:59:59Z");
  const row = (m, ex, st) => rep.find(r => r.month === m && r.exempt === ex && r.state === st);
  const aug = row("2026-08", false, "OH");
  console.log("Aug, OH: $64 gross, $3.63 tax, $60.37 net:", !!aug && aug.grossSales === 64 && aug.taxCollected === 3.63 && aug.netSales === 60.37);
  const augNoState = row("2026-08", false, "");
  console.log("Aug, no ship-to: $25 − $5 discount = $20 gross, $1.42 − $0.28 = $1.14 tax:", !!augNoState && augNoState.grossSales === 20 && augNoState.taxCollected === 1.14);
  const sepOH = row("2026-09", false, "OH");
  console.log("Sep, OH: tax $2.57, shipping $8.35 reported separately (untaxed):", !!sepOH && sepOH.taxCollected === 2.57 && sepOH.shipping === 8.35);
  const sepEx = row("2026-09", true, "");
  console.log("Sep exempt row: $0 tax, org listed:", !!sepEx && sepEx.taxCollected === 0 && sepEx.orgs.includes("rec"));
  console.log("every row: gross = net + tax:", rep.every(r => Math.round((r.netSales + r.taxCollected) * 100) === Math.round(r.grossSales * 100)));

  console.log("\n=== Admin API (real orders.js on the same database) ===");
  const ordersSrc = strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js"));
  const audits = [];
  Object.assign(global, {
    getCatalogData: async () => ({ subdomainMap: {}, orgs: {} }),
    requireAdmin: undefined,
  });
  const api = new Function(
    strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false,\n" +
    "  sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
    "const invalidateCatalogVersionCache = () => {};\n" +
    dbSrc + "\n" + ordersSrc + "\nreturn onRequestPost;")();
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body),
        headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let r = await call({ action: "updateSalesTaxSettings", ratePercent: 20 });
  console.log("rate above 15% rejected:", r.status === 400);
  r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "oh" });
  console.log("valid rate saved (6% → 600 bps, OH):", r.status === 200 && r.body.salesTax.rateBps === 600 && r.body.salesTax.jurisdiction === "OH");
  r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "Ohio!" });
  console.log("a state that isn't a 2-letter code is rejected:", r.status === 400);
  r = await call({ action: "updateSalesTaxSettings", ratePercent: 0, jurisdiction: "" });
  console.log("rate 0 with no state (not collecting tax) is a valid setting:", r.status === 200 && r.body.salesTax.rateBps === 0 && r.body.salesTax.jurisdiction === "");
  await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "oh" });
  r = await call({ action: "getSalesTaxSettings" });
  console.log("settings read back as percent:", r.body.salesTax.ratePercent === 6);
  r = await call({ action: "updateOrg", orgId: "prime", name: "Example League", subdomain: "prime", taxExempt: true, taxExemptCertificate: "" });
  console.log("exempt without a certificate number rejected:", r.status === 400);
  r = await call({ action: "updateOrg", orgId: "prime", name: "Example League", subdomain: "prime", taxExempt: true, taxExemptCertificate: "CERT-9", taxExemptExpires: "2027-06-30" });
  console.log("exemption with certificate saved:", r.status === 200 && (await lib.getAllOrgs(d1)).find(x => x.orgId === "prime").taxExemptCertificate === "CERT-9");
  r = await call({ action: "updateOrg", orgId: "prime", name: "Example League renamed", subdomain: "prime" });
  const prime = (await lib.getAllOrgs(d1)).find(x => x.orgId === "prime");
  console.log("an org update that doesn't mention tax leaves the exemption alone:", r.status === 200 && prime.name === "Example League renamed" && prime.taxExempt === true);
  r = await call({ action: "getSalesTaxReport", dateFrom: "2026-08-01", dateTo: "2026-09-30" });
  console.log("report API totals: tax = sum of rows, exempt sales listed:",
    r.status === 200 && r.body.totals.taxCollected === Math.round(r.body.rows.reduce((a, x) => a + x.taxCollected * 100, 0)) / 100 &&
    r.body.totals.exemptSales > 0 && r.body.ratePercent === 6);
  // ===================================================================
  // UI: storefront disclosure + admin Sales Tax report (jsdom)
  // ===================================================================
  const { JSDOM, ResourceLoader } = require("jsdom");
  const html = read("public/index.html");
  const adminJs = read("public/admin.js");
  const catalogFor = (rate) => ({ status: "ok", orgId: "prime", catalog: { name: "Example League", eyebrow: "", accent: "#1E7A4C",
    ready: true, desc: "", designImages: {}, shippingEnabled: false, enabledPayments: ["Venmo"],
    products: [{ id: "A", name: "Polo", sub: "", type: "shirt", sizePricing: { L: 16 }, images: [], features: [], stock: null }],
    salesTaxRate: rate, salesTaxJurisdiction: "OH" } });
  async function storefront(rate){
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://league101.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = async () => ({ ok: true, json: async () => catalogFor(rate) }); } });
    const w = dom.window;
    for(let i = 0; i < 200 && !w.document.getElementById("size-A"); i++) await new Promise(r => setTimeout(r, 10));
    w.addToCart("A");
    await new Promise(r => setTimeout(r, 30));
    const note = w.document.querySelector(".ticket-tax-note");
    return note ? note.textContent.trim() : null;
  }
  console.log("\n=== UI: storefront discloses tax-inclusive pricing ===");
  const note = await storefront(6);
  console.log("cart shows 'Prices include 6% OH sales tax.':", note === "Prices include 6% OH sales tax.");
  console.log("tax-exempt shop (rate 0) shows no tax note:", (await storefront(0)) === null);

  console.log("\n=== UI: admin Sales Tax report renders the API's figures ===");
  class Loader extends ResourceLoader {
    fetch(url, options){ return url.includes("/admin.js") ? Promise.resolve(Buffer.from(adminJs, "utf-8")) : super.fetch(url, options); }
  }
  const report = { status: "ok", ratePercent: 6, jurisdiction: "OH", dateFrom: "2026-09-01", dateTo: "2026-09-30",
    rows: [{ month: "2026-09", exempt: false, state: "OH", orders: 2, grossSales: 95, taxCollected: 5.38, netSales: 89.62, shipping: 8.35, orgs: ["prime"] },
           { month: "2026-09", exempt: true, state: "", orders: 1, grossSales: 80, taxCollected: 0, netSales: 80, shipping: 0, orgs: ["rec"] }],
    totals: { orders: 3, grossSales: 175, taxCollected: 5.38, netSales: 169.62, shipping: 8.35, exemptSales: 80, useTax: 0, netTaxDue: 5.38, taxRefunded: 0 },
    taxReturn: { ratePct: 6, jurisdiction: "OH", useTaxItems: [],
      months: [{ month: "2026-09", orders: 3, grossSales: 169.62, taxableSales: 89.62, exemptSales: 80, interstateSales: 0, nonTaxableSales: 0,
        taxCollected: 5.38, taxRefunded: 0, useTaxablePurchases: 0, useTax: 0, totalDue: 5.38, shipping: 8.35 }],
      total: { month: "total", orders: 3, grossSales: 169.62, taxableSales: 89.62, exemptSales: 80, interstateSales: 0, nonTaxableSales: 0,
        taxCollected: 5.38, taxRefunded: 0, useTaxablePurchases: 0, useTax: 0, totalDue: 5.38, shipping: 8.35 } } };
  const adom = new JSDOM(html, { runScripts: "dangerously", resources: new Loader(), url: "https://admin.example.com/x.html", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, opts) => {
      if(String(url).startsWith("/api/catalog")) return { ok: true, json: async () => ({ status: "admin" }) };
      const b = opts && opts.body ? JSON.parse(opts.body) : {};
      if(b.action === "getSalesTaxReport") return { ok: true, json: async () => report };
      return { ok: true, json: async () => ({ status: "ok", orgs: [] }) };
    }; } });
  const aw = adom.window;
  for(let i = 0; i < 1000 && typeof aw.renderSalesTaxReport !== "function"; i++) await new Promise(r => setTimeout(r, 10));
  aw.eval("adminKey = 'cookie'");
  aw.renderSalesTaxReport(aw.document.getElementById("app"));
  for(let i = 0; i < 500 && !aw.document.querySelector("#taxResults table"); i++) await new Promise(r => setTimeout(r, 10));
  const txt = (aw.document.getElementById("taxResults") || {}).textContent || "";
  console.log("summary shows tax collected $5.38 and exempt sales $80.00:", txt.includes("$5.38") && txt.includes("$80.00"));
  console.log("taxable sales (excl. tax, exempt excluded) shown ($89.62):", txt.includes("$89.62"));
  console.log("exempt row names its org; rate disclosed:", txt.includes("Exempt (rec)") && txt.includes("6% OH"));
  console.log("quarter shortcuts rendered (Q1–Q4):", aw.document.querySelectorAll(".taxQuick").length === 6);
})().catch(e => { console.log("test34 crashed:", false); console.error(e); process.exit(1); });
