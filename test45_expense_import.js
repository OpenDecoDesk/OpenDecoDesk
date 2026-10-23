const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Expense CSV import — real SQL (sql.js), real db.js + orders.js admin API,
// and the Expenses screen's Import CSV window end to end (jsdom).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
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
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const supplies = 2, software = 3, meals = 5;
  await call({ action: "saveExpense", expense: { date: "2026-08-02", description: "ADOBE CREATIVE CLOUD", categoryId: software, amount: 59.99, accountId: 2 } });
  await call({ action: "saveExpense", expense: { date: "2026-08-05", description: "Thread order", categoryId: supplies, amount: 42, accountId: 2 } });

  console.log("=== Preview ===");
  let r = await call({ action: "previewExpenseImport", rows: [
    { date: "2026-09-02", description: "ADOBE CREATIVE CLOUD", amount: 59.99 },
    { date: "2026-08-05", description: "THREAD ORDER", amount: 42 },
    { date: "2026-09-03", description: "ADOBE STOCK", amount: 9.99 },
    { date: "2026-09-04", description: "SHELL OIL", amount: 40 }] });
  const p = r.body.rows;
  console.log("same description → last category used (Adobe → Software):", p[0].suggestedCategoryId === software && !p[0].duplicate);
  console.log("same date + amount as a recorded expense → flagged as already recorded:", p[1].duplicate === true);
  console.log("same first word → suggested too (Adobe Stock → Software); unknown → no suggestion:", p[2].suggestedCategoryId === software && p[3].suggestedCategoryId === null);

  console.log("\n=== Import ===");
  r = await call({ action: "importExpenses", accountId: 2, rows: [{ date: "2026-09-02", description: "Adobe", amount: 59.99, categoryId: 0 }] });
  console.log("every row needs a category:", r.status === 400 && /category/.test(r.body.message));
  r = await call({ action: "importExpenses", rows: [{ date: "2026-09-02", description: "Adobe", amount: 59.99, categoryId: software }] });
  console.log("…and a paid-from account (or personal funds):", r.status === 400 && /paid/.test(r.body.message));
  r = await call({ action: "importExpenses", accountId: 2, mapping: { date: "Date", desc: "Description", mode: "one", amount: "Amount", flip: true, vendor: "", category: "Category" },
    rows: [{ date: "2026-09-02", description: "ADOBE CREATIVE CLOUD", amount: 59.99, categoryId: software },
           { date: "2026-09-10", description: "Lunch with client", vendor: "Panera", amount: 30, categoryId: meals }] });
  console.log("2 expenses created from the card, audited:", r.status === 200 && r.body.imported === 2 &&
    d1.q("SELECT count(*) n FROM expenses WHERE accountId = 2 AND deletedAt IS NULL")[0].n === 4 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='expense.imported'")[0].n === 1);
  console.log("vendor kept; meals category still applies its 50%:", d1.q("SELECT vendor FROM expenses WHERE description='Lunch with client'")[0].vendor === "Panera" &&
    (await call({ action: "listExpenses", dateFrom: "2026-09-01", dateTo: "2026-09-30" })).body.expenses.find(x => x.description === "Lunch with client").deductible === 15);
  console.log("column mapping remembered on the card account:", JSON.parse(d1.q("SELECT csvMapping FROM accounts WHERE id=2")[0].csvMapping).category === "Category");
  r = await call({ action: "importExpenses", paidPersonally: true, rows: [{ date: "2026-09-11", description: "Needles", amount: 8, categoryId: supplies }] });
  console.log("personal funds import works (owner money in):", r.status === 200 && d1.q("SELECT paidPersonally FROM expenses WHERE description='Needles'")[0].paidPersonally === 1);
  await call({ action: "closePeriod", month: "2026-08" });
  r = await call({ action: "importExpenses", accountId: 2, rows: [{ date: "2026-08-20", description: "Late August thing", amount: 5, categoryId: supplies }] });
  console.log("rows dated in a closed month are refused:", r.status === 409);
  await call({ action: "reopenPeriod", month: "2026-08" });
  r = await call({ action: "importExpenses", accountId: 2, rows: [{ date: "2099-01-01", description: "x", amount: 5, categoryId: supplies }] });
  const r2 = await call({ action: "importExpenses", accountId: 2, rows: [{ date: "2026-09-01", description: "x", amount: -5, categoryId: supplies }] });
  console.log("future dates and non-positive amounts refused:", r.status === 400 && r2.status === 400);

  console.log("\n=== Import window (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      sent.push(b);
      const res = await call(b);   // the real API on the same database
      return { ok: res.status < 400, status: res.status, json: async () => res.body }; }; } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  const app = w.document.getElementById("app");
  await w.renderExpenses(app);
  w.document.getElementById("expImportBtn").click();
  const modal = w.document.body.lastElementChild;
  modal.querySelector("#eiPaidFrom").value = "2";
  const csv = "Transaction Date,Description,Category,Amount\n09/15/2026,ADOBE CREATIVE CLOUD,Software,59.99\n09/16/2026,PAYMENT THANK YOU,,-500.00\n09/17/2026,AMAZON <b>MKT</b>,\"Supplies (thread, stabilizer, needles)\",23.10\n";
  const fileEl = modal.querySelector("#eiFile");
  Object.defineProperty(fileEl, "files", { value: [new w.File([csv], "card.csv", { type: "text/csv" })] });
  fileEl.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 100 && !modal.querySelector("#eiReviewBtn"); i++) await new Promise(res => setTimeout(res, 10));
  console.log("mapping guessed for a card export (flip signs, category column); payment row skipped:",
    modal.querySelector('[data-k="flip"]').checked && /Review 2 expenses/.test(modal.querySelector("#eiReviewBtn").textContent) && /1 money-in row/.test(modal.textContent));
  modal.querySelector("#eiReviewBtn").click();
  for (let i = 0; i < 100 && !modal.querySelector("#eiGo"); i++) await new Promise(res => setTimeout(res, 10));
  const rowsEl = [...modal.querySelectorAll("#eiReview tbody tr")];
  console.log("review: categories from the file's column — exact name (Supplies…) or its start (\"Software\" → Software & subscriptions); text escaped:",
    rowsEl.length === 2 && rowsEl[0].querySelector(".ei-cat").value === String(software) && rowsEl[1].querySelector(".ei-cat").value === String(supplies) &&
    !modal.querySelector("#eiReview b") && rowsEl[1].querySelector(".ei-desc").value === "AMAZON <b>MKT</b>");
  modal.querySelector("#eiGo").click();
  for (let i = 0; i < 100 && !sent.some(b => b.action === "importExpenses"); i++) await new Promise(res => setTimeout(res, 10));
  await new Promise(res => setTimeout(res, 50));
  const imp = sent.find(b => b.action === "importExpenses");
  console.log("imports both, paid from the card, amounts positive:", !!imp && imp.accountId === 2 && imp.rows.length === 2 &&
    imp.rows[0].amount === 59.99 && imp.rows[1].amount === 23.1 && d1.q("SELECT count(*) n FROM expenses WHERE description LIKE 'AMAZON%'")[0].n === 1);
  console.log("Import CSV button on the Expenses screen:", /id="expImportBtn"/.test(adminJs));
})().catch(e => { console.log("test45 crashed:", false); console.error(e); process.exit(1); });
