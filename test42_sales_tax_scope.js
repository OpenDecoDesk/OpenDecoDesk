const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Sales-tax scope + use tax (migrations/0013) — real SQL (sql.js),
// real db.js and orders.js:
//   out-of-state shipments carry no home-state tax (recomputed when the address changes),
//   non-taxable products / custom lines, discount tax prorated to taxable goods,
//   refunds' tax reversal follows the same rule, use tax on untaxed purchases,
//   the return summary (state return layout), taxed resale purchases flagged.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, addOrderItem, updateOrderItem, setOrderDiscount, updateOrderShipping,
  addOrderPayment, getSalesTaxRefunds, getSalesTaxReturn, isOutOfState, setSalesTaxSettings };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
      ('polo','prime','shirt','Polo','flat',16,'{}','t','t'), ('sew','prime','custom','Embroider your item','flat',10,'{}','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const polo = (qty = 1) => ({ productId: "polo", name: "Polo", type: "shirt", qty, unitPrice: 16 });

  console.log("=== Migration 0013 ===");
  const cats = d1.q("SELECT name, useTaxable FROM expense_categories WHERE useTaxable = 1 ORDER BY name").map(r => r.name);
  console.log("use-taxable categories are the goods ones (equipment, supplies, office, repairs):",
    JSON.stringify(cats) === JSON.stringify(["Equipment & machines", "Office expense", "Repairs & maintenance", "Supplies (thread, stabilizer, needles)"]));
  console.log("products and existing lines default to taxable:", d1.q("SELECT count(*) n FROM products WHERE taxable = 1")[0].n === 2);
  // The home state is a setting — Ohio here; nothing in the code knows any particular state.
  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH" });
  console.log("state names normalised: 'Ohio'/'oh' in state, 'Indiana'/'IN' out, blank (pickup) in:",
    !lib.isOutOfState("Ohio", "OH") && !lib.isOutOfState("oh", "OH") && !lib.isOutOfState("", "OH") && lib.isOutOfState("Indiana", "OH") && lib.isOutOfState("IN", "OH"));
  console.log("the same rule for any home state (New York, by name):",
    !lib.isOutOfState("NY", "New York") && lib.isOutOfState("OH", "new york") && !lib.isOutOfState("West Virginia", "WV"));
  console.log("no home state configured → nothing counts as out of state:", !lib.isOutOfState("IN", "") && !lib.isOutOfState("IN"));

  console.log("\n=== Out-of-state shipments ===");
  await lib.insertOrder(d1, { orderId: "HM1", orgId: "prime", customerName: "A", contact: "a@x", placedAt: "2026-09-02T00:00:00Z", shippingAddress: { state: "Ohio" } }, [polo()]);
  await lib.insertOrder(d1, { orderId: "IN1", orgId: "prime", customerName: "B", contact: "b@x", placedAt: "2026-09-03T00:00:00Z", shippingAddress: { state: "IN" } }, [polo(2)]);
  await lib.insertOrder(d1, { orderId: "PU1", orgId: "prime", customerName: "C", contact: "c@x", placedAt: "2026-09-04T00:00:00Z" }, [polo()]);
  const home = await lib.getOrderById(d1, "HM1"), out = await lib.getOrderById(d1, "IN1"), pu = await lib.getOrderById(d1, "PU1");
  console.log("Ohio (home state) address → $0.91 tax on $16; pickup (no address) → taxed too:", home.salesTax === 0.91 && pu.salesTax === 0.91);
  console.log("Indiana address → no Ohio tax, full $32 is product, customer still pays $32:", out.salesTax === 0 && out.netSales === 32 && out.total === 32);
  await lib.updateOrderShipping(d1, "PU1", { shippingAddress: { line1: "1 Main", city: "Indianapolis", state: "IN", zip: "46201" }, shippingCost: 5 });
  console.log("adding an Indiana address later removes the tax:", (await lib.getOrderById(d1, "PU1")).salesTax === 0);
  await lib.updateOrderShipping(d1, "PU1", { shippingAddress: { line1: "1 Main", city: "Toledo", state: "OH", zip: "43601" }, shippingCost: 5 });
  console.log("…and changing it back to Ohio restores it:", (await lib.getOrderById(d1, "PU1")).salesTax === 0.91);
  await lib.addOrderItem(d1, "IN1", "prime", polo());
  console.log("an item added to an out-of-state order stays untaxed:", (await lib.getOrderById(d1, "IN1")).salesTax === 0);

  console.log("\n=== Non-taxable products and lines ===");
  let r = await call({ action: "updateProduct", productId: "sew", type: "custom", name: "Embroider your item", pricingMode: "flat", flatPrice: 10, visible: true, taxable: false });
  console.log("product saved as non-taxable (admin API):", r.status === 200 && d1.q("SELECT taxable FROM products WHERE productId='sew'")[0].taxable === 0);
  r = await call({ action: "updateProduct", productId: "sew", type: "custom", name: "Embroider your item (renamed)", pricingMode: "flat", flatPrice: 10, visible: true });
  console.log("an update that doesn't mention taxable leaves it alone:", d1.q("SELECT taxable FROM products WHERE productId='sew'")[0].taxable === 0);
  r = await call({ action: "listProducts" });
  console.log("product list reports taxable:", r.body.products.find(p => p.productId === "sew").taxable === false && r.body.products.find(p => p.productId === "polo").taxable === true);
  await lib.insertOrder(d1, { orderId: "MX1", orgId: "prime", customerName: "D", contact: "d@x", placedAt: "2026-09-05T00:00:00Z" },
    [polo(), { productId: "sew", name: "Embroider your item", type: "custom", qty: 1, unitPrice: 10 }]);
  let mx = await lib.getOrderById(d1, "MX1");
  console.log("mixed order: polo taxed $0.91, service line $0:", mx.items[0].tax === 0.91 && mx.items[1].tax === 0 && mx.salesTax === 0.91);
  await lib.setOrderDiscount(d1, "MX1", 2.6, "promo");
  mx = await lib.getOrderById(d1, "MX1");
  // $2.60 off $26 → $1.60 of it comes off the taxable $16 → its tax is $0.09
  console.log("discount tax prorated to the taxable goods ($2.60 × 16/26 = $1.60 → $0.09):", Math.round(mx.salesTax * 100) === 82);
  r = await call({ action: "createLocalSale", customerName: "Walk-in", placedAt: "2026-09-06", items: [{ productId: "__custom__", name: "Name on customer's jacket", type: "custom", qty: 1, customUnitPrice: 12, taxable: false }] });
  const ls = await lib.getOrderById(d1, r.body.orderId);
  console.log("local-sale custom line marked non-taxable carries no tax:", r.status === 200 && ls.items[0].tax === 0 && ls.salesTax === 0);
  r = await call({ action: "createLocalSale", customerName: "Walk-in 2", placedAt: "2026-09-06", items: [{ productId: "__custom__", name: "Patch", type: "custom", qty: 1, customUnitPrice: 12 }] });
  console.log("…a custom line is taxable by default ($0.68 on $12):", (await lib.getOrderById(d1, r.body.orderId)).salesTax === 0.68);

  console.log("\n=== Refunds' tax reversal ===");
  await lib.addOrderPayment(d1, "IN1", 48, "Venmo", "", { method: "venmo" });
  await lib.addOrderPayment(d1, "IN1", -16, "refund", "", { method: "venmo", kind: "refund", receivedAt: "2026-09-20T00:00:00Z" });
  await lib.addOrderPayment(d1, "MX1", 23.4, "Venmo", "", { method: "venmo" });
  await lib.addOrderPayment(d1, "MX1", -13, "refund", "", { method: "venmo", kind: "refund", receivedAt: "2026-09-21T00:00:00Z" });
  const refunds = await lib.getSalesTaxRefunds(d1, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z");
  // IN1: no tax; MX: $13 × 16/26 = $8 taxable → $0.45
  console.log("refund on an out-of-state order reverses no tax; on a mixed order only the taxable share ($0.45):", refunds[0].taxRefunded === 0.45);

  console.log("\n=== Use tax ===");
  const catId = (n) => d1.q("SELECT id FROM expense_categories WHERE name=?", n)[0].id;
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-09-10", description: "Stabilizer from out-of-state seller", categoryId: catId("Supplies (thread, stabilizer, needles)"), amount: 50, vendorChargedTax: false } });
  console.log("expense saved with 'no sales tax charged' → use tax due:", r.status === 200 && r.body.expense.vendorChargedTax === false && r.body.expense.useTaxDue === true);
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-09-11", description: "Needles (taxed)", categoryId: catId("Supplies (thread, stabilizer, needles)"), amount: 20 } });
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-09-12", description: "Lunch", categoryId: catId("Meals (50%)"), amount: 30, vendorChargedTax: false } });
  r = await call({ action: "saveExpenseCategory", category: { id: catId("Advertising"), name: "Advertising", deductionType: "deductible", scheduleCLine: "8", deductiblePct: 100, useTaxable: true } });
  console.log("category use-tax setting saved:", r.body.categories.find(c => c.name === "Advertising").useTaxable === true);

  console.log("\n=== Return summary (state return layout) ===");
  r = await call({ action: "getSalesTaxReport", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  const m = r.body.taxReturn.months.find(x => x.month === "2026-09"), t = r.body.taxReturn.total;
  // Out of state: IN1's 3 polos ($48). Non-taxable: the $10 service line less its
  // $1.00 share of MX1's $2.60 discount ($9) + the $12 non-taxable custom line.
  console.log("out-of-state sales $48 and non-taxable sales $21 shown as deductions:", m.interstateSales === 48 && m.nonTaxableSales === 21);
  console.log("gross = taxable + exempt + out-of-state + non-taxable:", Math.round(m.grossSales * 100) === Math.round((m.taxableSales + m.exemptSales + m.interstateSales + m.nonTaxableSales) * 100));
  console.log("use tax: 6% of the $50 untaxed stabilizer = $3.00 (taxed needles and meals don't count):", m.useTax === 3 && r.body.taxReturn.useTaxItems.length === 1);
  console.log("total due = collected − refunded + use tax:", Math.round(m.totalDue * 100) === Math.round((m.taxCollected - m.taxRefunded + m.useTax) * 100) &&
    Math.round(r.body.totals.netTaxDue * 100) === Math.round(t.totalDue * 100));
  console.log("tax collected matches the orders' recorded tax (HM1 .91 + PU1 .91 + MX1 .82 + local .68):", t.taxCollected === 3.32);

  console.log("\n=== Blanks bought for resale with tax paid ===");
  d1._raw.exec("INSERT INTO blanks (id, name, brand, color, createdAt, updatedAt) VALUES (1,'Polo blank','ST','Green','t','t'); INSERT INTO blank_sizes (blankId, size, purchasePriceCents, quantity) VALUES (1,'M',400,0)");
  await call({ action: "receiveBlanks", blankId: 1, lines: [{ size: "M", qty: 10, unitCost: 4 }], vendor: "SanMar", vendorRef: "INV-9", vendorChargedTax: true, receivedAt: "2026-09-15" });
  await call({ action: "receiveBlanks", blankId: 1, lines: [{ size: "M", qty: 5, unitCost: 4 }], vendor: "SanMar", vendorRef: "INV-10", receivedAt: "2026-09-16" });
  r = await call({ action: "getInventoryReport", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  console.log("only the taxed purchase is flagged for the resale certificate:", r.body.taxedResale.length === 1 && r.body.taxedResale[0].invoice === "INV-9" && r.body.taxedResale[0].cost === 40);

  console.log("\n=== Accountant export + storefront ===");
  r = await call({ action: "getAccountantExport", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  const stab = r.body.expenses.find(x => x.description.startsWith("Stabilizer"));
  console.log("export: use tax per expense and in the monthly summary:", stab.useTax === 3 && stab.vendorChargedTax === "no" && r.body.summary.find(x => x.month === "2026-09").useTax === 3);
  console.log("storefront still discloses tax-inclusive pricing:", /Prices include/.test(read("public/index.html")));
})().catch(e => { console.log("test42 crashed:", false); console.error(e); process.exit(1); });
