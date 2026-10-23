const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Catch-up: use blanks for past orders — real SQL (sql.js), real db.js,
// real orders.js admin API.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, receiveBlanks, writeOffBlanks, consumeBlanksForOrder,
  setFulfillmentStage, updateBlank, getAllBlanks, deleteBlank, getBlankMovements, getInventoryValuation, getCogsReport, createBlank, cancelLineItem, planBlankCatchUp, applyBlankCatchUp };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
      ('polo','prime','shirt','Polo','sized',NULL,'{"S":23,"M":23}','t','t'), ('mug','prime','cap','Mug','flat',12,'{}','t','t');
    INSERT INTO blanks (id, name, brand, color, createdAt, updatedAt) VALUES (1,'Sport-Tek polo','Sport-Tek','Kelly','t','t');
    INSERT INTO blank_sizes (blankId, size, purchasePrice, quantity) VALUES (1,'S',0,0),(1,'M',0,0);
    INSERT INTO product_blank_links (orgId, productId, productSize, blankId, blankSize) VALUES ('prime','polo','S',1,'S'),('prime','polo','M',1,'M');
  `);
  for(const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const qty = (size) => d1.q("SELECT quantity FROM blank_sizes WHERE blankId=1 AND size=?", size)[0].quantity;
  const sumMoves = (size) => d1.q("SELECT COALESCE(SUM(qtyDelta),0) s FROM inventory_movements WHERE blankId=1 AND size=?", size)[0].s;
  const order = async (id, size, qtyN, dates = {}, extra = {}) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "Cust " + id, contact: id + "@x.com", placedAt: "2026-07-01T00:00:00Z" },
      [{ productId: extra.productId || "polo", name: "Polo", type: "shirt", size, qty: qtyN, unitPrice: 23 }]);
    for (const [col, v] of Object.entries(dates)) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]);
  };

  // Receipts entered AFTER the fact, dated in the past.
  await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "S", qty: 5, unitCost: 3.00 }], receivedAt: "2026-08-01T12:00:00.000Z" });
  await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "S", qty: 5, unitCost: 5.00 }], receivedAt: "2026-08-15T12:00:00.000Z" });
  await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "M", qty: 2, unitCost: 6.00 }], receivedAt: "2026-08-25T12:00:00.000Z" });

  await order("A", "S", 2, { manufacturedAt: "2026-08-10T12:00:00.000Z" });                       // made, no cost
  await order("B", "S", 1, { deliveredAt: "2026-08-20T12:00:00.000Z" });                          // delivered, never marked manufactured
  await order("F", "M", 1, { manufacturedAt: "2026-09-01T12:00:00.000Z" });
  d1._raw.run("UPDATE order_items SET cogsCents=999, cogsSource='estimate' WHERE orderId='F'");      // migration-style estimate
  await order("H", "M", 1, { manufacturedAt: "2026-08-01T00:00:00.000Z" });                       // made before any M was received
  await order("C", "S", 1, {});                                                                    // not made yet
  await order("V", "S", 1, { manufacturedAt: "2026-08-05T12:00:00.000Z", voidedAt: "2026-08-06T00:00:00.000Z" });
  await order("X", "S", 1, { manufacturedAt: "2026-08-05T12:00:00.000Z" }); d1._raw.run("UPDATE order_items SET cancelDate='2026-08-06' WHERE orderId='X'");
  await order("G", "", 1, { manufacturedAt: "2026-08-05T12:00:00.000Z" }, { productId: "mug" });   // not linked to a blank
  await order("R", "S", 1, { manufacturedAt: "2026-08-12T12:00:00.000Z" }); d1._raw.run("UPDATE order_items SET cogsCents=349, cogsSource='consumed' WHERE orderId='R'");

  console.log("=== Preview ===");
  let r = await call({ action: "previewBlankCatchUp" });
  const L = r.body.lines, byOrder = (id) => L.find(l => l.orderId === id);
  console.log("only made, linked, real lines without a real cost qualify (A, B, F, H):", r.status === 200 && JSON.stringify(L.map(l => l.orderId).sort()) === '["A","B","F","H"]');
  console.log("not-yet-made, voided, cancelled, unlinked and already-costed lines are left out:", !["C", "V", "X", "G", "R"].some(id => byOrder(id)));
  console.log("A (8/10, 2 blanks) is priced at the $3.00 average of what had been received by then → $6.00:", byOrder("A").unitCost === 3 && byOrder("A").cost === 6);
  console.log("B (8/20) uses the running average after the $5.00 receipt and A's use: (3×$3 + 5×$5) / 8 = $4.25:", byOrder("B").unitCost === 4.25 && byOrder("B").cost === 4.25);
  console.log("F's estimate is replaced by the real average ($6.00) and shows what it replaces:", byOrder("F").cost === 6 && byOrder("F").oldCost === 9.99);
  console.log("H was made before any M was received: short 1, priced at the current cost with a note:", byOrder("H").shortBy === 1 && byOrder("H").cost === 6 && /no purchase yet/.test(byOrder("H").costNote));
  console.log("totals: 5 blanks, $22.25 (6 + 4.25 + 6 + 6), 1 short line, $9.99 of estimate replaced:", r.body.totalUnits === 5 && r.body.total === 22.25 && r.body.shortLines === 1 && r.body.replacedEstimate === 9.99);
  console.log("preview writes nothing:", d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='consume'")[0].n === 0 && qty("S") === 10);

  console.log("\n=== Closed months and validation ===");
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-08','t','test')");
  r = await call({ action: "previewBlankCatchUp" });
  console.log("lines in a closed month are flagged locked:", r.body.lines.find(l => l.orderId === "A").locked === true && r.body.lines.find(l => l.orderId === "F").locked === false);
  r = await call({ action: "applyBlankCatchUp", itemIds: [byOrder("A").itemId, byOrder("F").itemId] });
  console.log("applying any line dated in a closed month is refused (409) and changes nothing:", r.status === 409 && /closed/.test(r.body.message) && d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='consume'")[0].n === 0);
  r = await call({ action: "applyBlankCatchUp", itemIds: [] });
  console.log("nothing ticked is refused:", r.status === 400);
  d1._raw.run("DELETE FROM closed_periods");

  console.log("\n=== Apply ===");
  r = await call({ action: "applyBlankCatchUp", itemIds: [byOrder("A").itemId, byOrder("B").itemId, byOrder("F").itemId] });
  console.log("applies just the ticked lines (H left for later):", r.status === 200 && r.body.applied === 3 && r.body.totalUnits === 4 && r.body.total === 16.25);
  const mv = d1.q("SELECT orderId, size, qtyDelta, unitCostCents, occurredAt, kind FROM inventory_movements WHERE kind='consume' ORDER BY occurredAt");
  console.log("each use is a consume movement dated the day the order was made:", JSON.stringify(mv.map(m => [m.orderId, m.qtyDelta, m.unitCostCents, m.occurredAt.slice(0, 10)])) === '[["A",-2,300,"2026-08-10"],["B",-1,425,"2026-08-20"],["F",-1,600,"2026-09-01"]]');
  const ci = (id) => d1.q("SELECT cogsCents, cogsSource FROM order_items WHERE orderId=?", id)[0];
  console.log("lines now carry the real cost (source 'consumed'), the estimate is gone:", ci("A").cogsCents === 600 && ci("B").cogsCents === 425 && ci("F").cogsCents === 600 && ["A", "B", "F"].every(id => ci(id).cogsSource === "consumed"));
  console.log("stock: S 10 → 7, M 2 → 1, and stock still equals the movement history:", qty("S") === 7 && qty("M") === 1 && qty("S") === sumMoves("S") && qty("M") === sumMoves("M"));
  console.log("the audit log records the lines:", d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.catch_up'")[0].n === 1);
  r = await call({ action: "applyBlankCatchUp", itemIds: [byOrder("A").itemId] });
  console.log("doing it again is refused — nothing is taken twice:", r.status === 400 && qty("S") === 7);
  r = await call({ action: "previewBlankCatchUp" });
  console.log("only H is still waiting:", JSON.stringify(r.body.lines.map(l => l.orderId)) === '["H"]');

  console.log("\n=== COGS report and later orders ===");
  r = await call({ action: "getInventoryReport", dateFrom: "2026-01-01", dateTo: "2099-12-31" });
  const aug = r.body.cogs.rows.find(x => x.month === "2026-08"), sep = r.body.cogs.rows.find(x => x.month === "2026-09");
  console.log("August COGS is $10.25 real (A + B), September $6.00 (F) with no estimate left in it:", aug.cogs === 10.25 && aug.estimatedPart === 0 && sep.cogs === 6 && sep.estimatedPart === 0);
  await lib.setFulfillmentStage(d1, "C", "manufactured");
  console.log("an order marked manufactured later still consumes normally:", qty("S") === 6 && d1.q("SELECT cogsSource FROM order_items WHERE orderId='C'")[0].cogsSource === "consumed");
  const adminJs = read("public/admin.js");
  console.log("Inventory & COGS screen has the catch-up button and window:", /id="cogsCatchUp"/.test(adminJs) && /async function showBlankCatchUp_/.test(adminJs) && /action: "applyBlankCatchUp"/.test(adminJs));
})();
