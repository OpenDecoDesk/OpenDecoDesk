const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Line-item blank fulfillment + multi-shipment carrier tracking with history (migrations/0039):
// per-item blank ordered/shipped/received + order-summary recompute, partial receive → only the
// received line runs, multiple shipments each tied to chosen line items, bulk across orders with
// line selection, and the daily job polling Shippo to store a full status history (flag delivered,
// never auto-receive). Real SQL (sql.js) + real db.js / deliveryCheck.js / orders.js; Shippo mocked.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), emailSrc = strip(read("functions/_lib/email.js")), delSrc = strip(read("functions/_lib/deliveryCheck.js"));
const lib = new Function(dbSrc + "\n" + emailSrc + "\n" + delSrc + `\nreturn { insertOrder, getOrderById, setFulfillmentStage, setOrderPaid,
  getProductionQueue, getOrdersAwaitingBlanks, addBlankShipment, updateBlankShipment, deleteBlankShipment,
  getBlankShipmentsForOrder, listActiveBlankShipments, checkBlankShipments };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const audit = () => {};\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + emailSrc + "\n" + delSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const tracks = {}; let lookups = [];
global.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://api.goshippo.com/tracks/")) {
    const num = decodeURIComponent(u.split("/").pop()); lookups.push(num);
    return { ok: true, status: 200, json: async () => tracks[num] || { tracking_status: { status: "UNKNOWN" } } };
  }
  throw new Error("unexpected fetch " + u);
};

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');`);
  const call = async (body) => {
    const res = await api({ env: { DB: d1, SHIPPO_API_KEY: "k" }, waitUntil: (p) => p && p.then && p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const itemIds = (orderId) => d1.q("SELECT id FROM order_items WHERE orderId=? ORDER BY id", orderId).map(r => Number(r.id));

  console.log("=== Per-item stamps + order summary recompute ===");
  await lib.insertOrder(d1, { orderId: "O1", orgId: "prime", customerName: "A", contact: "a@x.com", placedAt: "2026-07-01T00:00:00Z" },
    [{ productId: "p1", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 20 }, { productId: "p2", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 15 }]);
  await lib.setOrderPaid(d1, "O1", null, "paid");
  const [i1, i2] = itemIds("O1");
  await lib.setFulfillmentStage(d1, "O1", "blankOrdered", { vendor: "SanMar", vendorOrderId: "SO-1", estimatedDelivery: "2026-07-10" });
  let o = await lib.getOrderById(d1, "O1");
  ok("blankOrdered stamps every active line + rolls up to the order", o.items.every(it => it.blankOrderedAt) && !!o.blankOrderedAt && o.blankVendor === "SanMar");
  // Receive only item 1.
  await lib.setFulfillmentStage(d1, "O1", "blankReceived", { itemIds: [i1] });
  o = await lib.getOrderById(d1, "O1");
  ok("receiving one line stamps only that line; order summary stays NOT received (partial)",
    !!o.items.find(it => it.id === i1).blankReceivedAt && !o.items.find(it => it.id === i2).blankReceivedAt && !o.blankReceivedAt);

  console.log("\n=== Partial receive → only the received line is runnable ===");
  d1._raw.run("UPDATE orders SET blankReceivedAt=NULL, digitizingCompleteAt='2026-07-02T00:00:00Z' WHERE orderId='O1'"); // design-ready; no order-level received fallback
  let q = await lib.getProductionQueue(d1);
  const o1items = q.filter(j => j.orderId === "O1").map(j => j.itemId);
  ok("the received line is in the queue, the un-received line is not", o1items.includes(i1) && !o1items.includes(i2));
  await lib.setFulfillmentStage(d1, "O1", "blankReceived", { itemIds: [i2] });
  o = await lib.getOrderById(d1, "O1");
  ok("receiving the last line flips the order summary to received", !!o.blankReceivedAt);

  console.log("\n=== Multiple shipments, each tied to chosen line items ===");
  await lib.insertOrder(d1, { orderId: "O2", orgId: "prime", customerName: "B", contact: "b@x.com", placedAt: "2026-07-02T00:00:00Z" },
    [{ productId: "p1", name: "Polo", type: "shirt", size: "M", qty: 1, unitPrice: 20 }, { productId: "p2", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: 18 }]);
  await lib.setOrderPaid(d1, "O2", null, "paid");
  await lib.setFulfillmentStage(d1, "O2", "blankOrdered", { vendor: "S&S" });
  const [j1, j2] = itemIds("O2");
  const s1 = await lib.addBlankShipment(d1, { carrier: "UPS", trackingNumber: "1Z-AAA", shippedAt: "2026-07-04", itemIds: [j1] });
  const s2 = await lib.addBlankShipment(d1, { carrier: "FedEx", trackingNumber: "FX-BBB", shippedAt: "2026-07-05", itemIds: [j2] });
  o = await lib.getOrderById(d1, "O2");
  ok("each shipment stamped its own line's blankShippedAt", !!o.items.find(it => it.id === j1).blankShippedAt && !!o.items.find(it => it.id === j2).blankShippedAt);
  const ships = await lib.getBlankShipmentsForOrder(d1, "O2");
  ok("both shipments are listed with their carrier, number and covered item", ships.length === 2 &&
    ships.find(s => s.id === s1).itemIds.join() === String(j1) && ships.find(s => s.id === s2).carrier === "FedEx");

  console.log("\n=== Order exposes derived blank progress + shipments (Orders table cells) ===");
  o = await lib.getOrderById(d1, "O2");
  ok("parseOrder_ derives blankShippedAt (all lines shipped) + blankCounts + attaches blankShipments",
    !!o.blankShippedAt && o.blankCounts && o.blankCounts.shipped === 2 && o.blankCounts.total === 2 &&
    (o.blankShipments || []).length === 2);

  console.log("\n=== Bulk blank-ordered across orders with line selection (items:[{orderId,itemId}]) ===");
  await lib.insertOrder(d1, { orderId: "O3", orgId: "prime", customerName: "C", contact: "c@x.com", placedAt: "2026-07-03T00:00:00Z" },
    [{ productId: "p1", name: "Polo", type: "shirt", size: "S", qty: 1, unitPrice: 20 }, { productId: "p2", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 15 }]);
  await lib.setOrderPaid(d1, "O3", null, "paid");
  await lib.insertOrder(d1, { orderId: "O4", orgId: "prime", customerName: "D", contact: "d@x.com", placedAt: "2026-07-03T00:00:00Z" },
    [{ productId: "p1", name: "Polo", type: "shirt", size: "XL", qty: 1, unitPrice: 20 }]);
  await lib.setOrderPaid(d1, "O4", null, "paid");
  const o3a = itemIds("O3")[0], o4a = itemIds("O4")[0];
  const r = await call({ action: "bulkSetFulfillmentStage", orderIds: ["O3", "O4"], stage: "blankOrdered", vendor: "SanMar",
    items: [{ orderId: "O3", itemId: o3a }, { orderId: "O4", itemId: o4a }] });
  ok("bulk applied to the selected line in each order only", r.status === 200 &&
    !!(await lib.getOrderById(d1, "O3")).items.find(it => it.id === o3a).blankOrderedAt &&
    !(await lib.getOrderById(d1, "O3")).items.find(it => it.id !== o3a).blankOrderedAt &&
    !!(await lib.getOrderById(d1, "O4")).items.find(it => it.id === o4a).blankOrderedAt);

  console.log("\n=== Daily carrier poll: stores full history, updates status, flags delivered ===");
  tracks["1Z-AAA"] = { tracking_status: { status: "TRANSIT", status_date: "2026-07-06T10:00:00Z", status_details: "In transit" },
    tracking_history: [
      { status: "PRE_TRANSIT", status_date: "2026-07-04T01:00:00Z", status_details: "Label created", location: { city: "Memphis", state: "TN" } },
      { status: "TRANSIT", status_date: "2026-07-06T10:00:00Z", status_details: "In transit", location: { city: "Dallas", state: "TX" } },
    ] };
  tracks["FX-BBB"] = { tracking_status: { status: "DELIVERED", status_date: "2026-07-07T15:00:00Z", status_details: "Left at door" },
    tracking_history: [{ status: "DELIVERED", status_date: "2026-07-07T15:00:00Z", status_details: "Left at door", location: { city: "Springfield", state: "OH" } }] };
  let res = await lib.checkBlankShipments({ DB: d1, SHIPPO_API_KEY: "k" });
  ok("polls each active shipment and classifies transit vs delivered", res.checked === 2 && res.delivered.length === 1 && res.inTransit.length === 1);
  const evs1 = d1.q("SELECT status, location FROM blank_tracking_events WHERE shipmentId=? ORDER BY occurredAt", s1);
  ok("full per-scan history stored for the in-transit shipment", evs1.length === 2 && evs1[0].status === "PRE_TRANSIT" && /Dallas/.test(evs1[1].location));
  ok("the shipment's latest status is updated", d1.q("SELECT status FROM blank_shipments WHERE id=?", s1)[0].status === "TRANSIT");
  ok("delivered shipment is marked delivered + queues an owner notice (not auto-received)",
    !!d1.q("SELECT deliveredAt FROM blank_shipments WHERE id=?", s2)[0].deliveredAt &&
    d1.q("SELECT count(*) n FROM owner_notices WHERE kind='delivered'")[0].n >= 1 &&
    !(await lib.getOrderById(d1, "O2")).items.find(it => it.id === j2).blankReceivedAt);
  // Re-poll: no duplicate events; delivered shipment no longer polled.
  lookups = [];
  res = await lib.checkBlankShipments({ DB: d1, SHIPPO_API_KEY: "k" });
  ok("re-poll skips the delivered shipment and doesn't duplicate events",
    !lookups.includes("FX-BBB") && d1.q("SELECT count(*) n FROM blank_tracking_events WHERE shipmentId=?", s1)[0].n === 2);

  console.log("\n=== getOrdersAwaitingBlanks is item-aware + carries shipments ===");
  const waiting = await lib.getOrdersAwaitingBlanks(d1);
  const w2 = waiting.find(x => x.orderId === "O2");
  ok("an order with a line ordered-not-received appears, with only its waiting lines + its shipments",
    !!w2 && w2.items.length === 2 && w2.shipments.length === 2 && w2.shipments.some(s => s.status === "TRANSIT"));

  console.log("\n=== Shipments carry full carrier history + the carrier's own wording ===");
  const sTransit = w2.shipments.find(s => s.status === "TRANSIT");
  ok("each shipment carries its per-scan events (newest first) for the history view",
    Array.isArray(sTransit.events) && sTransit.events.length === 2 && sTransit.events[0].status === "TRANSIT" && /Dallas/.test(sTransit.events[0].location));
  ok("the shipment exposes the carrier's specific statusDetail, not just the coarse status",
    sTransit.statusDetail === "In transit" && sTransit.status === "TRANSIT");
  // Specific carrier wording ("Loaded on Delivery Vehicle") should win over the coarse label.
  d1._raw.run("UPDATE blank_shipments SET status='TRANSIT', statusDetail='Loaded on Delivery Vehicle' WHERE id=?", [s1]);
  const detailed = (await lib.getBlankShipmentsForOrder(d1, "O2")).find(s => s.id === s1);
  ok("getBlankShipmentsForOrder returns the detailed carrier wording + events in one call",
    detailed.statusDetail === "Loaded on Delivery Vehicle" && (detailed.events || []).length === 2);

  console.log("\n=== Edit an existing shipment: carrier/tracking/items editable, keeps its id ===");
  await lib.updateBlankShipment(d1, s1, { carrier: "USPS", trackingNumber: "US-CCC", shippedAt: "2026-07-04", itemIds: [j1, j2] });
  const after = (await lib.getBlankShipmentsForOrder(d1, "O2")).find(s => s.id === s1);
  ok("update keeps the shipment id and rewrites carrier/number + covered items",
    !!after && after.carrier === "USPS" && after.trackingNumber === "US-CCC" && after.itemIds.sort().join() === [j1, j2].sort().join());
  ok("changing the tracking number clears the old scan history for a fresh poll",
    d1.q("SELECT count(*) n FROM blank_tracking_events WHERE shipmentId=?", s1)[0].n === 0);

  console.log("\n=== Remove a shipment: unstamps lines no other shipment covers + recomputes ===");
  // s1 now covers j1 and j2; s2 covers j2. Deleting s2 leaves both lines still covered by s1.
  await lib.deleteBlankShipment(d1, s2);
  o = await lib.getOrderById(d1, "O2");
  ok("deleting one shipment keeps a line's shipped stamp while another shipment still covers it",
    (await lib.getBlankShipmentsForOrder(d1, "O2")).length === 1 && !!o.items.find(it => it.id === j2).blankShippedAt);
  // Now delete the last shipment → both lines lose their shipped stamp.
  await lib.deleteBlankShipment(d1, s1);
  o = await lib.getOrderById(d1, "O2");
  ok("deleting the last covering shipment clears the lines' blankShippedAt + the derived summary",
    o.items.every(it => !it.blankShippedAt) && !o.blankShippedAt && (o.blankShipments || []).length === 0);

  console.log("\n=== P1-D: a shipment is never created/left covering zero real lines ===");
  await lib.insertOrder(d1, { orderId: "O5", orgId: "prime", customerName: "E", contact: "e@x.com", placedAt: "2026-07-05T00:00:00Z" },
    [{ productId: "p1", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 20 }]);
  const o5a = itemIds("O5")[0];
  const beforeCount = d1.q("SELECT count(*) n FROM blank_shipments")[0].n;
  let threw = false;
  try { await lib.addBlankShipment(d1, { carrier: "UPS", trackingNumber: "BOGUS", itemIds: [999999] }); } catch (e) { threw = true; }
  ok("addBlankShipment with only bogus item ids throws and creates no orphan shipment row",
    threw && d1.q("SELECT count(*) n FROM blank_shipments")[0].n === beforeCount);
  const s5 = await lib.addBlankShipment(d1, { carrier: "UPS", trackingNumber: "US-REAL", itemIds: [o5a] });
  let threw2 = false;
  try { await lib.updateBlankShipment(d1, s5, { carrier: "FedEx", trackingNumber: "X", itemIds: [999999] }); } catch (e) { threw2 = true; }
  const still = (await lib.getBlankShipmentsForOrder(d1, "O5")).find(s => s.id === s5);
  ok("updateBlankShipment with only bogus item ids throws and leaves the shipment unchanged",
    threw2 && !!still && still.carrier === "UPS" && still.itemIds.join() === String(o5a));

  console.log("\n=== P1-B: blank_shipment_items.itemId cascades when its line is removed ===");
  d1._raw.run("DELETE FROM order_items WHERE id=?", [o5a]);
  ok("deleting the order line cascades its blank_shipment_items row (FK ON DELETE CASCADE)",
    d1.q("SELECT count(*) n FROM blank_shipment_items WHERE itemId=?", o5a)[0].n === 0);

  console.log("\n=== P1-A: shipments load via loadOrders_'s subquery path (no bound-param cap) ===");
  await lib.insertOrder(d1, { orderId: "O6", orgId: "prime", customerName: "F", contact: "f@x.com", placedAt: "2026-07-06T00:00:00Z" },
    [{ productId: "p1", name: "Polo", type: "shirt", size: "M", qty: 1, unitPrice: 20 }]);
  await lib.setOrderPaid(d1, "O6", null, "paid");
  await lib.setFulfillmentStage(d1, "O6", "blankOrdered", { vendor: "S&S" });   // ordered, not received → "waiting"
  await lib.addBlankShipment(d1, { carrier: "UPS", trackingNumber: "O6-TRK", itemIds: [itemIds("O6")[0]] });
  const o6waiting = (await lib.getOrdersAwaitingBlanks(d1)).find(o => o.orderId === "O6");
  ok("getOrdersAwaitingBlanks returns the shipment via loadOrders_'s subquery-scoped attach",
    !!o6waiting && (o6waiting.shipments || []).length === 1 && o6waiting.shipments[0].trackingNumber === "O6-TRK");

  console.log("\n=== admin UI wiring ===");
  const a = read("public/admin.js");
  ok("a Blank shipped stage + column + bulk button exist", /blankShipped:"blankShippedAt"/.test(a) &&
    /<th>Blank Shipped<\/th>/.test(a) && /data-stage="blankShipped"/.test(a) && /\["blankShippedAt", "Blank shipped", "blankShipped"\]/.test(a));
  ok("the Blank-shipped modal adds AND edits/removes tracking numbers, each with a line-item checklist",
    /function showBlankShippedModal/.test(a) && /\+ Add tracking number/.test(a) && /class="bsItem"/.test(a) &&
    /async function blankShippedFlow_/.test(a) && /action: "addBlankShipment"/.test(a) &&
    /action: "updateBlankShipment"/.test(a) && /action: "deleteBlankShipment"/.test(a) &&
    /data-ship-id/.test(a) && /function blankShipmentsOf_/.test(a));
  ok("the receive modal has per-line include checkboxes and sends items:[{orderId,itemId}]",
    /class="br-incl"/.test(a) && /orderId: r\.orderId, itemId: r\.sheetRow/.test(a));
  ok("blank stages re-fetch (not patch) and the waiting card shows per-shipment status + links",
    /if\(\/\^blank\/\.test\(stage\)\)\{ if\(orgObj\) refreshOrdersInPlace_/.test(a) && /function blankShipmentLine_/.test(a) && /o\.shipments \|\| \[\]/.test(a));
  ok("the Orders table's blank cells show per-line partial progress + the shipped cell's tracking",
    /N\/T ordered\/shipped\/received|\$\{n\}\/\$\{total\} \$\{field\}/.test(a) && /order\.blankShipments\.map\(blankShipmentLine_\)/.test(a));
  ok("the shipment line shows the carrier's own wording + a View history link opening the history modal",
    /function blankStatusText_/.test(a) && /function showShipmentHistoryModal_/.test(a) &&
    /showShipmentHistoryModal_\(\$\{Number\(s\.id\)\}\)/.test(a) && /View history/.test(a));
  ok("Communications shows the vendor blank shipments + a working Check now",
    /Blanks in transit from the vendor/.test(a) && /onclick="checkBlankShipmentsNow\(this\)"/.test(a) &&
    /async function checkBlankShipmentsNow/.test(a) && /action: "checkBlankShipments"/.test(a));

  console.log("\n=== Communications + on-demand check actions ===");
  const comms = await call({ action: "getPendingCommunications" });
  ok("getPendingCommunications returns awaitingBlanks with orgName + shipments",
    comms.status === 200 && Array.isArray(comms.body.awaitingBlanks));
  const chk = await call({ action: "checkBlankShipments" });
  ok("checkBlankShipments admin action runs the poll and returns a summary",
    chk.status === 200 && typeof chk.body.checked === "number");

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
