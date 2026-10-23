const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Records that must agree are written together (the paid rule counts sales tax added on top of the
// prices too, migrations/0052):
//   • a payment row and the order's paid flag — one transaction; a retry repairs, not just acknowledges
//   • saving the blank form — one transaction; it changes only the stock and cost that were edited
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { addOrderPayment, addShippingPayment, refreshPaidStatus, paidRefreshSql_, insertOrder, getOrderById, createBlank, updateBlank, getAllBlanks, receiveBlanks, getBlankMovements, voidPayment, setOrderDiscount };`)();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const mk = async (orderId, lines, extra = {}) => lib.insertOrder(d1, Object.assign({ orderId, orgId: "club", customerName: "C", contact: "c@x.com", paymentMethod: "Venmo", placedAt: "2026-10-01T00:00:00Z",
    subtotal: 0, shippingCost: 0, total: 0 }, extra), lines.map(([qty, unitPrice]) => ({ productId: "", name: "Item", type: "shirt", size: "L", qty, unitPrice })));
  const flag = (id) => d1.q("SELECT paid, paidAt FROM orders WHERE orderId=?", id)[0];

  console.log("=== The one-statement paid check agrees with the step-by-step one ===");
  // Many orders in every state; for each, run the SQL form on a copy of the state and compare with the JS form.
  let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let mismatches = 0, cases = 0, sawPaid = 0, sawUnpaid = 0, sawZero = 0;
  for (let i = 0; i < 160; i++) {
    const id = "R-" + i;
    await mk(id, Array.from({ length: 1 + rnd(3) }, () => [1 + rnd(3), [5, 12.5, 20, 33.33, 0][rnd(9) % 5]]), { shippingCost: [0, 0, 4.5, 8][rnd(4)] });
    if (rnd(4) === 0) d1._raw.run("UPDATE order_items SET cancelDate='2026-10-02' WHERE orderId=? AND id = (SELECT MIN(id) FROM order_items WHERE orderId=?)", [id, id]);
    if (rnd(3) === 0) d1._raw.run("UPDATE orders SET discountCents=? WHERE orderId=?", [[100, 500, 99999][rnd(3)], id]);
    // Sales tax added on top of the prices (migrations/0052): the tax is part of what's owed.
    if (rnd(3) === 0) {
      d1._raw.run("UPDATE orders SET taxMode='exclusive', discountTaxCents=? WHERE orderId=?", [[0, 0, 30, 999999][rnd(4)], id]);
      d1._raw.run("UPDATE order_items SET taxCents = ? WHERE orderId=?", [[0, 60, 125, 7][rnd(4)], id]);
    }
    const owedRow = await lib.refreshPaidStatus(d1, id);
    if (rnd(2) === 0 && owedRow.owedCents > 0) d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, note, kind) VALUES (?, ?, '2026-10-04T00:00:00Z', 'full', 'payment')", [id, owedRow.owedCents - (rnd(5) === 0 ? 1 : 0)]);
    for (let p = 0, n = rnd(4); p < n; p++) {
      const amt = [1, 5, 12.5, (owedRow.owedCents || 0) / 100, 40][rnd(5)] || 1;
      d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, note, kind, voidedAt) VALUES (?, ?, ?, 'x', ?, ?)",
        [id, Math.round(amt * 100) * (rnd(6) === 0 ? -1 : 1) || 100, "2026-10-0" + (1 + rnd(8)) + "T00:00:00Z", rnd(6) === 0 ? "refund" : "payment", rnd(7) === 0 ? "2026-10-09" : null]);
    }
    // Start from each possible stored flag, including a stale one.
    for (const [startPaid, startAt] of [[0, null], [1, "2026-09-30T00:00:00Z"]]) {
      d1._raw.run("UPDATE orders SET paid=?, paidAt=? WHERE orderId=?", [startPaid, startAt, id]);
      await d1.prepare(lib.paidRefreshSql_("taxMode")).bind("NOW", id).run();
      const viaSql = flag(id);
      d1._raw.run("UPDATE orders SET paid=?, paidAt=? WHERE orderId=?", [startPaid, startAt, id]);
      const st = await lib.refreshPaidStatus(d1, id);
      const viaJs = flag(id);
      cases++;
      const sameAt = viaSql.paidAt === viaJs.paidAt || (viaSql.paidAt === "NOW" && /^20\d\d-/.test(viaJs.paidAt || ""));
      if (Number(viaSql.paid) !== Number(viaJs.paid) || !sameAt) { mismatches++; if (mismatches < 4) console.log("  mismatch", id, startPaid, JSON.stringify(viaSql), JSON.stringify(viaJs)); }
      if (st.owedCents === 0) sawZero++; else if (viaJs.paid) sawPaid++; else sawUnpaid++;
    }
  }
  ok(`same flag and same paid date in all ${cases} cases (paid, unpaid and nothing-owed orders all exercised)`, mismatches === 0 && sawPaid > 20 && sawUnpaid > 20 && sawZero > 5);

  console.log("\n=== A payment and the paid flag are one transaction ===");
  await mk("A-1", [[1, 20]]);
  let id = await lib.addOrderPayment(d1, "A-1", 20, "Stripe", "pi_1", { method: "card", feeCents: 88 });
  ok("recording the payment marks the order paid, dated by the payment", id > 0 && flag("A-1").paid === 1 && /^20\d\d-/.test(flag("A-1").paidAt));
  ok("a part payment doesn't", (await mk("A-2", [[1, 20]]), await lib.addOrderPayment(d1, "A-2", 5, "part", "pi_2"), flag("A-2").paid === 0));
  // The failure the audit described: the row is there but the flag was never set; then the same event comes again.
  await mk("A-3", [[1, 20]]);
  d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, note, externalRef, kind) VALUES ('A-3', 2000, '2026-10-03T00:00:00Z', 'Stripe', 'pi_3', 'payment')");
  ok("(an order left with its payment recorded but still marked unpaid)", flag("A-3").paid === 0);
  id = await lib.addOrderPayment(d1, "A-3", 20, "Stripe", "pi_3", { method: "card" });
  ok("the retry adds no second row but DOES repair the flag", id === 0 && Number(d1.q("SELECT count(*) n FROM order_payments WHERE orderId='A-3'")[0].n) === 1 && flag("A-3").paid === 1 && flag("A-3").paidAt === "2026-10-03T00:00:00Z");
  // If the second statement of the batch fails, the first must not stay.
  await mk("A-4", [[1, 20]]);
  const realBatch = d1.batch.bind(d1);
  const src = lib.addOrderPayment.toString();
  ok("the row and the flag go to the database in a single batch (no write between them)", /const results = await db\.batch\(stmts\);/.test(src) && !/await refreshPaidStatus/.test(src) && /stmts\.push\(await paidRefreshStmt_\(db, orderId\)\);/.test(src));
  d1.batch = async (stmts) => { throw new Error("D1 unavailable"); };
  let threw = false; try { await lib.addOrderPayment(d1, "A-4", 20, "Stripe", "pi_4"); } catch (e) { threw = true; }
  d1.batch = realBatch;
  ok("when that batch fails nothing is recorded — no payment row without its flag", threw && Number(d1.q("SELECT count(*) n FROM order_payments WHERE orderId='A-4'")[0].n) === 0 && flag("A-4").paid === 0);
  await mk("A-5", [[1, 20]]);
  id = await lib.addOrderPayment(d1, "A-5", -8, "Refund", "re_5", { kind: "refund", shippingCents: 300 });
  ok("a refund's shipping part is stored on its own row, in the same step", id > 0 && Number(d1.q("SELECT shippingCents s FROM order_payments WHERE id=?", id)[0].s) === 300);
  await mk("A-6", [[1, 20]], { shippingCost: 6 });
  await lib.addOrderPayment(d1, "A-6", 20, "goods", "pi_6");
  await lib.addShippingPayment(d1, "A-6", 6, "Shipping payment", "pi_6s", 40);
  ok("a shipping payment that completes the balance marks the order paid in its own batch", flag("A-6").paid === 1 && /paidRefreshStmt_\(db, orderId\),/.test(lib.addShippingPayment.toString()));

  console.log("\n=== Saving the blank form ===");
  const blankId = (await lib.createBlank(d1, { name: "Polo", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 6, quantity: 10 }, { size: "L", purchasePrice: 6, quantity: 10 }] }] })).id;
  const stock = () => Object.fromEntries(d1.q("SELECT color||'|'||size k, quantity q, purchasePriceCents c FROM blank_sizes WHERE blankId=? ORDER BY 1", blankId).map(r => [r.k, r.q + "@" + r.c]));
  const moved = (key) => { const [c, z] = key.split("|"); return Number(d1.q("SELECT COALESCE(SUM(qtyDelta),0) n FROM inventory_movements WHERE blankId=? AND color=? AND size=? AND voidedAt IS NULL", blankId, c, z)[0].n); };
  // The form is opened (showing 10 and 10 at $6.00) …
  const formAsOpened = () => ({ name: "Polo", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [
    { size: "M", purchasePrice: 6, quantity: 10, baseQuantity: 10, basePurchasePrice: 6 }, { size: "L", purchasePrice: 6, quantity: 10, baseQuantity: 10, basePurchasePrice: 6 }] }] });
  // … and while it sits open, a delivery arrives (M: +20 at $8) and stock is used (L: 3 pieces).
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "M", qty: 20, unitCost: 8 }], receivedAt: "2026-10-05" });
  d1._raw.run("UPDATE blank_sizes SET quantity = quantity - 3 WHERE blankId=? AND size='L'", [blankId]);
  d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, note, occurredAt, createdAt) VALUES (?, 'Polo', 'Navy', 'L', -3, 600, 'consume', '', '2026-10-05', '2026-10-05')", [blankId]);
  const beforeSave = stock();
  ok("(stock moved while the form was open: M 30 at the new average cost, L 7)", beforeSave["Navy|M"] === "30@733" && beforeSave["Navy|L"] === "7@600");
  const f1 = formAsOpened(); f1.name = "Polo (renamed)";
  await lib.updateBlank(d1, blankId, f1);
  ok("saving the form with only the name changed leaves the stock and cost exactly as they are now", JSON.stringify(stock()) === JSON.stringify(beforeSave) && d1.q("SELECT name FROM blanks WHERE id=?", blankId)[0].name === "Polo (renamed)");
  ok("…and writes no stock adjustment", Number(d1.q("SELECT count(*) n FROM inventory_movements WHERE blankId=? AND note='Edited in blank form'", blankId)[0].n) === 0);
  const f2 = formAsOpened(); f2.colors[0].sizes[1].quantity = 12;      // the user counted 2 more L than the form showed
  await lib.updateBlank(d1, blankId, f2);
  ok("changing a quantity applies the difference to the stock as it is now (shown 10, typed 12, was 7 → 9)", stock()["Navy|L"] === "9@600" && stock()["Navy|M"] === "30@733");
  ok("the adjustment is recorded, and the history still adds up to the stock", moved("Navy|L") === 9 && moved("Navy|M") === 30);
  const f3 = formAsOpened(); f3.colors[0].sizes[0].purchasePrice = 7.25; // a deliberate cost edit
  f3.colors[0].sizes[1].baseQuantity = 10; f3.colors[0].sizes[1].quantity = 10;
  await lib.updateBlank(d1, blankId, f3);
  ok("a cost box that was edited is saved; one left alone keeps the current average", stock()["Navy|M"] === "30@725" && stock()["Navy|L"] === "9@600");
  await lib.updateBlank(d1, blankId, { name: "Polo", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 7.25, quantity: 4 }, { size: "L", purchasePrice: 6, quantity: 9 }] }] });
  ok("a caller that doesn't say what it was shown (an import, an older page) still sets the numbers outright", stock()["Navy|M"] === "4@725" && moved("Navy|M") === 4);
  const f4 = { name: "Polo", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 7.25, quantity: 4, baseQuantity: 4, basePurchasePrice: 7.25 },
    { size: "L", purchasePrice: 6, quantity: 0, baseQuantity: 9, basePurchasePrice: 6 }, { size: "XL", purchasePrice: 6.5, quantity: 5 }] }] };
  await lib.updateBlank(d1, blankId, f4);
  ok("a new size is added with its typed stock, and stock can't go below zero", stock()["Navy|XL"] === "5@650" && stock()["Navy|L"] === "0@600" && moved("Navy|XL") === 5 && moved("Navy|L") === 0);

  // A save that fails must leave everything as it was.
  const safe = stock(), safeColors = Number(d1.q("SELECT count(*) n FROM blank_colors WHERE blankId=?", blankId)[0].n), safeMoves = Number(d1.q("SELECT count(*) n FROM inventory_movements WHERE blankId=?", blankId)[0].n);
  d1.batch = async () => { throw new Error("D1 unavailable"); };
  threw = false; try { await lib.updateBlank(d1, blankId, { name: "Polo", productType: "shirt", colors: [{ color: "Black", images: [], sizes: [{ size: "S", purchasePrice: 5, quantity: 1 }] }] }); } catch (e) { threw = true; }
  d1.batch = realBatch;
  ok("a save that fails leaves every size, color, stock count and history row in place", threw && JSON.stringify(stock()) === JSON.stringify(safe) &&
    Number(d1.q("SELECT count(*) n FROM blank_colors WHERE blankId=?", blankId)[0].n) === safeColors && Number(d1.q("SELECT count(*) n FROM inventory_movements WHERE blankId=?", blankId)[0].n) === safeMoves);
  const w = dbSrc.slice(dbSrc.indexOf("async function writeBlankColors_"), dbSrc.indexOf("// ---- Vendor prices (migrations/0062)"));
  ok("the delete, the new rows and the stock movements are one batch (one transaction)", (w.match(/db\.batch\(/g) || []).length === 1 && /await db\.batch\(stmts\);\n  return priceChanges;\n\}/.test(w) && !/insertMovement_\(/.test(w));
  ok("the blank form sends back what each size was showing when it opened", /const withBase = \(s\) => \(\{ \.\.\.s, baseQuantity: s\.quantity, basePurchasePrice: s\.purchasePrice,/.test(read("public/admin.js")));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test124 crashed: false"); process.exit(1); });
