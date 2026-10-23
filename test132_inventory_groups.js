const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Inventory in three groups (migrations/0060): blanks for sale, blanks for testing / shop use (flagged
// per blank type), and FINISHED stock — pieces already decorated for a shop and listed as in stock on its
// site. Make for stock moves blanks into finished stock at their cost (not COGS); an order for a stocked
// size is filled from stock automatically (no blank / design / making steps), set aside until the order
// is made, then pulled (COGS). Cancels and voids put pulled pieces back. The Inventory & COGS report and
// the accountant export show each group, COGS by source and write-offs by reason, and the roll-forward
// adds up. Real migrations, db.js and orders.js on sql.js; the admin screens in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, receiveBlanks, createProduct, setBlankLink, insertOrder, settleOrderBalance, getOrderById, getProductionQueue, getBlanksToOrder,
  getBlankReservations, getReadyToShipByOrg, getFinishedStock, setFulfillmentStage, markItemPieceManufactured, cancelLineItem, voidOrder, stagePrereqError,
  getInventoryValuation, getFinishedGoodsValuation, getCogsReport, getAccountantExport, getPaidUnrunOrders, makeForStock, getBlankStockCoverage };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();

(async () => {
  console.log("=== The migration ===");
  {
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrations.filter(f => f < "0060")) old.execFile(read("migrations/" + f));
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);
      INSERT INTO products (productId, orgId, type, name, pricingMode, sizePricingCents, createdAt, updatedAt) VALUES ('tee','club','shirt','Club Tee','sized','{"M":2000}','t','t'), ('cap','club','cap','Club Cap','flat','{}','t','t'), ('mug','club','cap','Mug','flat','{}','t','t');
      INSERT INTO blanks (id, name, productType, createdAt, updatedAt) VALUES (1,'Gildan','shirt','t','t'), (2,'Cap blank','cap','t','t');
      INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (1,'Navy','M',412,20), (2,'Royal','OSFA',455,14);
      INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) VALUES ('club','tee','','M',1,'Navy','M'), ('club','cap','','OSFA',2,'Royal','OSFA');
      INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt) VALUES ('club','tee','M',5,'t'), ('club','cap','',3,'t'), ('club','mug','',2,'t'), ('club','tee','L',0,'t');
      INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, note, occurredAt, createdAt) VALUES
        (1,'Gildan','Navy','M',-1,412,'writeoff','Used for testing, samples, or shop scrap','2026-09-01','t'), (1,'Gildan','Navy','M',-1,412,'writeoff','Damaged','2026-09-01','t'),
        (1,'Gildan','Navy','M',-1,412,'writeoff','Lost / miscounted','2026-09-01','t'), (1,'Gildan','Navy','M',-1,412,'writeoff','sewout sample','2026-09-01','t'),
        (1,'Gildan','Navy','M',-1,412,'writeoff','Gave one away','2026-09-01','t');`);
    old.execFile(read("migrations/0060_inventory_groups.sql"));
    const fg = old.q("SELECT productId, size, qtyDelta, unitCostCents, kind FROM finished_goods_movements ORDER BY productId, size");
    ok("the counts already entered become an opening balance at the linked blank's current cost (a flat product's link is under OSFA)",
      fg.length === 3 && fg.find(r => r.productId === "tee").qtyDelta === 5 && fg.find(r => r.productId === "tee").unitCostCents === 412 &&
      fg.find(r => r.productId === "cap").unitCostCents === 455 && fg.every(r => r.kind === "opening"));
    ok("…a product with no blank link is opened at $0, and a zero count gets no row", fg.find(r => r.productId === "mug").unitCostCents === 0 && !fg.some(r => r.size === "L"));
    ok("…the cached average matches, and blank counts aren't touched", old.q("SELECT avgCostCents FROM ready_to_ship WHERE productId='tee' AND size='M'")[0].avgCostCents === 412 &&
      old.q("SELECT quantity FROM blank_sizes WHERE blankId=1")[0].quantity === 20);
    ok("every existing write-off gets its reason from its note", old.q("SELECT reason FROM inventory_movements WHERE kind='writeoff' ORDER BY id").map(r => r.reason).join() === "testing,damaged,lost,testing,other");
  }

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const call = async (body, { host = "admin", role = "admin" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: `https://${host}.example.com/api/orders`, json: async () => host === "admin" ? Object.assign({ key: "x", org: "club" }, body) : body, headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const blankQty = (id, color, size) => Number(d1.q(`SELECT quantity FROM blank_sizes WHERE blankId=${id} AND color='${color}' AND size='${size}'`)[0].quantity);
  const rts = (pid, size) => (d1.q(`SELECT quantity, avgCostCents FROM ready_to_ship WHERE orgId='club' AND productId='${pid}' AND size='${size}'`)[0] || { quantity: 0, avgCostCents: 0 });
  const avail = async (pid, size) => ((await lib.getReadyToShipByOrg(d1, "club")).find(r => r.productId === pid && r.size === size) || { quantity: 0 }).quantity;

  // Blanks: a Gildan tee for sale ($4.00), a cap ($4.50) and a tee bought for testing ($3.00).
  const gildan = (await lib.createBlank(d1, { name: "Gildan 64000", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "S", purchasePrice: 0, quantity: 0 }, { size: "M", purchasePrice: 0, quantity: 0 }] }] })).id;
  const capBlank = (await lib.createBlank(d1, { name: "Panel cap", productType: "cap", colors: [{ color: "Royal", images: [], sizes: [{ size: "OSFA", purchasePrice: 0, quantity: 0 }] }] })).id;
  let r = await call({ action: "createBlank", name: "Practice tee", productType: "shirt", forTesting: true, colors: [{ color: "White", images: [], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] }] });
  const practice = r.body.id;
  await lib.receiveBlanks(d1, { blankId: gildan, lines: [{ color: "Navy", size: "S", qty: 10, unitCost: 4 }, { color: "Navy", size: "M", qty: 20, unitCost: 4 }], vendor: "S&S", receivedAt: "2026-10-01T12:00:00.000Z" });
  await lib.receiveBlanks(d1, { blankId: capBlank, lines: [{ color: "Royal", size: "OSFA", qty: 14, unitCost: 4.5 }], vendor: "SanMar", receivedAt: "2026-10-01T12:00:00.000Z" });
  await lib.receiveBlanks(d1, { blankId: practice, lines: [{ color: "White", size: "L", qty: 10, unitCost: 3 }], vendor: "Walmart", receivedAt: "2026-10-01T12:00:00.000Z" });
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20 }, visible: true, sortOrder: 1 });
  await lib.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 22, visible: true, sortOrder: 2 });
  await lib.createProduct(d1, "club", { productId: "ctee", type: "shirt", name: "Pick-your-color tee", pricingMode: "sized", sizePricing: { M: 25 }, visible: true, configurable: true, garmentColors: ["Navy"] });
  await lib.createProduct(d1, "club", { productId: "patch", type: "cap", name: "Unlinked patch", pricingMode: "flat", flatPrice: 8, visible: true });
  for (const s of ["S", "M"]) await lib.setBlankLink(d1, "club", "tee", "", s, gildan, "Navy", s);
  await lib.setBlankLink(d1, "club", "cap", "", "OSFA", capBlank, "Royal", "OSFA");
  ok("a blank can be marked for testing / shop use", (await call({ action: "getBlanks" })).body.blanks.find(b => b.id === practice).forTesting === true);
  r = await call({ action: "updateBlank", id: practice, name: "Practice tee", productType: "shirt", forTesting: true });
  ok("(saving it unchanged writes no audit; changing the flag would)", Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.blank_testing_changed'")[0].n) === 0);

  console.log("\n=== Make for stock ===");
  r = await call({ action: "makeForStock", productId: "tee", size: "M", qty: 6 }, { role: "staff" });
  ok("a worker can make stock: 6 Gildan Navy M become 6 finished tees", r.status === 200 && blankQty(gildan, "Navy", "M") === 14 && rts("tee", "M").quantity === 6);
  ok("…at the blank's cost ($4.00 each)", r.body.unitCost === 4 && rts("tee", "M").avgCostCents === 400);
  const mv = d1.q("SELECT kind, reason, qtyDelta, unitCostCents FROM inventory_movements WHERE blankId=" + gildan + " AND kind='consume'");
  ok("the blanks leave as a 'finished' consume — moved into finished stock, not cost of goods", mv.length === 1 && mv[0].reason === "finished" && mv[0].qtyDelta === -6);
  ok("…and a 'make' entry is recorded in finished stock, linked to it", Number(d1.q("SELECT count(*) n FROM finished_goods_movements WHERE kind='make' AND blankMovementId IS NOT NULL")[0].n) === 1);
  r = await call({ action: "makeForStock", productId: "ctee", size: "M", qty: 1 });
  ok("a product with color / graphic choices can't be stocked", r.status === 409 && /color and graphic choices/.test(r.body.message));
  r = await call({ action: "makeForStock", productId: "patch", size: "", qty: 1 });
  ok("…nor one with no blank linked", r.status === 409 && /isn't linked to a blank/.test(r.body.message));
  r = await call({ action: "makeForStock", productId: "tee", size: "M", qty: 15 });
  ok("…nor more than the free blanks", r.status === 409 && /Only 14 Gildan 64000 Navy M free/.test(r.body.message));
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-09', 't', 'test')");
  r = await call({ action: "makeForStock", productId: "tee", size: "M", qty: 1, occurredAt: "2026-09-15" });
  ok("…nor dated in a closed month", r.status === 409 && /closed/.test(r.body.message));
  r = await call({ action: "makeForStock", productId: "cap", size: "", qty: 4 });
  ok("a flat product's stock is kept under one size", r.status === 200 && rts("cap", "").quantity === 4 && blankQty(capBlank, "Royal", "OSFA") === 10);
  // Two at once when only enough blanks for one.
  d1._raw.run(`UPDATE blank_sizes SET quantity = 3 WHERE blankId=${gildan} AND size='S'`);
  const both = await Promise.allSettled([lib.makeForStock(d1, { orgId: "club", productId: "tee", size: "S", qty: 2 }), lib.makeForStock(d1, { orgId: "club", productId: "tee", size: "S", qty: 2 })]);
  const madeOk = both.filter(x => x.status === "fulfilled" && x.value.claimed).length;
  ok("two at once with blanks for only one: one is made, the other isn't", madeOk === 1 && rts("tee", "S").quantity === 2 && blankQty(gildan, "Navy", "S") === 1);

  console.log("\n=== Correct count ===");
  r = await call({ action: "setReadyToShipQty", productId: "tee", size: "M", quantity: 7 }, { role: "staff" });
  ok("a counted number is recorded as a correction (+1 at the average cost)", r.status === 200 && r.body.delta === 1 && rts("tee", "M").quantity === 7 &&
    d1.q("SELECT qtyDelta, unitCostCents FROM finished_goods_movements WHERE kind='adjust'")[0].unitCostCents === 400);

  console.log("\n=== An order for a stocked size ===");
  const shopOrder = (orderId, items) => call({ orderId, orgId: "club", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", deliveryOptionId: "pickup", items }, { host: "club" });
  r = await shopOrder("S-1", [{ productId: "tee", size: "M", qty: 2 }]);
  let o = await lib.getOrderById(d1, "S-1");
  ok("it's filled from stock when placed", r.status === 200 && o.items[0].fromStock === true && o.allFromStock === true);
  ok("…the shop's badge now shows 5 available (7 on hand, 2 set aside)", (await avail("tee", "M")) === 5 && rts("tee", "M").quantity === 7);
  await lib.settleOrderBalance(d1, "S-1", "paid");
  o = await lib.getOrderById(d1, "S-1");
  ok("…it skips the blank, digitizing and approval steps: it can be marked made as soon as it's paid", o.needsBlanks === false && o.needsDigitizing === false && o.needsDesignApproval === false && lib.stagePrereqError(o, "manufactured") === "");
  ok("…it's not on Run Order, Blanks to Order or the blanks set aside", !(await lib.getProductionQueue(d1)).some(j => j.orderId === "S-1") &&
    !(await lib.getBlanksToOrder(d1)).suppliers.some(sp => sp.rows.some(x => x.orders.includes("S-1"))) && !(await lib.getBlankReservations(d1))[`${gildan}|Navy|M`]);
  ok("…and the run pages' list says From stock", (await lib.getPaidUnrunOrders(d1)).find(x => x.orderId === "S-1").allFromStock === true);
  r = await call({ action: "setReadyToShipQty", productId: "tee", size: "M", quantity: 1 });
  ok("the count can't be corrected below what's set aside", r.status === 409 && /set aside/.test(r.body.message));
  await lib.setFulfillmentStage(d1, "S-1", "manufactured");
  o = await lib.getOrderById(d1, "S-1");
  ok("marking it made pulls the 2 from stock: 7 → 5 on hand, cost of goods $8.00, no blank used", rts("tee", "M").quantity === 5 && o.items[0].cogs === 8 &&
    blankQty(gildan, "Navy", "M") === 14 && Number(d1.q("SELECT count(*) n FROM finished_goods_movements WHERE kind='sell' AND orderId='S-1'")[0].n) === 1);

  console.log("\n=== A mixed order, the last piece, cancels and voids ===");
  r = await shopOrder("S-2", [{ productId: "tee", size: "M", qty: 1 }, { productId: "tee", size: "S", qty: 3 }]);
  o = await lib.getOrderById(d1, "S-2");
  const mLine = o.items.find(i => i.size === "M"), sLine = o.items.find(i => i.size === "S");
  ok("in a mixed order only the stocked line is from stock (S has 2, the order wants 3)", mLine.fromStock && !sLine.fromStock && !o.allFromStock && o.needsBlanks === true);
  for (let i = 0; i < 3; i++) await lib.markItemPieceManufactured(d1, "S-2", sLine.id);
  o = await lib.getOrderById(d1, "S-2");
  ok("finishing the made line on Run Order pulls the stock line and completes the order", !!o.manufacturedAt && rts("tee", "M").quantity === 4 && o.items.find(i => i.size === "M").cogs === 4);
  await call({ action: "setReadyToShipQty", productId: "tee", size: "M", quantity: 1 });
  const race = await Promise.all([shopOrder("R-1", [{ productId: "tee", size: "M", qty: 1 }]), shopOrder("R-2", [{ productId: "tee", size: "M", qty: 1 }])]);
  const got = [(await lib.getOrderById(d1, "R-1")).items[0].fromStock, (await lib.getOrderById(d1, "R-2")).items[0].fromStock];
  ok("two orders for the last piece: only one gets it, the other is made as usual", race.every(x => x.status === 200) && got.filter(Boolean).length === 1 && (await avail("tee", "M")) === 0);
  const holder = got[0] ? "R-1" : "R-2";
  await lib.cancelLineItem(d1, (await lib.getOrderById(d1, holder)).items[0].id);
  ok("cancelling a line before it's pulled releases the piece", (await avail("tee", "M")) === 1);
  await call({ action: "setReadyToShipQty", productId: "tee", size: "M", quantity: 5 });
  await shopOrder("V-1", [{ productId: "tee", size: "M", qty: 2 }]);
  await lib.setFulfillmentStage(d1, "V-1", "manufactured");
  ok("(V-1 pulled: 5 → 3)", rts("tee", "M").quantity === 3);
  await lib.voidOrder(d1, "V-1", "customer changed their mind");
  ok("voiding a pulled order before it ships puts the pieces back, at their cost, and clears the line's cost", rts("tee", "M").quantity === 5 &&
    Number(d1.q("SELECT count(*) n FROM finished_goods_movements WHERE kind='return' AND orderId='V-1'")[0].n) === 1 && (await lib.getOrderById(d1, "V-1")).items[0].cogs === 0);
  await lib.voidOrder(d1, "V-1", "again");
  ok("…only once", rts("tee", "M").quantity === 5);
  await shopOrder("V-2", [{ productId: "tee", size: "M", qty: 1 }]);
  await lib.setFulfillmentStage(d1, "V-2", "manufactured");
  d1._raw.run("UPDATE orders SET shippedAt='2026-10-10T00:00:00Z' WHERE orderId='V-2'");
  await lib.voidOrder(d1, "V-2", "lost in the mail");
  ok("…but a shipped order's pieces don't come back", rts("tee", "M").quantity === 4);
  await lib.insertOrder(d1, { orderId: "T-1", orgId: "club", customerName: "Test", contact: "", paymentMethod: "Card", isTest: true, placedAt: new Date().toISOString() },
    [{ productId: "tee", name: "Club Tee", type: "shirt", size: "M", qty: 1, unitPrice: 20 }], { fillFromStock: true });
  ok("a test order never takes stock", !(await lib.getOrderById(d1, "T-1")).items[0].fromStock);
  r = await call({ action: "createLocalSale", customerName: "Walk-in", paymentMethod: "Cash", paid: true, items: [{ productId: "cap", size: "OSFA", qty: 1 }] });
  o = r.body.orderId && await lib.getOrderById(d1, r.body.orderId);
  ok("a local sale of a stocked item is pulled on the spot (it's handed over)", r.status === 200 && o.items[0].fromStock && o.items[0].cogs === 4.5 && !!o.manufacturedAt && rts("cap", "").quantity === 3);

  console.log("\n=== Write-offs and voids ===");
  r = await call({ action: "writeOffBlanks", blankId: practice, color: "White", size: "L", qty: 2, note: "Used for testing, samples, or shop scrap", reason: "testing" });
  await call({ action: "writeOffBlanks", blankId: gildan, color: "Navy", size: "M", qty: 1, note: "Damaged", reason: "damaged" });
  ok("write-offs keep their reason", d1.q("SELECT reason FROM inventory_movements WHERE kind='writeoff' ORDER BY id").map(x => x.reason).join() === "testing,damaged");
  const firstCapMake = Number(d1.q("SELECT id FROM finished_goods_movements WHERE kind='make' AND productId='cap'")[0].id);
  r = await call({ action: "voidFinishedGoodsMovement", movementId: firstCapMake, reason: "entered twice" });
  ok("a make entry whose pieces were partly sold can't be voided (it would go below zero)", r.status === 409 && /already been sold/.test(r.body.message));
  await call({ action: "makeForStock", productId: "cap", size: "", qty: 2 });
  const makeId = Number(d1.q("SELECT max(id) AS id FROM finished_goods_movements WHERE kind='make' AND productId='cap'")[0].id);
  ok("(two more caps made: 3 → 5 on hand, blanks 10 → 8)", rts("cap", "").quantity === 5 && blankQty(capBlank, "Royal", "OSFA") === 8);
  // A worker may void a stock entry, as they may a blank or transfer movement.
  r = await call({ action: "voidFinishedGoodsMovement", movementId: makeId, reason: "entered twice" }, { role: "staff" });
  ok("voiding a Made for stock entry puts its blanks back too (a worker may, as with blank movements)", r.status === 200 && blankQty(capBlank, "Royal", "OSFA") === 10 && rts("cap", "").quantity === 3);

  console.log("\n=== The report ===");
  r = await call({ action: "getInventoryReport", dateFrom: "2026-01-01", dateTo: new Date().toISOString().slice(0, 10) });
  const t = r.body.totals, g = r.body.groups;
  ok("the report shows the three groups: blanks for sale, for testing, and finished stock", r.status === 200 && g.testing.ending.value === 24 && g.testing.ending.units === 8 &&
    g.finished.ending.units === rts("tee", "M").quantity + rts("tee", "S").quantity + rts("cap", "").quantity && g.forSale.ending.value > 0);
  ok("COGS by source: blanks used on orders vs finished stock sold", t.cogsBlanks === 12 && t.cogsFinished === 8 + 4 + 4 + 4.5 && Math.abs(t.cogs - (t.cogsBlanks + t.cogsFinished)) < 0.001);
  ok("write-offs by reason: testing apart from damaged / lost", t.writeoffsTesting === 6 && t.writeoffsDamagedLost === 4 && t.writeoffs === 10);
  ok("blanks decorated into finished stock are shown as a move between groups", t.toFinished > 0);
  ok("the roll-forward adds up: beginning + purchases + corrections − COGS − write-offs = ending", Math.abs(r.body.rollForward.check) < 0.05);
  const ex = await lib.getAccountantExport(d1, "2026-01-01T00:00:00.000Z", new Date().toISOString());
  const month = ex.summary.find(m => m.month === new Date().toISOString().slice(0, 7));
  ok("the accountant export splits COGS and write-offs the same way", month.cogsFinished === t.cogsFinished && month.writeoffsTesting === 6 && month.toFinishedStock === t.toFinished);
  ok("…and lists each group's beginning and ending inventory", ex.inventoryGroups.length === 3 && ex.inventoryGroups[1].group === "Blanks for testing / shop use" && ex.inventoryGroups[1].ending === 24);

  console.log("\n=== The admin screens ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "club", name: "Club" }];');
  const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  const app = d.getElementById("app");
  await w.renderAdminBlanks(app);
  await until(() => d.querySelector(".blank-testing-badge"));
  ok("Blanks shows a TESTING badge on the testing blank and totals per group", d.querySelectorAll(".blank-testing-badge").length === 1 && /For testing \/ shop use \$24\.00 \(8 units\)/.test(d.querySelector(".blank-group-totals").textContent));
  d.getElementById("blankGroup").value = "testing"; d.getElementById("blankGroup").dispatchEvent(new w.Event("change"));
  ok("…and filters to just the testing blanks", /Practice tee/.test(d.getElementById("blanksPanel").textContent) && !/Gildan 64000/.test(d.getElementById("blanksPanel").textContent));
  w.showBlankModal({ id: practice, name: "Practice tee", productType: "shirt", forTesting: true, colors: [], sizes: [] }, () => {});
  await until(() => d.getElementById("blkForTesting"));
  ok("the blank form has the For testing / shop use box", d.getElementById("blkForTesting").checked === true);
  d.querySelectorAll("[data-modal-close]").forEach(b => b.click());
  w.showStockModal("club", "tee", "Club Tee", "sized", { S: 20, M: 20 });
  await until(() => d.querySelector('#fsBody tr[data-size="M"]'));
  const mRow = () => d.querySelector('#fsBody tr[data-size="M"]');
  ok("the Stock window shows on hand, set aside, available, cost and value, and the blank it's made from", /Gildan 64000 · Navy · M/.test(mRow().textContent) && /\$4\.00/.test(mRow().textContent));
  const before = rts("tee", "M").quantity;
  mRow().querySelector(".fsMakeQty").value = "2"; mRow().querySelector(".fsMake").click();
  await until(() => rts("tee", "M").quantity === before + 2);
  ok("Make for stock from the window", rts("tee", "M").quantity === before + 2);
  await until(() => /Made for stock/.test(d.getElementById("fsHistory").textContent));
  ok("…and History lists it, with Void", /Made for stock/.test(d.getElementById("fsHistory").textContent) && d.querySelectorAll(".fsVoid").length > 0);
  d.getElementById("fsClose").click();
  await w.renderInventoryReport(app);
  await until(() => d.querySelector(".cogs-groups"));
  const txt = app.textContent.replace(/\s+/g, " ");
  ok("the Inventory & COGS screen shows the groups, the roll-forward and three ending tables", /Blanks for sale/.test(txt) && /Blanks for testing \/ shop use/.test(txt) && /Finished stock/.test(txt) &&
    /finished stock sold/.test(txt) && /used for testing \/ shop use/.test(txt) && d.querySelector(".cogs-end-finished") && d.querySelector(".cogs-end-testing"));
  ok("…and says whether it adds up", /Adds up/.test(d.querySelector(".cogs-check").textContent));
  const evil = { id: 1, orderId: "X", name: "x", fromStock: true };
  ok("order lines filled from stock say so", /From stock/.test(w.lineDetail_(evil)));

  console.log("\n=== With what OpenDecoDesk adds ===");
  // Blanks from stock (Run Order's "In stock" / Use from stock): a line filled from FINISHED stock never
  // waits on blanks, so it's never offered blanks off the shelf either.
  await call({ action: "setReadyToShipQty", productId: "tee", size: "M", quantity: 6 });
  r = await shopOrder("F-1", [{ productId: "tee", size: "M", qty: 1 }]);
  await lib.settleOrderBalance(d1, "F-1", "paid");
  const f1 = (await lib.getPaidUnrunOrders(d1)).find(x => x.orderId === "F-1");
  ok("an order filled from finished stock isn't offered blanks from the shelf (it waits on none)", r.status === 200 && f1.allFromStock && !f1.blanksInStock &&
    !(await lib.getBlankStockCoverage(d1, ["F-1"]))["F-1"]);
  // Versions of a product (migrations/0059): each version is its own product, with its own stock.
  r = await call({ action: "createProductVersion", productId: "cap", newProductId: "cap-v2", label: "Classic", newLabel: "Trucker" }, { role: "staff" });
  const place = (orderId, it) => lib.insertOrder(d1, { orderId, orgId: "club", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date().toISOString() },
    [Object.assign({ name: "x", type: "cap", qty: 1, unitPrice: 22 }, it)], { fillFromStock: true });
  await place("VS-1", { productId: "cap-v2", size: "" });
  await place("VS-2", { productId: "cap", size: "" });
  ok("a version of a product never takes the other version's stock", r.status === 200 && !(await lib.getOrderById(d1, "VS-1")).items[0].fromStock &&
    (await lib.getOrderById(d1, "VS-2")).items[0].fromStock);
  // The customer's own design (migrations/0054): their artwork has to be made, never taken off a shelf.
  await place("CD-1", { productId: "tee", name: "Club Tee", type: "shirt", size: "M", customFiles: [{ fileKey: "customer-designs/x.png", fileName: "logo.png", fileExt: "png" }] });
  ok("a line with the customer's own design is never filled from stock", !(await lib.getOrderById(d1, "CD-1")).items[0].fromStock);
  // No blank needed (migrations/0057): nothing to take out — its count is entered instead.
  await lib.createProduct(d1, "club", { productId: "twill", type: "cap", name: "Twill patch", pricingMode: "flat", flatPrice: 6, visible: true, noBlankNeeded: true });
  r = await call({ action: "makeForStock", productId: "twill", size: "", qty: 2 });
  ok("Make for stock on a product made with no blank says to use Correct count instead", r.status === 409 && /made with no blank/.test(r.body.message) && /Correct count/.test(r.body.message));
  r = await call({ action: "setReadyToShipQty", productId: "twill", size: "", quantity: 4 });
  ok("…and Correct count works for it", r.status === 200 && rts("twill", "").quantity === 4);

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test132 crashed: false"); process.exit(1); });
