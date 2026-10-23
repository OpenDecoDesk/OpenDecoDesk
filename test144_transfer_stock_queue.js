const fs = require("fs");
const { JSDOM } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Run Transfer Sheets works out whether a line's transfers are in hand from transfer STOCK, not only from
// the "Mark transfer received" flag (which receiving a sheet never set — in production every line sat under
// "Waiting" even with the sheet on the shelf). A line is in hand when its transfers were already used, it
// was marked received, or stock covers it — stock shared out marked lines first, then soonest due first.
// The gang sheet then totals only what still has to be printed.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { createTransfer, createGraphic, createProduct, priceItem, insertOrder, getTransferQueue, getGangSheet, receiveTransferSheet, setTransferReceived, makeTransferLine, writeOffTransfers };")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const qr = await lib.createTransfer(d1, { name: "Club QR DTF" });
  const crestSheet = await lib.createTransfer(d1, { name: "Crest DTF" });
  const crest = await lib.createGraphic(d1, "club", { name: "Crest", kind: "transfer", transferId: crestSheet, tier: null });
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true,
    noBlankNeeded: true, configurable: true, garmentColors: ["Navy"], reorderQr: "t" + qr, locations: [{ key: "front", label: "Front", graphicIds: [crest] }] });

  const line = async (qty) => ({ productId: "tee", name: "Tee", type: "shirt", size: "L", qty, unitPrice: 20,
    config: (await lib.priceItem(d1, "club", "tee", "L", qty, false, { garmentColor: "Navy", locations: { front: { graphicId: crest } } })).config });
  const order = async (orderId, due, qty) => {
    await lib.insertOrder(d1, { orderId, orgId: "club", customerName: orderId, contact: "c@x.com", paymentMethod: "Card", placedAt: "2026-10-01T00:00:00Z" }, [await line(qty)]);
    d1._raw.run(`UPDATE orders SET paid=1, dueDate='${due}' WHERE orderId='${orderId}'`);
  };
  await order("LATE", "2026-11-20", 2);
  await order("SOON", "2026-11-01", 2);
  const itemOf = (orderId) => Number(d1._raw.exec(`SELECT id FROM order_items WHERE orderId='${orderId}'`)[0].values[0][0]);
  const queue = async () => { const q = await lib.getTransferQueue(d1); const all = q.ready.concat(q.waiting);
    return { q, card: (o) => all.find(c => c.orderId === o), isReady: (o) => q.ready.some(c => c.orderId === o) }; };
  const gangTotal = async () => (await lib.getGangSheet(d1)).reduce((n, r) => n + r.count, 0);

  let { card, isReady } = await queue();
  ok("each line carries two transfers (the crest + the reorder QR)", card("SOON").transfers.length === 2 && card("SOON").transfers.some(t => t.auto && t.transferId === qr));
  ok("no stock: both lines wait on transfers", !isReady("SOON") && !isReady("LATE") && card("SOON").transferSource === "");
  ok("…and say what's short (0 free, needs 2)", card("SOON").transferShort.length === 2 && card("SOON").transferShort.every(s => s.free === 0 && s.needed === 2));
  ok("gang sheet counts everything still to print (2 lines × 2 transfers × 2)", await gangTotal() === 8);

  // Receive 3 of each: enough for the sooner-due line only.
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: qr, count: 3, pctOfSheet: 50 }, { transferId: crestSheet, count: 3, pctOfSheet: 50 }], totalCents: 600, receivedAt: "2026-10-04" });
  ({ card, isReady } = await queue());
  ok("stock covers the soonest-due line: it's ready, from stock, without anyone marking it", isReady("SOON") && card("SOON").transferSource === "stock" && card("SOON").transferReceived);
  ok("…every transfer on it is set aside", card("SOON").transfers.every(t => t.inStock));
  ok("the later line isn't promised the same transfers (1 free, needs 2)", !isReady("LATE") && card("LATE").transferShort.every(s => s.free === 1 && s.needed === 2));
  ok("gang sheet now only counts the later line's transfers", await gangTotal() === 4);

  // Marking the later line received by hand: it holds its transfers first (that sheet was bought for it).
  await lib.setTransferReceived(d1, itemOf("LATE"), true);
  ({ card, isReady } = await queue());
  ok("a line marked received is ready (source: marked)", isReady("LATE") && card("LATE").transferSource === "marked");
  ok("…and takes its stock first, so the other line is now short", !isReady("SOON") && card("SOON").transferShort.length === 2);
  await lib.setTransferReceived(d1, itemOf("LATE"), false);

  // Making the covered line uses its transfers; the stock left over is re-shared.
  await lib.makeTransferLine(d1, "SOON", itemOf("SOON"));
  const onHand = (id) => Number(d1._raw.exec(`SELECT quantity FROM transfers WHERE id=${id}`)[0].values[0][0]);
  ok("making the line takes its transfers out of stock (3 → 1)", onHand(qr) === 1 && onHand(crestSheet) === 1);
  ({ card, isReady } = await queue());
  ok("the made line leaves the queue", !card("SOON"));
  ok("the other line still waits (1 free, needs 2)", !isReady("LATE") && card("LATE").transferShort[0].free === 1);

  // A line whose transfers were already used (an embroidered line made on Run Order, still listed until its
  // transfers are marked applied) is in hand and holds no stock.
  d1._raw.run(`INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, occurredAt, createdAt)
               VALUES (${qr}, 'Club QR DTF', -2, 0, 'consume', 'LATE', ${itemOf("LATE")}, '2026-10-10', '2026-10-10')`);
  ({ card, isReady } = await queue());
  ok("a line with a consume movement counts as used", isReady("LATE") && card("LATE").transferSource === "used");
  ok("…and is left off the gang sheet", await gangTotal() === 0);

  // A write-off is how a miscounted shelf is corrected; the queue follows the corrected count.
  d1._raw.run(`DELETE FROM transfer_movements WHERE kind='consume' AND orderId='LATE'`);
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: qr, count: 1, pctOfSheet: 50 }, { transferId: crestSheet, count: 1, pctOfSheet: 50 }], totalCents: 200, receivedAt: "2026-10-12" });
  ({ isReady } = await queue());
  ok("with 2 of each on hand the later line is covered", isReady("LATE"));
  await lib.writeOffTransfers(d1, { transferId: qr, qty: 1, note: "Counted the shelf", occurredAt: "2026-10-13" });
  ({ card, isReady } = await queue());
  ok("after writing one off it's short again, naming the transfer", !isReady("LATE") && card("LATE").transferShort.length === 1 && card("LATE").transferShort[0].name === "Club QR DTF");

  // An order that was delivered and completed but never marked made (30 pieces were still listed on a real
  // install) has nothing left to press — nor anything to run, nor blanks to hold.
  await order("DONE", "2026-10-02", 3);
  d1._raw.run(`UPDATE orders SET deliveredAt='2026-09-23T00:00:00Z', completedAt='2026-10-19T00:00:00Z' WHERE orderId='DONE'`);
  ({ card } = await queue());
  ok("a delivered + completed order that was never marked made is not on Run Transfer Sheets", !card("DONE"));
  d1._raw.run(`UPDATE orders SET completedAt=NULL WHERE orderId='DONE'`);
  ({ card } = await queue());
  ok("…nor is one that's only delivered", !card("DONE"));
  d1._raw.run(`UPDATE orders SET deliveredAt=NULL, shippedAt='2026-09-20T00:00:00Z' WHERE orderId='DONE'`);
  ({ card } = await queue());
  ok("…nor one that's only shipped", !card("DONE"));
  const paidUnrun = new Function(strip(read("functions/_lib/db.js")) + "\nreturn getPaidUnrunOrders;")();
  ok("…and it isn't on the 'Paid, not yet run' list", !(await paidUnrun(d1)).some(o => o.orderId === "DONE"));
  d1._raw.run(`UPDATE orders SET shippedAt=NULL WHERE orderId='DONE'`);
  ({ card } = await queue());
  ok("an open order that isn't made is still listed", !!card("DONE"));
  const dbSrc = read("functions/_lib/db.js");
  const body = (name) => dbSrc.slice(dbSrc.indexOf("async function " + name + "("), dbSrc.indexOf("\n}\n", dbSrc.indexOf("async function " + name + "(")));
  const DONE_RE = /o\.completedAt IS NULL AND o\.shippedAt IS NULL AND o\.deliveredAt IS NULL/;
  ok("Run Order leaves out shipped / delivered / completed orders", DONE_RE.test(body("getProductionQueue")));
  ok("blank reservations, stock coverage and Blanks to Order do too",
    ["getBlankReservations", "getBlankStockCoverage", "getBlanksToOrder"].every(f => DONE_RE.test(body(f))));

  // The card's note on the Run Transfer Sheets screen.
  const dom = new JSDOM(`<!doctype html><body></body>`, { runScripts: "outside-only" });
  dom.window.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const src = read("public/admin.js");
  const fn = src.slice(src.indexOf("function rtTransferNote_("), src.indexOf("async function renderRunTransfer("));
  dom.window.eval(fn);
  const note = dom.window.rtTransferNote_;
  ok("card note: in stock", /in stock/i.test(note({ transferSource: "stock" })));
  ok("card note: already used", /already used/i.test(note({ transferSource: "used" })));
  ok("card note: what's short, escaped", /Transfers short: A&lt;b&gt; — 1 free in stock, needs 2/.test(note({ transferSource: "", transferShort: [{ name: "A<b>", free: 1, needed: 2 }] })));
  ok("the gang sheet window says it only lists what's left to print", /What still has to be printed/.test(src));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
