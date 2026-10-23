const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Finance → Account viewer (2026-10): one account's register — every movement in a date range, newest first,
// with Date / Category / Description / Amount / Balance — and a receipt button on every row (view it, or add /
// replace it). Real db.js and orders.js on sql.js; the screen in jsdom, talking to that real API.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank, receiveBlanks, listAccounts, addOrderPayment, recordShippingLabel, getAccountRegister };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const KEY = (c) => "receipts/2026/" + c.repeat(32) + ".pdf";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('pp','pp','PP','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES
      ('A','pp','Ann','a@x','Check',1,50,50,'2026-03-01T00:00:00Z'), ('B','pp','Bob','b@x','Card',1,40,40,'2026-03-01T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES ('A','pp','p','Cap','cap',1,50,50,''),('B','pp','p','Cap','cap',1,40,40,'');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const acct = (n) => d1.q("SELECT id FROM accounts WHERE name = ?", n)[0].id;
  const checking = acct("Business checking"), venmo = acct("Venmo"), stripe = acct("Stripe balance");
  d1._raw.run("UPDATE accounts SET openingDate='2026-01-01', openingBalanceCents=100000 WHERE id = ?", [checking]);
  const tee = (await lib.createBlank(d1, { name: "Gildan 64000", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "S", purchasePrice: 0, quantity: 0 }, { size: "M", purchasePrice: 0, quantity: 0 }] }] })).id;
  const stamp = () => new Promise(r => setTimeout(r, 3));

  // ---- Seed one of every kind of movement in checking ----
  await lib.addOrderPayment(d1, "A", 50, "check #1", "", { method: "check", receivedAt: "2026-03-01T12:00:00Z" });
  await call({ action: "saveExpense", expense: { date: "2026-03-02", description: "Needles", categoryId: 2, amount: 20, accountId: checking } });
  await call({ action: "saveExpense", expense: { date: "2026-03-02", description: "Bobbins", categoryId: 2, amount: 5, accountId: checking } });
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 4, unitCost: 3.5 }, { color: "Navy", size: "M", qty: 6, unitCost: 3.5 }],
    vendor: "S&S", vendorRef: "INV-1", receivedAt: "2026-03-03", accountId: checking, receiptKey: KEY("a"), receiptName: "ss.pdf" });
  await call({ action: "saveMoneyEntry", kind: "income", entry: { date: "2026-03-04", description: "Digitizing", type: "service", amount: 75, accountId: checking } });
  await call({ action: "saveMoneyEntry", kind: "owner", entry: { date: "2026-03-05", kind: "draw", amount: 10, accountId: checking, note: "Lunch" } });
  await call({ action: "saveMoneyEntry", kind: "transfer", entry: { date: "2026-03-06", fromAccountId: checking, toAccountId: venmo, amount: 100, note: "Move to Venmo" } });
  await call({ action: "saveMoneyEntry", kind: "transfer", entry: { date: "2026-03-07", fromAccountId: venmo, toAccountId: checking, amount: 30, note: "Back" } });
  await call({ action: "saveMoneyDefaults", defaults: { postageAccountId: checking, payoutAccountId: checking } });
  await lib.recordShippingLabel(d1, { orderId: "A", shippoTransactionId: "tx_1", amount: 4.25 });
  // A card payment with a Stripe fee lands in the Stripe balance account.
  await lib.addOrderPayment(d1, "B", 40, "Stripe", "pi_1", { method: "card", feeCents: 150, receivedAt: "2026-03-08T12:00:00Z" });

  console.log("=== The register ===");
  // Records are stamped in UTC; between midnight UTC and local midnight the local date is a day behind, and a
  // register ending on it would leave out what was just recorded — so query through the later of the two.
  const localToday = new Date().toLocaleDateString("en-CA");
  const today = [localToday, new Date().toISOString().slice(0, 10)].sort().pop();
  const r = await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-01-01", dateTo: today });
  ok("the action answers", r.status === 200 && r.body.status === "ok" && Array.isArray(r.body.rows));
  const rows = r.body.rows;
  const accts = await lib.listAccounts(d1, today);
  const now = accts.find(a => a.id === checking).balance;
  ok("the ending balance is the account's balance on Accounts & money (same list of movements)", Math.abs(r.body.endBalance - now) < 0.0001 && Math.abs(rows[0].balance - now) < 0.0001);
  ok("started at the opening balance ($1,000)", r.body.startBalance === 1000);
  ok("newest first", rows.every((x, i) => i === 0 || rows[i - 1].date >= x.date));
  ok("every row's balance is the previous (older) row's balance plus its amount", rows.slice(0, -1).every((x, i) => Math.abs(x.balance - rows[i + 1].balance - x.amount) < 0.0001) && Math.abs(rows[rows.length - 1].balance - (1000 + rows[rows.length - 1].amount)) < 0.0001);
  const cat = (c) => rows.filter(x => x.category === c);
  ok("a check payment is a Deposit", cat("Deposit").length === 1 && cat("Deposit")[0].amount === 50 && /A payment \(check\)/.test(cat("Deposit")[0].description));
  ok("expenses are Expense (negative)", cat("Expense").length === 2 && cat("Expense").every(x => x.amount < 0));
  ok("a blank purchase is ONE Blanks row — the charge on the statement — with each size in its breakdown (2026-10)", cat("Blanks").length === 1 && cat("Blanks")[0].amount === -35 &&
    /^Blanks — .*\(2 items\)$/.test(cat("Blanks")[0].description) && cat("Blanks")[0].parts.length === 2 && cat("Blanks")[0].parts.every(p => /^Gildan 64000 · Navy [SM] ×\d+$/.test(p.description)) &&
    cat("Blanks")[0].parts.reduce((t, p) => t + p.amount, 0) === -35);
  ok("service income is Other income", cat("Other income").length === 1 && cat("Other income")[0].amount === 75);
  ok("an owner draw is Owner draw", cat("Owner draw").length === 1 && cat("Owner draw")[0].amount === -10);
  const xf = cat("Transfer");
  ok("transfers name the other account and carry the note, both directions", xf.length === 2 && xf.some(x => x.amount === -100 && /^To Venmo — Move to Venmo$/.test(x.description)) && xf.some(x => x.amount === 30 && /^From Venmo — Back$/.test(x.description)));
  ok("postage is Postage", cat("Postage").length === 1 && cat("Postage")[0].amount === -4.25);
  const sr = (await call({ action: "getAccountRegister", accountId: stripe, dateFrom: "2026-01-01", dateTo: today })).body.rows;
  ok("a card payment is a Deposit and its Stripe fee is a Processing fee, in the Stripe balance account", sr.some(x => x.category === "Deposit" && x.amount === 40) && sr.some(x => x.category === "Processing fee" && x.amount === -1.5));
  ok("same-day rows keep a stable order (the two 3/2 expenses: Bobbins entered later is above Needles)", (() => { const e = rows.filter(x => x.category === "Expense").map(x => x.description); return e[0] === "Bobbins" && e[1] === "Needles"; })());

  console.log("\n=== Date range ===");
  const part = (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-03-04", dateTo: "2026-03-06" })).body;
  const asOf0303 = (await lib.listAccounts(d1, "2026-03-03")).find(a => a.id === checking).balance;
  ok("a range starts from the balance the day before", part.startBalance === asOf0303);
  ok("…and holds only that range's rows (income, draw, transfer)", part.count === 3 && part.rows.map(x => x.date).join() === "2026-03-06,2026-03-05,2026-03-04");
  ok("…with totals in/out and an ending balance that is the start + in − out", part.totalIn === 75 && part.totalOut === 110 && Math.abs(part.endBalance - (part.startBalance + part.totalIn - part.totalOut)) < 0.0001);
  ok("an empty range is fine", (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-02-01", dateTo: "2026-02-05" })).body.count === 0);
  ok("an unknown account is 404", (await call({ action: "getAccountRegister", accountId: 9999, dateFrom: "2026-01-01", dateTo: "2026-01-02" })).status === 404);
  ok("a bad date, a start after the end, and a range over two years are 400", (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "x", dateTo: "2026-01-02" })).status === 400 &&
    (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-02-01", dateTo: "2026-01-01" })).status === 400 &&
    (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2020-01-01", dateTo: "2026-01-01" })).status === 400);

  console.log("\n=== Receipts ===");
  const withReceipt = rows.filter(x => x.receiptKey);
  ok("the blank purchase already shows its receipt on its row; nothing else has one", withReceipt.length === 1 && withReceipt.every(x => x.category === "Blanks" && x.receiptName === "ss.pdf"));
  const first = (c) => rows.find(x => x.category === c);
  const dbRow = (table, id) => d1.q(`SELECT receiptKey, receiptName FROM ${table} WHERE id = ?`, id)[0];
  const attach = (src, id, k, n) => call({ action: "setRecordReceipt", src, srcId: id, receiptKey: KEY(k), receiptName: n || "r.pdf" });
  const pay = first("Deposit"), exp = first("Expense"), inc = first("Other income"), own = first("Owner draw"), post = first("Postage");
  const xout = xf.find(x => x.amount < 0), xin = xf.find(x => x.amount > 0);
  const cases = [["payment", pay, "order_payments"], ["expense", exp, "expenses"], ["income", inc, "other_income"], ["owner", own, "owner_transactions"], ["postage", post, "shipping_labels"], ["transfer_out", xout, "account_transfers"]];
  for (const [src, row, table] of cases) {
    const res = await attach(src, row.srcId, "c", src + ".pdf");
    ok(`a receipt can be added to a ${src} row`, res.status === 200 && dbRow(table, row.srcId).receiptKey === KEY("c") && dbRow(table, row.srcId).receiptName === src + ".pdf" && row.src === src);
  }
  ok("a transfer's two sides share the one receipt", (await call({ action: "getAccountRegister", accountId: venmo, dateFrom: "2026-01-01", dateTo: today })).body.rows.find(x => x.src === "transfer_in" && x.srcId === xout.srcId).receiptKey === KEY("c") && xin.src === "transfer_in");
  const feeRow = sr.find(x => x.category === "Processing fee");
  ok("a Processing fee row's receipt is its payment's", (await attach("fee", feeRow.srcId, "d")).status === 200 && dbRow("order_payments", feeRow.srcId).receiptKey === KEY("d"));
  const afterAdd = (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-01-01", dateTo: today })).body.rows;
  ok("the register now returns those receipts", afterAdd.find(x => x.src === "expense" && x.srcId === exp.srcId).receiptKey === KEY("c"));
  const replaced = await attach("expense", exp.srcId, "e", "new.pdf");
  ok("a receipt can be replaced", replaced.status === 200 && dbRow("expenses", exp.srcId).receiptKey === KEY("e"));
  const audits = d1.q("SELECT action, detail FROM audit_log WHERE action LIKE 'receipt.%' ORDER BY id");
  ok("each change is audited — attached, then replaced (with the old and new file)", audits.some(a => a.action === "receipt.attached") && audits.some(a => a.action === "receipt.replaced" && JSON.parse(a.detail).from === KEY("c") && JSON.parse(a.detail).to === KEY("e")));
  ok("a bad receipt reference is refused", (await call({ action: "setRecordReceipt", src: "expense", srcId: exp.srcId, receiptKey: "../../etc/passwd" })).status === 400 && dbRow("expenses", exp.srcId).receiptKey === KEY("e"));
  ok("an unknown kind of record is refused", (await attach("orders", 1, "f")).status === 404);
  ok("a record that doesn't exist is refused", (await attach("expense", 9999, "f")).status === 404);
  await call({ action: "deleteExpense", expenseId: first("Expense").srcId });
  ok("a deleted record is refused", (await attach("expense", first("Expense").srcId, "f")).status === 404);

  // A blank order with R&D and a personal part: the receipt goes on the whole receive.
  const ord = await call({ action: "receiveBlankOrder", groups: [{ blankId: tee, lines: [{ color: "Navy", size: "S", qty: 2, total: 10 }, { color: "Navy", size: "M", qty: 2, total: 12 }] }],
    receivedAt: "2026-03-10", accountId: checking, vendor: "SanMar", vendorRef: "SM-9", rdAmount: 18, rdCategoryId: 2, personalAmount: 6.5, extraCost: 0 });
  ok("(setup) a Receive order with an R&D part and a personal part was recorded", ord.status === 200 && ord.body.parts.rd === 18 && ord.body.parts.personal === 6.5);
  const reg2 = (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-03-10", dateTo: "2026-03-10" })).body.rows;
  const sm = reg2.find(x => x.src === "blanks");
  const res = await attach("blanks", sm.srcId, "9", "sanmar.pdf");
  ok("one receipt on a blank purchase row goes on every record of that receive — both sizes, the R&D expense and the personal draw", res.status === 200 && res.body.records === 4 &&
    d1.q("SELECT count(*) n FROM inventory_movements WHERE receiptKey = ?", KEY("9"))[0].n === 2 && d1.q("SELECT count(*) n FROM expenses WHERE receiptKey = ?", KEY("9"))[0].n === 1 &&
    d1.q("SELECT count(*) n FROM owner_transactions WHERE receiptKey = ?", KEY("9"))[0].n === 1);
  ok("…and not on the earlier S&S receive", d1.q("SELECT count(*) n FROM inventory_movements WHERE receiptKey = ?", KEY("a"))[0].n === 2);

  console.log("\n=== A closed month doesn't stop a receipt ===");
  const closed = await call({ action: "closePeriod", month: "2026-02" });
  d1._raw.run("INSERT INTO other_income (incomeDate, description, type, amountCents, accountId, createdAt, updatedAt) VALUES ('2026-02-10','Old','other',500,?, 't','t')", [checking]);
  const oldRow = (await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-02-01", dateTo: "2026-02-28" })).body.rows[0];
  await call({ action: "closePeriod", month: "2026-02" });
  const inClosed = await attach("income", oldRow.srcId, "b");
  ok("a receipt can still be attached to a record in a closed month (it changes no amounts)", closed && inClosed.status === 200 && dbRow("other_income", oldRow.srcId).receiptKey === KEY("b"));

  console.log("\n=== The role gate ===");
  ok("both actions need the manager role, not staff", /"getAccountRegister"/.test(read("functions/api/orders.js").match(/const MANAGER_ACTIONS = \[[\s\S]*?\];/)[0]) && /"setRecordReceipt"/.test(read("functions/api/orders.js").match(/const MANAGER_ACTIONS = \[[\s\S]*?\];/)[0]) &&
    !/"getAccountRegister"/.test(read("functions/api/orders.js").match(/const STAFF_ACTIONS = \[[\s\S]*?\];/)[0]));
  ok("the migration and schema.sql add receiptKey/receiptName to every other source", ["order_payments", "other_income", "owner_transactions", "account_transfers", "shipping_labels"].every(t => new RegExp("ALTER TABLE " + t + "\\s+ADD COLUMN receiptKey").test(read("migrations/0061_receipts_and_groups.sql"))));

  console.log("\n=== The screen ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const calls = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; calls.push(b);
      const out = await call(b); return { ok: out.status < 400, status: out.status, json: async () => out.body }; }; } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  const nav = w.eval("ADMIN_NAV_GROUPS.find(g => g.label === 'Finance').items.map(i => i[0] + '=' + i[1]).join('|')");
  ok("Finance menu: Account viewer comes after Accounts & money and Reconcile", nav === "expenses=Expenses|money=Accounts & money|reconcile=Reconcile|accountviewer=Account viewer");
  const app = w.document.getElementById("app");
  const regCalls = () => calls.filter(c => c.action === "getAccountRegister");
  await w.renderAccountViewer(app);
  const $ = (id) => w.document.getElementById(id);
  const firstAccount = d1.q("SELECT id FROM accounts ORDER BY id LIMIT 1")[0].id;
  ok("the account list defaults to the first account", $("avAccount").value === String(firstAccount) && $("avAccount").options.length === d1.q("SELECT count(*) n FROM accounts")[0].n);
  const d31 = (() => { const d = new Date(); d.setDate(d.getDate() - 31); return d.toLocaleDateString("en-CA"); })();
  ok("the dates default to the last 32 days", $("avFrom").value === d31 && $("avTo").value === localToday && (Date.parse($("avTo").value) - Date.parse($("avFrom").value)) / 86400000 === 31);
  ok("opening the screen loads once with the defaults", regCalls().length === 1 && regCalls()[0].accountId === firstAccount && regCalls()[0].dateFrom === d31);
  ok("there is a Search button", /Search/.test($("avSearch").textContent));
  const list = $("avList");
  ok("the list scrolls (fixed height, overflow-y: auto)", /overflow-y:auto/.test(list.getAttribute("style")) && /max-height/.test(list.getAttribute("style")));

  $("avAccount").value = String(checking); $("avAccount").dispatchEvent(new w.Event("change"));
  $("avFrom").value = "2026-03-01"; $("avFrom").dispatchEvent(new w.Event("change"));
  await new Promise(res => setTimeout(res, 30));
  ok("changing the account or a date does NOT search — it asks you to click Search", regCalls().length === 1 && /click Search/.test($("avHint").textContent));
  $("avSearch").click();
  await new Promise(res => setTimeout(res, 100));
  ok("Search runs the query the controls now describe", regCalls().length === 2 && regCalls()[1].accountId === checking && regCalls()[1].dateFrom === "2026-03-01" && $("avHint").textContent === "");
  const trs = [...list.querySelectorAll("tbody tr")];
  ok("columns: Date, Category, Description, Amount, Balance (+ Receipt)", [...list.querySelectorAll("thead th")].map(t => t.textContent).join("|") === "Date|Category|Description|Amount|Balance|Receipt");
  ok("newest first", trs.length > 5 && trs.map(t => t.children[0].textContent).every((d, i, a) => i === 0 || a[i - 1] >= d));
  ok("a summary line shows the start, in, out and end", /started at/.test($("avSummary").textContent) && /ended at/.test($("avSummary").textContent) && /transactions/.test($("avSummary").textContent));
  const viewBtns = list.querySelectorAll(".av-view"), addBtns = list.querySelectorAll(".av-add");
  ok("every row has a receipt button: View where there is a receipt, ＋ Receipt where there isn't", trs.every(t => t.querySelector(".av-view") || t.querySelector(".av-add")) && viewBtns.length > 0 && [...addBtns].some(b => /Receipt/.test(b.textContent)));
  let opened = ""; w.eval("expViewReceipt_ = (k) => { window.__opened = k; };");
  viewBtns[0].click();
  ok("View opens the receipt the way an expense's does", /^receipts\/2026\//.test(w.__opened || ""));

  // Add a receipt through the screen: pick a file → upload → attach → the list refreshes with the LAST search.
  w.eval(`uploadReceipt_ = async (file) => ({ key: "receipts/2026/${"7".repeat(32)}.pdf", name: file.name })`);
  const target = [...list.querySelectorAll("tbody tr")].find(t => /Digitizing/.test(t.children[2].textContent));
  let clicked = 0; $("avFile").click = () => { clicked++; };
  target.querySelector(".av-add").click();
  ok("＋ Receipt opens the file picker", clicked === 1);
  const file = new w.File(["x"], "digitizing.pdf", { type: "application/pdf" });
  Object.defineProperty($("avFile"), "files", { value: [file], configurable: true });
  list.scrollTop = 40;
  $("avFrom").value = "2025-01-01"; $("avFrom").dispatchEvent(new w.Event("change"));   // edited but not searched
  const before = regCalls().length;
  $("avFile").dispatchEvent(new w.Event("change"));
  await new Promise(res => setTimeout(res, 150));
  const rc = calls.filter(c => c.action === "setRecordReceipt").pop();
  ok("the picked file is attached to that row's record", rc && rc.src === "income" && rc.srcId === inc.srcId && rc.receiptKey === KEY("7"));
  ok("the list refreshes with the last search — not the edited, unsearched date", regCalls().length === before + 1 && regCalls().pop().dateFrom === "2026-03-01");
  const again = [...list.querySelectorAll("tbody tr")].find(t => /Digitizing/.test(t.children[2].textContent));
  ok("…and that row now offers View", again && again.querySelector(".av-view") && /Replace/.test(again.textContent));
  ok("text from the database is escaped", (() => { return !list.innerHTML.includes("<script"); })());

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test133 crashed: false"); process.exit(1); });
