const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Refunding shipping (migrations/0035): a refund — or part of one — can be SHIPPING. Shipping isn't
// taxed, so the Sales Tax report backs no tax out of that part (getSalesTaxRefunds). Set when
// recording a refund ("of which shipping"), or afterwards on any refund — including a card refund
// made in Stripe, which arrives through the webhook as all goods (setRefundShipping). Real SQL
// (sql.js), real db.js and orders.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, addOrderPayment, getSalesTaxRefunds, createProduct };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  try {
    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
    // Sales tax is unset on a new database; this shop collects 6% in the state its orders ship to.
    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":"OH"}')`);
    const call = async (body) => {
      const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
        request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');`);
    await lib.createProduct(d1, "prime", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 16, visible: true });
    const now = new Date().toISOString(), month = now.slice(0, 7);
    // An in-state taxable order: $16 tee (incl. 6% tax) + $8 shipping, paid by card.
    const mk = async (id) => {
      await lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "C", contact: "c@x.com", placedAt: now, shippingCost: 8,
        shippingAddress: { name: "C", line1: "1 Main", city: "Springfield", state: "OH", zip: "45503" } },
        [{ productId: "tee", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: 16 }]);
      d1._raw.run("UPDATE orders SET shippingCostCents=800 WHERE orderId=?", [id]);
      await lib.addOrderPayment(d1, id, 24, "Stripe", "pi_" + id, { method: "card" });
    };
    await mk("S1"); await mk("S2"); await mk("S3");
    const taxBack = async () => { const r = await lib.getSalesTaxRefunds(d1, month + "-01", month + "-31T23:59:59Z"); return r.length ? r[0].taxRefunded : 0; };

    console.log("=== A card refund made in Stripe arrives as all goods ===");
    const stripeRefund = await lib.addOrderPayment(d1, "S1", -2, "Stripe refund", "re_S1", { method: "card", kind: "refund", receivedAt: now });
    console.log("a $2 refund backs $0.11 of tax out (as if it were goods) until it's marked:", await taxBack() === 0.11);
    console.log("the payments list shows it as all goods:", (await lib.getOrderById(d1, "S1")).payments.find(p => p.id === stripeRefund).shipping === 0);

    console.log("\n=== Marking it as shipping ===");
    let r = await call({ action: "setRefundShipping", orderId: "S1", paymentId: stripeRefund, shippingAmount: 2 });
    console.log("set the shipping part on the Stripe refund:", r.status === 200 && r.body.payments.find(p => p.id === stripeRefund).shipping === 2);
    console.log("now no tax comes back on it (shipping isn't taxed):", await taxBack() === 0);
    console.log("audited first, with from → to:", d1.q("SELECT detail FROM audit_log WHERE action='payment.refund_shipping_set'").map(x => JSON.parse(x.detail))
      .some(x => x.paymentId === stripeRefund && x.shippingFrom === 0 && x.shippingTo === 2));
    r = await call({ action: "setRefundShipping", orderId: "S1", paymentId: stripeRefund, shippingAmount: 2.5 });
    console.log("more than the refund is refused:", r.status === 400 && /can't be more than the \$2\.00 refund/.test(r.body.message));
    r = await call({ action: "setRefundShipping", orderId: "S1", paymentId: (await lib.getOrderById(d1, "S1")).payments.find(p => p.kind === "payment").id, shippingAmount: 1 });
    console.log("a payment (not a refund) can't have a shipping part:", r.status === 400 && /Only a refund/.test(r.body.message));

    console.log("\n=== Recording a refund that's partly shipping ===");
    r = await call({ action: "recordRefund", orderId: "S2", amount: 10, shippingAmount: 4, method: "venmo", note: "Shipping overcharge + goods" });
    const s2 = (await lib.getOrderById(d1, "S2")).payments.find(p => p.kind === "refund");
    console.log("the refund keeps its shipping part:", r.status === 200 && s2.amount === -10 && s2.shipping === 4);
    // $6 of goods on a $16 order whose goods are all taxable at 6%: tax = 6.00 − round(600 × 10000/10600) = $0.34.
    console.log("tax comes back only on the $6 of goods ($0.34):", await taxBack() === 0.34);
    r = await call({ action: "recordRefund", orderId: "S3", amount: 3, shippingAmount: 5, method: "venmo" });
    console.log("a shipping part bigger than the refund is refused:", r.status === 400 && /can't be more than the refund/.test(r.body.message));
    r = await call({ action: "recordRefund", orderId: "S3", amount: 3, method: "venmo" });
    console.log("a refund with no shipping part is all goods, as before:", r.status === 200 && (await lib.getOrderById(d1, "S3")).payments.find(p => p.kind === "refund").shipping === 0);

    console.log("\n=== Closed months ===");
    const old = await lib.addOrderPayment(d1, "S3", -1, "old refund", "re_old", { method: "card", kind: "refund", receivedAt: "2026-01-15T00:00:00Z" });
    d1._raw.run("INSERT INTO closed_periods (month, closedAt) VALUES ('2026-01', 't')");
    r = await call({ action: "setRefundShipping", orderId: "S3", paymentId: old, shippingAmount: 1 });
    console.log("a refund in a closed month can't be changed:", r.status === 409);

    console.log("\n=== Revenue report: received is net of refunds ===");
    // A worked case: $44 of goods, shipping charged $8.25, then lowered to $6.25 and $2 refunded.
    await lib.insertOrder(d1, { orderId: "REV", orgId: "prime", customerName: "C", contact: "c@x.com", placedAt: now },
      [{ productId: "tee", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: 44 }]);
    d1._raw.run("UPDATE order_items SET unitPriceCents=4400, lineTotalCents=4400 WHERE orderId='REV'");
    await lib.addOrderPayment(d1, "REV", 44, "Stripe", "pi_REV", { method: "card" });
    await lib.addOrderPayment(d1, "REV", 8.25, "Shipping — Stripe", "pi_REV_ship", { method: "card" });
    d1._raw.run("UPDATE orders SET shippingCostCents=625 WHERE orderId='REV'");
    const rr = await lib.addOrderPayment(d1, "REV", -2, "Stripe refund", "re_REV", { method: "card", kind: "refund" });
    await call({ action: "setRefundShipping", orderId: "REV", paymentId: rr, shippingAmount: 2 });
    // Expected for REV: total $44 + $6.25 = $50.25; received $44 + $8.25 − $2 = $50.25 — no gap.
    const revRows = await (new Function(dbSrc + "\nreturn getRevenueData;")())(d1, now.slice(0, 10) + "T00:00:00.000Z", now.slice(0, 10) + "T23:59:59.999Z");
    const revRow = revRows.find(x => x.orderId === "REV");
    console.log("received is net of the refund: $50.25 against a $50.25 total (no $2 gap):",
      Math.abs(revRow.received - 50.25) < 0.005 && Math.abs(revRow.itemSubtotal + revRow.shippingCost - 50.25) < 0.005);
    r = await call({ action: "getRevenueReport", dateFrom: now.slice(0, 10), dateTo: now.slice(0, 10) });
    console.log("the getRevenueReport action still works:", r.status === 200 && r.body.orgs.some(o => o.orgId === "prime"));
    console.log("the column says so:", /Received \(net of refunds\)/.test(read("public/admin.js")));

    console.log("\n=== Payments window ===");
    const adminJs = read("public/admin.js");
    console.log("refund rows say goods/shipping and have a Shipping part… button:",
      /all goods \(tax backed out\)/.test(adminJs) && /of it shipping \(no tax\)/.test(adminJs) && /onclick="pmSetRefundShipping\(/.test(adminJs) && /action:"setRefundShipping"/.test(adminJs));
    console.log("the Record refund form has “Of which shipping” and sends it:", /id="pmRefundShipping"/.test(adminJs) && /date: ov\.querySelector\("#pmRefundDate"\)\.value, shippingAmount,/.test(adminJs));
  } catch (e) {
    console.log("test75 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
