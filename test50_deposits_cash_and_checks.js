const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Bank deposits mapped to the orders' payments they cover — Venmo cash-outs, CASH and CHECKS, or a mix
// (cash + checks on one slip). Cash (recorded in Cash on hand) and Venmo move by a transfer and can be
// deposited in parts; a check already recorded in the bank account is matched whole. A deposit short of
// what was ticked is recorded as an expense; it never silently disagrees with the books.
// Real SQL (sql.js), the real db.js + orders.js admin API, and the Create… window in jsdom.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, listAccounts, matchStatementLine, getCardPaymentsMissingFees };")();
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

const CHECKING = 1, VENMO = 3, CASH = 4;
(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const x = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  const cat = (like) => d1.q("SELECT id FROM expense_categories WHERE name LIKE ?", like)[0].id;
  let n = 0;
  // One order per payment: method + account decide where the money was recorded (cash → Cash on hand, check → the bank).
  const pay = async (label, method, cents, day = 10, feeCents = 0) => {
    const id = "O" + (++n) + label;
    await lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "Cust " + label, contact: id + "@x.com", paymentMethod: method, placedAt: "2026-08-01T00:00:00Z" },
      [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: cents / 100 }]);
    const acct = { venmo: VENMO, cash: CASH, check: CHECKING, zelle: CHECKING, card: 5 }[method];
    d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId, feeCents) VALUES (?,?,?,?,?,?)", [id, cents, `2026-08-${String(day).padStart(2, "0")}T12:00:00Z`, method, acct, feeCents]);
    d1._raw.run("UPDATE orders SET paid=1 WHERE orderId=?", [id]);
    return { orderId: id, id: d1.q("SELECT id FROM order_payments WHERE orderId=?", id)[0].id };
  };
  let lineDay = 0;
  const line = async (desc, amount) => {
    await call({ action: "importStatement", accountId: CHECKING, lines: [{ date: `2026-09-${String(++lineDay).padStart(2, "0")}`, description: desc, amount }] });
    return (await call({ action: "getReconciliation", accountId: CHECKING, month: "2026-09" })).body.lines.find(l => l.description === desc);
  };
  const balance = async (id) => Math.round((await lib.listAccounts(d1, "2026-12-31")).find(a => a.id === id).balance * 100);
  const deposit = (lineId, allocs, extra = {}) => call(Object.assign({ action: "createFromStatementLine", lineId, kind: "deposit",
    allocations: allocs.map(a => ({ paymentId: a.id, amount: a.amount })) }, extra));
  const listed = async () => (await call({ action: "listCashoutPayments", accountId: CHECKING })).body.payments;
  // What an account should hold: payments recorded in it that haven't been deposited yet.
  const outstanding = async (method) => Math.round((await listed()).filter(p => p.method === method).reduce((t, p) => t + p.remaining, 0) * 100);

  // =====================================================================
  console.log("=== The payment list: Venmo, cash and checks ===");
  const c1 = await pay("cash1", "cash", 6000, 5), c2 = await pay("cash2", "cash", 4000, 6);
  const k1 = await pay("check1", "check", 5000, 7), k2 = await pay("check2", "check", 3000, 8);
  const v1 = await pay("venmo1", "venmo", 4600, 9);
  const zz = await pay("zelle0", "zelle", 2500, 9); await pay("card1", "card", 2500, 9);
  const L = await listed();
  console.log("lists Venmo, cash, check, Zelle and card (Stripe) payments:", L.length === 7 && L.every(p => ["venmo", "cash", "check", "zelle", "card"].includes(p.method)) && L.some(p => p.method === "card"));
  console.log("a card payment is paid out whole by Stripe (can't be split), like a check:", L.find(p => p.method === "card").whole === true && L.find(p => p.method === "card").direct === false && L.find(p => p.method === "cash").whole === false);
  console.log("checks are already in the bank account (matched whole); cash and Venmo are in other accounts (moved by transfer):",
    L.filter(p => p.method === "check" || p.method === "zelle").every(p => p.direct) && L.filter(p => p.method !== "check" && p.method !== "zelle").every(p => !p.direct) && L.find(p => p.method === "cash").accountName === "Cash on hand");

  // =====================================================================
  console.log("\n=== One deposit slip: cash + checks ===");
  let ln = await line("MOBILE DEPOSIT 1", 180);   // cash 60 + 40, checks 50 + 30
  let r = await deposit(ln.id, [{ id: c1.id, amount: 60 }, { id: c2.id, amount: 40 }, { id: k1.id, amount: 50 }, { id: k2.id, amount: 30 }]);
  console.log("$180 deposit = $100 cash + two checks ($80): accepted, the line is matched:", r.status === 200 && r.body.lines.find(l => l.id === ln.id).status === "matched");
  const tr = d1.q("SELECT * FROM account_transfers");
  console.log("the cash moves by ONE transfer of $100 from Cash on hand → the bank; the checks are matched whole (no transfer for them):",
    tr.length === 1 && tr[0].amountCents === 10000 && tr[0].fromAccountId === CASH && tr[0].toAccountId === CHECKING && /Cash deposit/.test(tr[0].note) &&
    d1.q("SELECT count(*) n FROM statement_matches WHERE lineId=? AND src='payment'", ln.id)[0].n === 2 && d1.q("SELECT count(*) n FROM statement_matches WHERE lineId=? AND src='transfer_in'", ln.id)[0].n === 1);
  console.log("Cash on hand nets to $0.00, and no expense or income was invented:", (await balance(CASH)) === 0 && d1.q("SELECT count(*) n FROM expenses")[0].n === 0 && d1.q("SELECT count(*) n FROM other_income")[0].n === 0);
  console.log("those payments are no longer offered:", (await listed()).every(p => ![c1.id, c2.id, k1.id, k2.id].includes(p.id)));

  // =====================================================================
  console.log("\n=== Cash: a deposit short of what was recorded ===");
  const c3 = await pay("cash3", "cash", 6000), c4 = await pay("cash4", "cash", 4000);
  ln = await line("CASH DEPOSIT", 90);
  r = await deposit(ln.id, [{ id: c3.id, amount: 60 }, { id: c4.id, amount: 40 }]);
  console.log("$90 for $100 of cash needs a category for the $10 difference:", r.status === 400 && /category for the difference/.test(r.body.message));
  r = await deposit(ln.id, [{ id: c3.id, amount: 60 }, { id: c4.id, amount: 40 }], { feeCategoryId: cat("Bank%") });
  const shortExp = d1.q("SELECT * FROM expenses")[0];
  console.log("with a category: the $10 is an expense out of Cash on hand, the transfer is $90, and the line matches:",
    r.status === 200 && shortExp.amountCents === 1000 && shortExp.accountId === CASH && /Deposit shortfall/.test(shortExp.description) && shortExp.vendor === "" &&
    d1.q("SELECT amountCents a FROM account_transfers ORDER BY id DESC")[0].a === 9000 && r.body.lines.find(l => l.id === ln.id).status === "matched");
  console.log("Cash on hand nets to $0.00 again (cash − shortfall − transfer):", (await balance(CASH)) === 0);
  ln = await line("CASH DEPOSIT TOO BIG", 500);
  const c5 = await pay("cash5", "cash", 10000);
  r = await deposit(ln.id, [{ id: c5.id, amount: 100 }]);
  console.log("a deposit bigger than what's ticked is refused ('tick more'):", r.status === 400 && /tick more/.test(r.body.message));

  // =====================================================================
  console.log("\n=== Checks are matched whole, and must equal the deposit ===");
  const k3 = await pay("check3", "check", 5000), k4 = await pay("check4", "check", 3000);
  ln = await line("CHECK DEPOSIT", 70);
  r = await deposit(ln.id, [{ id: k3.id, amount: 50 }, { id: k4.id, amount: 30 }], { feeCategoryId: cat("Bank%") });
  console.log("checks worth $80 against a $70 deposit are refused — they're already in this account, so they must equal it exactly:", r.status === 400 && /equal them exactly/.test(r.body.message));
  r = await deposit(ln.id, [{ id: k3.id, amount: 20 }]);
  console.log("a check can't be split:", r.status === 400 && /matched whole/.test(r.body.message));
  r = await deposit((await line("CHECK DEPOSIT 80", 80)).id, [{ id: k3.id, amount: 50 }, { id: k4.id, amount: 30 }]);
  console.log("two checks = an $80 deposit exactly: matched, no transfer, no expense:", r.status === 200 && d1.q("SELECT count(*) n FROM account_transfers")[0].n === 2 && d1.q("SELECT count(*) n FROM expenses")[0].n === 1);
  // Zelle lands in the bank account: listed, matched whole (no transfer), deposit must equal it, alone or with checks.
  const z1 = await pay("zelle1", "zelle", 6000, 9), z2 = await pay("zelle2", "zelle", 2500, 9), k5 = await pay("check5", "check", 1500, 9);
  const zl = (await listed()).filter(p => p.method === "zelle");
  console.log("Zelle payments are offered for a deposit, already in the bank account (matched whole):", zl.length === 3 && zl.every(p => p.direct && p.whole));
  const tBefore = d1.q("SELECT count(*) n FROM account_transfers")[0].n, eBefore = d1.q("SELECT count(*) n FROM expenses")[0].n;
  r = await deposit((await line("ZELLE PAYMENT", 60)).id, [{ id: z1.id, amount: 60 }]);
  console.log("a Zelle payment matches its bank line whole — no transfer, no expense:", r.status === 200 && d1.q("SELECT count(*) n FROM account_transfers")[0].n === tBefore && d1.q("SELECT count(*) n FROM expenses")[0].n === eBefore);
  r = await deposit((await line("ZELLE + CHECK", 40)).id, [{ id: z2.id, amount: 25 }, { id: k5.id, amount: 15 }]);
  console.log("Zelle and a check can share one deposit:", r.status === 200 && !(await listed()).some(p => [z1.id, z2.id, k5.id].includes(p.id)));

  // =====================================================================
  console.log("\n=== Cash in parts ===");
  const c6 = await pay("cash6", "cash", 10000);
  ln = await line("CASH DEPOSIT PART 1", 60);
  r = await deposit(ln.id, [{ id: c6.id, amount: 60 }]);
  let p6 = (await listed()).find(p => p.id === c6.id);
  console.log("$60 of a $100 cash payment: matched with no difference; $40 is still offered:", r.status === 200 && !!p6 && p6.remaining === 40 && p6.cashedOut === 60);
  ln = await line("CASH DEPOSIT PART 2", 40);
  r = await deposit(ln.id, [{ id: c6.id, amount: 40 }]);
  console.log("the rest finishes it, and it leaves the list:", r.status === 200 && !(await listed()).some(p => p.id === c6.id));
  console.log("Cash on hand holds exactly the cash not yet deposited ($100 — the payment from the refused too-big deposit):", (await balance(CASH)) === 10000 && (await outstanding("cash")) === 10000);
  r = await deposit((await line("CASH DEPOSIT AGAIN", 10)).id, [{ id: c6.id, amount: 10 }]);
  console.log("a fully deposited payment can't be used again:", r.status === 400 && /isn't available/.test(r.body.message));

  // =====================================================================
  console.log("\n=== Venmo + cash on one deposit ===");
  const c7 = await pay("cash7", "cash", 10000), v2 = await pay("venmo2", "venmo", 4600);
  ln = await line("DEPOSIT WITH VENMO", 142);
  const exp0 = d1.q("SELECT count(*) n FROM expenses")[0].n;
  r = await deposit(ln.id, [{ id: c7.id, amount: 100 }, { id: v2.id, amount: 46 }], { feeCategoryId: cat("Bank%") });
  const newExp = d1.q("SELECT * FROM expenses ORDER BY id DESC")[0], newTr = d1.q("SELECT fromAccountId f, amountCents a FROM account_transfers ORDER BY id DESC LIMIT 2");
  console.log("$142 deposit = $100 cash + $46 Venmo: one transfer per source account (cash $100, Venmo $42), matched to the line:",
    r.status === 200 && newTr.length === 2 && newTr.some(t => t.f === CASH && t.a === 10000) && newTr.some(t => t.f === VENMO && t.a === 4200) &&
    r.body.lines.find(l => l.id === ln.id).status === "matched");
  console.log("the $4.00 difference is Venmo's fee, taken out of the Venmo account (not the cash):", d1.q("SELECT count(*) n FROM expenses")[0].n === exp0 + 1 &&
    newExp.amountCents === 400 && newExp.accountId === VENMO && newExp.vendor === "Venmo" && /Venmo fees/.test(newExp.description));
  console.log("both accounts hold exactly what hasn't been deposited yet (nothing lost, nothing double counted):", (await balance(CASH)) === await outstanding("cash") && (await balance(VENMO)) === await outstanding("venmo"));
  console.log("audited (transfers, direct matches, difference):", (() => { const a = d1.q("SELECT detail FROM audit_log WHERE action='payments.deposit_mapped' ORDER BY id DESC")[0]; const d = a && JSON.parse(a.detail); return !!d && d.differenceCents === 400 && d.transfers.length === 2; })());

  // =====================================================================
  console.log("\n=== Other rules ===");
  const k9 = await pay("check9", "check", 4000);
  ln = await line("CHECK MATCHED BY HAND", 40);
  const hand = await lib.matchStatementLine(d1, ln.id, [`payment:${k9.id}`]);
  console.log("a check already matched to a statement line by hand isn't offered again:", hand.ok && !(await listed()).some(p => p.id === k9.id));
  const c8 = await pay("cash8", "cash", 3000);
  ln = await line("CASH DEPOSIT 30", 30);
  r = await deposit(ln.id, [{ id: c8.id, amount: 30 }]);
  const cashTr = d1.q("SELECT id FROM account_transfers ORDER BY id DESC")[0].id;
  await call({ action: "deleteMoneyEntry", kind: "transfer", id: cashTr });
  console.log("deleting the transfer puts the cash payment back on the list:", (await listed()).some(p => p.id === c8.id));
  const c9 = await pay("cash9", "cash", 2500);
  r = await call({ action: "createFromStatementLine", lineId: (await line("CASH 25", 25)).id, kind: "deposit", paymentIds: [c9.id] });
  console.log("plain paymentIds still means each payment's whole amount:", r.status === 200);
  r = await call({ action: "createFromStatementLine", lineId: (await line("MONEY OUT", -10)).id, kind: "deposit", paymentIds: [c9.id] });
  console.log("money going out can't be a deposit:", r.status === 400);
  const list2 = (await call({ action: "listCashoutPayments", accountId: 6 })).body.payments;
  console.log("for a different bank account, checks recorded in the main account are no longer 'matched whole' — they'd move by transfer:", list2.filter(p => p.method === "check").every(p => !p.direct));

  // =====================================================================
  console.log("\n=== Stripe payouts ===");
  const STRIPE = 5;
  let octDay = 0;
  const oline = async (desc, amount) => {
    await call({ action: "importStatement", accountId: CHECKING, lines: [{ date: `2026-10-${String(++octDay).padStart(2, "0")}`, description: desc, amount }] });
    return (await call({ action: "getReconciliation", accountId: CHECKING, month: "2026-10" })).body.lines.find(l => l.description === desc);
  };
  const fees = () => d1.q("SELECT id, feeCents f FROM order_payments").reduce((o, r) => { o[r.id] = r.f; return o; }, {});
  const s1 = await pay("st1", "card", 5000, 3, 175), s2 = await pay("st2", "card", 3000, 3, 117), s3 = await pay("st3", "card", 2000, 3, 88);
  const st1 = await oline("STRIPE TRANSFER ST-1", 96.2);
  const exp1 = d1.q("SELECT count(*) n FROM expenses")[0].n;
  r = await deposit(st1.id, [{ id: s1.id, amount: 50 }, { id: s2.id, amount: 30 }, { id: s3.id, amount: 20 }]);
  console.log("a payout of the 3 charges net of their recorded fees ($96.20 = $48.25 + $28.83 + $19.12): matched exactly — one Stripe → bank transfer, no expense, fees untouched:",
    r.status === 200 && r.body.lines.find(l => l.id === st1.id).status === "matched" && d1.q("SELECT amountCents a, fromAccountId f, note FROM account_transfers ORDER BY id DESC")[0].a === 9620 &&
    d1.q("SELECT fromAccountId f FROM account_transfers ORDER BY id DESC")[0].f === STRIPE && /Stripe payout/.test(d1.q("SELECT note FROM account_transfers ORDER BY id DESC")[0].note) &&
    d1.q("SELECT count(*) n FROM expenses")[0].n === exp1 && fees()[s1.id] === 175);
  // fees not synced yet: the deposit is short by Stripe's fee
  const t1 = await pay("st4", "card", 6000, 4), t2 = await pay("st5", "card", 4000, 4);
  ln = await oline("STRIPE TRANSFER ST-2", 96.1);
  const exp2 = d1.q("SELECT count(*) n FROM expenses")[0].n;
  r = await deposit(ln.id, [{ id: t1.id, amount: 60 }, { id: t2.id, amount: 40 }]);
  console.log("charges with no fee recorded ($100 gross, $96.10 paid out): no category is asked for — the $3.90 fee is put ON the payments, in proportion, to the cent:",
    r.status === 200 && fees()[t1.id] + fees()[t2.id] === 390 && fees()[t1.id] === 234 && fees()[t2.id] === 156 && d1.q("SELECT count(*) n FROM expenses")[0].n === exp2);
  console.log("the transfer is the $96.10 that was paid out, and the Stripe account holds exactly what's still unpaid out:",
    d1.q("SELECT amountCents a FROM account_transfers ORDER BY id DESC")[0].a === 9610 && (await balance(STRIPE)) === (await outstanding("card")));
  console.log("the audit records the fees put on each payment:", (() => { const a = d1.q("SELECT detail FROM audit_log WHERE action='payments.deposit_mapped' ORDER BY id DESC")[0]; const dd = JSON.parse(a.detail);
    return dd.stripeFeesRecordedOnPayments.length === 2 && dd.stripeFeesRecordedOnPayments.reduce((t, x) => t + x.cents, 0) === 390; })());
  // fees all recorded but the payout is smaller (a refund netted out of it)
  const u1 = await pay("st6", "card", 5000, 5, 175), u2 = await pay("st7", "card", 3000, 5, 117);
  ln = await oline("STRIPE TRANSFER ST-3", 70);
  r = await deposit(ln.id, [{ id: u1.id, amount: 50 }, { id: u2.id, amount: 30 }]);
  console.log("every charge already has its fee but the payout is $7.08 smaller (a refund netted out): a category is needed:", r.status === 400 && /category/.test(r.body.message));
  r = await deposit(ln.id, [{ id: u1.id, amount: 50 }, { id: u2.id, amount: 30 }], { feeCategoryId: cat("Bank%") });
  const stripeExp = d1.q("SELECT * FROM expenses ORDER BY id DESC")[0];
  console.log("with one, it's an expense out of the Stripe account (vendor Stripe) and the fees on the payments aren't changed:", r.status === 200 && stripeExp.amountCents === 708 && stripeExp.vendor === "Stripe" && stripeExp.accountId === STRIPE && fees()[u1.id] === 175);
  // rules
  const w1 = await pay("st8", "card", 2500, 6);
  ln = await oline("STRIPE TRANSFER ST-4", 10);
  r = await deposit(ln.id, [{ id: w1.id, amount: 10 }]);
  console.log("a card payment can't be split across payouts:", r.status === 400 && /paid out by Stripe whole/.test(r.body.message));
  const cashX = await pay("stcash", "cash", 1000, 6);
  ln = await oline("STRIPE TRANSFER ST-5", 34.5);
  r = await deposit(ln.id, [{ id: w1.id, amount: 25 }, { id: cashX.id, amount: 10 }]);
  console.log("card payments can't be mixed with cash/checks/Venmo in one deposit:", r.status === 400 && /own deposit/.test(r.body.message));
  // the webhook recorded this payout AFTER the statement was imported (so nothing auto-matched it)
  ln = await oline("STRIPE TRANSFER ST-6", 24);
  d1._raw.run("INSERT INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, note, externalRef, createdAt, updatedAt) VALUES ('2026-10-08', 5, 1, 2400, 'Stripe payout', 'po_1Auto', 't', 't')");
  const w2 = await pay("st9", "card", 2400, 6);
  r = await deposit(ln.id, [{ id: w2.id, amount: 24 }]);
  console.log("if Stripe's webhook already recorded that payout (unmatched), mapping orders is refused — it would count the payout twice — and points to Match…:", r.status === 400 && /already reported/.test(r.body.message) && /Match/.test(r.body.message));
  // …or the line was auto-matched to it on import
  d1._raw.run("INSERT INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, note, externalRef, createdAt, updatedAt) VALUES ('2026-10-08', 5, 1, 1900, 'Stripe payout', 'po_2Auto', 't', 't')");
  ln = await oline("STRIPE TRANSFER ST-8", 19);
  const w3 = await pay("st12", "card", 1900, 6);
  r = await deposit(ln.id, [{ id: w3.id, amount: 19 }]);
  console.log("a line that's already matched (auto-matched to the webhook's payout on import) can't have a new entry created over it — for any kind:",
    ln.status === "matched" && r.status === 400 && /already matched/.test(r.body.message) &&
    (await call({ action: "createFromStatementLine", lineId: ln.id, kind: "income", incomeType: "other" })).status === 400);
  // a payment in a closed month: putting the fee on it would change that month's numbers
  const x1 = await pay("st10", "card", 5000, 7), x2 = await pay("st11", "card", 5000, 7);
  ln = await oline("STRIPE TRANSFER ST-7", 96);
  await call({ action: "closePeriod", month: "2026-08" });
  r = await deposit(ln.id, [{ id: x1.id, amount: 50 }, { id: x2.id, amount: 50 }]);
  console.log("the fee can't be put on payments in a closed month (409, nothing changed):", r.status === 409 && /closed month/.test(r.body.message) && fees()[x1.id] === 0 && fees()[x2.id] === 0);
  await call({ action: "reopenPeriod", month: "2026-08" });
  r = await deposit(ln.id, [{ id: x1.id, amount: 50 }, { id: x2.id, amount: 50 }]);
  console.log("reopened: it goes through, $4.00 of fees split $2.00 / $2.00:", r.status === 200 && fees()[x1.id] === 200 && fees()[x2.id] === 200);

  // =====================================================================
  console.log("\n=== The Create… window (jsdom) ===");
  const p1 = await pay("uiCash", "cash", 8000, 12), p2 = await pay("uiCheck", "check", 5000, 13), p3 = await pay("uiVenmo", "venmo", 4600, 14);
  const dep = await line("MOBILE DEPOSIT 0000a1b2", 110), venmoLine = await line("VENMO CASHOUT", 88), short = await line("DEPOSIT 45", 45);
  const adminJs = read("public/admin.js");
  class L2 extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L2(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };
  const d = (await call({ action: "getReconciliation", accountId: CHECKING, month: "2026-09" })).body;
  const open = async (lineObj) => { let acted = null; await w.rcCreateModal_(d, d.lines.find(l => l.id === lineObj.id), async (b) => { acted = b; });
    const ov = w.document.body.lastElementChild; await wait(() => ov.querySelector("#vmList input[data-pid]") || !ov.querySelector("#vmList")); return { ov, q: (x) => ov.querySelector(x), acted: () => acted }; };
  const tick = (el) => { el.checked = true; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const rowOf = (m, orderId) => [...m.q("#vmList").querySelectorAll("tr[data-method]")].find(t => t.textContent.includes(orderId));

  let m = await open(dep);
  const kinds = [...m.q("#rccKind").options].map(o => o.value);
  console.log("a 'MOBILE DEPOSIT' line starts on Deposit, and the option says Venmo / cash / checks:", m.q("#rccKind").value === "deposit" && /Stripe payout, Venmo, Zelle, cash or checks/.test(m.q("#rccKind").selectedOptions[0].textContent) && kinds.includes("deposit"));
  console.log("it lists every method, each with a badge and where it's recorded:", m.q("#vmFilter").value === "" && /CASH/.test(rowOf(m, p1.orderId).textContent) && /CHECK/.test(rowOf(m, p2.orderId).textContent) && /VENMO/.test(rowOf(m, p3.orderId).textContent) &&
    /in Cash on hand/.test(rowOf(m, p1.orderId).textContent) && /matched whole/.test(rowOf(m, p2.orderId).textContent));
  const chk = rowOf(m, p2.orderId).querySelector("input[data-cov]");
  tick(rowOf(m, p2.orderId).querySelector("input[data-pid]"));
  console.log("a check's 'covers' is fixed at its full $50.00 (it can't be split):", chk.value === "50.00" && chk.disabled === true);
  console.log("checks alone ($50) against a $110 deposit say they're short:", /short of the deposit/.test(m.q("#vmSum").textContent) && m.q("#rccOk").disabled);
  m.q("#vmFilter").value = "cash"; m.q("#vmFilter").dispatchEvent(new w.Event("change"));
  console.log("filtering to Cash hides the other rows but keeps the check ticked:", rowOf(m, p2.orderId).style.display === "none" && rowOf(m, p1.orderId).style.display !== "none" && rowOf(m, p2.orderId).querySelector("input[data-pid]").checked);
  tick(rowOf(m, p1.orderId).querySelector("input[data-pid]"));
  console.log("ticking the cash: it defaults to what the deposit still needs ($60.00 of the cash), and $50 + $60 = $110 matches exactly:",
    rowOf(m, p1.orderId).querySelector("input[data-cov]").value === "60.00" && /matches exactly/.test(m.q("#vmSum").textContent) && m.q("#rccOk").disabled === false);
  const cashCov = rowOf(m, p1.orderId).querySelector("input[data-cov]");
  cashCov.value = "70.00"; cashCov.dispatchEvent(new w.Event("input", { bubbles: true }));
  console.log("cash counted higher than the deposit shows a difference (not Venmo's fee) and asks where to record it:",
    /difference \$10\.00/.test(m.q("#vmSum").textContent) && m.q("#vmFeeRow").style.display !== "none" && /cash kept/.test(m.q("#vmFeeLabel").textContent));
  cashCov.value = "60.00"; cashCov.dispatchEvent(new w.Event("input", { bubbles: true }));
  m.q("#rccOk").click(); await new Promise(x => setTimeout(x, 20));
  console.log("submits each payment with its amount:", !!m.acted() && m.acted().kind === "deposit" && m.acted().allocations.length === 2 &&
    m.acted().allocations.some(a => a.paymentId === p1.id && a.amount === 60) && m.acted().allocations.some(a => a.paymentId === p2.id && a.amount === 50));
  const done = await call(m.acted());
  console.log("…and the server records it (cash $60 by transfer, the check matched):", done.status === 200 && done.body.lines.find(l => l.id === dep.id).status === "matched");

  m = await open(venmoLine);
  console.log("a 'VENMO CASHOUT' line starts filtered to Venmo (the others are hidden, still one click away):",
    m.q("#vmFilter").value === "venmo" && rowOf(m, p3.orderId).style.display !== "none");
  tick(rowOf(m, p3.orderId).querySelector("input[data-pid]"));
  const vc = rowOf(m, p3.orderId).querySelector("input[data-cov]");
  vc.value = "46.00"; vc.dispatchEvent(new w.Event("input", { bubbles: true }));
  console.log("with Venmo ticked, the difference is labelled as Venmo's fee ($46.00 − $88 needs more; then a fee for a bigger one):", /short of the deposit/.test(m.q("#vmSum").textContent));

  const wrong = await pay("uiCheck2", "check", 5000, 15);
  m = await open(short);
  tick(rowOf(m, wrong.orderId).querySelector("input[data-pid]"));
  console.log("only checks ticked and $5.00 over the deposit: says they're already in this account so they must equal it exactly, Create disabled:",
    /already in this account.*equal the deposit exactly/.test(m.q("#vmSum").textContent) && m.q("#rccOk").disabled === true);


  // ---- Local sale can be paid by card
  console.log("\n=== Local sale: Card (in person) ===");
  console.log("the Local sale form offers Card:", /<option value="Card">Card \(in person\)<\/option>/.test(adminJs));
  const ls = await call({ action: "createLocalSale", org: "prime", customerName: "Walk-up", paymentMethod: "Card", paid: true,
    items: [{ productId: "__custom__", name: "Custom cap", type: "cap", qty: 1, customUnitPrice: 30 }] });
  const lsPay = d1.q("SELECT p.method, p.accountId, p.amountCents, p.feeCents, p.note FROM order_payments p WHERE p.orderId=?", ls.body.orderId)[0];
  console.log("a card local sale is recorded as a card payment in the Stripe balance account:", ls.status === 200 && lsPay.method === "card" && lsPay.accountId === STRIPE && lsPay.amountCents === 3000 && /Local sale \(Card\)/.test(lsPay.note));
  console.log("Sync Stripe fees leaves it alone (no Checkout Session exists for it — it would only ever be 'couldn't match'):", !(await lib.getCardPaymentsMissingFees(d1)).some(x => x.orderId === ls.body.orderId));
  console.log("...but a real card payment with no fee is still picked up:", (await lib.getCardPaymentsMissingFees(d1)).some(x => x.orderId !== ls.body.orderId));
  const lsList = await call({ action: "listCashoutPayments", accountId: CHECKING });
  console.log("it's offered when mapping a Stripe payout, where its fee is worked out from the deposit:", lsList.body.payments.some(p => p.orderId === ls.body.orderId && p.method === "card" && p.whole));
  const lsLine = await oline("STRIPE TRANSFER LOCAL", 29.1);
  const lsPid = d1.q("SELECT id FROM order_payments WHERE orderId=?", ls.body.orderId)[0].id;
  const lsDone = await deposit(lsLine.id, [{ id: lsPid, amount: 30 }]);
  console.log("a $30 walk-up card sale against a $29.10 payout: the $0.90 fee lands on that payment and the line matches:", lsDone.status === 200 && fees()[lsPid] === 90 && lsDone.body.lines.find(l => l.id === lsLine.id).status === "matched");

  // ---- a Stripe payout in the window
  const sp1 = await pay("uiStripe1", "card", 6000, 16), sp2 = await pay("uiStripe2", "card", 4000, 16);
  const sLine = await oline("STRIPE TRANSFER 4F2A", 96.1), sCash = await pay("uiStripeCash", "cash", 1000, 16);
  const dOct = (await call({ action: "getReconciliation", accountId: CHECKING, month: "2026-10" })).body;
  let actedS = null;
  await w.rcCreateModal_(dOct, dOct.lines.find(l => l.id === sLine.id), async (b) => { actedS = b; });
  const ovS = w.document.body.lastElementChild, qS = (x) => ovS.querySelector(x);
  await wait(() => qS("#vmList input[data-pid]"));
  console.log("a 'STRIPE TRANSFER' line starts on Deposit, filtered to Stripe (cards):", qS("#rccKind").value === "deposit" && qS("#vmFilter").value === "card" &&
    [...qS("#vmFilter").options].some(o => o.value === "card" && /Stripe/.test(o.textContent)));
  const sRow = (id) => [...qS("#vmList").querySelectorAll("tr[data-method]")].find(t => t.textContent.includes(id));
  console.log("card payments are badged STRIPE and can't be split (covers is fixed at the full amount once ticked):", /STRIPE/.test(sRow(sp1.orderId).textContent) &&
    (() => { tick(sRow(sp1.orderId).querySelector("input[data-pid]")); return sRow(sp1.orderId).querySelector("input[data-cov]").disabled && sRow(sp1.orderId).querySelector("input[data-cov]").value === "60.00"; })());
  tick(sRow(sp2.orderId).querySelector("input[data-pid]"));
  console.log("$100 of charges with no fee recorded against a $96.10 payout: shows Stripe fees $3.90 (3.9%) and says the fee goes on the payments — no category to choose:",
    /Stripe fees \$3\.90 \(3\.9%\)/.test(qS("#vmSum").textContent) && /recorded on the card payments/.test(qS("#vmSum").textContent) && qS("#vmFeeRow").style.display === "none" && qS("#rccOk").disabled === false);
  tick(sRow(sCash.orderId).querySelector("input[data-pid]"));
  console.log("ticking a cash payment too is refused — a Stripe payout is its own deposit:", /own deposit/.test(qS("#vmSum").textContent) && qS("#rccOk").disabled === true);
  sRow(sCash.orderId).querySelector("input[data-pid]").checked = false; sRow(sCash.orderId).querySelector("input[data-pid]").dispatchEvent(new w.Event("change", { bubbles: true }));
  qS("#rccOk").click(); await new Promise(x => setTimeout(x, 20));
  console.log("submits the two charges at their full amounts:", !!actedS && actedS.allocations.length === 2 && actedS.allocations.every(a => [60, 40].includes(a.amount)));
  const doneS = await call(actedS);
  console.log("…and the server puts the fee on the payments and matches the payout:", doneS.status === 200 && doneS.body.lines.find(l => l.id === sLine.id).status === "matched" &&
    fees()[sp1.id] + fees()[sp2.id] === 390);
})().catch(e => { console.log("test50 crashed:", false); console.error(e); process.exit(1); });
