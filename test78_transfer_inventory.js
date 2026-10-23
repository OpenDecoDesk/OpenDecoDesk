const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Transfer-sheet inventory & COGS (migrations/0036): receiving a sheet splits its cost across rows
// by count × % → per-application cost (weighted-average on reorder), consumption on make adds to the
// line's COGS, write-off/void/valuation mirror blanks, and transfers show in the Inventory report.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, priceItem, createProduct, createBlank, setBlankLink, receiveBlanks,
  createTransfer, updateTransfer, deleteTransfer, listTransfers, receiveTransferSheet, writeOffTransfers,
  getTransferMovements, voidTransferMovement, getTransferValuation, getTransferCogs,
  createGraphic, getGraphic, setTierPrices, getTierPrices, makeTransferLine, getOrderById, setOrderPaid };`)();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);

  console.log("=== Receive a sheet: cost split by count × % → per-application cost ===");
  const tA = await lib.createTransfer(d1, { name: "Lockup" });
  const tB = await lib.createTransfer(d1, { name: "Capital" });
  // One $30 sheet: Lockup 10 @ 60% = $18 → $1.80 ea; Capital 5 @ 40% = $12 → $2.40 ea.
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: tA, count: 10, pctOfSheet: 60 }, { transferId: tB, count: 5, pctOfSheet: 40 }],
    totalCents: 3000, receivedAt: "2026-07-01", vendorRef: "INV1" });
  let list = await lib.listTransfers(d1, "acme");
  const a = list.find(t => t.id === tA), b = list.find(t => t.id === tB);
  ok("Lockup: 10 on hand at $1.80 average", a.quantity === 10 && near(a.purchasePrice, 1.80));
  ok("Capital: 5 on hand at $2.40 average", b.quantity === 5 && near(b.purchasePrice, 2.40));

  console.log("\n=== Weighted average on reorder ===");
  // Another sheet gives Lockup 10 more at $2.20 ea (100% of a $22 sheet). Avg → (18+22)/20 = $2.00.
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: tA, count: 10, pctOfSheet: 100 }], totalCents: 2200, receivedAt: "2026-07-02" });
  list = await lib.listTransfers(d1); const a2 = list.find(t => t.id === tA);
  ok("Lockup reorder → 20 on hand at $2.00 weighted average", a2.quantity === 20 && near(a2.purchasePrice, 2.00));

  console.log("\n=== Consume on make adds to the line's COGS (blank + transfer) ===");
  await lib.createProduct(d1, "acme", { productId: "rag", type: "shirt", name: "Raglan", pricingMode: "flat", flatPrice: 18, visible: true,
    configurable: true, garmentColors: ["Navy"], locations: [{ key: "front", label: "Front", graphicIds: [] }], reorderQr: "none" });
  // Color is a stock dimension (migrations/0037): link the Navy garment color explicitly.
  const blankId = (await lib.createBlank(d1, { name: "Jerzees 63374", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] }] })).id;
  await lib.setBlankLink(d1, "acme", "rag", "Navy", "L", blankId, "Navy", "L");
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "L", qty: 10, unitCost: 5 }], receivedAt: "2026-07-01" });
  const gA = await lib.createGraphic(d1, "acme", { name: "Lockup", kind: "transfer", transferId: tA, tier: "medium" });
  // Order one raglan, Front = Lockup (transfer tA). Snapshot carries the transfer; make it → consume.
  const snap = { garmentColor: "Navy", size: "L", locations: [{ location: "front", label: "Front", graphicId: gA, kind: "transfer", transferId: tA, graphicName: "Lockup", ink: "", tier: "medium", addOnCents: 200 }] };
  await lib.insertOrder(d1, { orderId: "O1", orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-07-05T00:00:00Z" },
    [{ productId: "rag", name: "Raglan", type: "shirt", size: "L", qty: 2, unitPrice: 20, config: snap }]);
  await lib.setOrderPaid(d1, "O1", null, "paid");
  await lib.makeTransferLine(d1, "O1", (await lib.getOrderById(d1, "O1")).items[0].id);
  const made = (await lib.getOrderById(d1, "O1")).items[0];
  // COGS = 2 blanks @ $5 ($10) + 2 Lockup @ $2.00 ($4) = $14.
  ok("line COGS = blank + transfer consumed ($14)", near(made.cogs, 14) && made.cogsSource === "consumed");
  list = await lib.listTransfers(d1); const aAfter = list.find(t => t.id === tA);
  ok("transfer stock dropped by the 2 used (20 → 18)", aAfter.quantity === 18);

  console.log("\n=== Valuation + COGS report + write-off + void ===");
  const val = await lib.getTransferValuation(d1, "2026-12-31T23:59:59Z");
  ok("valuation on hand reflects stock after the consume", val.units === 18 + 5);
  const cogs = await lib.getTransferCogs(d1, "2026-01-01", "2027-12-31");
  const totalCogs = cogs.reduce((a, m) => a + m.cogs, 0), totalPurch = cogs.reduce((a, m) => a + m.purchases, 0);
  ok("COGS report: $4 consumed and the sheet purchases recorded", near(totalCogs, 4) && near(totalPurch, 30 + 22));
  await lib.writeOffTransfers(d1, { transferId: tB, qty: 1, note: "Damaged", occurredAt: "2026-07-10" });
  ok("write-off lowers stock", (await lib.listTransfers(d1)).find(t => t.id === tB).quantity === 4);
  const movements = await lib.getTransferMovements(d1, tA);
  const firstPurchase = movements.filter(m => m.kind === "purchase").slice(-1)[0];
  await lib.voidTransferMovement(d1, firstPurchase.id, "entered twice");
  const aVoided = (await lib.listTransfers(d1)).find(t => t.id === tA);
  ok("voiding the first purchase recomputes stock/average from what's left", aVoided.quantity === 18 - 10);

  console.log("\n=== deleteTransfer refused while a graphic references it ===");
  let refused = false;
  try { await lib.deleteTransfer(d1, tA); } catch (e) { refused = /graphic/i.test(e.message); }
  ok("refused while the Lockup graphic links to it", refused);

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
