const fs = require("fs");
const crypto = require("crypto");
const { createD1 } = require("./testlib/d1-shim.js");

// Complete payments ledger (migrations/0008) — real SQL (sql.js), real db.js,
// real orders.js admin API, real stripe-webhook.js:
//   method + reference on payments, refunds / lost disputes as NEGATIVE rows
//   (idempotent per Stripe refund / dispute id), Stripe fees, Shippo label
//   costs, refund tax reversal, and the Stripe-fee backfill action.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, addOrderPayment, recordShippingLabel,
  getSalesTaxRefunds, getCardPaymentsMissingFees, refreshPaidStatus };`)();
const emailMocks = "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendStripePaymentNotification = async () => true, sendRefundNotification = async () => true, sendDisputeNotification = async () => true;\n";
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  emailMocks + dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const webhook = new Function(strip(read("functions/_lib/http.js")) + "\n" + emailMocks + dbSrc + "\n" +
  strip(read("functions/api/stripe-webhook.js")) + "\nreturn onRequestPost;")();

const WHSEC = "whsec_test";
function signed(event){
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", WHSEC).update(t + "." + body).digest("hex");
  return { text: async () => body, headers: { get: (h) => h === "stripe-signature" ? `t=${t},v1=${sig}` : null } };
}

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES ('cap','prime','cap','Cap','flat',16,'{}','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES
      ('A','prime','Ann','a@x','Card',1,16,16,'2026-07-01T00:00:00Z'), ('B','prime','Bob','b@x','Zelle',1,16,16,'2026-07-02T00:00:00Z'),
      ('C','prime','Cy','c@x','Check',1,16,16,'2026-07-03T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES
      ('A','prime','cap','Cap','cap',1,16,16,''),('B','prime','cap','Cap','cap',1,16,16,''),('C','prime','cap','Cap','cap',1,16,16,'');
    INSERT INTO order_payments (orderId, amount, note, receivedAt) VALUES
      ('A',16,'stripe','2026-07-01T00:00:00Z'), ('B',16,'','2026-07-02T00:00:00Z'), ('C',16,'check','2026-07-03T00:00:00Z');
  `);
  for(const f of fs.readdirSync(__dirname + "/migrations").filter(f => f >= "0006").sort()) d1.execFile(read("migrations/" + f));

  console.log("=== Migration 0008: method backfilled ===");
  const methods = d1.q("SELECT orderId, method, kind, feeCents FROM order_payments ORDER BY orderId");
  console.log("'stripe' note → card; blank note → order's Zelle; 'check' → check:",
    methods.map(m => m.method).join(",") === "card,zelle,check");
  console.log("existing rows are kind=payment with no fee yet:", methods.every(m => m.kind === "payment" && m.feeCents === 0));

  const call = async (body) => {
    const res = await api({ env: { DB: d1, STRIPE_SECRET_KEY: "sk_test" }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("\n=== Recording payments with method + reference ===");
  await lib.insertOrder(d1, { orderId: "N1", orgId: "prime", customerName: "Dee", contact: "d@x", paymentMethod: "Venmo", placedAt: "2026-09-01T00:00:00Z" },
    [{ productId: "cap", name: "Cap", type: "cap", qty: 3, unitPrice: 16 }]);
  let r = await call({ action: "addPayment", orderId: "N1", amount: 20, method: "bitcoin" });
  console.log("unknown method rejected:", r.status === 400);
  r = await call({ action: "addPayment", orderId: "N1", amount: 20, reference: "VNM-123" });
  let o = await lib.getOrderById(d1, "N1");
  const p1 = o.payments[0];
  console.log("method defaults to the order's (Venmo); reference kept:", p1.method === "venmo" && p1.reference === "VNM-123");
  r = await call({ action: "addPayment", orderId: "N1", amount: 20, method: "check", reference: "1042", discountRemainder: true, discountNote: "rounding" });
  o = await lib.getOrderById(d1, "N1");
  console.log("'waive the rest' discounts exactly the $8 still owed (was understated):", o.discountAmount === 8 && o.balanceDue === 0 && o.paid === true);

  console.log("\n=== Refunds outside Stripe ===");
  r = await call({ action: "recordRefund", orderId: "N1", amount: 5, method: "card" });
  console.log("card refund refused here (Stripe records those itself):", r.status === 400);
  r = await call({ action: "recordRefund", orderId: "N1", amount: 999, method: "venmo" });
  console.log("refund larger than the money kept refused:", r.status === 400);
  r = await call({ action: "recordRefund", orderId: "N1", amount: 16, method: "venmo", reference: "VNM-900", note: "Cancelled cap", date: "2026-09-20" });
  o = await lib.getOrderById(d1, "N1");
  const ref = o.payments.find(p => p.kind === "refund");
  console.log("recorded as a NEGATIVE ledger row:", r.status === 200 && !!ref && ref.amount === -16 && ref.method === "venmo" && ref.reference === "VNM-900");
  console.log("received stays $40, refunded $16, net kept $24:", o.amountReceived === 40 && o.refundedAmount === 16 && o.netReceived === 24);
  console.log("a refund doesn't turn a settled order into one with a balance due:", o.paid === true && o.balanceDue === 0);
  console.log("refund is audited:", d1.q("SELECT count(*) n FROM audit_log WHERE action='payment.refunded'")[0].n === 1);

  console.log("\n=== Stripe webhook: fee, refunds, lost dispute ===");
  await lib.insertOrder(d1, { orderId: "S1", orgId: "prime", customerName: "Eve", contact: "e@x", paymentMethod: "Card", placedAt: "2026-09-02T00:00:00Z" },
    [{ productId: "cap", name: "Cap", type: "cap", qty: 2, unitPrice: 16 }]);
  let refundsList = [];
  global.fetch = async (url) => {
    url = String(url);
    if(url.includes("/payment_intents/pi_S1")) return { json: async () => ({ id: "pi_S1", metadata: { orderId: "S1", orgId: "prime" },
      latest_charge: { id: "ch_S1", balance_transaction: { fee: 123 } } }) };
    if(url.includes("/refunds?")) return { json: async () => ({ data: refundsList }) };
    // Old shipping-payment charge: no metadata on the PaymentIntent, only on its session.
    if(url.includes("/payment_intents/pi_SHIP")) return { json: async () => ({ id: "pi_SHIP", metadata: {},
      latest_charge: { id: "ch_SHIP", balance_transaction: { fee: 53 } } }) };
    if(url.includes("/checkout/sessions?limit=1&payment_intent=pi_SHIP")) return { json: async () => ({ data: [{ id: "cs_SHIP", metadata: { type: "shipping_payment", orderId: "S1", orgId: "prime" } }] }) };
    return { json: async () => ({}) };
  };
  const env = { DB: d1, STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test" };
  const paid = { id: "evt_p1", type: "checkout.session.completed", data: { object: { id: "cs_S1", payment_intent: "pi_S1", payment_status: "paid",
    amount_total: 3200, metadata: { orderId: "S1", orgId: "prime" } } } };
  await webhook({ request: signed(paid), env });
  o = await lib.getOrderById(d1, "S1");
  console.log("card payment recorded with Stripe's $1.23 fee:", o.payments.length === 1 && o.payments[0].method === "card" && o.payments[0].fee === 1.23 && o.processorFees === 1.23 && o.paid);

  const refundEvt = (id) => ({ id, type: "charge.refunded", data: { object: { id: "ch_S1", payment_intent: "pi_S1", amount_refunded: 1600, metadata: { orderId: "S1", orgId: "prime" } } } });
  refundsList = [{ id: "re_1", amount: 1600, status: "succeeded", created: 1790000000 }];
  let w = await webhook({ request: signed(refundEvt("evt_r1")), env });
  refundsList = [{ id: "re_1", amount: 1600, status: "succeeded", created: 1790000000 }, { id: "re_2", amount: 800, status: "succeeded", created: 1790100000 }];
  await webhook({ request: signed(refundEvt("evt_r2")), env });
  await webhook({ request: signed(refundEvt("evt_r3")), env }); // replay of the same state
  o = await lib.getOrderById(d1, "S1");
  const sRefunds = o.payments.filter(p => p.kind === "refund");
  console.log("two partial refunds → two negative rows, each once, despite 3 events:", w.status === 200 && sRefunds.length === 2 && sRefunds.map(p => p.amount).sort().join() === "-16,-8");
  console.log("refund rows dated when Stripe refunded:", sRefunds.some(p => p.receivedAt.startsWith("2026-09-22")));
  refundsList = null;
  w = await webhook({ request: signed(refundEvt("evt_r4")), env });
  console.log("Stripe unreachable while listing refunds → 500 so Stripe retries:", w.status === 500);

  const dispute = { id: "evt_d1", type: "charge.dispute.closed", created: 1790000000, data: { object: { id: "dp_1", status: "lost", amount: 800, reason: "fraudulent",
    payment_intent: "pi_S1", metadata: { orderId: "S1", orgId: "prime" }, balance_transactions: [{ fee: 1500 }] } } };
  await webhook({ request: signed(dispute), env });
  await webhook({ request: signed(Object.assign({}, dispute, { id: "evt_d2" })), env });
  o = await lib.getOrderById(d1, "S1");
  const dp = o.payments.filter(p => p.kind === "dispute");
  console.log("lost dispute → one negative row with the $15 dispute fee:", dp.length === 1 && dp[0].amount === -8 && dp[0].fee === 15);
  const won = { id: "evt_d3", type: "charge.dispute.closed", data: { object: { id: "dp_2", status: "won", amount: 800, payment_intent: "pi_S1", metadata: { orderId: "S1", orgId: "prime" } } } };
  await webhook({ request: signed(won), env });
  console.log("won dispute records nothing:", (await lib.getOrderById(d1, "S1")).payments.filter(p => p.kind === "dispute").length === 1);

  console.log("\n=== Shipping payment + refund (charge without order metadata) ===");
  await webhook({ request: signed({ id: "evt_sp", type: "checkout.session.completed", created: 1790000000, data: { object: { id: "cs_SHIP", payment_intent: "pi_SHIP",
    payment_status: "paid", amount_total: 825, metadata: { type: "shipping_payment", orderId: "S1", orgId: "prime" } } } }), env });
  let ship = d1.q("SELECT amountCents, feeCents, externalRef FROM order_payments WHERE externalRef='pi_SHIP'")[0];
  console.log("shipping payment recorded with its Stripe fee, dated when the event happened (resends keep the date):",
    !!ship && ship.amountCents === 825 && ship.feeCents === 53 &&
    d1.q("SELECT receivedAt FROM order_payments WHERE externalRef='pi_SHIP'")[0].receivedAt === new Date(1790000000 * 1000).toISOString());
  const shipPaid = () => d1.q("SELECT shippingPaidCents c FROM orders WHERE orderId='S1'")[0].c;
  const shipBefore = shipPaid();
  refundsList = [{ id: "re_SHIP", amount: 200, status: "succeeded", created: 1790000000 }];
  w = await webhook({ request: signed({ id: "evt_sr", type: "charge.refunded", data: { object: { id: "ch_SHIP", payment_intent: "pi_SHIP", amount_refunded: 200, metadata: {} } } }), env });
  console.log("its refund is traced to the order via the Checkout Session and recorded:",
    w.status === 200 && d1.q("SELECT amountCents FROM order_payments WHERE externalRef='re_SHIP'").map(r => r.amountCents).join() === "-200");
  await webhook({ request: signed({ id: "evt_sr2", type: "charge.refunded", data: { object: { id: "ch_SHIP", payment_intent: "pi_SHIP", amount_refunded: 200, metadata: {} } } }), env });
  console.log("a shipping refund lowers shipping paid by $2, once (replay doesn't lower it again):", shipPaid() === shipBefore - 200);
  d1._raw.exec("DELETE FROM order_payments WHERE externalRef IN ('pi_SHIP','re_SHIP')");

  console.log("\n=== Refund tax reversal (Sales Tax report) ===");
  const rt = await lib.getSalesTaxRefunds(d1, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z");
  const sep = rt.find(x => x.month === "2026-09");
  // $16 (Venmo) + $16 + $8 (Stripe refunds) + $8 (lost dispute) = $48; tax 0.91 + 0.91 + 0.45 + 0.45
  console.log("September: 4 refunds, $48 refunded, $2.72 of tax returned:", !!sep && sep.refunds === 4 && sep.refunded === 48 && sep.taxRefunded === 2.72);
  r = await call({ action: "getSalesTaxReport", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  console.log("report: net tax due = collected − refunded:", r.status === 200 &&
    r.body.totals.netTaxDue === Math.round((r.body.totals.taxCollected - r.body.totals.taxRefunded) * 100) / 100 && r.body.totals.taxRefunded === 2.72);

  console.log("\n=== Shipping label cost ===");
  await lib.recordShippingLabel(d1, { orderId: "S1", shippoTransactionId: "tx_1", carrier: "USPS", service: "Ground Advantage", amount: 5.25, trackingNumber: "9400" });
  await lib.recordShippingLabel(d1, { orderId: "S1", shippoTransactionId: "tx_1", carrier: "USPS", service: "Ground Advantage", amount: 5.25 });
  o = await lib.getOrderById(d1, "S1");
  console.log("label recorded once as a $5.25 postage expense:", o.labels.length === 1 && o.labelCost === 5.25 && o.labels[0].carrier === "USPS");

  console.log("\n=== Backfill Stripe fees on past card payments ===");
  console.log("the pre-existing card payment is missing its fee:", (await lib.getCardPaymentsMissingFees(d1)).map(p => p.orderId).join() === "A");
  // Regression: one order, two Stripe payments (the order, then shipping),
  // neither linked yet. Stripe lists the newer shipping session first.
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt) VALUES ('TWO','prime','T','t@x',4400,4400,'2026-09-01T00:00:00Z');
    INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method) VALUES ('TWO',4400,'Stripe','2026-09-01T00:00:00Z','card'), ('TWO',625,'Stripe','2026-09-05T00:00:00Z','card');
    INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method, externalRef) VALUES ('C',100,'x','2026-09-06T00:00:00Z','card','pi_TAKEN');`);
  global.fetch = async (url) => {
    url = String(url);
    if(url.includes("/checkout/sessions")) return { json: async () => ({ has_more: false, data: [
      { id: "cs_T2", payment_intent: "pi_T_ship", payment_status: "paid", amount_total: 625, metadata: { orderId: "TWO" } },
      { id: "cs_T1", payment_intent: "pi_T_order", payment_status: "paid", amount_total: 4400, metadata: { orderId: "TWO" } },
      { id: "cs_A", payment_intent: "pi_A", payment_status: "paid", amount_total: 1600, metadata: { orderId: "A" } },
      { id: "cs_X", payment_intent: "pi_X", payment_status: "unpaid", metadata: { orderId: "X" } }] }) };
    if(url.includes("/payment_intents/pi_A")) return { json: async () => ({ id: "pi_A", latest_charge: { created: 1785600000, balance_transaction: { fee: 76 } } }) };
    if(url.includes("/payment_intents/pi_T_order")) return { json: async () => ({ latest_charge: { balance_transaction: { fee: 158 } } }) };
    if(url.includes("/payment_intents/pi_T_ship")) return { json: async () => ({ latest_charge: { balance_transaction: { fee: 47 } } }) };
    return { json: async () => ({}) };
  };
  r = await call({ action: "backfillStripeFees" });
  const a = d1.q("SELECT feeCents, externalRef FROM order_payments WHERE orderId='A'")[0];
  console.log("fee $0.76 and PaymentIntent id stored:", r.status === 200 && a.feeCents === 76 && a.externalRef === "pi_A");
  const two = d1.q("SELECT amountCents, feeCents, externalRef FROM order_payments WHERE orderId='TWO' ORDER BY amountCents");
  console.log("two Stripe payments on one order are each matched by amount (no crash on the shared order id):",
    r.body.updated === 3 && two[0].externalRef === "pi_T_ship" && two[0].feeCents === 47 && two[1].externalRef === "pi_T_order" && two[1].feeCents === 158);
  console.log("Stripe-linked payment re-dated to when Stripe charged the card:",
    r.body.redated >= 1 && d1.q("SELECT receivedAt FROM order_payments WHERE externalRef='pi_A'")[0].receivedAt === new Date(1785600000 * 1000).toISOString());
  r = await call({ action: "backfillStripeFees" });
  console.log("running it again changes nothing:", r.body.updated === 0 && r.body.redated === 0);
})().catch(e => { console.log("test35 crashed:", false); console.error(e); process.exit(1); });
