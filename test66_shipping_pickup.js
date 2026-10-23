const fs = require("fs");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { createD1 } = require("./testlib/d1-shim.js");

// "Shipped" means the CARRIER has the package.
//   * Buying a label never marks an order shipped — it's "label created, not shipped yet".
//   * The daily tracking check (and Check now) looks up labeled-but-unshipped orders and marks one
//     shipped only once tracking shows a carrier scan, dated by the FIRST scan; delivered already →
//     delivered too. Still pre-transit → left alone, listed, checked again next run.
//   * The customer gets ONE "your order has shipped" email with tracking — on that carrier scan or
//     when the admin marks it shipped — never twice, never for pickups / test / voided orders.
//   * The server enforces stage order on the admin's stage actions (Delivered needs QA & packed, not
//     Shipped — pickups never ship).
//   * The roll-up lists "Picked up by the carrier" and "Label created, not shipped yet".
// Real SQL (sql.js) + real db.js / email.js / deliveryCheck.js / orders.js; Shippo and the email
// send are a mocked fetch.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), emailSrc = strip(read("functions/_lib/email.js")), delSrc = strip(read("functions/_lib/deliveryCheck.js"));
const L = new Function(dbSrc + "\n" + emailSrc + "\n" + delSrc + `\nreturn { insertOrder, getOrderById, setFulfillmentStage, stagePrereqError,
  recordShippingLabel, getLabeledAwaitingShipment, checkShippedDeliveries, sendDailyDigestEmail, sendShippedEmail, trackingUrl, carrierToken };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + emailSrc + "\n" + delSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

// Mocked network: Shippo tracking + the email send (every email lands in `mail`).
const tracks = {}; let lookups = [], lookupUrls = []; const mail = [];
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.goshippo.com/tracks/")) {
    const num = decodeURIComponent(u.split("/").pop()); lookups.push(num); lookupUrls.push(u);
    const t = tracks[num] || { tracking_status: { status: "UNKNOWN" } };
    return { ok: true, status: 200, json: async () => t };
  }
  if (captureMail(u, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + u);
};
const env = (d1) => ({ DB: d1, SHIPPO_API_KEY: "k", ...MAIL_ENV });
const iso = (daysAgo, h = 12) => { const d = new Date(Date.now() - daysAgo * 86400000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };

(async () => {
  try {
    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('prime','prime','Example League',1,'t','t');`);
    const addr = { name: "Ann", line1: "1 Main", city: "Springfield", state: "OH", zip: "45505" };
    const order = async (id, o = {}) => {
      await L.insertOrder(d1, { orderId: id, orgId: "prime", customerName: o.name || "Ann", contact: o.contact === undefined ? "ann@example.com" : o.contact,
        placedAt: iso(10), shippingAddress: o.pickup ? null : addr, isTest: !!o.isTest }, [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
      d1._raw.run("UPDATE orders SET paid=1, blankOrderedAt=?, blankReceivedAt=?, digitizingCompleteAt=?, designApprovedAt=?, manufacturedAt=?, qaPackedAt=? WHERE orderId=?",
        [iso(9), iso(8), iso(8), iso(7), iso(6), iso(5), id]);
    };
    const shippedAt = (id) => d1.q(`SELECT shippedAt s FROM orders WHERE orderId='${id}'`)[0].s;
    const call = async (body) => {
      const waits = [];
      const res = await api({ env: env(d1), waitUntil: (p) => waits.push(p),
        request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
      await Promise.all(waits);
      return { status: res.status, body: JSON.parse(await res.text()) };
    };

    console.log("=== A label is not 'shipped' ===");
    await order("A1");
    await L.recordShippingLabel(d1, { orderId: "A1", shippoTransactionId: "tx1", carrier: "USPS", service: "Ground Advantage", amount: 6.25, trackingNumber: "9400111", labelUrl: "" });
    console.log("buying a label leaves the order unshipped:", shippedAt("A1") === null);
    const pending = await L.getLabeledAwaitingShipment(d1);
    console.log("it's in the 'label created, not shipped yet' list, with the label's tracking:", pending.length === 1 && pending[0].tracking === "9400111");

    console.log("\n=== Daily check: still pre-transit → left alone ===");
    tracks["9400111"] = { tracking_status: { status: "PRE_TRANSIT", status_date: iso(1) }, tracking_history: [{ status: "PRE_TRANSIT", status_date: iso(1) }] };
    let r = await L.checkShippedDeliveries(env(d1));
    console.log("looked up, listed as awaiting pickup, not shipped, no customer email:",
      lookups.includes("9400111") && r.awaitingPickup.length === 1 && r.pickedUp.length === 0 && shippedAt("A1") === null && mail.length === 0);

    console.log("\n=== Daily check: carrier scanned it → shipped, dated by the first scan, emailed once ===");
    const firstScan = iso(1, 15);
    tracks["9400111"] = { tracking_status: { status: "TRANSIT", status_date: iso(0, 9) },
      tracking_history: [{ status: "PRE_TRANSIT", status_date: iso(2) }, { status: "TRANSIT", status_date: firstScan }, { status: "TRANSIT", status_date: iso(0, 9) }] };
    r = await L.checkShippedDeliveries(env(d1));
    console.log("marked shipped on the carrier's FIRST scan, not the label date or today:", r.pickedUp.length === 1 && shippedAt("A1") === firstScan);
    const shipMail = mail.filter(m => /has shipped/.test(m.subject));
    console.log("the customer got one shipped email with the USPS tracking link:", shipMail.length === 1 && shipMail[0].to === "ann@example.com" &&
      shipMail[0].htmlBody.includes("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111") && r.pickedUp[0].customerEmailed === true);
    console.log("audited as done by the check:", d1.q("SELECT actor FROM audit_log WHERE action='order.shipped_auto' AND orderId='A1'")[0].actor === "delivery-check");
    lookups = [];
    r = await L.checkShippedDeliveries(env(d1));
    console.log("next run: no second email; it's now watched for delivery instead:",
      mail.filter(m => /has shipped/.test(m.subject)).length === 1 && r.pickedUp.length === 0 && r.inTransit.some(x => x.orderId === "A1"));
    console.log("…and looked up once per run, not twice:", lookups.filter(n => n === "9400111").length === 1);

    console.log("\n=== Daily check: already delivered by the first look → shipped AND delivered ===");
    await order("A2");
    await L.recordShippingLabel(d1, { orderId: "A2", shippoTransactionId: "tx2", carrier: "UPS", service: "Ground", amount: 9, trackingNumber: "1Z222", labelUrl: "" });
    tracks["1Z222"] = { tracking_status: { status: "DELIVERED", status_date: iso(0, 10) },
      tracking_history: [{ status: "TRANSIT", status_date: iso(2, 14) }, { status: "DELIVERED", status_date: iso(0, 10) }] };
    r = await L.checkShippedDeliveries(env(d1));
    const a2 = d1.q("SELECT shippedAt s, deliveredAt d FROM orders WHERE orderId='A2'")[0];
    console.log("shipped (first scan) and delivered (carrier's date):", a2.s === iso(2, 14) && a2.d === iso(0, 10) && r.delivered.some(x => x.orderId === "A2"));
    console.log("UPS link in the customer's email:", mail.some(m => /has shipped/.test(m.subject) && m.htmlBody.includes("https://www.ups.com/track?tracknum=1Z222")));

    console.log("\n=== Shippo's test tracking numbers (for walking an order through on a test install) ===");
    console.log("SHIPPO_* numbers use Shippo's test carrier; real numbers are untouched:",
      L.carrierToken("USPS", "", "SHIPPO_TRANSIT") === "shippo" && L.carrierToken("USPS", "", "shippo_delivered") === "shippo" &&
      L.carrierToken("USPS", "", "9400111") === "usps" && L.carrierToken("", "UPS Ground", "1Z9") === "ups");
    await order("Z1");
    d1._raw.run("UPDATE orders SET trackingNumber='SHIPPO_PRE_TRANSIT' WHERE orderId='Z1'");
    tracks["SHIPPO_PRE_TRANSIT"] = { tracking_status: { status: "PRE_TRANSIT", status_date: iso(1) }, tracking_history: [{ status: "PRE_TRANSIT", status_date: iso(1) }] };
    lookupUrls = [];
    r = await L.checkShippedDeliveries(env(d1));
    console.log("SHIPPO_PRE_TRANSIT: asked at /tracks/shippo/…, stays 'label created, not shipped yet':",
      lookupUrls.includes("https://api.goshippo.com/tracks/shippo/SHIPPO_PRE_TRANSIT") && shippedAt("Z1") === null && r.awaitingPickup.some(x => x.orderId === "Z1"));
    d1._raw.run("UPDATE orders SET trackingNumber='SHIPPO_TRANSIT' WHERE orderId='Z1'");
    tracks["SHIPPO_TRANSIT"] = { tracking_status: { status: "TRANSIT", status_date: iso(0, 8) }, tracking_history: [{ status: "TRANSIT", status_date: iso(0, 8) }] };
    r = await L.checkShippedDeliveries(env(d1));
    console.log("SHIPPO_TRANSIT: marked shipped and the customer emailed:", shippedAt("Z1") === iso(0, 8) && r.pickedUp.some(x => x.orderId === "Z1" && x.customerEmailed));
    d1._raw.run("UPDATE orders SET trackingNumber='SHIPPO_DELIVERED' WHERE orderId='Z1'");
    tracks["SHIPPO_DELIVERED"] = { tracking_status: { status: "DELIVERED", status_date: iso(0, 11) }, tracking_history: [{ status: "DELIVERED", status_date: iso(0, 11) }] };
    r = await L.checkShippedDeliveries(env(d1));
    console.log("SHIPPO_DELIVERED: marked delivered:", r.delivered.some(x => x.orderId === "Z1") && d1.q("SELECT deliveredAt d FROM orders WHERE orderId='Z1'")[0].d === iso(0, 11));

    console.log("\n=== Marking shipped by hand ===");
    await order("M1");
    mail.length = 0;
    let res = await call({ action: "setFulfillmentStage", orderId: "M1", stage: "shipped", trackingNumber: "9400999" });
    console.log("marking shipped by hand emails the customer once, with the tracking typed in:",
      res.status === 200 && mail.length === 1 && /has shipped/.test(mail[0].subject) && mail[0].htmlBody.includes("9400999"));
    const firstAt = shippedAt("M1");
    res = await call({ action: "setFulfillmentStage", orderId: "M1", stage: "shipped", trackingNumber: "9400998" });
    console.log("marking it again: no second email, ship date kept, tracking updated:",
      res.status === 200 && mail.length === 1 && shippedAt("M1") === firstAt && (await L.getOrderById(d1, "M1")).trackingNumber === "9400998");
    await order("P1", { pickup: true });
    res = await call({ action: "setFulfillmentStage", orderId: "P1", stage: "shipped" });
    console.log("a pickup (no address, no tracking) marked shipped gets no email:", res.status === 200 && mail.length === 1);
    await order("T1", { isTest: true });
    d1._raw.run("UPDATE orders SET isTest=1 WHERE orderId='T1'");
    res = await call({ action: "setFulfillmentStage", orderId: "T1", stage: "shipped", trackingNumber: "9400777" });
    console.log("a test order gets no email:", res.status === 200 && mail.length === 1);
    await order("B1"); await order("B2");
    res = await call({ action: "bulkSetFulfillmentStage", orderIds: ["B1", "B2"], stage: "shipped", trackingNumber: "9400555" });
    console.log("bulk Mark shipped: one email per order:", res.body.updated === 2 && mail.length === 3);

    console.log("\n=== Stage order is enforced on the server ===");
    await L.insertOrder(d1, { orderId: "S1", orgId: "prime", customerName: "Sam", contact: "s@example.com", placedAt: iso(3), shippingAddress: addr },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
    res = await call({ action: "setFulfillmentStage", orderId: "S1", stage: "shipped" });
    console.log("can't mark shipped before QA & packed (409, with the reason):", res.status === 409 && /QA'd and packed/.test(res.body.message) && shippedAt("S1") === null);
    res = await call({ action: "setFulfillmentStage", orderId: "S1", stage: "blankOrdered" });
    console.log("can't order blanks before it's paid:", res.status === 409 && /isn't paid/.test(res.body.message));
    res = await call({ action: "bulkSetFulfillmentStage", orderIds: ["S1", "B1"], stage: "delivered" });
    console.log("bulk: the out-of-order one is skipped with its reason, the other goes through:",
      res.body.updated === 1 && res.body.skipped === 1 && /S1: can't mark delivered/.test(res.body.errors[0]));
    const pk = { paid: true, qaPackedAt: "x" };
    console.log("Delivered needs QA & packed, not Shipped (pickups never ship):", L.stagePrereqError(pk, "delivered") === "" && L.stagePrereqError({ paid: true }, "delivered") !== "");
    console.log("manufactured needs both the design approved and the blank received:",
      /design isn't approved/.test(L.stagePrereqError({ blankReceivedAt: "x" }, "manufactured")) && /blank hasn't been received/.test(L.stagePrereqError({ designApprovedAt: "x" }, "manufactured")));

    console.log("\n=== The roll-up ===");
    mail.length = 0;
    const pu = [{ orderId: "A1", orgId: "prime", customerName: "Ann", carrier: "USPS", tracking: "9400111", shippedAtLabel: "Oct 1", customerEmailed: true }];
    const aw = [{ orderId: "A9", orgId: "prime", customerName: "Zed", carrier: "USPS", tracking: "9400123", labelAtLabel: "Sep 30" }];
    let sent = await L.sendDailyDigestEmail(env(d1), { pickedUp: pu, awaitingPickup: aw, orgNames: { prime: "Example League" } });
    console.log("lists 'Picked up by the carrier' and 'Label created, not shipped yet', and says so in the subject:",
      sent === true && /Picked up by the carrier — 1/.test(mail[0].htmlBody) && /Label created, not shipped yet — 1/.test(mail[0].htmlBody) && /1 picked up by carrier/.test(mail[0].subject));
    mail.length = 0;
    sent = await L.sendDailyDigestEmail(env(d1), { awaitingPickup: aw });
    console.log("a label still waiting on its own is never a reason to send the roll-up:", sent === false && mail.length === 0);

    console.log("\n=== Orders table ===");
    const adminJs = read("public/admin.js");
    const badgeSrc = adminJs.slice(adminJs.indexOf("function fulfillmentBadge("), adminJs.indexOf("\n}\n", adminJs.indexOf("function fulfillmentBadge(")) + 2);
    const fulfillmentBadge = new Function("escapeHtml", badgeSrc + "\nreturn fulfillmentBadge;")(s => String(s));
    console.log("the Shipped cell shows 'Label created — not shipped yet' for a labeled, unshipped order:",
      /Label created/.test(fulfillmentBadge("", { labels: [{ voidedAt: "" }] }, "shipped")) && !/Label created/.test(fulfillmentBadge("", { labels: [{ voidedAt: "2026-01-01" }] }, "shipped")));
    console.log("…and is passed the order so it can:", /fulfillmentBadge\(o\.shippedAt, o, "shipped"\)/.test(adminJs));
  } catch (e) {
    console.log("test66 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
