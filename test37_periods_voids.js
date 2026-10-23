const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Reporting integrity (migrations/0010) — real SQL (sql.js), real db.js, real
// orders.js admin API: voids instead of deletes, explicit test flag, closed
// (filed) months, cash-basis revenue, accountant export.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { getOrderById, getRevenueData, getSalesTaxReport, recordShippingLabel };`)();
const emailMocks = "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n";
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { prime: 'prime' }, orgs: {} });\n" +
  emailMocks + dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES ('cap','prime','cap','Cap','flat',16,'{}','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES
      ('JUL','prime','Ann','a@x','Card',1,16,16,'2026-07-10T00:00:00Z'),
      ('AUG','prime','Bob','b@x','Venmo',1,32,32,'2026-08-05T00:00:00Z'),
      ('DUP','prime','Bob','b@x','Venmo',0,16,16,'2026-08-06T00:00:00Z'),
      ('TEST-1','prime','Admin Test Transaction','t@x','Card',1,5,5,'2026-08-07T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES
      ('JUL','prime','cap','Cap','cap',1,16,16,''), ('AUG','prime','cap','Cap','cap',2,16,32,''),
      ('DUP','prime','cap','Cap','cap',1,16,16,''), ('TEST-1','prime','cap','Test','cap',1,5,5,'');
    INSERT INTO order_payments (orderId, amount, note, receivedAt, externalRef) VALUES
      ('JUL',16,'stripe','2026-07-10T00:00:00Z','pi_jul'),
      ('AUG',32,'venmo','2026-09-02T00:00:00Z',''),
      ('TEST-1',5,'stripe','2026-08-07T00:00:00Z','pi_test');
  `);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec("UPDATE order_payments SET feeCents = 76 WHERE externalRef = 'pi_jul'; UPDATE order_payments SET feeCents = 45 WHERE externalRef = 'pi_test';");

  const call = async (body, url = "https://admin.example.com/api/orders") => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url, json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const audits = (action) => d1.q("SELECT count(*) n FROM audit_log WHERE action = ?", action)[0].n;

  console.log("=== Migration 0010 ===");
  const flags = d1.q("SELECT orderId, isTest, voidedAt FROM orders ORDER BY orderId");
  console.log("TEST- orders flagged isTest, others not:", flags.every(f => f.isTest === (f.orderId.startsWith("TEST-") ? 1 : 0)));
  console.log("nothing voided yet:", flags.every(f => f.voidedAt === null));
  const ins = new Function(dbSrc + "\nreturn insertOrder;")();
  await ins(d1, { orderId: "TEST-NEW", orgId: "prime", customerName: "Admin Test Transaction", contact: "t@x", placedAt: "2026-08-08T00:00:00Z", isTest: true },
    [{ productId: "", name: "Test", type: "cap", qty: 1, unitPrice: 1 }]);
  const r0 = await call({ action: undefined, orderId: "TEST-SNEAKY", orgId: "prime", customerName: "Eve", contact: "e@x.com", paymentMethod: "Venmo",
    items: [{ productId: "cap", qty: 1 }] }, "https://prime.example.com/api/orders");
  console.log("a storefront order can't claim the reserved TEST- prefix:", r0.status === 400 && r0.body.message === "Invalid order ID" && d1.q("SELECT count(*) n FROM orders WHERE orderId='TEST-SNEAKY'")[0].n === 0);
  console.log("a new admin test transaction is flagged isTest on insert:", d1.q("SELECT isTest FROM orders WHERE orderId='TEST-NEW'")[0].isTest === 1);

  console.log("\n=== Voiding a payment entry ===");
  let r = await call({ action: "addPayment", orderId: "DUP", amount: 16, method: "venmo", reference: "V-1" });
  const dupPay = d1.q("SELECT id FROM order_payments WHERE orderId='DUP'")[0].id;
  console.log("payment recorded, order paid:", r.status === 200 && (await lib.getOrderById(d1, "DUP")).paid === true);
  r = await call({ action: "voidPayment", paymentId: dupPay, reason: "Wrong order" });
  let dup = await lib.getOrderById(d1, "DUP");
  console.log("voided entry stays in history, excluded from totals, order unpaid again:",
    r.status === 200 && dup.payments.length === 1 && !!dup.payments[0].voidedAt && dup.payments[0].voidReason === "Wrong order" &&
    dup.amountReceived === 0 && dup.paid === false);
  console.log("audited as payment.voided:", audits("payment.voided") === 1);
  r = await call({ action: "voidPayment", paymentId: dupPay, reason: "again" });
  console.log("voiding twice refused:", r.status === 400);
  const julPay = d1.q("SELECT id FROM order_payments WHERE externalRef='pi_jul'")[0].id;
  r = await call({ action: "deletePayment", paymentId: julPay, reason: "x" });
  console.log("a real Stripe charge can't be voided (refund it in Stripe):", r.status === 400 && /Stripe/.test(r.body.message));

  console.log("\n=== Voiding an order ===");
  r = await call({ action: "voidOrder", orderId: "AUG", reason: "dup" });
  console.log("refused while money is still held on it:", r.status === 400 && /refund/.test(r.body.message));
  r = await call({ action: "deleteOrder", orderId: "DUP", reason: "Duplicate of AUG" });
  dup = await lib.getOrderById(d1, "DUP");
  console.log("legacy deleteOrder now voids: row kept with reason:", r.status === 200 && !!dup && !!dup.voidedAt && dup.voidReason === "Duplicate of AUG");
  console.log("audited as order.voided with a snapshot:", audits("order.voided") === 1);
  const rev = await lib.getRevenueData(d1, "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z");
  const tax = await lib.getSalesTaxReport(d1, "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z");
  const taxGross = tax.reduce((a, x) => a + x.grossSales, 0);
  console.log("voided and test orders excluded from sales-tax gross (JUL $16 + AUG $32):", taxGross === 48);
  console.log("…and from accrual revenue (only JUL and AUG):", rev.map(x => x.orderId).sort().join(",") === "AUG,JUL");

  console.log("\n=== Closed months ===");
  const thisMonth = new Date().toISOString().slice(0, 7);
  r = await call({ action: "closePeriod", month: thisMonth });
  console.log("the current month can't be closed:", r.status === 400);
  r = await call({ action: "closePeriod", month: "2026-13" });
  console.log("malformed month refused:", r.status === 400);
  r = await call({ action: "closePeriod", month: "2026-07" });
  console.log("July closed and listed, audited:", r.status === 200 && r.body.periods.length === 1 && r.body.periods[0].month === "2026-07" && audits("period.closed") === 1);
  r = await call({ action: "setDiscount", orderId: "JUL", amount: 2, note: "late" });
  console.log("discount on a July order refused (409, says how to reopen):", r.status === 409 && /July 2026 is closed/.test(r.body.message));
  r = await call({ action: "updateOrderDate", orderId: "AUG", date: "2026-07-20" });
  console.log("moving an August order INTO July refused:", r.status === 409);
  const julItem = d1.q("SELECT id FROM order_items WHERE orderId='JUL'")[0].id;
  r = await call({ action: "cancelLineItem", sheetRow: julItem, orgId: "prime", org: "prime" });
  console.log("cancelling a July line item refused:", r.status === 409);
  console.log("July order unchanged:", (await lib.getOrderById(d1, "JUL")).discountAmount === 0);
  r = await call({ action: "setDiscount", orderId: "AUG", amount: 1, note: "ok" });
  console.log("August (open) still editable:", r.status === 200);
  r = await call({ action: "reopenPeriod", month: "2026-07" });
  console.log("reopened (audited):", r.status === 200 && r.body.periods.length === 0 && audits("period.reopened") === 1);
  r = await call({ action: "setDiscount", orderId: "JUL", amount: 0, note: "" });
  console.log("July editable again after reopening:", r.status === 200);

  console.log("\n=== Payment dates ===");
  r = await call({ action: "addPayment", orderId: "JUL", amount: 1, method: "cash", date: "2026-07-15" });
  let late = d1.q("SELECT id, receivedAt FROM order_payments WHERE orderId='JUL' AND method='cash'")[0];
  console.log("a payment can be recorded with the date the money arrived:", r.status === 200 && late.receivedAt === "2026-07-15T12:00:00.000Z");
  r = await call({ action: "addPayment", orderId: "JUL", amount: 1, method: "cash", date: "2099-01-01" });
  console.log("future dates refused:", r.status === 400);
  r = await call({ action: "setPaymentDate", paymentId: late.id, date: "2026-07-20" });
  console.log("an entry's date can be corrected (audited):", r.status === 200 &&
    d1.q("SELECT receivedAt FROM order_payments WHERE id=?", late.id)[0].receivedAt === "2026-07-20T12:00:00.000Z" &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='payment.date_changed'")[0].n === 1);
  r = await call({ action: "setPaymentDate", paymentId: julPay, date: "2026-07-01" });
  console.log("a Stripe payment's date can't be hand-edited (it comes from Stripe):", r.status === 400 && /Stripe/.test(r.body.message));
  await call({ action: "closePeriod", month: "2026-06" });
  r = await call({ action: "setPaymentDate", paymentId: late.id, date: "2026-06-30" });
  console.log("moving an entry INTO a closed month is refused:", r.status === 409);
  r = await call({ action: "addPayment", orderId: "JUL", amount: 1, method: "cash", date: "2026-06-10" });
  console.log("recording a payment dated in a closed month is refused:", r.status === 409);
  await call({ action: "reopenPeriod", month: "2026-06" });
  await call({ action: "voidPayment", paymentId: late.id, reason: "test cleanup" });

  console.log("\n=== Cash-basis revenue ===");
  await call({ action: "setDiscount", orderId: "AUG", amount: 0, note: "" });
  r = await call({ action: "getRevenueReport", basis: "cash", dateFrom: "2026-07-01", dateTo: "2026-09-30" });
  const c = r.body;
  console.log("cash basis: $16 card (Jul) + $32 Venmo (received Sep, order Aug) = $48; voided entry excluded:",
    r.status === 200 && c.basis === "cash" && c.total.received === 48 && c.total.fees === 0.76);
  console.log("by method: card $16, venmo $32:", c.methods.find(m => m.method === "card").received === 16 && c.methods.find(m => m.method === "venmo").received === 32);
  console.log("test card charge reported separately for 1099-K reconciliation:", c.testCardCharges === 5 && c.testCardFees === 0.45);
  r = await call({ action: "getRevenueReport", basis: "cash", dateFrom: "2026-08-01", dateTo: "2026-08-31" });
  console.log("August cash = $0 (Bob paid in September):", r.body.total.received === 0);

  console.log("\n=== Accountant export ===");
  await lib.recordShippingLabel(d1, { orderId: "AUG", shippoTransactionId: "tx1", carrier: "USPS", service: "Ground", amount: 5.25, trackingNumber: "9400" });
  r = await call({ action: "getAccountantExport", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  const x = r.body;
  const sum = (k) => Math.round(x.summary.reduce((a, m) => a + m[k] * 100, 0)) / 100;
  console.log("summary: gross $48, tax $2.72 (0.91 + 1.81), test card $5:", r.status === 200 && sum("grossSales") === 48 && sum("taxCollected") === 2.72 && sum("testCardCharges") === 5);
  console.log("summary: card $16 / other $32 receipts, fees $0.76, postage $5.25 (by the month it moved):",
    sum("cardReceipts") === 16 && sum("otherReceipts") === 32 && sum("stripeFees") === 0.76 && sum("postage") === 5.25);
  console.log("sales lines include void/test rows but flag them:",
    x.sales.find(s => s.orderId === "DUP").status === "void" && x.sales.find(s => s.orderId === "TEST-1").status === "test" && x.sales.find(s => s.orderId === "JUL").status === "");
  console.log("ledger keeps the voided entry, flagged:", x.ledger.some(l => l.orderId === "DUP" && l.status === "void"));
  console.log("sales line splits tax (JUL: $16 → $15.09 + $0.91):", (() => { const s = x.sales.find(s => s.orderId === "JUL"); return s.gross === 16 && s.net === 15.09 && s.tax === 0.91; })());
  console.log("export audited:", audits("report.accountant_export") === 1);

  console.log("\n=== Admin export helper: CSV quoting & formula safety ===");
  const adminSrc = read("public/admin.js");
  const grab = (name) => { const i = adminSrc.indexOf("function " + name); let d = 0, j = adminSrc.indexOf("{", i);
    for (let k = j; k < adminSrc.length; k++) { if (adminSrc[k] === "{") d++; else if (adminSrc[k] === "}" && --d === 0) return adminSrc.slice(i, k + 1); } };
  const csvCell_ = new Function(grab("csvSafe") + "\n" + grab("csvCell_") + "\nreturn csvCell_;")();
  console.log("numbers raw, negatives not prefixed:", csvCell_(-16.5) === "-16.5" && csvCell_(0) === "0");
  console.log("formula-looking text neutralised:", csvCell_("=HYPERLINK(1)") === "'=HYPERLINK(1)");
  console.log("commas/quotes quoted:", csvCell_('Smith, "Bo"') === '"Smith, ""Bo"""');
  console.log("null → empty, true → yes:", csvCell_(null) === "" && csvCell_(true) === "yes");
})().catch(e => { console.log("test37 crashed:", false); console.error(e); process.exit(1); });
