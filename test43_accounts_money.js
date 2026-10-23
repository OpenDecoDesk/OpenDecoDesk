const fs = require("fs");
const crypto = require("crypto");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Accounts & money (migrations/0014) — real SQL (sql.js), real db.js,
// orders.js and stripe-webhook.js: every movement has an account, balances,
// other income, owner contributions/draws, transfers, Stripe payouts,
// personal-funds expenses, period locks, export — plus the admin screen.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), httpSrc = strip(read("functions/_lib/http.js"));
const emailStubs = "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendStripePaymentNotification = async () => true, sendRefundNotification = async () => true, sendDisputeNotification = async () => true;\n";
const lib = new Function(dbSrc + "\nreturn { insertOrder, getOrderById, addOrderPayment, recordShippingLabel, listAccounts, getMoneySummary };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + httpSrc + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  emailStubs + dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const webhook = new Function(httpSrc + "\n" + emailStubs + dbSrc + "\n" + strip(read("functions/api/stripe-webhook.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES
      ('A','prime','Ann','a@x','Card',1,16,16,'2026-07-01T00:00:00Z'), ('B','prime','Bob','b@x','Venmo',1,16,16,'2026-07-02T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES
      ('A','prime','p','Cap','cap',1,16,16,''),('B','prime','p','Cap','cap',1,16,16,'');
    INSERT INTO order_payments (orderId, amount, note, receivedAt) VALUES ('A',16,'stripe','2026-07-01T00:00:00Z'), ('B',16,'venmo','2026-07-02T00:00:00Z');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "prime" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const bal = async (name, asOf = "2099-12-31") => (await lib.listAccounts(d1, asOf)).find(a => a.name === name).balance;

  console.log("=== Migration 0014 ===");
  const accts = d1.q("SELECT id, name, type FROM accounts ORDER BY id");
  console.log("5 accounts seeded (checking, credit card, Venmo, cash, Stripe):", accts.map(a => a.type).join() === "checking,credit_card,venmo,cash,stripe");
  console.log("existing payments get their method's account (card → Stripe, Venmo → Venmo):",
    d1.q("SELECT accountId FROM order_payments ORDER BY orderId").map(r => r.accountId).join() === "5,3");

  console.log("\n=== Payments land in accounts ===");
  await call({ action: "saveAccount", account: { id: 1, name: "Business checking", type: "checking", openingDate: "2026-01-01", openingBalance: 100, active: true } });
  let r = await call({ action: "addPayment", orderId: "A", amount: 10, method: "check", reference: "1001", date: "2026-07-05" });
  const chk = d1.q("SELECT id, accountId FROM order_payments WHERE reference='1001'")[0];
  console.log("a check payment goes to Business checking by default:", r.status === 200 && chk.accountId === 1);
  r = await call({ action: "addPayment", orderId: "A", amount: 5, method: "cash", date: "2026-07-06", accountId: 1 });
  console.log("…or to the account chosen (cash deposited straight to checking):", d1.q("SELECT accountId FROM order_payments WHERE method='cash'")[0].accountId === 1);
  r = await call({ action: "setPaymentAccount", paymentId: chk.id, accountId: 4 });
  console.log("an entry can be moved to another account (audited):", r.status === 200 && d1.q("SELECT accountId FROM order_payments WHERE id=?", chk.id)[0].accountId === 4 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='payment.account_changed'")[0].n === 1);
  await lib.addOrderPayment(d1, "B", 20, "Stripe", "pi_B1", { method: "card", feeCents: 88, receivedAt: "2026-07-07T00:00:00Z" });
  const stripePay = d1.q("SELECT id FROM order_payments WHERE externalRef='pi_B1'")[0].id;
  r = await call({ action: "setPaymentAccount", paymentId: stripePay, accountId: 1 });
  console.log("Stripe payments stay in the Stripe balance:", r.status === 400);
  console.log("Stripe balance = $16 + $20 − $0.88 fee = $35.12:", await bal("Stripe balance") === 35.12);

  console.log("\n=== Expenses, blanks, postage ===");
  r = await call({ action: "saveExpense", expense: { date: "2026-07-10", description: "Thread", categoryId: 2, amount: 30 } });
  console.log("an expense must say where it was paid from:", r.status === 400 && /Choose which account/.test(r.body.message));
  r = await call({ action: "saveExpense", expense: { date: "2026-07-10", description: "Thread", categoryId: 2, amount: 30, accountId: 2 } });
  console.log("paid by credit card → card balance −$30 (owed):", r.status === 200 && r.body.expense.accountId === 2 && await bal("Credit card") === -30);
  r = await call({ action: "saveExpense", expense: { date: "2026-07-11", description: "Needles", categoryId: 2, amount: 12, paidPersonally: true } });
  console.log("paid from personal funds → no account moves, counts as owner money in:", r.body.expense.paidPersonally === true && r.body.expense.accountId === null);
  d1._raw.exec("INSERT INTO blanks (id, name, brand, color, createdAt, updatedAt) VALUES (1,'Polo blank','ST','Green','t','t'); INSERT INTO blank_sizes (blankId, size, purchasePriceCents, quantity) VALUES (1,'M',400,0)");
  await call({ action: "receiveBlanks", blankId: 1, lines: [{ size: "M", qty: 10, unitCost: 4 }], vendor: "SanMar", receivedAt: "2026-07-12", accountId: 1 });
  console.log("blanks paid from checking: $100 opening + $5 cash deposit − $40:", await bal("Business checking") === 65);
  await lib.insertOrder(d1, { orderId: "S1", orgId: "prime", customerName: "S", contact: "s@x", placedAt: "2026-07-13T00:00:00Z" }, [{ productId: "p", name: "Cap", type: "cap", qty: 1, unitPrice: 16 }]);
  await lib.recordShippingLabel(d1, { orderId: "S1", shippoTransactionId: "tx_1", amount: 5.25 });
  console.log("Shippo postage charged to the default (credit card): −$35.25:", await bal("Credit card") === -35.25);
  r = await call({ action: "saveMoneyDefaults", defaults: { postageAccountId: 1, payoutAccountId: 1 } });
  await lib.recordShippingLabel(d1, { orderId: "S1", shippoTransactionId: "tx_2", amount: 4 });
  console.log("…the default can be changed (next label from checking):", r.status === 200 && await bal("Business checking") === 61);

  console.log("\n=== Other income, owner money, transfers ===");
  r = await call({ action: "saveMoneyEntry", kind: "income", entry: { date: "2026-07-15", description: "Digitizing for Acme", type: "service", amount: 75, accountId: 3 } });
  console.log("service income recorded into Venmo:", r.status === 200 && await bal("Venmo") === 16 + 75);
  r = await call({ action: "saveMoneyEntry", kind: "income", entry: { date: "2026-07-15", description: "x", type: "gift", amount: 5, accountId: 1 } });
  const r2 = await call({ action: "saveMoneyEntry", kind: "income", entry: { date: "2099-01-01", description: "x", type: "other", amount: 5, accountId: 1 } });
  console.log("unknown type / future date refused:", r.status === 400 && r2.status === 400);
  await call({ action: "saveMoneyEntry", kind: "owner", entry: { date: "2026-07-16", kind: "contribution", amount: 500, accountId: 1, note: "Startup" } });
  await call({ action: "saveMoneyEntry", kind: "owner", entry: { date: "2026-07-20", kind: "draw", amount: 50, accountId: 1 } });
  console.log("owner put in $500, took out $50 (checking 61 + 500 − 50):", await bal("Business checking") === 511);
  r = await call({ action: "saveMoneyEntry", kind: "transfer", entry: { date: "2026-07-21", fromAccountId: 3, toAccountId: 1, amount: 91, note: "Venmo to bank" } });
  console.log("Venmo → checking transfer moves money between them:", r.status === 200 && await bal("Venmo") === 0 && await bal("Business checking") === 602);
  r = await call({ action: "saveMoneyEntry", kind: "transfer", entry: { date: "2026-07-21", fromAccountId: 1, toAccountId: 1, amount: 5 } });
  console.log("a transfer to the same account is refused:", r.status === 400);
  await call({ action: "saveMoneyEntry", kind: "transfer", entry: { date: "2026-07-22", fromAccountId: 1, toAccountId: 2, amount: 35.25, note: "Pay card" } });
  console.log("paying the card clears what's owed:", await bal("Credit card") === 0);

  console.log("\n=== Stripe payouts (webhook) ===");
  const WHSEC = "whsec_t";
  const signed = (ev) => { const body = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
    return { text: async () => body, headers: { get: (h) => h === "stripe-signature" ? `t=${t},v1=${crypto.createHmac("sha256", WHSEC).update(t + "." + body).digest("hex")}` : null } }; };
  const payout = { id: "evt_po1", type: "payout.paid", created: 1785000000, data: { object: { id: "po_1", amount: 3000, arrival_date: 1785000000 } } };
  let w = await webhook({ request: signed(payout), env: { DB: d1, STRIPE_WEBHOOK_SECRET: WHSEC } });
  await webhook({ request: signed(Object.assign({}, payout, { id: "evt_po1b" })), env: { DB: d1, STRIPE_WEBHOOK_SECRET: WHSEC } });
  console.log("payout.paid → one transfer Stripe → checking, even if delivered twice:", w.status === 200 &&
    d1.q("SELECT count(*) n FROM account_transfers WHERE externalRef='po_1'")[0].n === 1 && await bal("Stripe balance") === 5.12);
  const po = d1.q("SELECT id FROM account_transfers WHERE externalRef='po_1'")[0].id;
  r = await call({ action: "deleteMoneyEntry", kind: "transfer", id: po });
  console.log("automatic payouts can't be deleted by hand:", r.status === 400);

  console.log("\n=== Opening date, locks, summary, export ===");
  console.log("balances as of a date only count movements up to it ($100 + $5 by Jul 11):", await bal("Business checking", "2026-07-11") === 105);
  await call({ action: "saveAccount", account: { id: 3, name: "Venmo", type: "venmo", openingDate: "2026-07-16", openingBalance: 0, active: true } });
  console.log("movements before an account's opening date don't count (its opening balance covers them):", await bal("Venmo") === -91);
  await call({ action: "saveAccount", account: { id: 3, name: "Venmo", type: "venmo", openingDate: "2026-01-01", openingBalance: 0, active: true } });
  await call({ action: "closePeriod", month: "2026-07" });
  r = await call({ action: "saveMoneyEntry", kind: "owner", entry: { date: "2026-07-25", kind: "draw", amount: 5, accountId: 1 } });
  console.log("entries in a closed month are refused:", r.status === 409);
  await call({ action: "reopenPeriod", month: "2026-07" });
  r = await call({ action: "listMoney", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  const s = r.body.summary;
  console.log("summary: $75 services, owner in $512 ($500 + $12 paid personally), out $50:",
    s.otherIncome.service === 75 && s.owner.totalIn === 512 && s.owner.paidPersonally === 12 && s.owner.draws === 50);
  r = await call({ action: "getAccountantExport", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  const sum = (k) => Math.round(r.body.summary.reduce((a, m) => a + (m[k] || 0) * 100, 0)) / 100;
  console.log("export: income, owner, transfers and account balances; summary columns:",
    r.body.income.length === 1 && r.body.owner.length === 2 && r.body.transfers.length === 3 && r.body.accounts.length === 5 &&
    sum("serviceIncome") === 75 && sum("ownerContributions") === 512 && sum("ownerDraws") === 50 &&
    r.body.expenses.find(x => x.description === "Needles").paidFrom === "Personal funds");
  r = await call({ action: "getRevenueReport", basis: "cash", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  console.log("cash-basis report includes other income:", r.body.otherIncome.service === 75);

  console.log("\n=== D1 limits ===");
  // D1 caps the terms in a compound SELECT far below SQLite's default, and the
  // sql.js test engine doesn't — so guard it statically: no query in the
  // server code may chain more than 3 UNION ALLs.
  const tooBig = ["functions/_lib/db.js", "functions/api/orders.js"].flatMap(f =>
    [...read(f).matchAll(/`[^`]*`/g)].map(m => m[0]).filter(q => (q.match(/UNION ALL/gi) || []).length > 3));
  console.log("no compound SELECT with more than 4 terms (D1 rejects them):", tooBig.length === 0);

  console.log("\n=== Admin screen (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const accountsNow = (await call({ action: "listAccounts" })).body, moneyNow = (await call({ action: "listMoney", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body;
  moneyNow.income[0].description = "<img src=x onerror=alert(1)>";
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const data = b.action === "listAccounts" ? accountsNow : b.action === "listMoney" ? moneyNow : { status: "error", message: "n/a" };
      return { ok: true, status: 200, json: async () => data }; }; } });
  const wv = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await wv.loadAdminScript();
  wv.eval('adminKey = "cookie"');
  const app = wv.document.getElementById("app");
  wv.document.getElementById("app").innerHTML = "";
  await wv.renderMoney(app);
  wv.document.getElementById("mnYear").innerHTML = "<option>2026</option>";
  await wv.mnLoad_();
  const txt = app.textContent;
  console.log("Accounts & money button next to Expenses:", /\["expenses", "[^"]*"\],\s*\["money"/.test(adminJs));
  console.log("screen lists accounts with balances, income, owner and transfers; text escaped:",
    /Business checking/.test(txt) && /Stripe balance/.test(txt) && /Owner put in/.test(txt) && /Transfers between accounts/.test(txt) &&
    !app.innerHTML.includes("<img src=x") && app.innerHTML.includes("&lt;img src=x"));
})().catch(e => { console.log("test43 crashed:", false); console.error(e); process.exit(1); });
