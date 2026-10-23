const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Completed orders + the daily delivery check (migrations/0016).
//  - an order is COMPLETED once it's delivered and paid in full; the orders
//    screen hides completed orders unless "Include completed" is ticked, and
//    every count/total/export follows the view
//  - after orders are set to Delivered the screen offers to complete the ones that can be
//  - the 6 AM roll-up checks tracking (Shippo) for shipped orders, marks the delivered
//    ones, lists them in the email, and they show on the Communications page
// Real SQL (sql.js) + the real db.js, deliveryCheck.js, email.js, daily-digest.js,
// orders.js and admin.js (jsdom). Only Shippo's tracking API and the email
// send are mocked.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const deliverySrc = strip(read("functions/_lib/deliveryCheck.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, setOrdersCompleted, getShippedAwaitingDelivery, whyNotCompletable_, getUnsentOwnerNotices };")();
const del = new Function(dbSrc + "\n" + deliverySrc + "\nreturn { checkShippedDeliveries, carrierToken };")();
const migrationsUpTo = (n) => fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < n).sort();

// Shippo tracking mock: tracking number → {status, status_date} (or an Error to throw).
const tracks = {}; let trackCalls = [];
let emails = [];
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.goshippo.com/tracks/")) {
    trackCalls.push({ url: u, auth: init && init.headers && init.headers.Authorization });
    const num = decodeURIComponent(u.split("/").pop());
    const t = tracks[num];
    if (t instanceof Error) throw t;
    return { ok: true, json: async () => (t ? { tracking_status: t } : { tracking_status: null, messages: [{ text: "not found" }] }) };
  }
  if (captureMail(url, init, emails)) return MAIL_OK;
  return { ok: true, json: async () => ({ status: "ok" }) };
};

async function freshDb(upTo = "9999") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t'), ('rec','rec','REC','t','t');`);
  for (const f of migrationsUpTo(upTo)) d1.execFile(read("migrations/" + f));
  return d1;
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const addOrder = (d1, orderId, orgId, extra = {}) => lib.insertOrder(d1, Object.assign({ orderId, orgId, customerName: "Cust " + orderId,
  contact: orderId.toLowerCase() + "@x.com", paymentMethod: "Venmo", placedAt: daysAgo(10) }, extra),
  [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 2, unitPrice: 23 }]);
// paid = a $46 ledger payment + the cached flag; shipped/delivered stamp the stage dates.
const setState = (d1, orderId, s) => {
  if (s.paid) { d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method) VALUES (?, 4600, ?, 'venmo')", [orderId, daysAgo(9)]); d1._raw.run("UPDATE orders SET paid=1, paidAt=? WHERE orderId=?", [daysAgo(9), orderId]); }
  for (const [k, col] of [["shipped", "shippedAt"], ["delivered", "deliveredAt"], ["completed", "completedAt"]]) if (s[k]) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [s[k] === true ? daysAgo(3) : s[k], orderId]);
  if (s.tracking) d1._raw.run("UPDATE orders SET trackingNumber=?, shippingMethod=? WHERE orderId=?", [s.tracking, s.method || "USPS Ground Advantage", orderId]);
};

(async () => {
  // =====================================================================
  console.log("=== Migration 0016: completedAt backfill + 'delivered' notices ===");
  let d1 = await freshDb("0016");
  await addOrder(d1, "DONE", "prime"); setState(d1, "DONE", { paid: true, shipped: daysAgo(6), delivered: daysAgo(4) });
  await addOrder(d1, "UNPAID", "prime"); setState(d1, "UNPAID", { shipped: daysAgo(6), delivered: daysAgo(4) });
  await addOrder(d1, "MOVING", "prime"); setState(d1, "MOVING", { paid: true, shipped: daysAgo(2) });
  await addOrder(d1, "VOIDED", "prime"); setState(d1, "VOIDED", { paid: true, delivered: daysAgo(4) }); d1._raw.run("UPDATE orders SET voidedAt=? WHERE orderId='VOIDED'", [daysAgo(1)]);
  await addOrder(d1, "TESTY", "prime", { isTest: true }); setState(d1, "TESTY", { paid: true, delivered: daysAgo(4) });
  d1._raw.run("INSERT INTO owner_notices (kind, orderId, summary, createdAt) VALUES ('payment','DONE','old notice','2026-09-01T00:00:00Z')");
  d1.execFile(read("migrations/0016_completed_orders_delivery_notices.sql"));
  const done = d1.q("SELECT orderId, completedAt, deliveredAt FROM orders WHERE completedAt IS NOT NULL");
  console.log("only the delivered + paid real order is backfilled as completed, on its delivery date:",
    done.length === 1 && done[0].orderId === "DONE" && done[0].completedAt === done[0].deliveredAt);
  console.log("unpaid, undelivered, voided and test orders are left open:", d1.q("SELECT count(*) n FROM orders WHERE completedAt IS NULL")[0].n === 4);
  console.log("existing owner notices survive the table rebuild:", d1.q("SELECT summary FROM owner_notices")[0].summary === "old notice");
  d1._raw.run("INSERT INTO owner_notices (kind, orderId, summary, createdAt) VALUES ('delivered','DONE','x','2026-09-24T00:00:00Z')");
  let rejected = false; try { d1._raw.run("INSERT INTO owner_notices (kind, summary, createdAt) VALUES ('bogus','x','t')"); } catch (e) { rejected = true; }
  console.log("the new 'delivered' kind is accepted, an unknown kind is still refused:", rejected && d1.q("SELECT count(*) n FROM owner_notices")[0].n === 2);

  // =====================================================================
  console.log("\n=== Completing orders: the rules ===");
  d1 = await freshDb();
  await addOrder(d1, "OK1", "prime"); setState(d1, "OK1", { paid: true, delivered: true });
  await addOrder(d1, "OK2", "prime"); setState(d1, "OK2", { paid: true, delivered: true });
  await addOrder(d1, "UNPAID", "prime"); setState(d1, "UNPAID", { delivered: true });
  await addOrder(d1, "UNDELIV", "prime"); setState(d1, "UNDELIV", { paid: true, shipped: true });
  await addOrder(d1, "VOID", "prime"); setState(d1, "VOID", { paid: true, delivered: true }); d1._raw.run("UPDATE orders SET voidedAt=? WHERE orderId='VOID'", [daysAgo(1)]);
  await addOrder(d1, "CANC", "prime"); setState(d1, "CANC", { paid: true, delivered: true }); d1._raw.run("UPDATE order_items SET cancelDate=? WHERE orderId='CANC'", [daysAgo(2)]);
  let r = await lib.setOrdersCompleted(d1, ["OK1", "UNPAID", "UNDELIV", "VOID", "CANC", "GHOST"], true);
  const why = Object.fromEntries(r.skipped.map(x => [x.orderId, x.reason]));
  console.log("completes only what qualifies (delivered, paid, not voided, an active item):", r.updated.length === 1 && r.updated[0].orderId === "OK1");
  console.log("says why each of the others can't be:",
    /balance/.test(why.UNPAID) && /not delivered/.test(why.UNDELIV) && /voided/.test(why.VOID) && /cancelled/.test(why.CANC) && /not found/.test(why.GHOST));
  console.log("completedAt is stamped now:", Math.abs(Date.now() - Date.parse(d1.q("SELECT completedAt c FROM orders WHERE orderId='OK1'")[0].c)) < 5000);
  r = await lib.setOrdersCompleted(d1, ["OK1"], true);
  console.log("completing twice is a harmless skip, not a re-stamp:", r.updated.length === 0 && /already/.test(r.skipped[0].reason));
  r = await lib.setOrdersCompleted(d1, ["OK1", "OK2"], false);
  console.log("reopen clears it (and skips the one that was never completed):", r.updated.length === 1 && r.skipped.length === 1 &&
    d1.q("SELECT completedAt c FROM orders WHERE orderId='OK1'")[0].c === null);

  // =====================================================================
  console.log("\n=== Delivery check: which orders are looked up ===");
  d1 = await freshDb();
  await addOrder(d1, "S1", "prime", { customerName: "Ann" }); setState(d1, "S1", { paid: true, shipped: daysAgo(3), tracking: "9400000000000000000001" });
  await addOrder(d1, "S2", "prime", { customerName: "Bob" }); setState(d1, "S2", { paid: false, shipped: daysAgo(4), tracking: "1Z999AA10123456784", method: "UPS Ground" });
  await addOrder(d1, "S3", "prime"); setState(d1, "S3", { paid: true, shipped: daysAgo(2) });                        // shipped, no tracking anywhere
  await addOrder(d1, "S4", "prime"); setState(d1, "S4", { paid: true, shipped: daysAgo(5) });                        // tracking only on its label
  d1._raw.run("INSERT INTO shipping_labels (orderId, shippoTransactionId, carrier, service, amountCents, trackingNumber, purchasedAt, accountId) VALUES ('S4','tx4','USPS','Ground Advantage',625,'9400100000000000000001','2026-09-24T12:00:00Z',2)");
  await addOrder(d1, "N1", "prime"); setState(d1, "N1", { paid: true, tracking: "9400000000000000000009" });        // not shipped yet
  await addOrder(d1, "D1", "prime"); setState(d1, "D1", { paid: true, shipped: daysAgo(6), delivered: daysAgo(4), tracking: "9400000000000000000010" });
  await addOrder(d1, "V1", "prime"); setState(d1, "V1", { paid: true, shipped: daysAgo(6), tracking: "9400000000000000000011" }); d1._raw.run("UPDATE orders SET voidedAt=? WHERE orderId='V1'", [daysAgo(1)]);
  await addOrder(d1, "T1", "prime", { isTest: true }); setState(d1, "T1", { paid: true, shipped: daysAgo(6), tracking: "9400000000000000000012" });
  const cand = await lib.getShippedAwaitingDelivery(d1);
  console.log("looks up shipped, undelivered, real orders that have tracking — its own or its label's (oldest shipment first):",
    cand.map(c => c.orderId).join(",") === "S4,S2,S1" && cand.find(c => c.orderId === "S4").tracking === "9400100000000000000001");
  console.log("skips: no tracking, not shipped, already delivered, voided, test:", !cand.some(c => ["S3", "N1", "D1", "V1", "T1"].includes(c.orderId)));
  console.log("carrier from the label, else the shipping method (usps before ups — 'usps' contains 'ups'):",
    del.carrierToken("USPS", "") === "usps" && del.carrierToken("", "UPS Ground Saver") === "ups" && del.carrierToken("", "USPS Ground Advantage") === "usps" &&
    del.carrierToken("", "FedEx Home") === "fedex" && del.carrierToken("", "") === "usps");

  // =====================================================================
  console.log("\n=== Delivery check: marking delivered ===");
  const env = { DB: d1, SHIPPO_API_KEY: "shippo_key" };
  const delivAt = new Date(Date.now() - 2 * 3600000).toISOString();
  tracks["9400100000000000000001"] = { status: "DELIVERED", status_date: delivAt };
  tracks["1Z999AA10123456784"] = { status: "TRANSIT", status_date: daysAgo(1) };
  tracks["9400000000000000000001"] = new Error("network down");
  trackCalls = [];
  let res = await del.checkShippedDeliveries(env);
  console.log("delivered order marked delivered on the carrier's delivery time:", res.delivered.length === 1 && res.delivered[0].orderId === "S4" &&
    d1.q("SELECT deliveredAt d FROM orders WHERE orderId='S4'")[0].d === delivAt);
  console.log("in transit is left alone; a failed lookup is counted, not fatal:", d1.q("SELECT deliveredAt d FROM orders WHERE orderId='S2'")[0].d === null && res.inTransit.length === 1 && res.errors === 1 && res.checked === 4);
  console.log("a labeled order the carrier hasn't scanned (N1) is looked up too, listed as awaiting pickup, NOT marked shipped:",
    res.awaitingPickup.length === 1 && res.awaitingPickup[0].orderId === "N1" && d1.q("SELECT shippedAt s FROM orders WHERE orderId='N1'")[0].s === null);
  console.log("asks Shippo for the right carrier + tracking number, with the key:",
    trackCalls.some(c => c.url === "https://api.goshippo.com/tracks/usps/9400100000000000000001" && c.auth === "ShippoToken shippo_key") &&
    trackCalls.some(c => c.url === "https://api.goshippo.com/tracks/ups/1Z999AA10123456784"));
  const notice = (await lib.getUnsentOwnerNotices(d1)).filter(n => n.kind === "delivered");
  console.log("queues one 'delivered' notice — customer, carrier + tracking, and that it's ready to complete:",
    notice.length === 1 && notice[0].orderId === "S4" && /USPS 9400100000000000000001 delivered/.test(notice[0].summary) && /ready to mark completed/.test(notice[0].detail));
  console.log("audited as done by the delivery check:", d1.q("SELECT actor, orderId FROM audit_log WHERE action='order.delivered_auto'").some(a => a.orderId === "S4" && a.actor === "delivery-check"));
  trackCalls = [];
  res = await del.checkShippedDeliveries(env);
  console.log("already-delivered orders aren't looked up or announced again:", !trackCalls.some(c => c.url.includes("9400100000000000000001")) && res.delivered.length === 0 &&
    (await lib.getUnsentOwnerNotices(d1)).filter(n => n.kind === "delivered").length === 1);
  tracks["1Z999AA10123456784"] = { status: "DELIVERED", status_date: daysAgo(0) };
  res = await del.checkShippedDeliveries(env);
  const unpaidNote = (await lib.getUnsentOwnerNotices(d1)).find(n => n.orderId === "S2");
  console.log("an unpaid order is delivered too, and the notice says it can't be completed yet:", res.delivered.length === 1 && /balance is still due/.test(unpaidNote.detail));
  d1._raw.run("UPDATE orders SET deliveredAt=NULL WHERE orderId='S1'");
  tracks["9400000000000000000001"] = { status: "DELIVERED", status_date: daysAgo(0) };
  let human = true;
  const realFetch = global.fetch;
  global.fetch = async (u, i) => { if (human && String(u).includes("/tracks/")) d1._raw.run("UPDATE orders SET deliveredAt='2026-09-20T00:00:00Z' WHERE orderId='S1'"); return realFetch(u, i); };
  const before = (await lib.getUnsentOwnerNotices(d1)).length;
  res = await del.checkShippedDeliveries(env);
  global.fetch = realFetch;
  console.log("if a person marked it delivered while the lookup ran, no duplicate notice:", res.delivered.length === 0 && (await lib.getUnsentOwnerNotices(d1)).length === before);
  res = await del.checkShippedDeliveries({ DB: d1 });
  console.log("without a Shippo key it does nothing (and doesn't throw):", res.checked === 0 && !!res.skipped);

  // =====================================================================
  console.log("\n=== The 6 AM roll-up: delivered section in the email ===");
  d1 = await freshDb();
  await addOrder(d1, "R1", "prime", { customerName: "Rita" }); setState(d1, "R1", { paid: true, shipped: daysAgo(3), tracking: "9400000000000000000101" });
  await addOrder(d1, "R2", "rec", { customerName: "Rob" }); setState(d1, "R2", { paid: false, shipped: daysAgo(3), tracking: "9400000000000000000102" });
  d1._raw.run("UPDATE orders SET placedAt=? WHERE orderId IN ('R1','R2')", [daysAgo(20)]);   // old orders: nothing new to report except deliveries
  d1._raw.run("INSERT OR REPLACE INTO global_settings (key,value) VALUES ('dailyDigest', ?)", [JSON.stringify({ afterRowid: 999, sentAt: daysAgo(1) })]);
  tracks["9400000000000000000101"] = { status: "DELIVERED", status_date: daysAgo(0) };
  tracks["9400000000000000000102"] = { status: "TRANSIT", status_date: daysAgo(0) };
  const digest = new Function(strip(read("functions/_lib/http.js")) + "\n" +
    "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + deliverySrc + "\n" + strip(read("functions/api/daily-digest.js")) + "\nreturn onRequestPost;")();
  const denv = { DB: d1, CRON_SECRET: "cron-key", ...MAIL_ENV, SHIPPO_API_KEY: "shippo_key" };
  const run = async () => { const x = await digest({ env: denv, request: { json: async () => ({ key: "cron-key" }), headers: { get: () => null } } }); return { status: x.status, body: JSON.parse(await x.text()) }; };
  emails = [];
  let rr = await run();
  console.log("a delivery alone is enough to send the roll-up (no new orders needed):", rr.status === 200 && rr.body.sent === true && rr.body.delivered === 1 && emails.length === 1);
  const em = emails[0];
  console.log("subject counts the delivery:", /1 delivery/.test(em.subject));
  console.log("email has a Delivered section naming the customer, carrier + tracking, and that it can be completed:",
    /Delivered — 1/.test(em.htmlBody) && /Rita/.test(em.htmlBody) && /USPS 9400000000000000000101/.test(em.htmlBody) && /ready to mark completed/.test(em.htmlBody) && /DELIVERED — 1/.test(em.body));
  console.log("the still-in-transit order is shown in the email under In transit:", /Rob/.test(em.htmlBody));
  console.log("the order is marked delivered and the notice is marked sent:", d1.q("SELECT deliveredAt d FROM orders WHERE orderId='R1'")[0].d !== null &&
    (await lib.getUnsentOwnerNotices(d1)).length === 0);
  emails = []; rr = await run();
  // "Still in transit" alone isn't news — no daily email just for that.
  console.log("next day: still in transit and nothing else new → no email:", rr.body.sent === false && emails.length === 0);
  // A Shippo outage must never stop the roll-up: new order + a lookup that throws.
  await addOrder(d1, "R3", "prime"); emails = []; tracks["9400000000000000000102"] = new Error("Shippo down");
  emails = []; rr = await run();
  console.log("Shippo down: the roll-up still goes out with the new order:", rr.body.sent === true && rr.body.orders === 1 && emails.length === 1 && !/Delivered/.test(emails[0].htmlBody));

  // =====================================================================
  console.log("\n=== Admin API (real orders.js) ===");
  d1 = await freshDb();
  await addOrder(d1, "A1", "prime", { customerName: "Ann" }); setState(d1, "A1", { paid: true, delivered: daysAgo(2) });
  await addOrder(d1, "A2", "prime", { customerName: "Amy" }); setState(d1, "A2", { paid: true, shipped: daysAgo(3), tracking: "9400000000000000000201" });
  await addOrder(d1, "A3", "prime", { customerName: "Al" }); setState(d1, "A3", { paid: false, delivered: daysAgo(2) });
  const ordersSrc = strip(read("functions/api/orders.js"));
  const api = new Function(
    strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false,\n" +
    "  sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + deliverySrc + "\n" + ordersSrc + "\nreturn onRequestPost;")();
  let apiEnv = { DB: d1, SHIPPO_API_KEY: "shippo_key" };
  const call = async (body) => {
    const x = await api({ env: apiEnv, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  let a = await call({ action: "setOrderCompleted", org: "prime", orderIds: ["A1", "A3", "A2"] });
  console.log("setOrderCompleted closes the one that qualifies and reports why not for the rest:",
    a.status === 200 && a.body.updated === 1 && a.body.skipped.length === 2 && d1.q("SELECT completedAt c FROM orders WHERE orderId='A1'")[0].c !== null &&
    a.body.skipped.find(x => x.orderId === "A3").reason.includes("balance"));
  console.log("audited (order.completed):", d1.q("SELECT orderId FROM audit_log WHERE action='order.completed'").some(x => x.orderId === "A1"));
  a = await call({ action: "setOrderCompleted", org: "prime", orderIds: ["bad id!"] });
  console.log("a malformed order id is refused; nothing given is refused:", a.status === 400 && (await call({ action: "setOrderCompleted", org: "prime", orderIds: [] })).status === 400);
  a = await call({ action: "setOrderCompleted", org: "prime", orderIds: ["A1"], completed: false });
  console.log("reopen works over the API:", a.body.updated === 1 && d1.q("SELECT completedAt c FROM orders WHERE orderId='A1'")[0].c === null);
  await call({ action: "setOrderCompleted", org: "prime", orderIds: ["A1"] });
  const go = await call({ action: "getOrders", org: "prime" });
  const orders = go.body.orders || go.body;
  console.log("getOrders exposes completedAt:", Array.isArray(orders) && orders.find(o => o.orderId === "A1").completedAt !== "" && orders.find(o => o.orderId === "A3").completedAt === "");
  // getPendingCommunications runs the Shippo check live — show inTransit with status while in transit
  tracks["9400000000000000000201"] = { status: "TRANSIT", status_date: daysAgo(1) };
  let pc = await call({ action: "getPendingCommunications" });
  console.log("Communications lists the shipped order with its current Shippo status:", pc.body.inTransit.length === 1 && pc.body.inTransit[0].orderId === "A2" && pc.body.inTransit[0].tracking === "9400000000000000000201" && pc.body.inTransit[0].status === "In transit");
  // When it's delivered, getPendingCommunications marks it and shows it in the delivered notices
  tracks["9400000000000000000201"] = { status: "DELIVERED", status_date: daysAgo(0) };
  pc = await call({ action: "getPendingCommunications" });
  console.log("the delivery shows in Communications on the next load, and nothing is in transit:",
    pc.body.notices.some(n => n.kind === "delivered" && n.orderId === "A2") && pc.body.inTransit.length === 0);
  // checkDeliveries still works as an explicit action too
  a = await call({ action: "checkDeliveries" });
  console.log("'Check now' is idempotent — already delivered, reports 0:", a.status === 200 && a.body.delivered.length === 0);
  apiEnv = { DB: d1 };
  a = await call({ action: "checkDeliveries" });
  console.log("checkDeliveries without a Shippo key says so:", a.status === 500 && /Shippo/.test(a.body.message));
  apiEnv = { DB: d1, SHIPPO_API_KEY: "shippo_key" };

  // =====================================================================
  console.log("\n=== Orders screen (jsdom, real API + database) ===");
  d1 = await freshDb();
  await addOrder(d1, "OPEN1", "prime", { customerName: "Olive" });                                             // unpaid, open
  await addOrder(d1, "DONE1", "prime", { customerName: "Dora" }); setState(d1, "DONE1", { paid: true, delivered: daysAgo(3), completed: daysAgo(2) });
  await addOrder(d1, "UNP1", "prime", { customerName: "Uma" }); setState(d1, "UNP1", { qaPacked: true, delivered: daysAgo(1) });   // delivered, balance due
  await addOrder(d1, "PAID1", "prime", { customerName: "Pia" }); setState(d1, "PAID1", { paid: true });        // paid, not delivered yet
  d1._raw.run("UPDATE orders SET qaPackedAt=? WHERE orderId IN ('UNP1','PAID1')", [daysAgo(4)]);
  apiEnv = { DB: d1, SHIPPO_API_KEY: "shippo_key" };
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window;
  w.CSS = { escape: (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };   // browsers have CSS.escape; jsdom doesn't
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "prime", name: "Example League" }]; window._ordersFilter = { from: "", to: "" };');
  const toasts = []; w.showToast = (m, bad) => toasts.push({ m, bad });
  const confirms = []; let confirmAnswer = true; autoConfirm(w, (m) => { confirms.push(m); return confirmAnswer; });
  const app = w.document.getElementById("app");
  const wait = async (fn, n = 200) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };
  const org = { orgId: "prime", name: "Example League" };
  const ids = () => [...w.document.querySelectorAll("tbody tr[data-order]")].map(tr => tr.dataset.order).filter((v, i, arr) => arr.indexOf(v) === i).sort();
  // A re-render replaces the panel with "Loading…" first, so "settled" = the summary bar (or the empty message) is back.
  const settle = async () => { await new Promise(x => setTimeout(x, 30)); await wait(() => w.document.getElementById("ordSummaryBar") || /No open orders/.test(app.textContent)); };
  const summary = () => w.document.getElementById("ordSummaryBar").textContent.replace(/\s+/g, " ").trim();
  const paint = async () => { await w.renderAdminOrders(app, org); await wait(() => w.document.getElementById("ordSummaryBar") || /No open orders/.test(app.textContent)); };

  await paint();
  console.log("default view: completed orders are hidden, open ones shown:", ids().join(",") === "OPEN1,PAID1,UNP1" && !ids().includes("DONE1"));
  console.log("'Include completed' box at the top, unticked:", (() => { const c = w.document.getElementById("ordIncludeCompleted"); return !!c && !c.checked && /Include completed/.test(c.parentElement.textContent); })());
  console.log("the count and totals cover only the view (3 orders × $46 = $138.00; only the two unpaid owe: $92.00):", /^3 orders · \$138\.00 active total · \$92\.00 balance due/.test(summary()));
  console.log("the breakdown at the bottom counts only the view too:", (() => { const b = w.document.getElementById("ordBreakdownSection").textContent; return /Polo/.test(b); })());
  const bd = () => w.document.getElementById("ordBreakdownSection").textContent.replace(/\s+/g, " ");
  const bdDefault = bd();
  w.document.getElementById("ordIncludeCompleted").click();
  await settle();
  console.log("ticking it shows the completed order and the summary now counts it (4 orders, $184.00, still $92.00 due):",
    ids().join(",") === "DONE1,OPEN1,PAID1,UNP1" && /^4 orders · \$184\.00 active total · \$92\.00 balance due/.test(summary()) && w.document.getElementById("ordIncludeCompleted").checked);
  console.log("...and the breakdown follows (more units than before):", bd() !== bdDefault);
  const doneRow = w.document.querySelector('tr[data-order="DONE1"]');
  console.log("the Completed column shows the date; the action cell says Completed + offers Reopen:",
    /✓/.test(doneRow.querySelector("td[data-completed-td]").textContent) && /Completed/.test(doneRow.querySelector("td[data-action-td]").textContent) && /Reopen/.test(doneRow.querySelector("td[data-action-td]").textContent));
  const unpRow = w.document.querySelector('tr[data-order="UNP1"]');
  console.log("delivered-but-unpaid gets no 'Mark completed' button:", !/Mark completed/.test(unpRow.querySelector("td[data-action-td]").textContent));
  w.exportCsv("prime");
  const boxText = w.document.getElementById("exportBox").value;
  console.log("(export, ticked) includes the completed order and has a Completed column:", /DONE1/.test(boxText) && /\tCompleted\n/.test(boxText));
  w.document.getElementById("ordIncludeCompleted").click();
  await settle();
  w.exportCsv("prime");
  console.log("(export, unticked) leaves the completed order out — it follows the view:", !/DONE1/.test(w.document.getElementById("exportBox").value) && /OPEN1/.test(w.document.getElementById("exportBox").value));

  // -- prompt after Delivered
  const check = (id) => { const c = w.document.querySelector(`.order-select[data-order="${id}"]`); c.checked = true; w.updateBulkBar("prime"); };
  confirms.length = 0; toasts.length = 0;
  check("PAID1");
  await w.bulkSetFulfillmentStage("prime", "delivered");
  console.log("after setting Delivered on a paid order, it asks to complete it:",
    confirms.length === 2 && /as delivered/.test(confirms[0]) && /as completed/.test(confirms[1]) && /PAID1/.test(confirms[1]));
  await settle();
  console.log("accepting completes it: stamped in the database, and it leaves the default view:",
    d1.q("SELECT completedAt c, deliveredAt d FROM orders WHERE orderId='PAID1'")[0].c !== null && !ids().includes("PAID1") && ids().join(",") === "OPEN1,UNP1" &&
    /^2 orders · \$92\.00 active total · \$92\.00 balance due/.test(summary()));
  confirms.length = 0; toasts.length = 0;
  await paint(); check("OPEN1");
  await w.bulkSetFulfillmentStage("prime", "delivered");
  console.log("delivering an UNPAID order asks nothing more — it just says a balance is due:",
    confirms.length === 1 && !/completed/.test(confirms[0]) && toasts.some(t => /can't be completed yet.*balance/.test(t.m)) &&
    d1.q("SELECT completedAt c FROM orders WHERE orderId='OPEN1'")[0].c === null);
  // declining
  await addOrder(d1, "PAID2", "prime", { customerName: "Pat" }); setState(d1, "PAID2", { paid: true }); d1._raw.run("UPDATE orders SET qaPackedAt=? WHERE orderId='PAID2'", [daysAgo(1)]);
  await paint(); confirms.length = 0;
  let n = 0; autoConfirm(w, (m) => { confirms.push(m); return ++n === 1; });   // yes to "delivered", no to "completed"
  check("PAID2");
  await w.bulkSetFulfillmentStage("prime", "delivered");
  console.log("declining the completion prompt leaves it delivered but open:", d1.q("SELECT completedAt c, deliveredAt d FROM orders WHERE orderId='PAID2'").map(x => x.c === null && x.d !== null)[0]);
  autoConfirm(w, (m) => { confirms.push(m); return true; });
  await paint();
  const p2 = w.document.querySelector('tr[data-order="PAID2"] td[data-action-td]');
  console.log("...and it now has a 'Mark completed' button:", /Mark completed/.test(p2.textContent));
  const btn = [...p2.querySelectorAll("button")].find(b => /Mark completed/.test(b.textContent));
  btn.click();
  await wait(() => d1.q("SELECT completedAt c FROM orders WHERE orderId='PAID2'")[0].c !== null);
  await settle();
  console.log("clicking it completes the order and it leaves the default view:", !ids().includes("PAID2"));
  // single-order Delivered from the action-cell dropdown
  await addOrder(d1, "PAID3", "prime", { customerName: "Paz" }); setState(d1, "PAID3", { paid: true }); d1._raw.run("UPDATE orders SET qaPackedAt=? WHERE orderId='PAID3'", [daysAgo(1)]);
  await paint(); confirms.length = 0;
  await w.setFulfillmentStage("prime", "PAID3", "delivered");
  console.log("the per-order Delivered dropdown offers to complete too:", confirms.length === 2 && /as completed/.test(confirms[1]));
  await settle();
  // Reopen from the view
  await paint();
  w.document.getElementById("ordIncludeCompleted").click(); await settle();
  const reopenBtn = [...w.document.querySelector('tr[data-order="DONE1"] td[data-action-td]').querySelectorAll("button")].find(b => /Reopen/.test(b.textContent));
  reopenBtn.click();
  await wait(() => d1.q("SELECT completedAt c FROM orders WHERE orderId='DONE1'")[0].c === null);
  await settle();
  console.log("Reopen puts it back to open:", d1.q("SELECT completedAt c FROM orders WHERE orderId='DONE1'")[0].c === null);
  // only completed orders left → friendly empty state, box still there
  d1._raw.run("UPDATE orders SET completedAt=deliveredAt WHERE completedAt IS NULL AND deliveredAt IS NOT NULL AND paid=1");
  d1._raw.run("UPDATE orders SET completedAt=? WHERE orderId IN ('OPEN1','UNP1','DONE1')", [daysAgo(1)]);
  w.document.getElementById("ordIncludeCompleted").checked = false; w._orderView.includeCompleted = false;
  await paint();
  console.log("when everything is completed the view says so and keeps the checkbox:", /No orders match the current filter/.test(app.textContent) && !!w.document.getElementById("ordIncludeCompleted"));
  w._orderView.includeCompleted = false;

  // =====================================================================
  console.log("\n=== Communications page (jsdom) ===");
  d1 = await freshDb();
  await addOrder(d1, "C1", "prime", { customerName: "Cora" }); setState(d1, "C1", { paid: true, shipped: daysAgo(2), tracking: "9400000000000000000301" });
  await addOrder(d1, "C2", "rec", { customerName: "Cal" }); setState(d1, "C2", { paid: true, shipped: daysAgo(3), tracking: "9400000000000000000302" });
  d1._raw.run("UPDATE orders SET placedAt=? WHERE orderId IN ('C1','C2')", [daysAgo(20)]);
  d1._raw.run("INSERT OR REPLACE INTO global_settings (key,value) VALUES ('dailyDigest', ?)", [JSON.stringify({ afterRowid: 999, sentAt: daysAgo(1) })]);
  apiEnv = { DB: d1, SHIPPO_API_KEY: "shippo_key" };
  tracks["9400000000000000000301"] = { status: "TRANSIT", status_date: daysAgo(0) };
  tracks["9400000000000000000302"] = { status: "DELIVERED", status_date: daysAgo(0) };
  await w.renderCommunications(app);
  await wait(() => /waiting on delivery/.test(app.textContent));
  let txt = app.textContent.replace(/\s+/g, " ");
  // C2 (DELIVERED) moves to the Delivered section immediately on load; C1 (TRANSIT) stays in waiting
  console.log("delivered order moves to Delivered section on load; in-transit order stays in waiting:", /Delivered — 1/.test(txt) && /Cal — USPS 9400000000000000000302 delivered/.test(txt) && /Shipped — waiting on delivery — 1/.test(txt) && /Cora/.test(txt));
  console.log("has a Refresh button and the status column:", !!w.document.getElementById("checkDeliveriesBtn") && /In transit/.test(txt));
  console.log("the page says the email will be sent (deliveries + in-transit):", !/Nothing new — no email will be sent/.test(txt));
  w.document.getElementById("checkDeliveriesBtn").click();
  await wait(() => /waiting on delivery/.test(app.textContent));
  txt = app.textContent.replace(/\s+/g, " ");
  console.log("Refresh keeps the same state:", /Delivered — 1/.test(txt) && /Shipped — waiting on delivery — 1/.test(txt));
})().catch(e => { console.log("test48 crashed:", false); console.error(e); process.exit(1); });
