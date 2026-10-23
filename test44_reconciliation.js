const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Statement import & monthly reconciliation (migrations/0015) — real SQL
// (sql.js), real db.js + orders.js admin API, plus the admin CSV parsing and
// Reconcile screen (jsdom).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { addOrderPayment, maskStatementDescription, listAccounts };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, subtotal, total, placedAt) VALUES
      ('A','prime','Ann','a@x','Check',100,100,'2026-08-01T00:00:00Z'), ('B','prime','Bob','b@x','Card',50,50,'2026-08-02T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES
      ('A','prime','p','Cap','cap',1,100,100,''),('B','prime','p','Cap','cap',1,50,50,'');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  // Checking opens Aug 1 with $1,000. Recorded in August: two check deposits
  // ($60 + $40, deposited together), an expense by debit card ($25), a check
  // payment not yet deposited ($15), and a Stripe card payment (+ fee).
  await call({ action: "saveAccount", account: { id: 1, name: "Business checking", type: "checking", openingDate: "2026-08-01", openingBalance: 1000, active: true } });
  await call({ action: "saveAccount", account: { id: 5, name: "Stripe balance", type: "stripe", openingDate: "2026-08-01", openingBalance: 0, active: true } });
  await call({ action: "addPayment", orderId: "A", amount: 60, method: "check", reference: "101", date: "2026-08-03" });
  await call({ action: "addPayment", orderId: "A", amount: 40, method: "check", reference: "102", date: "2026-08-03" });
  await call({ action: "saveExpense", expense: { date: "2026-08-10", description: "Thread", categoryId: 2, amount: 25, accountId: 1 } });
  await call({ action: "addPayment", orderId: "B", amount: 15, method: "check", reference: "103", date: "2026-08-28" });
  await lib.addOrderPayment(d1, "B", 35, "Stripe", "pi_B", { method: "card", feeCents: 132, receivedAt: "2026-08-05T00:00:00Z" });

  console.log("=== Import ===");
  const stmt = [
    { date: "2026-08-04", description: "DEPOSIT", amount: 100 },
    { date: "2026-08-11", description: "POS PURCHASE ETSY 4412 8812 3301 9921", amount: -25 },
    { date: "2026-08-15", description: "MONTHLY SERVICE FEE", amount: -12 },
    { date: "2026-08-20", description: "AMAZON MKTPLACE", amount: -48.5 },
    { date: "2026-08-20", description: "AMAZON MKTPLACE", amount: -48.5 },
  ];
  let r = await call({ action: "importStatement", accountId: 1, lines: stmt, mapping: { date: "Date", desc: "Description", mode: "one", amount: "Amount", flip: false } });
  console.log("5 lines imported (two identical Amazon lines kept apart):", r.status === 200 && r.body.inserted === 5 && r.body.duplicates === 0);
  console.log("$25 debit-card purchase auto-matched to the Thread expense:", r.body.matched === 1);
  r = await call({ action: "importStatement", accountId: 1, lines: stmt });
  console.log("re-importing the same file adds nothing:", r.body.inserted === 0 && r.body.duplicates === 5);
  console.log("card numbers in descriptions are masked:", lib.maskStatementDescription("POS ETSY 4412 8812 3301 9921") === "POS ETSY ••••9921" &&
    d1.q("SELECT description FROM statement_lines WHERE amountCents = -2500")[0].description === "POS PURCHASE ETSY ••••9921");
  console.log("column mapping remembered on the account:", JSON.parse(d1.q("SELECT csvMapping FROM accounts WHERE id=1")[0].csvMapping).amount === "Amount");
  r = await call({ action: "importStatement", accountId: 1, lines: [{ date: "08/04/2026", description: "x", amount: 5 }] });
  console.log("unreadable dates refused:", r.status === 400);

  console.log("\n=== Reconciling August ===");
  r = await call({ action: "getReconciliation", accountId: 1, month: "2026-08" });
  let d = r.body;
  console.log("book balance $1,090 (1000 + 60 + 40 − 25 + 15); 4 lines unmatched:", d.bookBalance === 1090 && d.lines.filter(l => l.status === "unmatched").length === 4);
  const deposit = d.lines.find(l => l.description === "DEPOSIT");
  const chkKeys = d.candidates.filter(c => [60, 40].includes(c.amount)).map(c => c.key);
  r = await call({ action: "matchStatementLine", lineId: deposit.id, keys: [chkKeys[0]] });
  console.log("matching items that don't add up to the line is refused:", r.status === 400 && /add up/.test(r.body.message));
  r = await call({ action: "matchStatementLine", lineId: deposit.id, keys: chkKeys });
  console.log("the $100 deposit matched to both checks ($60 + $40):", r.status === 200 && r.body.lines.find(l => l.id === deposit.id).status === "matched");
  const fee = r.body.lines.find(l => l.description === "MONTHLY SERVICE FEE");
  r = await call({ action: "createFromStatementLine", lineId: fee.id, kind: "expense", categoryId: 15, description: "Bank service fee" });
  console.log("bank fee recorded as an expense straight from the line, and matched:", r.status === 200 &&
    d1.q("SELECT count(*) n FROM expenses WHERE description='Bank service fee' AND accountId=1 AND amountCents=1200")[0].n === 1 &&
    r.body.lines.find(l => l.id === fee.id).status === "matched");
  r = await call({ action: "createFromStatementLine", lineId: fee.id, kind: "income", incomeType: "other" });
  console.log("money out can't be recorded as income:", r.status === 400);
  const [amz1, amz2] = r.body.lines ? [] : (await call({ action: "getReconciliation", accountId: 1, month: "2026-08" })).body.lines.filter(l => l.description === "AMAZON MKTPLACE");
  r = await call({ action: "createFromStatementLine", lineId: amz1.id, kind: "owner", description: "Personal purchase on business account" });
  console.log("a personal purchase recorded as an owner draw:", r.status === 200 && d1.q("SELECT kind FROM owner_transactions")[0].kind === "draw");
  r = await call({ action: "ignoreStatementLine", lineId: amz2.id, reason: "" });
  console.log("ignoring needs a reason:", r.status === 400);
  r = await call({ action: "ignoreStatementLine", lineId: amz2.id, reason: "Duplicate charge, reversed next month" });
  d = r.body;
  console.log("ignored with a reason:", d.lines.find(l => l.id === amz2.id).status === "ignored");
  // Statement ending balance: 1000 + 100 − 25 − 12 − 48.50 − 48.50 = 966.00.
  // Book: 1090 − 12 (fee) − 48.50 (draw) = 1029.50; uncleared = check 103 ($15);
  // ignored line −48.50 → expected 1029.50 − 15 − 48.50 = 966.00.
  console.log("expected statement balance = book − uncleared + ignored ($966.00):", d.bookBalance === 1029.5 && d.uncleared === 15 && d.ignored === -48.5 && d.expectedStatementBalance === 966);
  console.log("the undeposited $15 check is listed as not on the statement:", d.unmatchedBook.length === 1 && d.unmatchedBook[0].amount === 15);
  r = await call({ action: "reconcileMonth", accountId: 1, month: "2026-08", statementBalance: 960 });
  console.log("a balance that's off is refused, with the difference:", r.status === 400 && /off by -6\.00/.test(r.body.message));
  r = await call({ action: "reconcileMonth", accountId: 1, month: "2026-08", statementBalance: 966 });
  console.log("August reconciled at $966.00 (audited):", r.status === 200 && r.body.reconciled && r.body.reconciled.statementBalance === 966 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='statement.reconciled'")[0].n === 1);
  r = await call({ action: "unmatchStatementLine", lineId: deposit.id });
  console.log("a reconciled month's lines are locked:", r.status === 400 && /reopen/.test(r.body.message));
  r = await call({ action: "unreconcileMonth", accountId: 1, month: "2026-08" });
  console.log("…until the month is reopened (audited):", r.status === 200 && r.body.reconciled === null && d1.q("SELECT count(*) n FROM audit_log WHERE action='statement.reopened'")[0].n === 1);

  console.log("\n=== Stripe net payouts, credit cards, broken matches ===");
  r = await call({ action: "importStatement", accountId: 5, lines: [{ date: "2026-08-05", description: "Charge ch_1", amount: 33.68 }] });
  console.log("a Stripe line for the net amount matches the payment + its fee ($35 − $1.32):", r.body.matched === 1 &&
    JSON.stringify(d1.q("SELECT sm.src FROM statement_matches sm JOIN statement_lines sl ON sl.id = sm.lineId WHERE sl.accountId = 5 ORDER BY sm.src").map(x => x.src)) === '["fee","payment"]');
  await call({ action: "saveAccount", account: { id: 2, name: "Credit card", type: "credit_card", openingDate: "2026-08-01", openingBalance: 0, active: true } });
  await call({ action: "saveExpense", expense: { date: "2026-08-12", description: "Stabilizer", categoryId: 2, amount: 30, accountId: 2 } });
  r = await call({ action: "importStatement", accountId: 2, lines: [{ date: "2026-08-13", description: "SUPPLIER", amount: -30 }] });
  r = await call({ action: "reconcileMonth", accountId: 2, month: "2026-08", statementBalance: 30 });
  console.log("credit card reconciled by entering the amount owed ($30):", r.status === 200 && r.body.reconciled && r.body.reconciled.statementBalance === -30);
  const thread = d1.q("SELECT id FROM expenses WHERE description='Thread'")[0].id;
  await call({ action: "deleteExpense", expenseId: thread });
  d = (await call({ action: "getReconciliation", accountId: 1, month: "2026-08" })).body;
  console.log("deleting a matched expense flags its statement line to re-match:", d.lines.find(l => l.amount === -25).status === "broken");
  r = await call({ action: "reconcileMonth", accountId: 1, month: "2026-08", statementBalance: 966 });
  console.log("…and the month can't be reconciled until it's fixed:", r.status === 400 && /unmatched/.test(r.body.message));

  console.log("\n=== Blank purchase straight from a statement line ===");
  d1._raw.exec("INSERT INTO blanks (id, name, brand, color, createdAt, updatedAt) VALUES (7,'Sport-Tek polo','ST','Kelly','t','t'); INSERT INTO blank_sizes (blankId, size, purchasePriceCents, quantity) VALUES (7,'M',400,2),(7,'L',400,0)");
  await call({ action: "importStatement", accountId: 2, lines: [{ date: "2026-09-03", description: "SANMAR ORDER 5521", amount: -52 }, { date: "2026-09-04", description: "SANMAR REFUND", amount: 10 }] });
  let sep = (await call({ action: "getReconciliation", accountId: 2, month: "2026-09" })).body;
  const san = sep.lines.find(l => l.amount === -52), refund = sep.lines.find(l => l.amount === 10);
  r = await call({ action: "createFromStatementLine", lineId: san.id, kind: "blanks", blankId: 7, lines: [{ size: "M", qty: 6, unitCost: 4 }, { size: "L", qty: 5, unitCost: 5 }] });
  console.log("sizes that don't add up to the line are refused (with the shipping/tax tip):", r.status === 400 && /add up to \$49\.00/.test(r.body.message) && /Shipping & other costs/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: refund.id, kind: "blanks", blankId: 7, lines: [{ size: "M", qty: 1, unitCost: 10 }] });
  console.log("money in can't be a blank purchase:", r.status === 400);
  r = await call({ action: "createFromStatementLine", lineId: san.id, kind: "blanks", blankId: 7, vendor: "SanMar", vendorRef: "5521",
    lines: [{ size: "M", qty: 6, unitCost: 4 }, { size: "L", qty: 4, unitCost: 7 }] });
  const sanNow = r.body.lines && r.body.lines.find(l => l.id === san.id);
  console.log("6 M @ $4 + 4 L @ $7 = $52: received into inventory and matched to the line:", r.status === 200 && sanNow.status === "matched" && sanNow.matched.length === 1 && sanNow.matched[0].keys.length === 2 && sanNow.matched[0].parts.length === 2 &&   // one purchase = one entry (2026-10)
    d1.q("SELECT quantity FROM blank_sizes WHERE blankId=7 AND size='M'")[0].quantity === 8 && d1.q("SELECT quantity FROM blank_sizes WHERE blankId=7 AND size='L'")[0].quantity === 4);
  const mv = d1.q("SELECT accountId, vendor, vendorRef, substr(occurredAt,1,10) d FROM inventory_movements WHERE kind='purchase' AND blankId=7");
  await call({ action: "importStatement", accountId: 2, lines: [{ date: "2026-09-05", description: "SANMAR ORDER 5530", amount: -24.5 }] });
  const s2 = (await call({ action: "getReconciliation", accountId: 2, month: "2026-09" })).body.lines.find(l => l.amount === -24.5);
  r = await call({ action: "createFromStatementLine", lineId: s2.id, kind: "blanks", blankId: 7, lines: [{ size: "L", qty: 4, total: 24.5 }] });
  const lMoves = d1.q("SELECT qtyDelta, unitCostCents FROM inventory_movements WHERE kind='purchase' AND blankId=7 AND size='L' AND substr(occurredAt,1,10)='2026-09-05' ORDER BY unitCostCents");
  console.log("a size total that doesn't split into whole cents ($24.50 for 4) → 2 × $6.12 + 2 × $6.13, matched exactly:", r.status === 200 &&
    JSON.stringify(lMoves.map(m => [m.qtyDelta, m.unitCostCents])) === "[[2,612],[2,613]]" && r.body.lines.find(l => l.id === s2.id).status === "matched");
  console.log("purchase dated on the statement line, paid from the card, vendor/invoice kept:", mv.length === 2 && mv.every(m => m.accountId === 2 && m.vendor === "SanMar" && m.vendorRef === "5521" && m.d === "2026-09-03"));

  console.log("\n=== Landed cost: shipping spread over the sizes ===");
  const landed = new Function(dbSrc + "\nreturn landedCostLines;")();
  // 6 M @ $4 ($24) + 4 L @ $4.50 ($18) + $6.50 shipping: by value M gets 24/42 = $3.71, L $2.79
  const lc = landed([{ size: "M", qty: 6, cents: 2400 }, { size: "L", qty: 4, cents: 1800 }], 650);
  const sum = (sz) => lc.filter(x => x.size === sz).reduce((a, x) => a + x.qty * Math.round(x.unitCost * 100), 0);
  console.log("shipping split by value, cents exact: M $27.71, L $20.79 (= $48.50):", sum("M") === 2771 && sum("L") === 2079 &&
    lc.filter(x => x.size === "M").reduce((a, x) => a + x.qty, 0) === 6 && lc.filter(x => x.size === "L").reduce((a, x) => a + x.qty, 0) === 4);
  const free = landed([{ size: "S", qty: 2, cents: 0 }, { size: "M", qty: 3, cents: 0 }], 500);
  console.log("all-free blanks → shipping split by quantity ($2 / $3):", free.reduce((a, x) => a + (x.size === "S" ? x.qty * Math.round(x.unitCost * 100) : 0), 0) === 200 &&
    free.reduce((a, x) => a + (x.size === "M" ? x.qty * Math.round(x.unitCost * 100) : 0), 0) === 300);
  await call({ action: "importStatement", accountId: 2, lines: [{ date: "2026-09-06", description: "SANMAR ORDER 5540 + SHIP", amount: -48.5 }] });
  const s3 = (await call({ action: "getReconciliation", accountId: 2, month: "2026-09" })).body.lines.find(l => l.amount === -48.5);
  r = await call({ action: "createFromStatementLine", lineId: s3.id, kind: "blanks", blankId: 7, extraCost: 6,
    lines: [{ size: "M", qty: 6, total: 24 }, { size: "L", qty: 4, total: 18 }] });
  console.log("blanks + shipping that miss the line are refused:", r.status === 400 && /plus shipping/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: s3.id, kind: "blanks", blankId: 7, extraCost: 6.5,
    lines: [{ size: "M", qty: 6, total: 24 }, { size: "L", qty: 4, total: 18 }] });
  const mv3 = d1.q("SELECT size, qtyDelta, unitCostCents, note FROM inventory_movements WHERE kind='purchase' AND blankId=7 AND substr(occurredAt,1,10)='2026-09-06'");
  console.log("blanks + $6.50 shipping = the $48.50 line: received at landed cost and matched:", r.status === 200 && r.body.lines.find(l => l.id === s3.id).status === "matched" &&
    mv3.reduce((a, m) => a + m.qtyDelta * m.unitCostCents, 0) === 4850 && mv3.every(m => /landed cost incl\. \$6\.50/.test(m.note)));
  d1._raw.exec("INSERT INTO blanks (id, name, brand, color, createdAt, updatedAt) VALUES (8,'Cap blank','Richardson','Black','t','t'); INSERT INTO blank_sizes (blankId, size, purchasePriceCents, quantity) VALUES (8,'OSFA',0,0)");
  r = await call({ action: "receiveBlanks", blankId: 8, lines: [{ size: "OSFA", qty: 12, unitCost: 3 }], extraCost: 9, receivedAt: "2026-09-07", accountId: 1 });
  console.log("Blanks → Receive with $9 shipping: 12 caps at $3.75 landed each:", r.status === 200 &&
    d1.q("SELECT purchasePriceCents p, quantity q FROM blank_sizes WHERE blankId=8")[0].p === 375 && d1.q("SELECT quantity q FROM blank_sizes WHERE blankId=8")[0].q === 12);

  console.log("\n=== Mixed blank order: inventory + R&D + personal ===");
  await call({ action: "importStatement", accountId: 2, lines: [{ date: "2026-09-08", description: "SANMAR MIXED 5601", amount: -100 },
    { date: "2026-09-09", description: "SANMAR SAMPLES", amount: -30 }] });
  let rec9 = (await call({ action: "getReconciliation", accountId: 2, month: "2026-09" })).body;
  const mixLine = rec9.lines.find(l => l.amount === -100), sampLine = rec9.lines.find(l => l.amount === -30);
  const suppliesCat = d1.q("SELECT id FROM expense_categories WHERE name LIKE 'Supplies%'")[0].id;
  r = await call({ action: "createFromStatementLine", lineId: mixLine.id, kind: "blanks", blankId: 7, extraCost: 8, rdAmount: 20, personalAmount: 12,
    lines: [{ size: "M", qty: 6, total: 36 }, { size: "L", qty: 4, total: 24 }] });
  console.log("R&D part needs a category:", r.status === 400 && /category/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: mixLine.id, kind: "blanks", blankId: 7, extraCost: 8, rdAmount: 20, rdCategoryId: suppliesCat, personalAmount: 12, vendor: "SanMar", vendorRef: "5601",
    lines: [{ size: "M", qty: 6, total: 36 }, { size: "L", qty: 4, total: 24 }] });
  const mixMv = d1.q("SELECT qtyDelta, unitCostCents FROM inventory_movements WHERE kind='purchase' AND blankId=7 AND substr(occurredAt,1,10)='2026-09-08'");
  const rdExp = d1.q("SELECT amountCents, description, categoryId, accountId FROM expenses WHERE expenseDate='2026-09-08'")[0];
  const draw = d1.q("SELECT amountCents, kind, note, accountId FROM owner_transactions WHERE txDate='2026-09-08'")[0];
  // $8 shipping spread by value over $60 / $20 / $12 → $5.22 / $1.74 / $1.04
  console.log("$100 line → inventory $65.22 (landed), R&D expense $21.74, owner draw $13.04:", r.status === 200 &&
    mixMv.reduce((x, m) => x + m.qtyDelta * m.unitCostCents, 0) === 6522 && rdExp && rdExp.amountCents === 2174 && rdExp.categoryId === suppliesCat &&
    /R&D \/ testing — SanMar #5601/.test(rdExp.description) && draw && draw.amountCents === 1304 && draw.kind === "draw" && /Personal items/.test(draw.note));
  console.log("all three matched to the one line, paid from its account:", r.body.lines.find(l => l.id === mixLine.id).status === "matched" &&
    d1.q("SELECT count(*) n FROM statement_matches WHERE lineId = ?", mixLine.id)[0].n === mixMv.length + 2 && rdExp.accountId === 2 && draw.accountId === 2);
  r = await call({ action: "createFromStatementLine", lineId: sampLine.id, kind: "blanks", rdAmount: 25, rdCategoryId: suppliesCat, personalAmount: 5, lines: [] });
  console.log("no inventory at all (just R&D + personal) needs no blank:", r.status === 200 && r.body.lines.find(l => l.id === sampLine.id).status === "matched");
  r = await call({ action: "createFromStatementLine", lineId: sampLine.id, kind: "blanks", lines: [] });
  console.log("nothing entered is refused:", r.status === 400);

  await call({ action: "importStatement", accountId: 2, lines: [{ date: "2026-09-10", description: "SANMAR POLOS+CAPS", amount: -60 }] });
  const twoLine = (await call({ action: "getReconciliation", accountId: 2, month: "2026-09" })).body.lines.find(l => l.amount === -60);
  r = await call({ action: "createFromStatementLine", lineId: twoLine.id, kind: "blanks", extraCost: 10,
    groups: [{ blankId: 7, lines: [{ size: "M", qty: 5, total: 30 }] }, { blankId: 0, lines: [{ size: "OSFA", qty: 4, total: 20 }] }] });
  console.log("every blank group needs its blank chosen:", r.status === 400 && /every group/.test(r.body.message));
  r = await call({ action: "createFromStatementLine", lineId: twoLine.id, kind: "blanks", extraCost: 10,
    groups: [{ blankId: 7, lines: [{ size: "M", qty: 5, total: 30 }] }, { blankId: 8, lines: [{ size: "OSFA", qty: 4, total: 20 }] }] });
  const cost = (id) => d1.q("SELECT sum(qtyDelta*unitCostCents) c FROM inventory_movements WHERE kind='purchase' AND blankId=? AND substr(occurredAt,1,10)='2026-09-10'", id)[0].c;
  console.log("two blank types on one $60 line: $10 shipping split by value → polos $36, caps $24, all matched:", r.status === 200 &&
    cost(7) === 3600 && cost(8) === 2400 && r.body.lines.find(l => l.id === twoLine.id).status === "matched");

  console.log("\n=== Closed tax months, export ===");
  await call({ action: "closePeriod", month: "2026-08" });
  const brokenLine = d.lines.find(l => l.amount === -25);
  r = await call({ action: "createFromStatementLine", lineId: brokenLine.id, kind: "expense", categoryId: 2 });
  console.log("creating an entry dated in a closed month is refused:", r.status === 409);
  await call({ action: "reopenPeriod", month: "2026-08" });
  r = await call({ action: "getAccountantExport", dateFrom: "2026-08-01", dateTo: "2026-08-31" });
  console.log("export lists the reconciled months:", r.body.reconciliations.length === 1 && r.body.reconciliations[0].account === "Credit card");

  console.log("\n=== Admin CSV parsing + screen (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const accountsNow = (await call({ action: "listAccounts" })).body, recNow = (await call({ action: "getReconciliation", accountId: 1, month: "2026-08" })).body;
  recNow.lines[0].description = "<img src=x onerror=alert(1)>";
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const data = b.action === "listAccounts" ? accountsNow : b.action === "getReconciliation" ? recNow : { status: "error", message: "n/a" };
      return { ok: true, status: 200, json: async () => data }; }; } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  const rows = w.parseCsv_('Date,Description,Amount\r\n08/04/2026,"DEPOSIT, BRANCH 12",100.00\r\n8/11/26,"Say ""hi""","($25.00)"\r\n2026-08-15,Fee,-12\n');
  console.log("CSV: quotes, commas and doubled quotes parsed:", rows.length === 4 && rows[1][1] === "DEPOSIT, BRANCH 12" && rows[2][1] === 'Say "hi"');
  const mapped = w.mapStatementRows_(rows.slice(1), { date: 0, desc: 1, mode: "one", amount: 2, flip: false });
  console.log("dates (MM/DD/YYYY, M/D/YY, ISO) and amounts ($, parentheses, minus) read correctly:",
    JSON.stringify(mapped.lines.map(l => [l.date, l.amount])) === JSON.stringify([["2026-08-04", 100], ["2026-08-11", -25], ["2026-08-15", -12]]) && mapped.errors.length === 0);
  const split = w.mapStatementRows_([["2026-08-01", "x", "25.00", ""], ["2026-08-02", "y", "", "10.00"]], { date: 0, desc: 1, mode: "split", debit: 2, credit: 3, flip: false });
  console.log("debit/credit columns: debit out (−), credit in (+):", split.lines[0].amount === -25 && split.lines[1].amount === 10);

  const app = w.document.getElementById("app");
  await w.renderReconcile(app);
  w.document.getElementById("rcAccount").value = "1";
  w.document.getElementById("rcMonth").value = "2026-08";
  await w.rcLoad_();

  // A single "Debit/Credit" column matches /debit/i AND /credit/i on its own — it must
  // not be mistaken for separate split columns (both pointing at that one column), which
  // would double every debit and round every credit to $0, silently dropping it (one
  // bank's export does this). Drive the real file-upload path (rcFile's onchange,
  // wired by rcLoad_ above) end to end.
  const bankCsv = 'Date,Description,Debit/Credit,Balance,Name\n' +
    '2026-08-10,"Blank Supply Co, Dayton, OH",-180.25,-380.25,\n' +
    '2026-08-08,Mobile Deposit 0000a1b2,150.00,950.00,\n';
  const bankFile = new w.File([bankCsv], "examplebank.csv", { type: "text/csv" });
  const rcFileEl = w.document.getElementById("rcFile");
  Object.defineProperty(rcFileEl, "files", { value: [bankFile], configurable: true });
  rcFileEl.dispatchEvent(new w.Event("change"));
  await new Promise(res => setTimeout(res, 30));
  const rcMap = w.document.getElementById("rcMap");
  console.log("Example Bank-style \"Debit/Credit\" single column: detected as one signed column, not split (no doubling/dropping):",
    rcMap.querySelector('select[data-k="mode"]').value === "one" &&
    rcMap.textContent.includes("−$180.25") && rcMap.textContent.includes("$150.00") && / 2 lines /.test(rcMap.textContent));
  await w.renderReconcile(app);
  w.document.getElementById("rcAccount").value = "1";
  w.document.getElementById("rcMonth").value = "2026-08";
  await w.rcLoad_();
  const txt = app.textContent;
  console.log("Create… offers Blank purchase (inventory, R&D, personal) for money-out lines:", /\["blanks", "Blank purchase \(inventory, R&D, personal\)"\]/.test(adminJs));
  console.log("Reconcile button next to Accounts & money:", /\["money", "[^"]*"\],\s*\["reconcile"/.test(adminJs));
  console.log("screen shows balances, unmatched lines and uncleared entries; text escaped:",
    /Statement ending balance/.test(txt) && /On the statement, not in the books/.test(txt) && /In the books, not on this statement/.test(txt) &&
    !app.innerHTML.includes("<img src=x") && app.innerHTML.includes("&lt;img src=x"));

  console.log("\n=== Create… → Blank purchase window, mixed (jsdom, real API) ===");
  await call({ action: "importStatement", accountId: 2, lines: [{ date: "2026-09-12", description: "SANMAR 5700", amount: -50 }] });
  const d12 = (await call({ action: "getReconciliation", accountId: 2, month: "2026-09" })).body;
  const l12 = d12.lines.find(l => l.amount === -50);
  const dom2 = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const res = await call(b); return { ok: res.status < 400, status: res.status, json: async () => res.body }; }; } });
  const w2 = dom2.window;
  await new Promise(res => setTimeout(res, 150));
  await w2.loadAdminScript();
  w2.eval('adminKey = "cookie"');
  let acted = null;
  await w2.rcCreateModal_(d12, l12, async (b) => { acted = b; });
  const ov = w2.document.body.lastElementChild, q = (sel) => ov.querySelector(sel);
  const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new w2.Event("input", { bubbles: true })); };
  q("#rccKind").value = "blanks"; q("#rccKind").dispatchEvent(new w2.Event("change"));
  const groupsIn = () => [...ov.querySelectorAll(".rcc-group")];
  const pick = (g, id) => { const sel = g.querySelector(".rcc-blank"); sel.value = id; sel.dispatchEvent(new w2.Event("change")); };
  pick(groupsIn()[0], "7");
  typeIn(groupsIn()[0].querySelector('.rcc-qty[data-i="0"]'), "5"); typeIn(groupsIn()[0].querySelector('.rcc-cost[data-i="0"]'), "20");
  q("#rccAddBlank").click();
  pick(groupsIn()[1], "8");
  typeIn(groupsIn()[1].querySelector('.rcc-qty[data-i="0"]'), "1"); typeIn(groupsIn()[1].querySelector('.rcc-cost[data-i="0"]'), "10");
  typeIn(q("#rccShip"), "5"); typeIn(q("#rccRd"), "10"); typeIn(q("#rccPers"), "5");
  const okBtn = q("#rccOk");
  // $5 shipping by value over $20 polos / $10 caps / $10 R&D / $5 personal → 2.22 / 1.11 / 1.11 / 0.56
  console.log("two blank types + R&D + personal + shipping: total and per-part split shown:", !okBtn.disabled && /= \$50\.00/.test(q("#rccTotal").textContent) &&
    /Sport-Tek polo \$22\.22 · Cap blank \$11\.11 · R&D expense \$11\.11 · owner draw \$5\.56/.test(q("#rccTotal").textContent));
  q("#rccAddBlank").click();
  console.log("an extra blank box can be removed again:", groupsIn().length === 3 && (groupsIn()[2].querySelector(".rcc-rm").click(), groupsIn().length === 2) &&
    !groupsIn()[0].querySelector(".rcc-rm"));
  okBtn.click();
  await new Promise(res => setTimeout(res, 20));
  console.log("sends both blanks, shipping (not $0), R&D with Supplies preselected, and personal:", !!acted && acted.extraCost === 5 && acted.rdAmount === 10 &&
    acted.personalAmount === 5 && acted.rdCategoryId === suppliesCat && acted.groups.length === 2 &&
    acted.groups[0].blankId === 7 && acted.groups[0].lines[0].qty === 5 && acted.groups[1].blankId === 8 && acted.groups[1].lines[0].total === 10);
  const r12 = await call(acted);
  console.log("…and the server records the same split and matches the line:", r12.status === 200 && r12.body.lines.find(l => l.id === l12.id).status === "matched" &&
    d1.q("SELECT amountCents FROM expenses WHERE expenseDate='2026-09-12'")[0].amountCents === 1111 && d1.q("SELECT amountCents FROM owner_transactions WHERE txDate='2026-09-12'")[0].amountCents === 556 &&
    d1.q("SELECT sum(qtyDelta*unitCostCents) c FROM inventory_movements WHERE kind='purchase' AND blankId=7 AND substr(occurredAt,1,10)='2026-09-12'")[0].c === 2222 &&
    d1.q("SELECT sum(qtyDelta*unitCostCents) c FROM inventory_movements WHERE kind='purchase' AND blankId=8 AND substr(occurredAt,1,10)='2026-09-12'")[0].c === 1111);

  console.log("\n=== Blanks → Receive order (several blanks, R&D, personal) ===");
  const ord = (extra) => call(Object.assign({ action: "receiveBlankOrder", receivedAt: "2026-09-14", accountId: 2, extraCost: 3.5, rdAmount: 5, rdCategoryId: suppliesCat, personalAmount: 5,
    vendor: "SanMar", vendorRef: "5800", groups: [{ blankId: 7, lines: [{ size: "L", qty: 2, total: 10 }] }, { blankId: 8, lines: [{ size: "OSFA", qty: 3, total: 15 }] }] }, extra));
  r = await ord({ orderTotal: 40 });
  console.log("order total that doesn't match the parts is refused:", r.status === 400 && /\$38\.50/.test(r.body.message));
  r = await ord({ accountId: 0 });
  console.log("paid-from is required:", r.status === 400 && /paid from/.test(r.body.message));
  r = await ord({ receivedAt: "2099-01-01" });
  console.log("future dates refused:", r.status === 400);
  r = await ord({ orderTotal: 38.5 });
  const oc = (id) => d1.q("SELECT sum(qtyDelta*unitCostCents) c, max(accountId) a FROM inventory_movements WHERE kind='purchase' AND blankId=? AND substr(occurredAt,1,10)='2026-09-14'", id)[0];
  // $3.50 by value over $10 / $15 / $5 / $5 → 1.00 / 1.50 / 0.50 / 0.50
  console.log("$38.50 order: polos $11, caps $16.50, R&D $5.50, draw $5.50 — all from the card:", r.status === 200 && r.body.total === 38.5 &&
    oc(7).c === 1100 && oc(8).c === 1650 && oc(7).a === 2 &&
    d1.q("SELECT amountCents a, accountId x FROM expenses WHERE expenseDate='2026-09-14'")[0].a === 550 &&
    d1.q("SELECT amountCents a FROM owner_transactions WHERE txDate='2026-09-14' AND kind='draw'")[0].a === 550);
  r = await ord({ receivedAt: "2026-09-15", accountId: undefined, paidPersonally: true });
  console.log("paid with personal funds: blanks + R&D marked personal, personal part not recorded:", r.status === 200 && !r.body.parts.personal &&
    d1.q("SELECT count(*) n FROM inventory_movements WHERE substr(occurredAt,1,10)='2026-09-15' AND paidPersonally=1")[0].n === 2 &&
    d1.q("SELECT paidPersonally p FROM expenses WHERE expenseDate='2026-09-15'")[0].p === 1 &&
    d1.q("SELECT count(*) n FROM owner_transactions WHERE txDate='2026-09-15'")[0].n === 0);
  r = await ord({ receivedAt: "2026-08-25", accountId: 2, receiptKey: "receipts/2026/" + "a".repeat(32) + ".pdf", receiptName: "SanMar invoice.pdf" });
  const recMovs = (await call({ action: "getBlankMovements", blankId: 7 })).body.movements;
  console.log("a receipt attached to a blank order shows up on every purchase movement it created:", r.status === 200 &&
    recMovs.filter(m => m.kind === "purchase" && m.occurredAt.startsWith("2026-08-25"))
      .every(m => m.receiptKey === "receipts/2026/" + "a".repeat(32) + ".pdf" && m.receiptName === "SanMar invoice.pdf"));
  r = await ord({ receivedAt: "2026-08-26", accountId: 2, receiptKey: "not-a-real-key.pdf" });
  console.log("a malformed receipt reference is refused:", r.status === 400 && /Invalid receipt reference/.test(r.body.message));
  console.log("an order with no receipt leaves it blank:",
    (await call({ action: "getBlankMovements", blankId: 7 })).body.movements.find(m => m.occurredAt.startsWith("2026-09-14")).receiptKey === "");

  await call({ action: "closePeriod", month: "2026-08" });
  const rc1 = await ord({ receivedAt: "2026-08-20" });
  const rc2 = await call({ action: "receiveBlanks", blankId: 7, lines: [{ size: "M", qty: 1, unitCost: 4 }], receivedAt: "2026-08-20", accountId: 2 });
  console.log("receiving into a closed month is refused (order and single blank):", rc1.status === 409 && rc2.status === 409);
  await call({ action: "reopenPeriod", month: "2026-08" });

  // The window on the Blanks screen, end to end
  const before = d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='purchase'")[0].n;
  const pending = w2.showReceiveOrderModal(() => {});
  for (let i = 0; i < 100 && !w2.document.getElementById("roSave"); i++) await new Promise(res => setTimeout(res, 10));
  await pending; await new Promise(res => setTimeout(res, 30));
  const ro = w2.document.body.lastElementChild, rq = (sel) => ro.querySelector(sel);
  rq("#roDate").value = "2026-09-16"; rq("#roPaidFrom").value = "2";
  const rg = () => [...ro.querySelectorAll(".rcc-group")];
  pick(rg()[0], "7"); typeIn(rg()[0].querySelector('.rcc-qty[data-i="0"]'), "4"); typeIn(rg()[0].querySelector('.rcc-cost[data-i="0"]'), "16");
  rq("#rccAddBlank").click();
  pick(rg()[1], "8"); typeIn(rg()[1].querySelector('.rcc-qty[data-i="0"]'), "2"); typeIn(rg()[1].querySelector('.rcc-cost[data-i="0"]'), "8");
  typeIn(rq("#rccShip"), "6");
  console.log("Receive order window: no order total → any total is fine; shows $30.00 and each blank's landed cost:", !rq("#roSave").disabled &&
    /= \$30\.00/.test(rq("#rccTotal").textContent) && /Sport-Tek polo \$20\.00 · Cap blank \$10\.00/.test(rq("#rccTotal").textContent));
  typeIn(rq("#roTotal"), "31");
  const blockedAt31 = rq("#roSave").disabled;
  typeIn(rq("#roTotal"), "30");
  console.log("…with an order total it must match ($31 blocks, $30 allows):", blockedAt31 && !rq("#roSave").disabled);
  rq("#roSave").click();
  for (let i = 0; i < 100 && ro.isConnected; i++) await new Promise(res => setTimeout(res, 10));
  console.log("Record order receives both blanks from the card and closes:", !ro.isConnected &&
    d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='purchase'")[0].n === before + 2 &&
    d1.q("SELECT sum(qtyDelta*unitCostCents) c FROM inventory_movements WHERE kind='purchase' AND substr(occurredAt,1,10)='2026-09-16' AND accountId=2")[0].c === 3000);
  console.log("Receive order button on the Blanks screen:", /id="blankOrderBtn"/.test(adminJs) && /showReceiveOrderModal\(refresh\)/.test(adminJs));
})().catch(e => { console.log("test44 crashed:", false); console.error(e); process.exit(1); });
