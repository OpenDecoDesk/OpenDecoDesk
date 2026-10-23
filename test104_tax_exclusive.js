const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Sales tax ADDED to the listed prices ("exclusive" mode, migrations/0052) next to the original
// tax-included ("inclusive") mode. Real SQL (sql.js), real db.js / orders.js / checkout.js /
// email.js, and the storefront cart in jsdom.
//   * per-line rounding, and parity: a net price in exclusive mode and the matching tax-included
//     price in inclusive mode record the same net and the same tax;
//   * what the customer owes (total, balance, paid, card charge) includes the tax; shipping doesn't;
//   * discounts, other-state shipments, exempt shops and non-taxable products;
//   * a refund's tax reversal; the sales tax report, the return and the accountant export over a
//     month with orders of both kinds; changing the setting only affects new orders.
// The shop's home state here is OH, at a sample rate of 6%.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { splitTaxInclusive, addTaxExclusive, orderAmounts, getSalesTaxSettings, setSalesTaxSettings,
  insertOrder, getOrderById, getOrdersByOrg, addOrderItem, updateOrderItem, setOrderDiscount, updateOrderShipping, addOrderPayment,
  refreshPaidStatus, settleOrderBalance, getOrderCheckoutState, recalcOrderTotals, cancelLineItem, setOrgTaxExemption, createProduct,
  getSalesTaxReport, getSalesTaxReturn, getSalesTaxRefunds, getRevenueData, getAccountantExport, getPublicCatalogData };`)();
const sent = [];
const stripeCalls = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, sent)) return MAIL_OK;
  if (String(url).includes("api.stripe.com")) { stripeCalls.push(Object.fromEntries(new URLSearchParams(init.body))); return { json: async () => ({ url: "https://checkout.stripe.test/s" }) }; }
  throw new Error("unexpected fetch " + url);
};
const ORDERS = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\nconst verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost, signQuote, canonicalItems };")();
const api = ORDERS.post;
const QUOTE_ENV = { SIGNING_SECRET: "s".repeat(40) };
const { orderTokenFor } = require("./testlib/order-token");
const checkout = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  dbSrc + "\n" + strip(read("functions/api/checkout.js")) + "\nreturn onRequestPost;")();
const E = new Function("const recordSystemIssue = async () => {};\n" + strip(read("functions/_lib/email.js")) +
  "\nreturn { sendOrderReceivedEmail, sendPaymentConfirmedEmail };")();
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

let fails = 0;
const ok = (d, c) => { console.log(d + ":", !!c); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('acme','acme','Acme',1,'t','t'), ('gov','gov','County Rec',1,'t','t');`);
  await lib.createProduct(d1, "acme", { productId: "polo", type: "cap", name: "Polo", pricingMode: "flat", flatPrice: 16, visible: true });
  await lib.createProduct(d1, "acme", { productId: "sew", type: "cap", name: "Embroider your item", pricingMode: "flat", flatPrice: 10, visible: true });
  d1._raw.exec(`UPDATE products SET taxable = 0 WHERE productId = 'sew'`);
  await lib.createProduct(d1, "gov", { productId: "hood", type: "cap", name: "Hoodie", pricingMode: "flat", flatPrice: 40, visible: true });
  await lib.setOrgTaxExemption(d1, "gov", { taxExempt: true, certificate: "EX-1", expires: "2030-01-01" });
  d1._raw.exec(`UPDATE orgs SET shippingEnabled = 1 WHERE orgId = 'acme'`);
  const call = async (body, url = "https://admin.example.com/api/orders") => {
    const res = await api({ env: { DB: d1, ...QUOTE_ENV }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url, json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const mode = (m) => lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: m });
  const line = (price, qty = 1, extra = {}) => ({ productId: "", name: "Item", type: "custom", size: "", qty, unitPrice: price, ...extra });
  const place = (orderId, items, extra = {}) => lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-09-10T00:00:00Z", ...extra }, items);
  const get = (id) => lib.getOrderById(d1, id);

  console.log("=== Rounding: tax added per line, the same convention as the tax-included split ===");
  const A = lib.addTaxExclusive, S = lib.splitTaxInclusive;
  ok("$15.09 at 6% → + $0.91 = $16.00", eq(A(1509, 600), { grossCents: 1600, taxCents: 91 }));
  ok("a $45.28 line → + $2.72 = $48.00 (rounded once for the line)", eq(A(4528, 600), { grossCents: 4800, taxCents: 272 }));
  ok("half a cent rounds up: $0.25 at 6% (1.5¢) → 2¢", A(25, 600).taxCents === 2 && A(8, 600).taxCents === 0);
  ok("no rate, a zero or a negative amount → no tax", A(1600, 0).taxCents === 0 && A(0, 600).taxCents === 0 && eq(A(-500, 600), { grossCents: -500, taxCents: 0 }));
  let parity = true;
  for (const bps of [600, 625, 725, 825, 1000, 1500]) for (let n = 1; n <= 100000; n++) {
    const a = A(n, bps), s = S(a.grossCents, bps);
    if (s.netCents !== n || s.taxCents !== a.taxCents) { parity = false; console.log("  mismatch at", n, bps); break; }
  }
  ok("for every net price from 1¢ to $1,000 at six rates: adding the tax, then backing it out of the result, gives the same net and tax", parity);

  console.log("\n=== The setting ===");
  ok("a new database prices tax-included (nothing changes until it's chosen)", (await lib.getSalesTaxSettings(d1)).taxMode === "inclusive");
  let r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "OH", taxMode: "on-top" });
  ok("an unknown mode is refused", r.status === 400 && /inclusive/.test(r.body.message));
  r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "OH", taxMode: "exclusive" });
  ok("the mode is saved through the admin API", r.status === 200 && r.body.salesTax.taxMode === "exclusive" && (await lib.getSalesTaxSettings(d1)).taxMode === "exclusive");
  r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "OH" });
  ok("saving the rate without naming a mode keeps the mode", r.status === 200 && r.body.salesTax.taxMode === "exclusive");
  r = await call({ action: "getSalesTaxSettings" });
  ok("…and it's read back with the rate", r.body.salesTax.taxMode === "exclusive" && r.body.salesTax.ratePercent === 6);
  ok("the audit entry records the change of mode", d1.q("SELECT detail FROM audit_log WHERE action='settings.sales_tax_set' ORDER BY id").some(a => /"taxMode":"inclusive".*"taxMode":"exclusive"/.test(a.detail)));
  ok("the storefront catalog carries the mode", (await lib.getPublicCatalogData(d1)).globalSettings.salesTax.taxMode === "exclusive");

  console.log("\n=== The same NET price in each mode records the same net and the same tax ===");
  await mode("inclusive");
  await place("INC", [line(16), line(48)]);                 // listed with the tax inside
  await mode("exclusive");
  await place("EXC", [line(15.09), line(45.28)]);            // the same goods listed before tax
  let inc = await get("INC"), exc = await get("EXC");
  ok("each order remembers its own mode", inc.taxMode === "inclusive" && exc.taxMode === "exclusive");
  ok("same tax per line ($0.91, $2.72)", eq(inc.items.map(i => i.tax), [0.91, 2.72]) && eq(exc.items.map(i => i.tax), [0.91, 2.72]));
  ok("same net per line ($15.09, $45.28)", eq(inc.items.map(i => i.netAmount), [15.09, 45.28]) && eq(exc.items.map(i => i.netAmount), [15.09, 45.28]));
  ok("same order tax ($3.63), net sales ($60.37) and amount owed ($64.00)", inc.salesTax === 3.63 && exc.salesTax === 3.63 && inc.netSales === 60.37 && exc.netSales === 60.37 && inc.effectiveTotal === 64 && exc.effectiveTotal === 64);
  ok("the listed subtotal differs: $64.00 with tax inside, $60.37 before tax", inc.itemsSubtotal === 64 && exc.itemsSubtotal === 60.37);
  ok("the stored order total includes the tax either way", inc.total === 64 && exc.total === 64);
  await place("QTY", [line(15.09, 3)]);
  ok("a 3 × $15.09 line is taxed once on $45.27 ($2.72), not 3 × $0.91", (await get("QTY")).salesTax === 2.72 && (await get("QTY")).effectiveTotal === 47.99);

  console.log("\n=== What the customer owes: shipping is not taxed ===");
  await place("SHIP", [line(100)], { shippingCost: 8.35, shippingAddress: { line1: "1 Main", city: "Toledo", state: "OH", zip: "43601" } });
  let o = await get("SHIP");
  ok("$100 + $6.00 tax + $8.35 shipping = $114.35", o.salesTax === 6 && o.effectiveTotal === 114.35 && o.balanceDue === 114.35 && o.total === 114.35);
  await lib.addOrderPayment(d1, "SHIP", 108.35, "Venmo", "", { method: "venmo" });
  o = await get("SHIP");
  ok("paying the pre-tax amount leaves the tax owing, and the order unpaid", o.paid === false && o.balanceDue === 6);
  ok("Mark as paid records exactly the rest ($6.00)", (await lib.settleOrderBalance(d1, "SHIP", "Marked paid")) === 6 && (await get("SHIP")).paid === true && (await get("SHIP")).balanceDue === 0);

  console.log("\n=== Discounts reduce the tax ===");
  await place("DISC", [line(100)]);
  await lib.setOrderDiscount(d1, "DISC", 10, "loyalty");
  o = await get("DISC");
  ok("$100 − $10 → tax on $90 = $5.40; owes $95.40; net sales $90", o.salesTax === 5.4 && o.effectiveTotal === 95.4 && o.netSales === 90);
  await mode("inclusive");
  await place("DISCI", [line(106)]);
  await lib.setOrderDiscount(d1, "DISCI", 10.6, "loyalty");
  const oi = await get("DISCI");
  ok("…the same sale priced tax-included ($106 − $10.60) records the same tax, net and amount owed", oi.salesTax === 5.4 && oi.netSales === 90 && oi.effectiveTotal === 95.4);
  await mode("exclusive");
  await place("MIX", [line(60), line(40, 1, { taxable: false })]);
  await lib.setOrderDiscount(d1, "MIX", 10, "x");
  o = await get("MIX");
  ok("a discount's tax is prorated to the taxable goods ($10 × 60/100 → $0.36 off $3.60): owes $93.24", o.salesTax === 3.24 && o.effectiveTotal === 93.24 && o.netSales === 90);
  await lib.setOrderDiscount(d1, "MIX", 0, "");
  ok("removing the discount puts the tax back ($3.60; owes $103.60)", (await get("MIX")).salesTax === 3.6 && (await get("MIX")).effectiveTotal === 103.6);

  console.log("\n=== No tax: another state, a tax-exempt shop, a non-taxable product — in either mode ===");
  for (const m of ["inclusive", "exclusive"]) {
    await mode(m);
    await place("OUT-" + m, [line(50)], { shippingCost: 5, shippingAddress: { line1: "1 Main", city: "Indianapolis", state: "IN", zip: "46201" } });
    await lib.insertOrder(d1, { orderId: "EX-" + m, orgId: "gov", customerName: "Rec", contact: "r@x.com", placedAt: "2026-09-11T00:00:00Z" }, [{ productId: "hood", name: "Hoodie", type: "cap", size: "", qty: 2, unitPrice: 40 }]);
    await place("NT-" + m, [{ productId: "sew", name: "Embroider your item", type: "cap", size: "", qty: 1, unitPrice: 10 }]);
    const out = await get("OUT-" + m), ex = await get("EX-" + m), nt = await get("NT-" + m);
    ok(m + ": shipped to Indiana → $0 tax, owes the listed $50 + $5 shipping", out.salesTax === 0 && out.effectiveTotal === 55 && out.netSales === 50 && out.taxMode === m);
    ok(m + ": tax-exempt shop → $0 tax, owes the listed $80", ex.taxExempt === true && ex.salesTax === 0 && ex.effectiveTotal === 80 && ex.netSales === 80);
    ok(m + ": non-taxable product → $0 tax, owes the listed $10", nt.salesTax === 0 && nt.effectiveTotal === 10);
  }
  await mode("exclusive");
  await lib.updateOrderShipping(d1, "OUT-exclusive", { shippingAddress: { line1: "1 Main", city: "Toledo", state: "OH", zip: "43601" }, shippingCost: 5 });
  o = await get("OUT-exclusive");
  ok("changing the address to the home state adds the tax ($3.00): owes $58.00, and the stored total follows", o.salesTax === 3 && o.effectiveTotal === 58 && o.total === 58);
  await lib.updateOrderShipping(d1, "OUT-exclusive", { shippingAddress: { line1: "1 Main", city: "Indianapolis", state: "IN", zip: "46201" }, shippingCost: 5 });
  ok("…and back out of state takes it off again", (await get("OUT-exclusive")).effectiveTotal === 55 && (await get("OUT-exclusive")).total === 55);

  console.log("\n=== Edits ===");
  await place("EDIT", [line(20)]);
  const addId = await lib.addOrderItem(d1, "EDIT", "acme", line(30));
  let t = await lib.recalcOrderTotals(d1, "EDIT");
  ok("adding a $30 line: tax $3.00 on $50, stored total $53.00", t.total === 53 && t.subtotal === 50 && (await get("EDIT")).effectiveTotal === 53);
  await lib.updateOrderItem(d1, addId, { ...line(40) });
  t = await lib.recalcOrderTotals(d1, "EDIT");
  ok("changing it to $40: total $63.60 (the price difference an edit bills includes its tax)", t.total === 63.6);
  await lib.cancelLineItem(d1, addId);
  ok("cancelling the line: owes $21.20 again", (await get("EDIT")).effectiveTotal === 21.2 && (await get("EDIT")).salesTax === 1.2);

  console.log("\n=== Changing the setting affects only new orders ===");
  await mode("inclusive");
  o = await get("EXC");
  ok("an order placed with tax on top still owes its tax on top", o.taxMode === "exclusive" && o.effectiveTotal === 64 && o.salesTax === 3.63);
  await lib.addOrderItem(d1, "EXC", "acme", line(10));
  ok("an item added to it later is taxed ITS way ($10 + $0.60)", (await get("EXC")).effectiveTotal === 74.6);
  await place("NEWI", [line(10)]);
  ok("a new order now has the tax inside its price ($10 owes $10, $0.57 of it tax)", (await get("NEWI")).taxMode === "inclusive" && (await get("NEWI")).effectiveTotal === 10 && (await get("NEWI")).salesTax === 0.57);
  await mode("exclusive");
  await lib.addOrderItem(d1, "INC", "acme", line(16));
  ok("…and the other way round: an old tax-included order stays tax-included ($64 + $16 = $80)", (await get("INC")).effectiveTotal === 80 && (await get("INC")).salesTax === 4.54);

  console.log("\n=== Card checkout charges the tax ===");
  const pay = async (orderId) => {
    stripeCalls.length = 0;
    const res = await checkout({ env: { DB: d1, STRIPE_SECRET_KEY: "sk_test_x" },
      request: { url: "https://acme.example.com/api/checkout", json: async () => ({ orderId, orgId: "acme", checkoutToken: await orderTokenFor({ STRIPE_SECRET_KEY: "sk_test_x" }, orderId) }), headers: { get: () => null } } });
    return { status: res.status, sent: stripeCalls[0] };
  };
  let c = await pay("DISC");
  ok("the Checkout Session is for $95.40 — goods less discount, plus tax", c.status === 200 && c.sent["line_items[0][price_data][unit_amount]"] === "9540");
  ok("…and says how much of it is sales tax", /includes \$5\.40 sales tax/.test(c.sent["line_items[0][price_data][product_data][description]"]));
  c = await pay("DISCI");
  ok("a tax-included order is charged its listed price ($95.40), with no tax wording added", c.sent["line_items[0][price_data][unit_amount]"] === "9540" && !/sales tax/.test(c.sent["line_items[0][price_data][product_data][description]"]));
  const due = await lib.getOrderCheckoutState(d1, "DISC");
  ok("the webhook's amount check uses the same balance ($95.40)", due.total === 95.4 && due.taxAdded === 5.4);
  await lib.addOrderPayment(d1, "DISC", 95.4, "Stripe", "pi_1", { method: "card" });
  ok("recording that charge marks the order paid; nothing left to charge", (await get("DISC")).paid === true && (await lib.getOrderCheckoutState(d1, "DISC")).total === 0);
  c = await pay("OUT-exclusive");
  ok("an out-of-state order is charged without tax ($55.00)", c.sent["line_items[0][price_data][unit_amount]"] === "5500");

  console.log("\n=== A storefront order through the real API ===");
  const shop = (orderId, extra = {}, items = [{ productId: "polo", qty: 2 }]) => call({ orderId, orgId: "acme", customerName: "Bea", contact: "bea@example.com", paymentMethod: "Venmo", items, ...extra }, "https://acme.example.com/api/orders");
  r = await shop("WEB-1");
  o = await get("WEB-1");
  ok("pickup: 2 × $16 + $1.92 tax = $33.92, and the response tells the storefront so", r.status === 200 && r.body.taxMode === "exclusive" && r.body.total === 33.92 && r.body.salesTax === 1.92 && o.effectiveTotal === 33.92);
  // Shipped by carrier: the address comes with the signed quote for its ZIP ($5.00 here).
  const inQuote = await ORDERS.signQuote(QUOTE_ENV, { orgId: "acme", zip: "46201", items: ORDERS.canonicalItems([{ productId: "polo", qty: 2 }]), amountCents: 500, method: "USPS Ground" });
  r = await shop("WEB-2", { shippingQuoteToken: inQuote, shippingAddress: { name: "Bea", line1: "1 Main", city: "Indianapolis", state: "IN", zip: "46201" } });
  ok("shipped to another state: no tax, total $32.00 + $5.00 shipping", r.status === 200 && r.body.total === 37 && r.body.salesTax === 0 && (await get("WEB-2")).effectiveTotal === 37);
  r = await shop("WEB-2P", { shippingAddress: { name: "Bea", line1: "1 Main", city: "Indianapolis", state: "IN", zip: "46201" } });
  ok("a pickup order sent with that same address is still taxed ($33.92): pickup has no ship-to address", r.status === 200 && r.body.total === 33.92 && r.body.salesTax === 1.92 && !(await get("WEB-2P")).shippingAddress);
  r = await shop("WEB-3", {}, [{ productId: "polo", qty: 1 }, { productId: "sew", qty: 1 }]);
  ok("a non-taxable product in the cart isn't taxed: $16 + $0.96 + $10 = $26.96", r.body.total === 26.96 && r.body.salesTax === 0.96);
  await mode("inclusive");
  r = await shop("WEB-4");
  ok("with tax-included prices the response is the plain one it always was (plus the card-checkout token)", r.status === 200 && eq(Object.assign({}, r.body, { checkoutToken: undefined }), { status: "ok", checkoutToken: undefined }) && (await get("WEB-4")).effectiveTotal === 32);
  r = await call({ action: "createTestTransaction", org: "acme", amount: 5 });
  await mode("exclusive");
  r = await call({ action: "createTestTransaction", org: "acme", amount: 5 });
  const tests = d1.q("SELECT orderId FROM orders WHERE isTest = 1 ORDER BY insertedAt, orderId");
  ok("an admin test transaction charges exactly the amount typed in either mode", tests.length >= 1 && (await Promise.all(tests.map(x => get(x.orderId)))).every(x => x.effectiveTotal === 5));
  r = await call({ action: "createLocalSale", org: "acme", customerName: "Walk-in", paymentMethod: "Cash", paid: true, items: [{ productId: "polo", name: "Polo", type: "cap", size: "", qty: 1 }] });
  o = r.body.orderId ? await get(r.body.orderId) : null;
  ok("a local sale marked paid records the price plus tax ($16.96) as received", r.status === 200 && !!o && o.effectiveTotal === 16.96 && o.amountReceived === 16.96 && o.paid === true);

  console.log("\n=== Receipts show the tax as its own row ===");
  const env = { ...MAIL_ENV };
  await E.sendOrderReceivedEmail(env, { orderId: "R-1", customerName: "Ann", contact: "a@x.com", paymentMethod: "Card",
    items: [{ name: "Polo", size: "L", qty: 2, lineTotal: 32 }], subtotal: 32, shippingCost: 8.25, shippingMethod: "USPS Ground Advantage",
    total: 42.17, effectiveTotal: 42.17, salesTax: 1.92, taxRate: 6, taxMode: "exclusive" });
  let m = sent.pop(), h = plain(m.htmlBody || m.html || "");
  ok("Subtotal, Shipping, Sales tax (6%), then the Total they add up to", /Subtotal \$32\.00 Shipping \(USPS Ground Advantage\) \$8\.25 Sales tax \(6%\) \$1\.92 Total \$42\.17/.test(h));
  ok("…and no \"includes sales tax\" note (it isn't inside the prices)", !/Includes sales tax/i.test(h) && !/includes \$/.test(m.body || m.text || ""));
  ok("plain text too", /Subtotal: \$32\.00\nShipping \(USPS Ground Advantage\): \$8\.25\nSales tax \(6%\): \$1\.92\nTotal: \$42\.17/.test(m.body || m.text || ""));
  await E.sendPaymentConfirmedEmail(env, await get("MIX"), "2026-09-22T00:00:00Z");
  h = plain(sent.pop().htmlBody);
  ok("a saved order's receipt adds up from the order itself ($100.00 + $3.60 = $103.60)", /Subtotal \$100\.00 Sales tax \(6%\) \$3\.60 Total \$103\.60/.test(h));
  await E.sendPaymentConfirmedEmail(env, await get("DISCI"), "2026-09-22T00:00:00Z");
  h = plain(sent.pop().htmlBody);
  ok("a tax-included order's receipt is unchanged: the note under the total", /Total \$95\.40 Includes sales tax \(6%\) \$5\.40/.test(h) && !/Sales tax \(6%\) \$5\.40 Total/.test(h));
  await E.sendPaymentConfirmedEmail(env, await get("EX-exclusive"), "2026-09-22T00:00:00Z");
  h = plain(sent.pop().htmlBody);
  ok("a tax-exempt order says so and adds nothing", /Total \$80\.00 Tax-exempt order/.test(h) && !/Sales tax \(/.test(h));

  console.log("\n=== A refund's tax reversal ===");
  const fresh = async () => {
    const db = await createD1();
    db._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) db.execFile(read("migrations/" + f));
    db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('acme','acme','Acme',1,'t','t'), ('gov','gov','County Rec',1,'t','t');`);
    await lib.setOrgTaxExemption(db, "gov", { taxExempt: true, certificate: "EX-1", expires: "2030-01-01" });
    return db;
  };
  const taxBack = async (db) => (await lib.getSalesTaxRefunds(db, "2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z")).reduce((a, x) => a + Math.round(x.taxRefunded * 100), 0) / 100;
  const refundCase = async (m, items, paid, refund, extra = {}, shipping = 0) => {
    const db = await fresh();
    await lib.setSalesTaxSettings(db, { rateBps: 600, jurisdiction: "OH", taxMode: m });
    await lib.insertOrder(db, { orderId: "RF", orgId: extra.orgId || "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-09-10T00:00:00Z", ...extra }, items);
    await lib.addOrderPayment(db, "RF", paid, "Venmo", "", { method: "venmo" });
    await lib.addOrderPayment(db, "RF", -refund, "refund", "", { method: "venmo", kind: "refund", receivedAt: "2026-10-05T00:00:00Z" });
    if (shipping) db._raw.exec(`UPDATE order_payments SET shippingCents = ${Math.round(shipping * 100)} WHERE kind = 'refund'`);
    return taxBack(db);
  };
  ok("tax on top: refunding half of a $106.00 order ($53.00) reverses half its $6.00 tax", (await refundCase("exclusive", [line(100)], 106, 53)) === 3);
  ok("…exactly what the same sale priced tax-included reverses", (await refundCase("inclusive", [line(106)], 106, 53)) === 3);
  ok("a full refund reverses all of it ($6.00)", (await refundCase("exclusive", [line(100)], 106, 106)) === 6);
  ok("taxable + non-taxable ($60 + $40, paid $103.60): half back ($51.80) reverses half the $3.60 tax", (await refundCase("exclusive", [line(60), line(40, 1, { taxable: false })], 103.6, 51.8)) === 1.8);
  ok("the shipping part of a refund carries no tax ($58 back, $5 of it shipping → tax on $53)", (await refundCase("exclusive", [line(100)], 111, 58, { shippingCost: 5 }, 5)) === 3);
  ok("an out-of-state order's refund reverses nothing", (await refundCase("exclusive", [line(100)], 100, 50, { shippingAddress: { state: "IN", zip: "46201" } })) === 0);
  ok("a tax-exempt order's refund reverses nothing", (await refundCase("exclusive", [line(100)], 100, 50, { orgId: "gov" })) === 0);

  console.log("\n=== Reports over a month with orders of both kinds ===");
  const rdb = await fresh();
  await lib.setSalesTaxSettings(rdb, { rateBps: 600, jurisdiction: "OH", taxMode: "inclusive" });
  const rplace = (orderId, items, extra = {}) => lib.insertOrder(rdb, { orderId, orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-09-10T00:00:00Z", ...extra }, items);
  await rplace("I1", [line(106)], { shippingCost: 4 });                         // $100 net + $6 tax, inside the price
  await lib.setSalesTaxSettings(rdb, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });
  await rplace("X1", [line(100)], { shippingCost: 4 });                         // $100 net + $6 tax, on top
  await rplace("X2", [line(50), line(20, 1, { taxable: false })]);              // $50 taxable (+$3), $20 not
  await lib.setOrderDiscount(rdb, "X2", 7, "x");                               // $5 off the taxable part → tax $2.70
  await rplace("X3", [line(30)], { shippingAddress: { state: "IN", zip: "46201" } });   // out of state
  await lib.insertOrder(rdb, { orderId: "X4", orgId: "gov", customerName: "Rec", contact: "r@x.com", placedAt: "2026-09-12T00:00:00Z" }, [line(80)]);   // exempt
  const rep = await lib.getSalesTaxReport(rdb, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z");
  const row = (ex, st) => rep.find(x => x.month === "2026-09" && x.exempt === ex && x.state === st) || {};
  const home = row(false, "");
  ok("home-state row: gross $277.70 = what customers paid for goods (106 + 106 + 65.70), tax $14.70, net $263.00", home.orders === 3 && home.grossSales === 277.7 && home.taxCollected === 14.7 && home.netSales === 263);
  ok("…shipping reported apart ($8.00), untaxed", home.shipping === 8);
  ok("out-of-state row: $30 gross = net, no tax", row(false, "IN").grossSales === 30 && row(false, "IN").netSales === 30 && row(false, "IN").taxCollected === 0);
  ok("exempt row: $80 gross = net, no tax", row(true, "").grossSales === 80 && row(true, "").netSales === 80 && row(true, "").taxCollected === 0);
  ok("every row: gross = net + tax", rep.every(x => Math.round((x.netSales + x.taxCollected) * 100) === Math.round(x.grossSales * 100)));
  const ret = (await lib.getSalesTaxReturn(rdb, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z")).total;
  ok("return: taxable sales excl. tax $245 (100 + 100 + 45), non-taxable $18, out of state $30, exempt $80 → gross $373", ret.taxableSales === 245 && ret.nonTaxableSales === 18 && ret.interstateSales === 30 && ret.exemptSales === 80 && ret.grossSales === 373);
  ok("return: tax collected $14.70 = 6% of the taxable sales, and the same figure as the report", ret.taxCollected === 14.7 && Math.round(ret.taxableSales * 6) / 100 === 14.7 && ret.totalDue === 14.7);
  const rev = await lib.getRevenueData(rdb, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z");
  const revOf = (id) => rev.find(x => x.orderId === id) || {};
  ok("revenue report: each order comes to what its customer owes (I1 $110, X1 $110, X2 $65.70, X3 $30, X4 $80)", revOf("I1").effectiveTotal === 110 && revOf("X1").effectiveTotal === 110 && revOf("X2").effectiveTotal === 65.7 && revOf("X3").effectiveTotal === 30 && revOf("X4").effectiveTotal === 80);
  const revApi = await (async () => { const res = await api({ env: { DB: rdb }, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders", json: async () => ({ key: "x", action: "getRevenueReport", dateFrom: "2026-09-01", dateTo: "2026-09-30" }), headers: { get: () => null } } }); return JSON.parse(await res.text()); })();
  ok("…and the report's total is their sum ($395.70)", revApi.status === "ok" && Math.round(revApi.total.effectiveTotal * 100) === 39570 && Math.round(revApi.total.balance * 100) === 39570);
  const exp = await lib.getAccountantExport(rdb, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z");
  const sale = (id) => exp.sales.filter(x => x.orderId === id);
  ok("accountant export: the two $100-net sales read the same — gross $106, tax $6, net $100 — each flagged with its mode",
    eq(sale("I1").map(x => [x.gross, x.tax, x.net, x.taxMode]), [[106, 6, 100, "inclusive"]]) && eq(sale("X1").map(x => [x.gross, x.tax, x.net, x.taxMode]), [[106, 6, 100, "exclusive"]]));
  const sum = exp.summary.find(x => x.month === "2026-09");
  ok("…and the month's summary: gross $387.70, tax $14.70, net $373.00 (the return's gross sales), shipping $8.00", sum.grossSales === 387.7 && sum.taxCollected === 14.7 && sum.netSales === 373 && sum.netSales === ret.grossSales && sum.shippingIncome === 8);
  const taxApi = await (async () => { const res = await api({ env: { DB: rdb }, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders", json: async () => ({ key: "x", action: "getSalesTaxReport", dateFrom: "2026-09-01", dateTo: "2026-09-30" }), headers: { get: () => null } } }); return JSON.parse(await res.text()); })();
  ok("the Sales Tax report API says which mode is current, and its totals match", taxApi.taxMode === "exclusive" && taxApi.totals.taxCollected === 14.7 && taxApi.totals.netTaxDue === 14.7);

  console.log("\n=== A database from before the tax mode column still works (everything is tax-included) ===");
  const old = await createD1();
  old._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < "0052").sort()) old.execFile(read("migrations/" + f));
  old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('acme','acme','Acme',1,'t','t');`);
  await lib.setSalesTaxSettings(old, { rateBps: 600, jurisdiction: "OH" });
  await lib.insertOrder(old, { orderId: "OLD", orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-09-10T00:00:00Z" }, [line(16)]);
  await lib.setOrderDiscount(old, "OLD", 1, "x");
  o = await lib.getOrderById(old, "OLD");
  ok("order, discount, balance and the reports all run", o.taxMode === "inclusive" && o.effectiveTotal === 15 && (await lib.getOrderCheckoutState(old, "OLD")).total === 15 &&
    (await lib.getSalesTaxReport(old, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z"))[0].grossSales === 15 && (await lib.getSalesTaxReturn(old, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z")).total.taxCollected === 0.85);

  console.log("\n=== Storefront cart (jsdom) ===");
  const { JSDOM } = require("jsdom");
  const html = read("public/index.html");
  const catalogFor = (over) => ({ status: "ok", orgId: "acme", catalog: Object.assign({ name: "Acme", eyebrow: "", accent: "#1E7A4C",
    ready: true, desc: "", designImages: {}, shippingEnabled: false, enabledPayments: ["Venmo"],
    products: [{ id: "A", name: "Polo", sub: "", type: "shirt", sizePricing: { L: 16 }, images: [], features: [], stock: null },
               { id: "B", name: "Sew-on", sub: "", type: "shirt", sizePricing: { L: 10 }, images: [], features: [], stock: null, taxable: false }],
    salesTaxRate: 6, salesTaxJurisdiction: "OH", salesTaxMode: "exclusive" }, over) });
  async function storefront(over, add = ["A"]) {
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://acme.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win) { win.fetch = async () => ({ ok: true, json: async () => catalogFor(over) }); } });
    const w = dom.window;
    for (let i = 0; i < 200 && !w.document.getElementById("size-A"); i++) await new Promise(r => setTimeout(r, 10));
    for (const id of add) w.addToCart(id);
    await new Promise(r => setTimeout(r, 30));
    const text = (sel) => { const e = w.document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; };
    return { w, taxLine: text(".ticket-tax-line"), total: text(".ticket-total .t-amount"), note: text(".ticket-tax-note") };
  }
  let s = await storefront({});
  ok("tax on top: the cart shows a Sales tax (6%) row of $0.96 and a total of $16.96", s.taxLine === "Sales tax (6%)$0.96" && s.total === "$16.96");
  ok("…and says the tax is added, naming the rate and state", s.note === "6% OH sales tax is added to the listed prices.");
  ok("the cart's figure is the server's for the same line (16.00 → 0.96)", lib.addTaxExclusive(1600, 600).taxCents === 96);
  s = await storefront({}, ["A", "B"]);
  ok("a non-taxable product adds no tax: $16 + $10 + $0.96 = $26.96", s.taxLine === "Sales tax (6%)$0.96" && s.total === "$26.96");
  s.w.eval(`shippingZip = "46201"; shippingManual = true; shippingManualPicked = true; currentOrg.shippingEnabled = true; currentOrg.deliveryOptions = [{id:"shipping",type:"shipping",label:"Shipping",fee:null}]; renderTicket(currentOrg, route.org);`);
  const t2 = (sel) => { const e = s.w.document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; };
  ok("shipping to another state's ZIP: no tax row, total $26.00, and the cart says why", t2(".ticket-tax-line") === null && t2(".ticket-total .t-amount") === "$26.00" && /No OH sales tax on orders shipped to another state/.test(t2(".ticket-tax-note")));
  s.w.eval(`shippingZip = "43601"; renderTicket(currentOrg, route.org);`);
  ok("…a home-state ZIP is taxed", t2(".ticket-tax-line") === "Sales tax (6%)$0.96" && t2(".ticket-total .t-amount") === "$26.96");
  s = await storefront({ salesTaxRate: 0 });
  ok("a tax-exempt shop (rate 0): no tax row, no note, total $16.00", s.taxLine === null && s.note === null && s.total === "$16.00");
  s = await storefront({ salesTaxMode: "inclusive" });
  ok("tax-included prices: no tax row, total $16.00, the original disclosure", s.taxLine === null && s.total === "$16.00" && s.note === "Prices include 6% OH sales tax.");

  console.log("\n=== Admin ===");
  const adminJs = read("public/admin.js");
  ok("Global settings has the mode selector, explains both, and saves it", /id="gTaxMode"/.test(adminJs) && /Prices include sales tax<\/option>/.test(adminJs) && /Sales tax is added at checkout<\/option>/.test(adminJs) && /taxMode: \(document\.getElementById\("gTaxMode"\)/.test(adminJs));
  const orderActiveTotal_ = new Function(/function orderActiveTotal_\(o\)\{[\s\S]*?\n\}/.exec(adminJs)[0] + "\nreturn orderActiveTotal_;")();
  ok("the orders list's active total includes tax on top, from the order as loaded", orderActiveTotal_(await get("MIX")) === 103.6 && orderActiveTotal_(await get("DISCI")) === 106 && orderActiveTotal_(await get("SHIP")) === 114.35);

  if (fails) console.log("test104 failures:", fails === 0);
})().catch(e => { console.log("test104 crashed:", false); console.error(e); process.exit(1); });
