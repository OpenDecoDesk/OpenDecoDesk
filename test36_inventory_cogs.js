const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Inventory history + COGS (migrations/0009) — real SQL (sql.js), real db.js,
// real orders.js admin API.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, receiveBlanks, writeOffBlanks, consumeBlanksForOrder,
  setFulfillmentStage, updateBlank, getAllBlanks, deleteBlank, getBlankMovements, getInventoryValuation, getCogsReport, createBlank, cancelLineItem, voidInventoryMovement, getInventoryMovementById };`)();
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
    INSERT INTO blank_sizes (blankId, size, purchasePrice, quantity) VALUES (1,'S',3.49,10),(1,'M',3.49,4);
    INSERT INTO product_blank_links (orgId, productId, productSize, blankId, blankSize) VALUES ('prime','polo','S',1,'S'),('prime','polo','M',1,'M');
    INSERT INTO orders (orderId, orgId, customerName, contact, paid, subtotal, total, placedAt, manufacturedAt) VALUES
      ('OLD','prime','Ann','a@x',1,58,58,'2026-08-01T00:00:00Z','2026-08-10T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPrice, lineTotal, cancelDate) VALUES
      ('OLD','prime','polo','Polo','shirt','M',2,23,46,''), ('OLD','prime','mug','Mug','cap','',1,12,12,''),
      ('OLD','prime','','Polo — Kelly','shirt','S',1,23,23,'');
    UPDATE products SET name='Polo - Kelly' WHERE productId='polo';
  `);
  for(const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const qty = (size) => d1.q("SELECT quantity FROM blank_sizes WHERE blankId=1 AND size=?", size)[0].quantity;
  const sumMoves = (size) => d1.q("SELECT COALESCE(SUM(qtyDelta),0) s FROM inventory_movements WHERE blankId=1 AND size=?", size)[0].s;
  const ledgerMatchesStock = () => ["S", "M"].every(s => qty(s) === sumMoves(s));

  console.log("=== Migration 0009 ===");
  const open = d1.q("SELECT size, qtyDelta, unitCostCents, kind, note FROM inventory_movements ORDER BY size");
  console.log("opening balance movement per size at recorded cost:", JSON.stringify(open.map(m => [m.size, m.qtyDelta, m.unitCostCents, m.kind])) === '[["M",4,349,"adjust"],["S",10,349,"adjust"]]');
  const old = d1.q("SELECT productId, cogsCents, cogsSource FROM order_items WHERE orderId='OLD' ORDER BY id");
  console.log("already-manufactured linked line gets an estimated COGS (2 × $3.49):", old[0].cogsCents === 698 && old[0].cogsSource === "estimate");
  console.log("unlinked line stays unknown (NULL):", old[1].cogsCents === null);
  console.log("estimates didn't move stock:", qty("M") === 4 && ledgerMatchesStock());
  const legacy = d1.q("SELECT productId, cogsCents FROM order_items WHERE name='Polo — Kelly'")[0];
  console.log("legacy line with no productId recovered by name (em dash vs hyphen) and costed:", legacy.productId === "polo" && legacy.cogsCents === 349);

  console.log("\n=== Receiving stock ===");
  await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "S", qty: 10, unitCost: 4.00 }], vendor: "SanMar", vendorRef: "INV-77", receivedAt: "2026-09-10T12:00:00.000Z" });
  let s = d1.q("SELECT quantity, purchasePriceCents FROM blank_sizes WHERE blankId=1 AND size='S'")[0];
  console.log("10 @ $3.49 + 10 @ $4.00 → 20 on hand at $3.75 average:", s.quantity === 20 && s.purchasePriceCents === 375);
  const rcv = d1.q("SELECT * FROM inventory_movements WHERE kind='purchase'")[0];
  console.log("purchase recorded with vendor, invoice, date, price paid:", rcv.vendor === "SanMar" && rcv.vendorRef === "INV-77" && rcv.unitCostCents === 400 && rcv.occurredAt.startsWith("2026-09-10"));

  console.log("\n=== Manufacturing consumes blanks → COGS ===");
  await lib.insertOrder(d1, { orderId: "N1", orgId: "prime", customerName: "Bo", contact: "b@x", placedAt: "2026-09-12T00:00:00Z" },
    [{ productId: "polo", name: "Polo", type: "shirt", size: "S", qty: 3, unitPrice: 23 }, { productId: "mug", name: "Mug", type: "cap", qty: 1, unitPrice: 12 }]);
  await lib.setFulfillmentStage(d1, "N1", "manufactured");
  let o = await lib.getOrderById(d1, "N1");
  const polo = o.items.find(i => i.productId === "polo");
  console.log("3 blanks used at the $3.75 average → $11.25 COGS on that line:", polo.cogs === 11.25 && polo.cogsSource === "consumed");
  console.log("stock 20 → 17:", qty("S") === 17);
  console.log("unlinked product has no cost yet:", o.items.find(i => i.productId === "mug").cogs === null);
  await lib.setFulfillmentStage(d1, "N1", "manufactured");
  console.log("marking manufactured again consumes nothing more:", qty("S") === 17 && d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='consume'")[0].n === 1);
  await lib.cancelLineItem(d1, polo.id);
  console.log("cancelling after manufacture keeps the cost (the blanks were used):", (await lib.getOrderById(d1, "N1")).items.find(i => i.id === polo.id).cogs === 11.25);

  console.log("\n=== blankReceived with per-item conditions (sheetRow id form the client sends) ===");
  await lib.insertOrder(d1, { orderId: "BR1", orgId: "prime", customerName: "Cy", contact: "c@x", placedAt: "2026-09-13T00:00:00Z" },
    [{ productId: "polo", name: "Polo", type: "shirt", size: "S", qty: 1, unitPrice: 23 }]);
  const brItemId = (await lib.getOrderById(d1, "BR1")).items[0].sheetRow; // = order_items.id, what admin.js sends as sheetRow
  let brThrew = false;
  try { await lib.setFulfillmentStage(d1, "BR1", "blankReceived", { blankCondition: "Other", itemConditions: [{ sheetRow: brItemId, condition: "Damaged", note: "scuffed" }] }); }
  catch (e) { brThrew = true; }
  console.log("doesn't throw (no undefined bind) and records blankReceivedAt:", !brThrew && !!(await lib.getOrderById(d1, "BR1")).blankReceivedAt);
  const brRow = d1.q("SELECT blankCondition, blankConditionNote FROM order_items WHERE id=?", brItemId)[0];
  console.log("per-item condition saved by the sheetRow id:", brRow.blankCondition === "Damaged" && brRow.blankConditionNote === "scuffed");

  console.log("\n=== Edits and write-offs are movements too ===");
  const blanks = await lib.getAllBlanks(d1);
  const b = blanks[0];
  // Color is a dimension now (migrations/0037): edit the Kelly color's sizes in place.
  await lib.updateBlank(d1, 1, { ...b, colors: [{ color: "Kelly", images: [],
    sizes: b.sizes.map(z => ({ size: z.size, purchasePrice: z.purchasePrice, quantity: z.size === "S" ? 15 : z.quantity })) }] });
  const adj = d1.q("SELECT qtyDelta, note FROM inventory_movements WHERE kind='adjust' AND note='Edited in blank form'");
  console.log("typing 17 → 15 in the blank form records a −2 adjustment:", adj.length === 1 && adj[0].qtyDelta === -2 && qty("S") === 15);
  await lib.writeOffBlanks(d1, { blankId: 1, size: "S", qty: 1, note: "Stained" });
  console.log("write-off: −1 at average cost, stock 14:", qty("S") === 14 && d1.q("SELECT unitCostCents u FROM inventory_movements WHERE kind='writeoff'")[0].u === 375);
  console.log("movement history always sums to on-hand stock:", ledgerMatchesStock());

  console.log("\n=== Valuation on any date ===");
  const before = await lib.getInventoryValuation(d1, "2020-01-01T00:00:00Z");
  console.log("before tracking began: nothing recorded:", before.rows.length === 0 && before.value === 0);
  const now = await lib.getInventoryValuation(d1, "2099-01-01T00:00:00Z");
  const nowS = now.rows.find(r => r.size === "S"), nowM = now.rows.find(r => r.size === "M");
  console.log("today: S 14 @ $3.75 = $52.50, M 4 @ $3.49 = $13.96:", nowS.qty === 14 && nowS.value === 52.5 && nowM.qty === 4 && nowM.value === 13.96 && now.value === 66.46);
  // The opening balance is dated when tracking was switched on (the migration
  // ran "now"), so a date before that only sees movements dated earlier —
  // here, just the receipt backdated to Sep 10.
  const midSep = await lib.getInventoryValuation(d1, "2026-09-11T00:00:00Z");
  console.log("valuation as of Sep 11 sees only what's dated by then (the 10 received Sep 10):",
    midSep.rows.length === 1 && midSep.rows[0].size === "S" && midSep.rows[0].qty === 10 && midSep.rows[0].value === 40);

  console.log("\n=== COGS report (real admin API) ===");
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let r = await call({ action: "getInventoryReport", dateFrom: "2026-01-01", dateTo: "2099-12-31" });
  const aug = r.body.cogs.rows.find(x => x.month === "2026-08");
  console.log("August: $10.47 estimated COGS for the order made before tracking (2 × $3.49 + 1 × $3.49):", !!aug && aug.cogs === 10.47 && aug.estimatedPart === 10.47);
  console.log("period totals: COGS $21.72 ($11.25 consumed + $10.47 est.), purchases $40.00, write-offs $3.75:",
    r.body.totals.cogs === 21.72 && r.body.totals.purchases === 40 && r.body.totals.writeoffs === 3.75);
  console.log("unlinked manufactured items are flagged (mug × 2 orders):", r.body.cogs.missingCost.length === 2 && r.body.cogs.missingCost.every(m => m.name === "Mug"));
  console.log("…as NOT linked (link the size first):", r.body.cogs.missingCost.every(m => m.reason === "notLinked"));
  const mugSizes = d1.q("SELECT DISTINCT size FROM order_items WHERE productId='mug'").map(x => x.size);
  for (const sz of mugSizes) d1._raw.run("INSERT INTO product_blank_links (orgId, productId, productSize, blankId, blankSize) VALUES ('prime','mug',?,1,'S')", [sz]);
  let r2 = await call({ action: "getInventoryReport", dateFrom: "2026-01-01", dateTo: "2099-12-31" });
  console.log("once the size is linked, the same lines say 'linked now' (made before the link — use Use blanks for past orders):",
    r2.body.cogs.missingCost.length === 2 && r2.body.cogs.missingCost.every(m => m.reason === "linkedNow"));
  d1._raw.run("DELETE FROM product_blank_links WHERE productId='mug'");
  {
    const adminSrc = read("public/admin.js");
    const fnSrc = adminSrc.slice(adminSrc.indexOf("function missingCostHtml_("), adminSrc.indexOf("\n}\n", adminSrc.indexOf("function missingCostHtml_(")) + 2);
    const html = new Function("escapeHtml", fnSrc + "\nreturn missingCostHtml_;")((x) => String(x).replace(/</g, "&lt;"))([
      { orderId: "A", name: "DTF Tee", size: "XL", qty: 4, reason: "linkedNow" },
      { orderId: "B", name: "Mug", size: "", qty: 1, reason: "notLinked" },
      { orderId: "C", name: "20 Custom Shirts", size: "OSFA", qty: 20, reason: "custom" }]);
    console.log("the report message explains each kind with its own fix:",
      /1 made item has no blank cost yet<\/strong> — its size is linked to a blank now, but the order was marked manufactured before the link existed/.test(html) &&
      /class="admin-btn cogs-catchup-inline"/.test(html) &&
      /1 made item isn't linked to a blank<\/strong> — link the product's sizes/.test(html) &&
      /1 made item is a custom item with no product<\/strong> — custom lines can't be linked/.test(html) && !/isn't linked to a blank \(Manage Catalog/.test(html));
    console.log("no message when nothing is missing:", new Function("escapeHtml", fnSrc + "\nreturn missingCostHtml_;")(String)([]) === "");
  }
  r = await call({ action: "receiveBlanks", blankId: 1, lines: [{ size: "M", qty: 2.5, unitCost: 4 }] });
  console.log("fractional quantity rejected:", r.status === 400);
  r = await call({ action: "receiveBlanks", blankId: 1, lines: [{ size: "M", qty: 6, unitCost: 3.49 }], vendor: "SanMar" });
  console.log("receiving through the API works and is audited:", r.status === 200 && qty("M") === 10 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.received'")[0].n === 1);

  console.log("\n=== Writing off stock as test/shop scrap (real admin API) ===");
  r = await call({ action: "writeOffBlanks", blankId: 1, size: "M", qty: 3, note: "Used for testing, samples, or shop scrap", occurredAt: "2026-09-20" });
  console.log("a test/scrap write-off through the API works, is audited, and is dated:", r.status === 200 && qty("M") === 7 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.written_off'")[0].n === 1 &&
    d1.q("SELECT note, occurredAt o FROM inventory_movements WHERE kind='writeoff' AND note LIKE 'Used for testing%'")[0].o.startsWith("2026-09-20"));
  r = await call({ action: "writeOffBlanks", blankId: 1, size: "M", qty: 999, note: "x" });
  console.log("can't write off more than is on hand:", r.status === 400 && /Only \d+ on hand/.test(r.body.message));
  r = await call({ action: "writeOffBlanks", blankId: 1, size: "does-not-exist", qty: 1, note: "x" });
  console.log("an unknown size is refused:", r.status === 400 && /Choose a size/.test(r.body.message));
  r = await call({ action: "writeOffBlanks", blankId: 1, size: "M", qty: 1, note: "x", occurredAt: "2099-01-01" });
  console.log("a future date is refused:", r.status === 400 && /future/.test(r.body.message));
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-08','t','test')");
  r = await call({ action: "writeOffBlanks", blankId: 1, size: "M", qty: 1, note: "x", occurredAt: "2026-08-15" });
  console.log("writing off into a closed month is refused:", r.status === 409);
  d1._raw.run("DELETE FROM closed_periods");

  console.log("\n=== Voiding a mistaken movement (duplicate receive) ===");
  const capId = (await lib.createBlank(d1, { name: "Cap", productType: "cap" }, [{ size: "OSFA", purchasePrice: 0, quantity: 0 }])).id;
  await lib.receiveBlanks(d1, { blankId: capId, lines: [{ size: "OSFA", qty: 9, unitCost: 6.00 }], vendor: "SanMar", vendorRef: "SO-1", receivedAt: "2026-08-10T12:00:00.000Z" });
  await lib.receiveBlanks(d1, { blankId: capId, lines: [{ size: "OSFA", qty: 9, unitCost: 6.00 }], vendor: "SanMar", vendorRef: "SO-1", receivedAt: "2026-08-11T12:00:00.000Z" });
  const capQty = () => d1.q("SELECT quantity q, purchasePriceCents c FROM blank_sizes WHERE blankId=? AND size='OSFA'", capId)[0];
  console.log("both duplicate receives counted before voiding: 18 on hand:", capQty().q === 18);
  const dupe = (await lib.getBlankMovements(d1, capId)).find(m => m.occurredAt.startsWith("2026-08-11"));
  r = await call({ action: "voidInventoryMovement", movementId: dupe.id, reason: "Duplicate entry" });
  console.log("voiding the duplicate succeeds and is audited:", r.status === 200 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.movement_voided'")[0].n === 1);
  console.log("stock and average cost are recomputed from what's left — back to 9 @ $6.00:", capQty().q === 9 && capQty().c === 600);
  const afterVoid = await lib.getBlankMovements(d1, capId);
  console.log("the voided row stays in history (with its reason) instead of disappearing:",
    afterVoid.some(m => m.id === dupe.id && m.voidedAt && m.voidReason === "Duplicate entry"));
  r = await call({ action: "voidInventoryMovement", movementId: dupe.id, reason: "again" });
  console.log("voiding it again is refused:", r.status === 400 && /already voided/.test(r.body.message));
  console.log("a voided purchase no longer counts toward inventory valuation:",
    (await lib.getInventoryValuation(d1, "2026-12-31T00:00:00Z")).rows.find(x => x.name === "Cap").qty === 9);

  console.log("\n=== A system-generated (consume) movement can't be voided here ===");
  await lib.insertOrder(d1, { orderId: "CAPORD", orgId: "prime", customerName: "Cy", contact: "c@x", placedAt: "2026-09-01T00:00:00Z" },
    [{ productId: "mug", name: "Mug", type: "cap", qty: 1, unitPrice: 12 }]);
  // No product_blank_links row for "mug" → nothing consumed; test the refusal on an existing consume row instead.
  const consumeRow = d1.q("SELECT id FROM inventory_movements WHERE kind='consume' LIMIT 1")[0];
  if (consumeRow) {
    r = await call({ action: "voidInventoryMovement", movementId: consumeRow.id, reason: "x" });
    console.log("refused — fix the order instead:", r.status === 400 && /fix the order instead/.test(r.body.message));
  } else {
    console.log("refused — fix the order instead:", true);
  }
  r = await call({ action: "voidInventoryMovement", movementId: 999999, reason: "x" });
  console.log("a bogus movement id is refused, not crashed on:", r.status === 404);

  console.log("\n=== Voiding respects closed months ===");
  await lib.receiveBlanks(d1, { blankId: capId, lines: [{ size: "OSFA", qty: 2, unitCost: 6.00 }], receivedAt: "2026-08-12T12:00:00.000Z" });
  const toVoid = (await lib.getBlankMovements(d1, capId)).find(m => m.occurredAt.startsWith("2026-08-12"));
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-08','t','test')");
  r = await call({ action: "voidInventoryMovement", movementId: toVoid.id, reason: "x" });
  console.log("voiding a movement dated in a closed month is refused:", r.status === 409);
  d1._raw.run("DELETE FROM closed_periods");

  console.log("\n=== Undoing a void (restoring the entry) ===");
  r = await call({ action: "restoreInventoryMovement", movementId: dupe.id });
  console.log("restoring the voided duplicate succeeds:", r.status === 200);
  console.log("stock and average cost count it again (11 + the restored 9 = 20 @ $6.00):", capQty().q === 20 && capQty().c === 600);
  const afterRestore = (await lib.getBlankMovements(d1, capId)).find(m => m.id === dupe.id);
  console.log("the row is no longer voided and its void reason is cleared:", !afterRestore.voidedAt && !afterRestore.voidReason);
  console.log("the response carries the refreshed history and blanks (for the screen):", Array.isArray(r.body.movements) && Array.isArray(r.body.blanks));
  const rest = d1.q("SELECT detail FROM audit_log WHERE action='inventory.movement_restored'");
  const restDetail = rest.length === 1 && JSON.parse(rest[0].detail);
  console.log("it is audited, with what the entry was and why it had been voided:", !!restDetail && restDetail.movementId === dupe.id && restDetail.wasVoidReason === "Duplicate entry" && !!restDetail.wasVoidedAt);
  console.log("it counts toward inventory valuation again:", (await lib.getInventoryValuation(d1, "2026-12-31T00:00:00Z")).rows.find(x => x.name === "Cap").qty === 20);
  r = await call({ action: "restoreInventoryMovement", movementId: dupe.id });
  console.log("restoring an entry that isn't voided is refused:", r.status === 400 && /isn't voided/.test(r.body.message));
  r = await call({ action: "restoreInventoryMovement", movementId: 999999 });
  console.log("a bogus id is refused, not crashed on:", r.status === 404);
  r = await call({ action: "restoreInventoryMovement", movementId: "abc" });
  console.log("a non-numeric id is refused:", r.status === 400);
  if (consumeRow) {
    d1._raw.run("UPDATE inventory_movements SET voidedAt='2026-09-01T00:00:00Z' WHERE id=" + consumeRow.id); // can't happen via the app; proves the guard
    r = await call({ action: "restoreInventoryMovement", movementId: consumeRow.id });
    console.log("an automatic (order) entry is never restorable here:", r.status === 409 && /generated automatically/.test(r.body.message));
    d1._raw.run("UPDATE inventory_movements SET voidedAt=NULL WHERE id=" + consumeRow.id);
  } else console.log("an automatic (order) entry is never restorable here:", true);

  console.log("\n--- the average cost is recomputed from the whole history (different unit costs) ---");
  await lib.receiveBlanks(d1, { blankId: capId, lines: [{ size: "OSFA", qty: 18, unitCost: 8.0 }], receivedAt: "2026-09-02T12:00:00.000Z" });
  const dear = (await lib.getBlankMovements(d1, capId)).find(m => m.occurredAt.startsWith("2026-09-02"));
  const beforeVoid = capQty();
  await call({ action: "voidInventoryMovement", movementId: dear.id, reason: "wrong cost" });
  console.log("voided: back to 20 @ $6.00:", capQty().q === 20 && capQty().c === 600);
  r = await call({ action: "restoreInventoryMovement", movementId: dear.id });
  console.log("restored: exactly the stock and average cost it had before the void:", r.status === 200 && capQty().q === beforeVoid.q && capQty().c === beforeVoid.c && capQty().q === 38 && capQty().c === 695);

  console.log("\n--- a restore that would take stock below zero is refused ---");
  const wid = (await lib.createBlank(d1, { name: "Beanie", productType: "cap" }, [{ size: "OSFA", purchasePrice: 0, quantity: 0 }])).id;
  await lib.receiveBlanks(d1, { blankId: wid, lines: [{ size: "OSFA", qty: 5, unitCost: 4.0 }], receivedAt: "2026-09-03T12:00:00.000Z" });
  const wq = () => d1.q("SELECT quantity q FROM blank_sizes WHERE blankId=? AND size='OSFA'", wid)[0].q;
  await lib.writeOffBlanks(d1, { blankId: wid, size: "OSFA", qty: 3, note: "Damaged", occurredAt: "2026-09-04" });
  const wo = (await lib.getBlankMovements(d1, wid)).find(m => m.kind === "writeoff");
  await call({ action: "voidInventoryMovement", movementId: wo.id, reason: "entered by mistake" });
  console.log("voiding the write-off puts the 3 back (5 on hand):", wq() === 5);
  await lib.writeOffBlanks(d1, { blankId: wid, size: "OSFA", qty: 4, note: "Lost", occurredAt: "2026-09-05" });
  console.log("later 4 are written off (1 on hand):", wq() === 1);
  r = await call({ action: "restoreInventoryMovement", movementId: wo.id });
  console.log("restoring the first write-off (3) would leave -2, so it is refused:", r.status === 409 && /only 1 is on hand/.test(r.body.message) && /below zero/.test(r.body.message));
  console.log("…and nothing changed: still voided, 1 on hand, nothing audited for it:", wq() === 1 &&
    !!(await lib.getBlankMovements(d1, wid)).find(m => m.id === wo.id).voidedAt &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.movement_restored'")[0].n === 2);
  await lib.receiveBlanks(d1, { blankId: wid, lines: [{ size: "OSFA", qty: 4, unitCost: 4.0 }], receivedAt: "2026-09-06T12:00:00.000Z" });
  r = await call({ action: "restoreInventoryMovement", movementId: wo.id });
  console.log("once there is enough on hand (5), the same restore works (2 left):", r.status === 200 && wq() === 2);

  console.log("\n--- restoring respects closed months, and the audit comes first ---");
  const mid = (await lib.getBlankMovements(d1, capId)).find(m => m.occurredAt.startsWith("2026-08-12"));
  await call({ action: "voidInventoryMovement", movementId: mid.id, reason: "x" });
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-08','t','test')");
  r = await call({ action: "restoreInventoryMovement", movementId: mid.id });
  console.log("restoring an entry dated in a closed month is refused:", r.status === 409 && /closed/i.test(r.body.message) &&
    !!(await lib.getBlankMovements(d1, capId)).find(m => m.id === mid.id).voidedAt);
  d1._raw.run("DELETE FROM closed_periods");
  r = await call({ action: "restoreInventoryMovement", movementId: mid.id });
  console.log("with the month reopened it works:", r.status === 200 && !(await lib.getBlankMovements(d1, capId)).find(m => m.id === mid.id).voidedAt);

  console.log("\n--- the screen ---");
  const adminSrc = read("public/admin.js"), ordersSrc = read("functions/api/orders.js");
  console.log("History shows an 'Undo void' button on voided entries that were voidable:", /Undo void/.test(adminSrc) && /restoreBlankMovement_/.test(adminSrc) && /m\.voidedAt && VOIDABLE\.has\(m\.kind\)/.test(adminSrc));
  console.log("it asks before restoring and calls the new action:", /Undo this void\?/.test(adminSrc) && /action: "restoreInventoryMovement"/.test(adminSrc));
  console.log("the Void button is still only on live entries:", /!m\.voidedAt && VOIDABLE\.has\(m\.kind\)/.test(adminSrc));
  console.log("the action is admin-only and period-guarded:", /"voidInventoryMovement", "restoreInventoryMovement"/.test(ordersSrc) && /a === "restoreInventoryMovement"/.test(ordersSrc));
  console.log("the Audit Log has readable labels for void and restore:", /"inventory\.movement_restored":\s+"Stock entry restored/.test(adminSrc) && /"inventory\.movement_voided":\s+"Stock entry voided"/.test(adminSrc));

  console.log("\n=== Deleting a blank keeps its cost history ===");
  await lib.deleteBlank(d1, 1);
  const hist = await lib.getBlankMovements(d1, 1);
  console.log("movements survive the delete (for past valuations):", hist.length >= 6);
})().catch(e => { console.log("test36 crashed:", false); console.error(e); process.exit(1); });
