const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Reconciling money coming IN (migrations/0017):
//  1. a Venmo cash-out on the bank statement is mapped to the orders' Venmo payments it covers;
//     the missing part is Venmo's fee, recorded as an expense
//  2. a refund of something you bought is a NEGATIVE expense in the original category (it reduces
//     that Schedule C line) — not other income
//  3. a bank bonus/promotion is Other income (the hints say when to use which)
// Real SQL (sql.js), the real db.js + orders.js admin API, and the Create… window in jsdom.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, getExpenseSummary, getSalesTaxReturn, listAccounts };")();
const migrationsUpTo = (n) => fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < n).sort();

async function freshDb(upTo = "9999") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');`);
  for (const f of migrationsUpTo(upTo)) d1.execFile(read("migrations/" + f));
  // Sales tax is unset on a new database; this shop collects 6% (use tax is owed at the same rate).
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":"OH"}')`);
  return d1;
}
const api = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false,\n" +
  "  sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const checkShippedDeliveries = async () => ({ delivered: [] });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const CHECKING = 1, CARD = 2, VENMO = 3;
(async () => {
  // =====================================================================
  console.log("=== Migration 0017: expenses can be refunds; payments know their cash-out ===");
  let d1 = await freshDb("0017");
  const cat = (like) => d1.q("SELECT id FROM expense_categories WHERE name LIKE ?", like)[0].id;
  d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, vendor, createdAt, updatedAt, accountId) VALUES ('2026-08-01','Adobe',?,1299,'Adobe','t','t',2)", [cat("Software%")]);
  d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, businessUsePct, createdAt, updatedAt, deletedAt, paidPersonally) VALUES ('2026-08-02','Old lunch',?,5000,50,'t','t','2026-08-03T00:00:00Z',1)", [cat("Meals%")]);
  const before = d1.q("SELECT id, expenseDate, description, categoryId, amountCents, vendor, businessUsePct, deletedAt, accountId, paidPersonally FROM expenses ORDER BY id");
  d1.execFile(read("migrations/0017_venmo_cashouts_expense_refunds.sql"));
  const after = d1.q("SELECT id, expenseDate, description, categoryId, amountCents, vendor, businessUsePct, deletedAt, accountId, paidPersonally FROM expenses ORDER BY id");
  console.log("every existing expense (incl. a deleted one) survives the table rebuild unchanged:", JSON.stringify(before) === JSON.stringify(after) && after.length === 2);
  d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt, refundOfId) VALUES ('2026-08-20','Adobe refund',?,-1299,'t','t',1)", [cat("Software%")]);
  let rejected = false; try { d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES ('2026-08-20','zero',?,0,'t','t')", [cat("Software%")]); } catch (e) { rejected = true; }
  console.log("a negative amount (refund) is accepted, zero is refused:", rejected && d1.q("SELECT amountCents a FROM expenses WHERE id=3")[0].a === -1299);
  d1._raw.run("DELETE FROM expenses WHERE id=1");
  console.log("deleting the original just unlinks its refund (refundOfId → NULL):", d1.q("SELECT refundOfId r FROM expenses WHERE id=3")[0].r === null);
  console.log("order_payments has cashoutTransferId, empty for existing payments:", d1.q("SELECT name FROM pragma_table_info('order_payments') WHERE name='cashoutTransferId'").length === 1);

  // =====================================================================
  console.log("\n=== Refunds are negative expenses (real API) ===");
  d1 = await freshDb();
  let apiEnv = { DB: d1 };
  const call = async (body) => {
    const x = await api({ env: apiEnv, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  const software = cat("Software%"), meals = cat("Meals%"), office = cat("Office%");
  const buy = (o) => call({ action: "saveExpense", expense: Object.assign({ date: "2026-08-20", description: "Adobe Creative Cloud", categoryId: software, amount: 12.99, accountId: CARD }, o) });
  await buy({}); await buy({ description: "Lunch", categoryId: meals, amount: 10.05, date: "2026-08-21" });
  const list = async () => (await call({ action: "listExpenses", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body;
  let L = await list();
  const adobe = L.expenses.find(e => e.description === "Adobe Creative Cloud"), lunch = L.expenses.find(e => e.description === "Lunch");
  let r = await call({ action: "saveExpense", expense: { date: "2026-09-02", description: "Adobe refund", categoryId: software, amount: 12.99, refund: true, refundOfId: adobe.id, accountId: CARD } });
  L = await list();
  const ref = L.expenses.find(e => e.description === "Adobe refund");
  console.log("saving a refund stores it as a negative expense linked to the purchase:", r.status === 200 && ref.amount === -12.99 && ref.isRefund && ref.refundOfId === adobe.id);
  const sw = L.summary.byLine.find(x => x.line === "27a");
  console.log("the refund reduces the SAME Schedule C line (line 27a nets to $0.00 for the Adobe purchase + refund):", !!sw && sw.amount === 0 && sw.deductible === 0);
  console.log("total spent is net of the refund:", L.summary.totals.amount === 10.05);
  await call({ action: "saveExpense", expense: { date: "2026-09-03", description: "Lunch refund", categoryId: meals, amount: 10.05, refund: true, refundOfId: lunch.id, accountId: CARD } });
  L = await list();
  const lunchRefund = L.expenses.find(e => e.description === "Lunch refund");
  console.log("a 50%-deductible purchase and its refund reverse to the cent (not off by 1¢ from rounding):", lunch.deductible === 5.03 && lunchRefund.deductible === -5.03 &&
    L.summary.totals.deductible === 0 && L.summary.totals.amount === 0);
  r = await call({ action: "saveExpense", expense: { date: "2026-09-04", description: "again", categoryId: software, amount: 1, refund: true, refundOfId: adobe.id, accountId: CARD } });
  console.log("refunding more than was left of a purchase is refused:", r.status === 400 && /more than what's left/.test(r.body.message));
  r = await call({ action: "saveExpense", expense: { date: "2026-09-04", description: "x", categoryId: software, amount: 1, refund: true, refundOfId: ref.id, accountId: CARD } });
  console.log("a refund can't be the 'original' of another refund:", r.status === 400);
  r = await call({ action: "saveExpense", expense: { date: "2026-09-04", description: "x", categoryId: software, amount: 1, refundOfId: adobe.id, accountId: CARD } });
  console.log("only a refund can point at an original:", r.status === 400);
  r = await call({ action: "saveExpense", expense: { date: "2026-09-04", description: "x", categoryId: software, amount: -5, accountId: CARD } });
  console.log("a plain expense still can't be negative or zero:", r.status === 400);
  r = await call({ action: "saveExpense", expense: { id: ref.id, date: "2026-09-02", description: "Adobe refund (edited)", categoryId: software, amount: 10, refund: true, refundOfId: adobe.id, accountId: CARD } });
  L = await list();
  console.log("editing a refund keeps it negative (and can be smaller than the purchase):", r.status === 200 && L.expenses.find(e => e.id === ref.id).amount === -10);
  // use tax: a refund of an untaxed purchase reverses the use tax
  await buy({ description: "Office chair (no tax charged)", categoryId: office, amount: 100, vendorChargedTax: false, date: "2026-07-05" });
  const chair = (await list()).expenses.find(e => e.description.startsWith("Office chair"));
  await call({ action: "saveExpense", expense: { date: "2026-07-20", description: "Chair partly returned", categoryId: office, amount: 40, refund: true, refundOfId: chair.id, vendorChargedTax: false, accountId: CARD } });
  const tax = await lib.getSalesTaxReturn(d1, "2026-07-01", "2026-07-31");
  console.log("use tax on an untaxed purchase is reversed by its refund ($100 → $6.00, less $40 → $3.60):", tax.total.useTax === 3.6 && tax.total.useTaxablePurchases === 60);

  const ex = (await call({ action: "getAccountantExport", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body;
  const exRef = ex.expenses.find(e => e.description === "Adobe refund (edited)");
  console.log("the accountant export marks refunds (Type = Refund, negative amount) and the monthly deduction nets them:",
    !!exRef && exRef.type === "Refund" && exRef.amount === -10 && ex.expenses.find(e => e.description === "Lunch").type === "Expense" &&
    ex.summary.find(m => m.month === "2026-09").expensesDeductible < 0);

  // =====================================================================
  console.log("\n=== Reconcile → Create… → Refund of an expense ===");
  d1 = await freshDb(); apiEnv = { DB: d1 };
  const buy2 = (o) => call({ action: "saveExpense", expense: Object.assign({ date: "2026-08-20", description: "Adobe Creative Cloud", categoryId: cat("Software%"), amount: 12.99, accountId: CHECKING, vendor: "Adobe", businessUsePct: 60 }, o) });
  await buy2({});
  const adobe2 = (await call({ action: "listExpenses", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body.expenses[0];
  await call({ action: "importStatement", accountId: CHECKING, lines: [
    { date: "2026-09-10", description: "ADOBE SYSTEMS CREDIT", amount: 12.99 },
    { date: "2026-09-11", description: "SOMETHING ELSE REFUND", amount: 5 },
    { date: "2026-09-12", description: "BANK PROMOTION BONUS", amount: 20 },
    { date: "2026-09-13", description: "MONTHLY MAINTENANCE FEE", amount: -20 },
    { date: "2026-09-14", description: "SOFTWARE PURCHASE", amount: -9 }] });
  const recData = async () => (await call({ action: "getReconciliation", accountId: CHECKING, month: "2026-09" })).body;
  const lineOf = async (amt) => (await recData()).lines.find(l => l.amount === amt);
  let ln = await lineOf(12.99);
  const bal0 = (await lib.listAccounts(d1, "2026-12-31")).find(a => a.id === CHECKING).balance;
  r = await call({ action: "createFromStatementLine", lineId: ln.id, kind: "expense_refund", refundOfId: adobe2.id });
  const refExp = (await call({ action: "listExpenses", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body.expenses.find(e => e.isRefund);
  console.log("refund of the Adobe charge: a −$12.99 expense in the ORIGINAL category, linked, dated the deposit, matched to the line:",
    r.status === 200 && refExp.amount === -12.99 && refExp.category === adobe2.category && refExp.refundOfId === adobe2.id && refExp.date === "2026-09-10" &&
    r.body.lines.find(l => l.id === ln.id).status === "matched");
  console.log("it copied the original's vendor and business-use % (so it reverses the same deduction), and keeps the bank's wording:",
    refExp.vendor === "Adobe" && refExp.businessUsePct === 60 && refExp.deductible === -adobe2.deductible && /ADOBE SYSTEMS CREDIT/.test(refExp.description));
  const bal1 = (await lib.listAccounts(d1, "2026-12-31")).find(a => a.id === CHECKING).balance;
  console.log("the bank account's balance goes UP by the refund, as money in:", Math.round((bal1 - bal0) * 100) === 1299);
  console.log("...and no Other income entry was created (it isn't income):", d1.q("SELECT count(*) n FROM other_income")[0].n === 0);
  ln = await lineOf(5);
  r = await call({ action: "createFromStatementLine", lineId: ln.id, kind: "expense_refund", refundOfId: adobe2.id });
  console.log("a second refund that would exceed the purchase is refused:", r.status === 400 && /already refunded/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: ln.id, kind: "expense_refund" });
  console.log("a refund needs a category when no original is chosen:", r.status === 400 && /category/i.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: ln.id, kind: "expense_refund", categoryId: cat("Supplies%") });
  const noOrig = (await call({ action: "listExpenses", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body.expenses.find(e => e.isRefund && e.refundOfId == null);
  console.log("without an original: just the category — still a negative expense, unlinked:", r.status === 200 && noOrig.amount === -5 && noOrig.category.startsWith("Supplies"));
  ln = await lineOf(-9);
  r = await call({ action: "createFromStatementLine", lineId: ln.id, kind: "expense_refund", categoryId: cat("Supplies%") });
  console.log("money going OUT can't be recorded as a refund:", r.status === 400);
  ln = await lineOf(20);
  r = await call({ action: "createFromStatementLine", lineId: ln.id, kind: "income", incomeType: "other", description: "Bank promotion" });
  console.log("a bank bonus/promotion is Other business income (existing behavior):", r.status === 200 && d1.q("SELECT type FROM other_income")[0].type === "other");
  ln = await lineOf(-20);
  r = await call({ action: "createFromStatementLine", lineId: ln.id, kind: "expense", categoryId: cat("Bank%") });
  console.log("the $20 fee is a Bank & other fees expense (existing behavior):", r.status === 200 && d1.q("SELECT amountCents a FROM expenses WHERE description LIKE '%MAINTENANCE%'")[0].a === 2000);

  // =====================================================================
  console.log("\n=== Reconcile → Create… → Venmo cash-out ===");
  d1 = await freshDb(); apiEnv = { DB: d1 };
  const order = (id, cust) => lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: cust, contact: id + "@x.com", paymentMethod: "Venmo", placedAt: "2026-08-15T00:00:00Z" },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 2, unitPrice: 23 }]);
  for (const [id, c] of [["V1", "Vera"], ["V2", "Vic"], ["V3", "Val"], ["V4", "Vin"]]) await order(id, c);
  const venmoPay = (orderId, day, cents = 4600, extra = {}) => d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId, feeCents) VALUES (?,?,?,?,?,?)",
    [orderId, cents, `2026-08-${day}T12:00:00Z`, extra.method || "venmo", extra.accountId || VENMO, extra.fee || 0]);
  venmoPay("V1", "16"); venmoPay("V2", "17"); venmoPay("V3", "18"); venmoPay("V4", "19", 4600, { method: "other", accountId: CHECKING });
  d1._raw.run("UPDATE orders SET paid=1 WHERE orderId IN ('V1','V2','V3','V4')");
  await call({ action: "importStatement", accountId: CHECKING, lines: [
    { date: "2026-09-05", description: "VENMO CASHOUT", amount: 130 },
    { date: "2026-09-06", description: "VENMO CASHOUT SMALL", amount: 100 },
    { date: "2026-09-07", description: "VENMO CASHOUT EXACT AFTER FEE", amount: 45 },
    { date: "2026-09-08", description: "VENMO CASHOUT BIG", amount: 500 },
    { date: "2026-09-09", description: "VENMO CASHOUT NO FEE", amount: 46 }] });
  const vLine = async (amt) => (await recData()).lines.find(l => l.amount === amt);
  let cp = await call({ action: "listCashoutPayments" });
  console.log("lists the Venmo payments on real orders waiting to be cashed out (not the other-method one):",
    cp.status === 200 && cp.body.payments.length === 3 && cp.body.payments.every(p => p.orderId !== "V4") && cp.body.payments[0].orderId === "V3");
  const ids = cp.body.payments.map(p => p.id);
  const zellePay = d1.q("SELECT id FROM order_payments WHERE orderId='V4'")[0].id;
  let l130 = await vLine(130);
  r = await call({ action: "createFromStatementLine", lineId: (await vLine(500)).id, kind: "venmo_cashout", paymentIds: ids, feeCategoryId: cat("Bank%") });
  console.log("a deposit bigger than the ticked payments is refused ('tick more orders'):", r.status === 400 && /tick more/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: l130.id, kind: "venmo_cashout", paymentIds: [...ids.slice(0, 2), zellePay], feeCategoryId: cat("Bank%") });
  console.log("a non-Venmo payment can't be included:", r.status === 400 && /isn't available/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: l130.id, kind: "venmo_cashout", paymentIds: ids });
  console.log("when there's a fee, its category is required:", r.status === 400 && /category/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: l130.id, kind: "venmo_cashout", paymentIds: [] });
  console.log("nothing ticked is refused:", r.status === 400);
  r = await call({ action: "createFromStatementLine", lineId: l130.id, kind: "venmo_cashout", paymentIds: ids, feeCategoryId: cat("Bank%") });
  const tr = d1.q("SELECT * FROM account_transfers")[0];
  const fee = d1.q("SELECT * FROM expenses WHERE vendor='Venmo'")[0];
  console.log("$130 deposit for 3 × $46 = $138: one Venmo → checking transfer of $130, dated the deposit, matched to the line:",
    r.status === 200 && d1.q("SELECT count(*) n FROM account_transfers")[0].n === 1 && tr.amountCents === 13000 && tr.fromAccountId === VENMO && tr.toAccountId === CHECKING &&
    tr.transferDate === "2026-09-05" && /V1, V2, V3|V3, V2, V1/.test(tr.note) && r.body.lines.find(l => l.id === l130.id).status === "matched");
  console.log("the missing $8.00 is recorded as a Venmo-fee expense in the chosen category, out of the Venmo account:",
    !!fee && fee.amountCents === 800 && fee.accountId === VENMO && fee.categoryId === cat("Bank%") && fee.expenseDate === "2026-09-05" && /Venmo fees/.test(fee.description));
  const acc = await lib.listAccounts(d1);
  console.log("the Venmo account nets to $0.00 (3 payments − fee − cash-out), so nothing is left unexplained:", acc.find(a => a.id === VENMO).balance === 0);
  console.log("the three payments are marked cashed out and no longer offered:",
    d1.q("SELECT count(DISTINCT paymentId) n FROM payment_cashouts")[0].n === 3 && (await call({ action: "listCashoutPayments" })).body.payments.length === 0);
  console.log("audited with the payments, orders, deposit and fee:", (() => { const a = d1.q("SELECT detail FROM audit_log WHERE action='payments.deposit_mapped'")[0]; const dd = a && JSON.parse(a.detail); return !!dd && dd.differenceCents === 800 && dd.allocations.length === 3 && dd.transfers.length === 1; })());
  r = await call({ action: "createFromStatementLine", lineId: (await vLine(100)).id, kind: "venmo_cashout", paymentIds: ids, feeCategoryId: cat("Bank%") });
  console.log("already-cashed-out payments can't be used again:", r.status === 400 && /isn't available/.test(r.body.message));
  // deleting the transfer frees the payments again
  const del = await call({ action: "deleteMoneyEntry", kind: "transfer", id: tr.id });
  console.log("deleting the transfer puts the payments back on the list:", del.status === 200 && (await call({ action: "listCashoutPayments" })).body.payments.length === 3);
  // exact (no fee) + a payment that already had a recorded fee
  d1._raw.run("DELETE FROM payment_cashouts");
  d1._raw.run("UPDATE order_payments SET feeCents=0"); d1._raw.run("UPDATE order_payments SET feeCents=100 WHERE orderId='V1'");
  const exp0 = d1.q("SELECT count(*) n FROM expenses")[0].n;
  const v1 = d1.q("SELECT id FROM order_payments WHERE orderId='V1'")[0].id, v2 = d1.q("SELECT id FROM order_payments WHERE orderId='V2'")[0].id;
  r = await call({ action: "createFromStatementLine", lineId: (await vLine(45)).id, kind: "venmo_cashout", paymentIds: [v1] });
  console.log("deposit = payment less a fee already recorded on it ($46 − $1 = $45): accepted, no category needed:", r.status === 200 && r.body.lines.find(l => l.amount === 45).status === "matched");
  r = await call({ action: "createFromStatementLine", lineId: (await vLine(46)).id, kind: "venmo_cashout", paymentIds: [v2] });
  console.log("deposit = payment exactly (no fee): accepted, and no fee expense is created at all:", r.status === 200 && d1.q("SELECT count(*) n FROM expenses")[0].n === exp0);

  // =====================================================================
  console.log("\n=== A payment cashed out in PARTS (50% down / 50% at the end) ===");
  d1 = await freshDb(); apiEnv = { DB: d1 };
  await lib.insertOrder(d1, { orderId: "HALF", orgId: "prime", customerName: "Hal", contact: "h@x.com", paymentMethod: "Venmo", placedAt: "2026-08-15T00:00:00Z" },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 4, unitPrice: 23 }]);
  d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId) VALUES ('HALF',9200,'2026-08-16T12:00:00Z','venmo',3)");
  d1._raw.run("UPDATE orders SET paid=1 WHERE orderId='HALF'");
  await call({ action: "importStatement", accountId: CHECKING, lines: [
    { date: "2026-09-05", description: "VENMO CASHOUT A", amount: 44 }, { date: "2026-09-19", description: "VENMO CASHOUT B", amount: 44 }, { date: "2026-09-20", description: "VENMO CASHOUT C", amount: 90 }] });
  const half = d1.q("SELECT id FROM order_payments WHERE orderId='HALF'")[0].id;
  const pline = async (amt) => (await recData()).lines.find(l => l.amount === amt);
  const listed = async () => (await call({ action: "listCashoutPayments" })).body.payments;
  const lines44 = (await recData()).lines.filter(l => l.amount === 44);
  r = await call({ action: "createFromStatementLine", lineId: lines44[0].id, kind: "venmo_cashout", allocations: [{ paymentId: half, amount: 0 }], feeCategoryId: cat("Bank%") });
  console.log("an amount of zero is refused:", r.status === 400 && /Enter how much/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: lines44[0].id, kind: "venmo_cashout", allocations: [{ paymentId: half, amount: 93 }], feeCategoryId: cat("Bank%") });
  console.log("more than the payment has is refused:", r.status === 400 && /only \$92\.00 left/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: lines44[0].id, kind: "venmo_cashout", allocations: [{ paymentId: half, amount: 40 }], feeCategoryId: cat("Bank%") });
  console.log("covering less than the deposit is refused ('tick more'):", r.status === 400 && /tick more/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: lines44[0].id, kind: "venmo_cashout", allocations: [{ paymentId: half, amount: 46 }], feeCategoryId: cat("Bank%") });
  const tA = d1.q("SELECT id FROM account_transfers ORDER BY id")[0];
  console.log("first cash-out: $44 deposit covers $46 of the $92 payment → $2.00 fee, transfer matched:",
    r.status === 200 && r.body.lines.find(l => l.id === lines44[0].id).status === "matched" && d1.q("SELECT amountCents a FROM expenses WHERE vendor='Venmo'")[0].a === 200);
  let pl = (await listed()).find(p => p.id === half);
  console.log("the payment is STILL offered, showing $46.00 left of $92.00 ($46.00 already cashed out):", !!pl && pl.remaining === 46 && pl.cashedOut === 46 && pl.amount === 92);
  r = await call({ action: "createFromStatementLine", lineId: lines44[1].id, kind: "venmo_cashout", allocations: [{ paymentId: half, amount: 46.01 }], feeCategoryId: cat("Bank%") });
  console.log("the second cash-out can't take more than what's left ($46.00):", r.status === 400 && /only \$46\.00 left/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: lines44[1].id, kind: "venmo_cashout", allocations: [{ paymentId: half, amount: 46 }], feeCategoryId: cat("Bank%") });
  console.log("second cash-out covers the remaining $46 → another $2.00 fee, both deposits matched:", r.status === 200 && d1.q("SELECT count(*) n FROM expenses WHERE vendor='Venmo'")[0].n === 2 &&
    d1.q("SELECT sum(amountCents) a FROM payment_cashouts")[0].a === 9200);
  console.log("the payment is fully cashed out and no longer offered:", !(await listed()).some(p => p.id === half));
  console.log("the Venmo account nets to $0.00 across the two cash-outs and the two fees:", (await lib.listAccounts(d1, "2026-12-31")).find(a => a.id === VENMO).balance === 0);
  r = await call({ action: "createFromStatementLine", lineId: (await pline(90)).id, kind: "venmo_cashout", allocations: [{ paymentId: half, amount: 10 }], feeCategoryId: cat("Bank%") });
  console.log("a fully cashed-out payment can't be used again:", r.status === 400 && /isn't available/.test(r.body.message));
  await call({ action: "deleteMoneyEntry", kind: "transfer", id: tA.id });
  pl = (await listed()).find(p => p.id === half);
  console.log("deleting the first transfer frees just its $46.00 (the second cash-out still holds the other $46.00):", !!pl && pl.remaining === 46 && pl.cashedOut === 46);
  // plain paymentIds still means the whole remaining amount
  const lC = await pline(90);
  r = await call({ action: "createFromStatementLine", lineId: lC.id, kind: "venmo_cashout", paymentIds: [half], feeCategoryId: cat("Bank%") });
  console.log("the older 'paymentIds' form still works and takes the whole remaining amount ($46 for a $90 deposit is refused; short):", r.status === 400 && /tick more/.test(r.body.message));

  // migration 0018 backfills whole-payment allocations from 0017's single link
  console.log("\n=== Migration 0018: existing cash-out links become allocations ===");
  d1 = await freshDb("0018"); apiEnv = { DB: d1 };
  await lib.insertOrder(d1, { orderId: "MIG", orgId: "prime", customerName: "Mig", contact: "m@x.com", paymentMethod: "Venmo", placedAt: "2026-08-15T00:00:00Z" },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 2, unitPrice: 23 }]);
  d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId) VALUES ('MIG',4600,'2026-08-16T12:00:00Z','venmo',3), ('MIG',4600,'2026-08-17T12:00:00Z','venmo',3)");
  d1._raw.run("INSERT INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, createdAt, updatedAt) VALUES ('2026-09-05',3,1,4500,'t','t')");
  d1._raw.run("UPDATE order_payments SET cashoutTransferId=1 WHERE receivedAt LIKE '2026-08-16%'");
  d1.execFile(read("migrations/0018_payment_cashout_allocations.sql"));
  const alloc = d1.q("SELECT paymentId, transferId, amountCents FROM payment_cashouts");
  console.log("the already-cashed-out payment gets a full-amount allocation; the other is untouched:", alloc.length === 1 && alloc[0].amountCents === 4600 && alloc[0].transferId === 1);
  console.log("...so it's no longer offered but the other still is:", (await listed()).length === 1);

  // =====================================================================
  console.log("\n=== The Create… window (jsdom) ===");
  d1 = await freshDb(); apiEnv = { DB: d1 };
  for (const [id, c] of [["W1", "Wes"], ["W2", "Wren"]]) await lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: c, contact: id + "@x.com", paymentMethod: "Venmo", placedAt: "2026-08-15T00:00:00Z" },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 2, unitPrice: 23 }]);
  d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId) VALUES ('W1',4600,'2026-08-16T12:00:00Z','venmo',3), ('W2',4600,'2026-08-17T12:00:00Z','venmo',3)");
  await call({ action: "saveExpense", expense: { date: "2025-11-20", description: "ADOBE CREATIVE CLOUD", categoryId: cat("Software%"), amount: 12.99, accountId: CHECKING, vendor: "Adobe" } });
  await call({ action: "saveExpense", expense: { date: "2026-08-20", description: "Thread order", categoryId: cat("Supplies%"), amount: 40, accountId: CHECKING } });
  await call({ action: "saveExpense", expense: { date: "2026-08-22", description: "Tiny purchase", categoryId: cat("Supplies%"), amount: 5, accountId: CHECKING } });
  await call({ action: "importStatement", accountId: CHECKING, lines: [
    { date: "2026-09-05", description: "VENMO CASHOUT 8871", amount: 88 }, { date: "2026-09-10", description: "ADOBE SYSTEMS REFUND", amount: 12.99 },
    { date: "2026-09-12", description: "PROMOTION BONUS", amount: 20 }, { date: "2026-09-13", description: "MONTHLY FEE", amount: -20 }] });
  const adminJs = read("public/admin.js");
  class L2 extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L2(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; sent.push(b); const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };
  const d = (await call({ action: "getReconciliation", accountId: CHECKING, month: "2026-09" })).body;
  const openModal = async (amt) => { const line = d.lines.find(l => l.amount === amt); let acted = null;
    await w.rcCreateModal_(d, line, async (b) => { acted = b; }); const ov = w.document.body.lastElementChild; return { ov, q: (s) => ov.querySelector(s), acted: () => acted, line }; };
  const tick = (el) => { el.checked = true; el.dispatchEvent(new w.Event("change", { bubbles: true })); };

  let m = await openModal(88);
  const kindOpts = [...m.q("#rccKind").options].map(o => o.value);
  console.log("money-in lines offer: Other income, Refund of an expense, Deposit (Venmo/cash/checks), owner, transfer:", kindOpts.join(",") === "income,expense_refund,deposit,owner,transfer");
  console.log("a 'VENMO CASHOUT' line starts on Deposit (showing Venmo payments), with a hint that explains it:", m.q("#rccKind").value === "deposit" && /a Venmo cash-out, cash, checks/.test(m.q("#rccHint").textContent));
  await wait(() => m.q("#vmList input[data-pid]"));
  console.log("lists the Venmo payments waiting (order, customer, amount), Create disabled until something is ticked:",
    m.q("#vmList").querySelectorAll("input[data-pid]").length === 2 && /Wes|Wren/.test(m.q("#vmList").textContent) && m.q("#rccOk").disabled === true);
  tick(m.q("#vmList input[data-pid]"));
  console.log("one $46 payment against an $88 deposit says it's short and stays disabled:", /short of the deposit/.test(m.q("#vmSum").textContent) && m.q("#rccOk").disabled);
  m.q("#vmOldest").click();
  const covs = () => [...m.q("#vmList").querySelectorAll("input[data-cov]")];
  console.log("'Tick oldest first until it covers the deposit' ticks both; the second only covers what's still needed ($46 + $42 = $88):",
    [...m.q("#vmList").querySelectorAll("input[data-pid]")].every(b => b.checked) && covs().map(c => c.value).sort().join(",") === "42.00,46.00" && /matches exactly/.test(m.q("#vmSum").textContent));
  const second = covs().find(c => c.value === "42.00");
  second.value = "46.00"; second.dispatchEvent(new w.Event("input", { bubbles: true }));
  console.log("raising the second to its full $46 shows the fee: $92.00 − $88.00 = $4.00 (4.3%), the fee-category picker appears, Create is enabled:",
    /Venmo fees \$4\.00 \(4\.3%\)/.test(m.q("#vmSum").textContent) && m.q("#vmFeeRow").style.display !== "none" && m.q("#rccOk").disabled === false);
  second.value = "46.01"; second.dispatchEvent(new w.Event("input", { bubbles: true }));
  console.log("an amount above what the payment has left is flagged and Create is disabled:", m.q("#rccOk").disabled === true && /needs an amount/.test(m.q("#vmSum").textContent));
  second.value = "46.00"; second.dispatchEvent(new w.Event("input", { bubbles: true }));
  console.log("the fee category defaults to a bank/fees category:", /Bank/.test(m.q("#vmCat").selectedOptions[0].textContent));
  m.q("#rccOk").click();
  await new Promise(x => setTimeout(x, 20));
  console.log("submits each payment with the amount it covers, and the fee category:", !!m.acted() && m.acted().kind === "deposit" && m.acted().allocations.length === 2 &&
    m.acted().allocations.every(a => a.amount === 46) && m.acted().feeCategoryId > 0);
  const real = await call(m.acted());
  console.log("…and the server records it, matching the deposit:", real.status === 200 && real.body.lines.find(l => l.id === m.line.id).status === "matched" && d1.q("SELECT amountCents a FROM expenses WHERE vendor='Venmo'")[0].a === 400);

  // A payment already part-cashed-out: the window shows what's left and defaults "covers" to what the deposit needs.
  await lib.insertOrder(d1, { orderId: "PH", orgId: "prime", customerName: "Pia", contact: "p@x.com", paymentMethod: "Venmo", placedAt: "2026-08-15T00:00:00Z" },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 4, unitPrice: 23 }]);
  d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId) VALUES ('PH',9200,'2026-08-10T12:00:00Z','venmo',3)");
  d1._raw.run("INSERT INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, createdAt, updatedAt) VALUES ('2026-09-01',3,1,4400,'t','t')");
  d1._raw.run("INSERT INTO payment_cashouts (paymentId, transferId, amountCents, createdAt) VALUES ((SELECT id FROM order_payments WHERE orderId='PH'), (SELECT max(id) FROM account_transfers), 4600, 't')");
  await call({ action: "importStatement", accountId: CHECKING, lines: [{ date: "2026-09-14", description: "VENMO CASHOUT PART TWO", amount: 44 }] });
  const dP = (await call({ action: "getReconciliation", accountId: CHECKING, month: "2026-09" })).body;
  let acted2 = null;
  await w.rcCreateModal_(dP, dP.lines.find(l => l.description === "VENMO CASHOUT PART TWO"), async (b) => { acted2 = b; });
  const ovP = w.document.body.lastElementChild, qP = (x) => ovP.querySelector(x);
  await wait(() => qP('#vmList input[data-cov]'));
  const rowP = [...qP("#vmList").querySelectorAll("tr")].find(t => /PH/.test(t.textContent));
  console.log("a part-cashed-out payment shows what's left ($46.00 left of $92.00, $46.00 already cashed out):", /\$46\.00 left of \$92\.00/.test(rowP.textContent) && /\$46\.00 already deposited/.test(rowP.textContent));
  const boxP = rowP.querySelector("input[data-pid]"), covP = rowP.querySelector("input[data-cov]");
  console.log("'covers' is disabled until the payment is ticked:", covP.disabled === true);
  boxP.checked = true; boxP.dispatchEvent(new w.Event("change", { bubbles: true }));
  console.log("ticking it defaults 'covers' to the smaller of what's left and what the deposit needs ($44.00), so there's no fee yet:", covP.value === "44.00" && /matches exactly/.test(qP("#vmSum").textContent));
  covP.value = "46.00"; covP.dispatchEvent(new w.Event("input", { bubbles: true }));
  console.log("entering the payment's real $46.00 share shows the Venmo fee ($2.00, 4.3%) and enables Create:", /Venmo fees \$2\.00 \(4\.3%\)/.test(qP("#vmSum").textContent) && qP("#rccOk").disabled === false);
  qP("#rccOk").click(); await new Promise(x => setTimeout(x, 20));
  console.log("submits just that payment's covered amount:", acted2 && acted2.allocations.length === 1 && acted2.allocations[0].amount === 46);
  const done = await call(acted2);
  console.log("...and the server finishes the payment off (nothing left to offer):", done.status === 200 && (await call({ action: "listCashoutPayments" })).body.payments.every(p => p.orderId !== "PH"));

  m = await openModal(12.99);
  console.log("an 'ADOBE … REFUND' line starts on Refund of an expense, hint says it's not income:", m.q("#rccKind").value === "expense_refund" && /not income/.test(m.q("#rccHint").textContent));
  await wait(() => m.q("#rfOrig").options.length > 1);
  const opts = [...m.q("#rfOrig").options];
  console.log("lists past purchases, best match (Adobe, same amount) first and preselected, category copied from it:",
    /ADOBE CREATIVE CLOUD/.test(opts[1].textContent) && m.q("#rfOrig").value === opts[1].value && /Software/.test(m.q("#rfCat").selectedOptions[0].textContent));
  console.log("Create is enabled once there's a category:", m.q("#rccOk").disabled === false);
  console.log("the Adobe purchase was in 2025, so it warns that a refund in a later year is normally other income:", /2025/.test(m.q("#rfNote").textContent) && /other income/i.test(m.q("#rfNote").textContent));
  console.log("a purchase smaller than the refund ($5 vs $12.99) isn't offered; bigger ones are:", !opts.some(o => /Tiny purchase/.test(o.textContent)) && opts.some(o => /Thread order/.test(o.textContent)));
  m.q("#rfOrig").value = ""; m.q("#rfOrig").dispatchEvent(new w.Event("change")); m.q("#rfCat").value = ""; m.q("#rfCat").dispatchEvent(new w.Event("change"));
  console.log("with no category the button is disabled again:", m.q("#rccOk").disabled === true);
  m.q("#rfCat").value = String(cat("Software%")); m.q("#rfCat").dispatchEvent(new w.Event("change"));
  m.q("#rccOk").click(); await new Promise(x => setTimeout(x, 20));
  console.log("submits the category (and no original when none is chosen):", m.acted().kind === "expense_refund" && m.acted().categoryId === cat("Software%") && m.acted().refundOfId === 0);

  m = await openModal(20);
  console.log("a 'PROMOTION BONUS' line stays on Other income, with the bonus-vs-refund hint:", m.q("#rccKind").value === "income" && /bonus\/promotion is Other business income/.test(m.q("#rccHint").textContent) && /Refund of an expense/.test(m.q("#rccHint").textContent));
  m = await openModal(-20);
  console.log("money-out lines are unchanged (no refund / Venmo options):", ![...m.q("#rccKind").options].some(o => /refund|venmo/.test(o.value)));

  // Expenses screen
  await w.renderExpenses(w.document.getElementById("app"));
  await wait(() => w.document.getElementById("expRefund"));
  console.log("the Expenses form has a 'This is a refund' box:", !!w.document.getElementById("expRefund"));
  await w.renderExpenses(w.document.getElementById("app"));
  await wait(() => /Thread order/.test(w.document.getElementById("expList").textContent));
  console.log("negative amounts show as −$…:", w.eval("expMoney_(-12.99)") === "−$12.99" && w.eval("expMoney_(12.99)") === "$12.99");
  console.log("(the list marks refunds with a REFUND tag):", /x\.isRefund \? `<span[^`]*REFUND/.test(adminJs));
})().catch(e => { console.log("test49 crashed:", false); console.error(e); process.exit(1); });
