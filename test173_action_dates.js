const fs = require("fs");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// When things happened (2026-10): order steps are usually recorded after the fact, so each one takes a date and time
// (default now) that has to fit the order's other dates — a step can't be before the steps it follows, nor after a
// step already recorded that follows it (refused, saying which). Covers the stage actions (single + bulk), blanks
// from stock, completed, cancel, line refund, the blank-received date that used to be ignored, receiving only the
// lines picked from one order, manufactured dating the blank use (cost of goods) and closed months, a local sale
// dated into a closed month, and the admin's date-and-time box. Real db.js / orders.js on sql.js; admin.js in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct, createBlank, setBlankLink, stageTimeError, getOrderById };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(r => setTimeout(r, 10)); return fn(); };
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x", org: "acme" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  const blankId = (await lib.createBlank(d1, { name: "Cap blank", productType: "cap", vendor: "SanMar", color: "", colors: [{ color: "Navy", sizes: [{ size: "OSFA", quantity: 10, purchasePrice: 3 }] }] })).id;
  await lib.setBlankLink(d1, "acme", "cap", "", "OSFA", blankId, "Navy", "OSFA");
  let n = 0;
  const order = async (placedAt, items = 1, extra = {}) => {
    const orderId = "D" + (++n);
    await lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", placedAt },
      Array.from({ length: items }, () => ({ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 })));
    d1._raw.run("UPDATE orders SET paid=1 WHERE orderId=?", [orderId]);
    for (const [k, v] of Object.entries(extra)) d1._raw.run(`UPDATE orders SET ${k}=? WHERE orderId=?`, [v, orderId]);
    return orderId;
  };
  const col = (id, c) => d1.q(`SELECT ${c} AS v FROM orders WHERE orderId=?`, id)[0].v;

  console.log("=== The rule ===");
  const o = { placedAt: hoursAgo(100), shippedAt: hoursAgo(50), qaPackedAt: hoursAgo(60), manufacturedAt: hoursAgo(70) };
  ok("a step after the ones it follows is fine", lib.stageTimeError(o, "delivered", hoursAgo(10)) === "");
  ok("…before them is refused, saying which and when", /^Delivered can't be before it shipped \(/.test(lib.stageTimeError(o, "delivered", hoursAgo(55))));
  ok("…before the order date is refused", /can't be before the order date/.test(lib.stageTimeError(o, "blankOrdered", hoursAgo(101))));
  ok("…after a step already recorded that follows it is refused", /^QA and packed can't be after it shipped/.test(lib.stageTimeError(o, "qaPacked", hoursAgo(40))));
  ok("…in the future is refused", /future/.test(lib.stageTimeError(o, "delivered", new Date(Date.now() + 3600000).toISOString())));
  const dayOnly = { placedAt: "2026-09-10T12:00:00.000Z" };
  ok("a date-only order date counts as the whole day (a step that morning is fine, the day before isn't)", lib.stageTimeError(dayOnly, "blankOrdered", "2026-09-10T09:00:00.000Z") === "" &&
    /order date \(Sep 10, 2026\)/.test(lib.stageTimeError(dayOnly, "blankOrdered", "2026-09-09T20:00:00.000Z")));

  console.log("\n=== Stage actions take the date ===");
  const a1 = await order(hoursAgo(200), 1, { blankOrderedAt: hoursAgo(190), blankReceivedAt: hoursAgo(180), manufacturedAt: hoursAgo(150), qaPackedAt: hoursAgo(140), shippedAt: hoursAgo(120) });
  const deliveredAt = hoursAgo(48);
  let r = await call({ action: "setFulfillmentStage", orderId: a1, stage: "delivered", at: deliveredAt });
  ok("marking delivered two days late records the date chosen, and says so", r.status === 200 && col(a1, "deliveredAt") === deliveredAt && r.body.timestamp === deliveredAt);
  const a2 = await order(hoursAgo(200), 1, { blankOrderedAt: hoursAgo(190), blankReceivedAt: hoursAgo(180), manufacturedAt: hoursAgo(150), qaPackedAt: hoursAgo(140), shippedAt: hoursAgo(20) });
  r = await call({ action: "setFulfillmentStage", orderId: a2, stage: "delivered", at: hoursAgo(30) });
  ok("…a date before it shipped is refused, and nothing is written", r.status === 409 && /Delivered can't be before it shipped/.test(r.body.message) && col(a2, "deliveredAt") === null);
  r = await call({ action: "setFulfillmentStage", orderId: a2, stage: "delivered", at: "not a date" });
  ok("…nonsense is refused", r.status === 400);
  r = await call({ action: "setFulfillmentStage", orderId: a2, stage: "delivered" });
  ok("…no date given = now (as before)", r.status === 200 && Math.abs(Date.parse(col(a2, "deliveredAt")) - Date.now()) < 60000);
  const m1 = await order(hoursAgo(300), 1, { blankOrderedAt: hoursAgo(290), blankReceivedAt: hoursAgo(280), digitizingCompleteAt: hoursAgo(270) });
  d1._raw.run("UPDATE order_items SET blankOrderedAt=?, blankReceivedAt=? WHERE orderId=?", [hoursAgo(290), hoursAgo(280), m1]);
  const madeAt = hoursAgo(72);
  r = await call({ action: "setFulfillmentStage", orderId: m1, stage: "manufactured", at: madeAt });
  const use = d1.q("SELECT occurredAt FROM inventory_movements WHERE orderId=? AND kind='consume'", m1)[0];
  ok("manufactured after the fact: the order and its blank use (cost of goods) are dated when it was made", r.status === 200 && col(m1, "manufacturedAt") === madeAt && use && use.occurredAt === madeAt);
  const old = await order("2026-01-05T12:00:00.000Z", 1, { blankOrderedAt: "2026-01-06T12:00:00.000Z", blankReceivedAt: "2026-01-07T12:00:00.000Z", digitizingCompleteAt: "2026-01-08T12:00:00.000Z" });
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-01', 't', 'x')");
  r = await call({ action: "setFulfillmentStage", orderId: old, stage: "manufactured", at: "2026-01-20T15:00:00.000Z" });
  ok("…made in a closed month is refused (its cost of goods would change that month)", r.status === 409 && /January 2026 is closed/.test(r.body.message) && col(old, "manufacturedAt") === null);

  console.log("\n=== Blanks received: the date, and only the lines picked ===");
  const rc = await order(hoursAgo(100), 2, { blankOrderedAt: hoursAgo(90) });
  d1._raw.run("UPDATE order_items SET blankOrderedAt=? WHERE orderId=?", [hoursAgo(90), rc]);
  const items = d1.q("SELECT id FROM order_items WHERE orderId=? ORDER BY id", rc).map(x => x.id);
  const arrived = hoursAgo(26);
  r = await call({ action: "setFulfillmentStage", orderId: rc, stage: "blankReceived", at: arrived, items: [{ orderId: rc, itemId: items[0] }], itemConditions: [{ sheetRow: items[0], condition: "Good" }] });
  const recv = d1.q("SELECT id, blankReceivedAt FROM order_items WHERE orderId=? ORDER BY id", rc);
  ok("receiving from one order's stage menu: only the line picked is received, on the date chosen (both used to be ignored)", r.status === 200 && recv[0].blankReceivedAt === arrived && recv[1].blankReceivedAt === null);

  console.log("\n=== Bulk: one date for all; an order it doesn't fit is skipped, saying why ===");
  const b1 = await order(hoursAgo(100), 1, { blankOrderedAt: hoursAgo(95), blankReceivedAt: hoursAgo(94), manufacturedAt: hoursAgo(90), qaPackedAt: hoursAgo(80) });
  const b2 = await order(hoursAgo(10), 1, { blankOrderedAt: hoursAgo(9), blankReceivedAt: hoursAgo(9), manufacturedAt: hoursAgo(8), qaPackedAt: hoursAgo(7) });
  const shipAt = hoursAgo(50);
  r = await call({ action: "bulkSetFulfillmentStage", orderIds: [b1, b2], stage: "shipped", at: shipAt });
  ok("bulk shipped two days ago: the order packed before then gets it, the one packed since is skipped with the reason", r.status === 200 && r.body.updated === 1 && col(b1, "shippedAt") === shipAt && col(b2, "shippedAt") === null &&
    r.body.errors.length === 1 && new RegExp(`^${b2}: can't mark shipped — Shipped can't be before`).test(r.body.errors[0]));

  console.log("\n=== Blanks from stock, completed, cancel, refund ===");
  const s1 = await order(hoursAgo(100));
  const tookAt = hoursAgo(30);
  r = await call({ action: "useBlanksFromStock", orderId: s1, at: tookAt });
  ok("blanks from stock are received on the date chosen", r.status === 200 && d1.q("SELECT blankReceivedAt v FROM order_items WHERE orderId=?", s1)[0].v === tookAt);
  const c1 = await order(hoursAgo(200), 1, { deliveredAt: hoursAgo(40) });
  r = await call({ action: "setOrderCompleted", orderIds: [c1], completed: true, at: hoursAgo(50) });
  ok("completed before it was delivered is skipped with the reason", r.status === 200 && r.body.updated === 0 && /before it was delivered/.test(r.body.skipped[0].reason));
  const doneAt = hoursAgo(20);
  r = await call({ action: "setOrderCompleted", orderIds: [c1], completed: true, at: doneAt });
  ok("…after it, completed on that date", r.status === 200 && r.body.updated === 1 && col(c1, "completedAt") === doneAt);
  const x1 = await order(hoursAgo(100), 2);
  const xi = d1.q("SELECT id FROM order_items WHERE orderId=? ORDER BY id", x1).map(x => x.id);
  r = await call({ action: "cancelLineItem", sheetRow: xi[0], at: hoursAgo(120) });
  ok("a cancellation before the order is refused", r.status === 409 && /before the order date/.test(r.body.message));
  const cancelAt = hoursAgo(12);
  r = await call({ action: "cancelLineItem", sheetRow: xi[0], at: cancelAt, reason: "dup" });
  ok("…otherwise the line is cancelled on the date chosen", r.status === 200 && d1.q("SELECT cancelDate v FROM order_items WHERE id=?", xi[0])[0].v === cancelAt);
  const refAt = hoursAgo(6);
  r = await call({ action: "setLineItemRefund", sheetRow: xi[0], refundAmount: 20, at: refAt });
  ok("a line refund is dated when it was refunded", r.status === 200 && d1.q("SELECT refundDate v FROM order_items WHERE id=?", xi[0])[0].v === refAt);

  console.log("\n=== The order's Dates… window (setOrderDates) ===");
  const e1 = await order(hoursAgo(300), 1, { blankOrderedAt: hoursAgo(290), blankReceivedAt: hoursAgo(280), digitizingCompleteAt: hoursAgo(275) });
  d1._raw.run("UPDATE order_items SET blankOrderedAt=?, blankReceivedAt=? WHERE orderId=?", [hoursAgo(290), hoursAgo(280), e1]);
  await call({ action: "setFulfillmentStage", orderId: e1, stage: "manufactured", at: hoursAgo(200) });
  d1._raw.run("UPDATE orders SET qaPackedAt=?, shippedAt=?, deliveredAt=? WHERE orderId=?", [hoursAgo(150), hoursAgo(100), hoursAgo(50), e1]);
  const newShip = hoursAgo(120), newMade = hoursAgo(220);
  r = await call({ action: "setOrderDates", orderId: e1, dates: { shippedAt: newShip, manufacturedAt: newMade }, dueDate: "2026-12-01" });
  ok("several dates change at once (only those sent), with the due date", r.status === 200 && col(e1, "shippedAt") === newShip && col(e1, "manufacturedAt") === newMade && col(e1, "dueDate") === "2026-12-01" &&
    col(e1, "deliveredAt") === r.body.order.deliveredAt);
  ok("…a new Manufactured date moves the order's blank use (cost of goods) with it", d1.q("SELECT occurredAt v FROM inventory_movements WHERE orderId=? AND kind='consume'", e1)[0].v === newMade);
  ok("…and it's in the audit log, from → to", (() => { const row = d1.q("SELECT detail FROM audit_log WHERE action='order.dates_changed' AND orderId=?", e1)[0]; const dt = row && JSON.parse(row.detail);
    return dt && dt.to.shippedAt === newShip && typeof dt.from.shippedAt === "string" && dt.from.shippedAt !== newShip && dt.to.dueDate === "2026-12-01"; })());
  r = await call({ action: "setOrderDates", orderId: e1, dates: { deliveredAt: hoursAgo(130) } });
  ok("out of order is refused, saying which (delivered before it shipped), nothing written", r.status === 409 && /^Delivered \(.+\) can't be before it shipped/.test(r.body.message) && col(e1, "deliveredAt") !== hoursAgo(130));
  r = await call({ action: "setOrderDates", orderId: e1, dates: { deliveredAt: null } });
  ok("a step can be cleared (not done after all)", r.status === 200 && col(e1, "deliveredAt") === null);
  ok("…but not the order date or Manufactured", (await call({ action: "setOrderDates", orderId: e1, dates: { placedAt: "" } })).status === 400 && (await call({ action: "setOrderDates", orderId: e1, dates: { manufacturedAt: null } })).status === 400);
  // OpenDecoDesk: dating an order's steps is a worker's job, like Edit order date (updateOrderDate).
  { const src = read("functions/api/orders.js"), staff = src.slice(src.indexOf("const STAFF_ACTIONS = ["), src.indexOf("];", src.indexOf("const STAFF_ACTIONS = [")));
    ok("setOrderDates is a worker's, like updateOrderDate", staff.includes('"setOrderDates"') && staff.includes('"updateOrderDate"')); }
  ok("…and nothing in the future", (await call({ action: "setOrderDates", orderId: e1, dates: { shippedAt: new Date(Date.now() + 86400000).toISOString() } })).status === 400);
  const e2 = await order("2026-01-10T12:00:00.000Z", 1);
  r = await call({ action: "setOrderDates", orderId: e2, dates: { placedAt: hoursAgo(10) } });
  ok("the order date can't move out of a closed month", r.status === 409 && /January 2026 is closed/.test(r.body.message));
  const e3 = await order(hoursAgo(100), 1, { deliveredAt: hoursAgo(20) });
  d1._raw.run("UPDATE orders SET paid=0 WHERE orderId=?", [e3]);
  r = await call({ action: "setOrderDates", orderId: e3, dates: { completedAt: hoursAgo(10) } });
  ok("Completed can't be set on an order that isn't paid", r.status === 409 && /can't be completed: a balance is still due/.test(r.body.message));
  const blk = await order(hoursAgo(100), 2, { blankOrderedAt: hoursAgo(90) });
  d1._raw.run("UPDATE order_items SET blankOrderedAt=? WHERE orderId=?", [hoursAgo(90), blk]);
  const recvAt = hoursAgo(40);
  r = await call({ action: "setOrderDates", orderId: blk, dates: { blankReceivedAt: recvAt } });
  ok("Blank received applies to every line and rolls up to the order", r.status === 200 && d1.q("SELECT COUNT(*) n FROM order_items WHERE orderId=? AND blankReceivedAt=?", blk, recvAt)[0].n === 2 && col(blk, "blankReceivedAt") === recvAt);

  console.log("\n=== Money and stock ===");
  const pay1 = await order(hoursAgo(100));
  d1._raw.run("UPDATE orders SET paid=0 WHERE orderId=?", [pay1]);
  r = await call({ action: "markPaidManual", orderId: pay1, at: hoursAgo(120) });
  ok("Mark as paid before the order date is refused", r.status === 409 && /before the order date/.test(r.body.message));
  const paidAt = hoursAgo(40);
  r = await call({ action: "markPaidManual", orderId: pay1, at: paidAt });
  const prow = d1.q("SELECT receivedAt FROM order_payments WHERE orderId=? AND voidedAt IS NULL", pay1)[0];
  ok("Mark as paid records the payment — and the order's paid date — when it was paid", r.status === 200 && prow && prow.receivedAt === paidAt && col(pay1, "paidAt") === paidAt);
  const pay2 = await order(hoursAgo(100));
  d1._raw.run("UPDATE orders SET paid=0 WHERE orderId=?", [pay2]);
  const gotAt = hoursAgo(30);
  r = await call({ action: "addPayment", orderId: pay2, amount: 5, method: "cash", at: gotAt });
  const pid = d1.q("SELECT id, receivedAt FROM order_payments WHERE orderId=? ORDER BY id DESC LIMIT 1", pay2)[0];
  ok("a payment in the payments window takes a date and time", r.status === 200 && pid.receivedAt === gotAt);
  const moved = hoursAgo(20);
  r = await call({ action: "setPaymentDate", paymentId: pid.id, orderId: pay2, at: moved });
  ok("…and its date and time can be changed", r.status === 200 && d1.q("SELECT receivedAt v FROM order_payments WHERE id=?", pid.id)[0].v === moved);
  const saleAt = hoursAgo(26);
  r = await call({ action: "createLocalSale", placedAt: saleAt, customerName: "Walk-in", items: [{ productId: "cap", size: "OSFA", qty: 1 }], paymentMethod: "Cash", paid: true, delivered: true });
  const sale = r.body.orderId;
  ok("a local sale: the order, its payment and its hand-over are all dated when the sale happened", r.status === 200 && col(sale, "placedAt") === saleAt && col(sale, "deliveredAt") === saleAt &&
    d1.q("SELECT receivedAt v FROM order_payments WHERE orderId=?", sale)[0].v === saleAt);
  r = await call({ action: "writeOffTransfers", transferId: 1, qty: 1, occurredAt: "garbage" });
  ok("a transfer write-off's date is checked (it was stored as typed)", r.status === 400);

  console.log("\n=== A local sale dated into a closed month ===");
  r = await call({ action: "createLocalSale", placedAt: "2026-01-15", customerName: "Walk-in", items: [{ productId: "cap", size: "OSFA", qty: 1 }], paymentMethod: "Cash" });
  ok("is refused (it was only checked against this month)", r.status === 409 && /January 2026 is closed/.test(r.body.message));

  console.log("\n=== The admin's date-and-time box ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o2){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o2); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#orders/acme", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Acme" }];');
  const p = w.askWhen_("Mark order X as delivered?");
  await wait(() => d.getElementById("cmWhen"));
  const box = d.getElementById("cmWhen");
  ok("the question shows a date-and-time box set to now (the admin's own time), no later than now", box.type === "datetime-local" && Math.abs(new Date(box.value) - Date.now()) < 120000 && !!box.max);
  box.value = "2099-01-01T10:00"; d.getElementById("cmOk").click();
  await new Promise(res => setTimeout(res, 20));
  ok("…a future time isn't accepted (it says why, and the window stays)", !!d.getElementById("cmWhen") && /future/.test(d.querySelector(".when-err").textContent));
  d.getElementById("cmWhen").value = "2026-10-20T15:30"; d.getElementById("cmOk").click();
  const at = await p;
  ok("…a past time is returned as that moment", at === new Date("2026-10-20T15:30").toISOString());
  const p2 = w.askWhen_("Mark it?");
  await wait(() => d.getElementById("cmCancel"));
  d.getElementById("cmCancel").click();
  ok("…Cancel returns nothing", (await p2) === null);
  // The stage menu sends it.
  const st = await order(hoursAgo(100), 1, { blankOrderedAt: hoursAgo(95), blankReceivedAt: hoursAgo(94), digitizingCompleteAt: hoursAgo(93) });
  sent.length = 0;
  const pr = w.setFulfillmentStage("acme", st, "manufactured");
  await wait(() => d.getElementById("cmWhen"));
  d.getElementById("cmWhen").value = w.localDateTime_(hoursAgo(5)); d.getElementById("cmOk").click();
  await pr;
  const sb = sent.find(b => b.action === "setFulfillmentStage");
  ok("an order's stage menu asks when, and sends it", sb && sb.at && Math.abs(Date.parse(sb.at) - Date.parse(hoursAgo(5))) < 61000 && col(st, "manufacturedAt") === sb.at);
  // The Dates… window.
  const ord = (await call({ action: "getOrders", org: "acme" })).body.orders || [];
  w.eval("window._ordersCache = window._ordersCache || {};");
  w._ordersCache.acme = ord;
  sent.length = 0;
  w.showOrderDates_("acme", e1);
  await wait(() => d.querySelector('.od-input[data-col="shippedAt"]'));
  ok("the Dates window lists every date on the order (in the admin's time), with the due date and paid", d.querySelectorAll(".od-input").length === 10 && !!d.querySelector(".od-due") &&
    d.querySelector('.od-input[data-col="shippedAt"]').value === w.localDateTime_(newShip) && d.querySelector('.od-input[data-col="deliveredAt"]').value === "" && /Paid/.test(d.querySelector(".od-due").closest("table").textContent));
  d.querySelector('.od-input[data-col="deliveredAt"]').value = w.localDateTime_(hoursAgo(30));
  d.getElementById("odSave").click();
  await wait(() => sent.some(b => b.action === "setOrderDates"));
  const sd = sent.find(b => b.action === "setOrderDates");
  ok("…Save sends only what changed", sd && Object.keys(sd.dates).join() === "deliveredAt" && !("dueDate" in sd));
  await wait(() => col(e1, "deliveredAt"));
  ok("…and it's saved", Math.abs(Date.parse(col(e1, "deliveredAt")) - Date.parse(hoursAgo(30))) < 61000);
  ok("each order has one Dates… button, and the ✎ by its order and due dates open the same window", /onclick="showOrderDates_\(this\.dataset\.org,this\.dataset\.order\)"[^>]*>Dates…</.test(adminJs) &&
    /async function editOrderDate\(btn\)\{ return showOrderDates_/.test(adminJs) && /async function editOrderDueDate\(btn\)\{ return showOrderDates_/.test(adminJs));
  ok("the receive, tracking and blank-ordered windows ask when too", /whenFieldHtml_\("blankReceivedWhen"/.test(adminJs) && /whenFieldHtml_\("trackWhen"/.test(adminJs) && /whenFieldHtml_\("blankOrderWhen"/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test157 crashed: false"); process.exit(1); });
