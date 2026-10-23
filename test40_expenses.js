const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Business expenses (migrations/0012) — real SQL (sql.js), real db.js, real
// orders.js admin API, real receipt.js, and the admin Expenses screen (jsdom).

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
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const audits = (a) => d1.q("SELECT count(*) n FROM audit_log WHERE action = ?", a)[0].n;

  console.log("=== Migration 0012: seeded categories ===");
  let r = await call({ action: "listExpenseCategories" });
  const cats = r.body.categories, byName = (n) => cats.find(c => c.name === n);
  console.log("16 starting categories:", cats.length === 16);
  console.log("machines → depreciation, line 13; meals → deductible 50%, line 24b; personal → none:",
    byName("Equipment & machines").deductionType === "depreciation" && byName("Equipment & machines").scheduleCLine === "13" &&
    byName("Meals (50%)").deductiblePct === 50 && byName("Meals (50%)").scheduleCLine === "24b" &&
    byName("Personal / non-deductible").deductionType === "none");
  console.log("Schedule C lines and methods sent for the dropdowns:", r.body.scheduleCLines["22"] === "Supplies" && r.body.depreciationMethods.section179 === "Section 179");

  console.log("\n=== Categories: add, edit, duplicate, delete rules ===");
  r = await call({ action: "saveExpenseCategory", category: { name: "Embroidery software", deductionType: "deductible", scheduleCLine: "27a", deductiblePct: 100 } });
  const softId = r.body.id;
  console.log("category added (audited):", r.status === 200 && r.body.categories.some(c => c.name === "Embroidery software") && audits("expense_category.created") === 1);
  r = await call({ action: "saveExpenseCategory", category: { name: "embroidery SOFTWARE", deductionType: "deductible" } });
  console.log("duplicate name (any case) refused:", r.status === 400 && /already exists/.test(r.body.message));
  r = await call({ action: "saveExpenseCategory", category: { id: softId, name: "Digitizing software", deductionType: "deductible", scheduleCLine: "27a", deductiblePct: 100 } });
  console.log("category renamed (audited with before/after):", r.status === 200 && r.body.categories.some(c => c.name === "Digitizing software") && audits("expense_category.updated") === 1);
  r = await call({ action: "saveExpenseCategory", category: { name: "Bad", deductionType: "sometimes" } });
  const r2 = await call({ action: "saveExpenseCategory", category: { name: "Bad", deductionType: "deductible", scheduleCLine: "99" } });
  const r3 = await call({ action: "saveExpenseCategory", category: { name: "Bad", deductionType: "deductible", deductiblePct: 150 } });
  console.log("unknown deduction type / Schedule C line / % out of range refused:", r.status === 400 && r2.status === 400 && r3.status === 400);

  console.log("\n=== Expenses ===");
  const machines = byName("Equipment & machines").id, meals = byName("Meals (50%)").id, phone = byName("Utilities & phone").id, personal = byName("Personal / non-deductible").id;
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-03-10", description: "Embroidery machine #1", categoryId: machines, amount: 12500, vendor: "Tajima",
    placedInService: "2026-03-15", depMethod: "section179" } });
  const m1 = r.body.expense;
  console.log("capital machine saved with Form 4562 facts:", r.status === 200 && m1.amount === 12500 && m1.placedInService === "2026-03-15" && m1.depMethod === "section179" && m1.deductible === 0);
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-02", description: "Embroidery machine #2", categoryId: machines, amount: 9800, businessUsePct: 90 } });
  console.log("placed-in-service defaults to the purchase date, method to Ask CPA:", r.body.expense.placedInService === "2026-04-02" && r.body.expense.depMethod === "ask_cpa");
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-05", description: "Client lunch", categoryId: meals, amount: 45.51 } });
  console.log("meal: 50% deductible → $22.76 (cents-rounded):", r.body.expense.deductible === 22.76);
  const meal = r.body.expense;
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-06", description: "Cell phone", categoryId: phone, amount: 80, businessUsePct: 60, vendor: "Verizon" } });
  console.log("phone: 60% business use → $48.00 deductible:", r.body.expense.deductible === 48);
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-07", description: "Groceries", categoryId: personal, amount: 30 } });
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-08", description: "x", categoryId: meals, amount: 5, depMethod: "bonus" } });
  console.log("depreciation fields refused on a non-depreciation category:", r.status === 400);
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2099-01-01", description: "x", categoryId: meals, amount: 5 } });
  const rr = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-08", description: "x", categoryId: meals, amount: -5 } });
  const rk = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-08", description: "x", categoryId: meals, amount: 5, receiptKey: "../../etc/passwd" } });
  console.log("future date / negative amount / bad receipt reference refused:", r.status === 400 && rr.status === 400 && rk.status === 400);
  r = await call({ action: "saveExpense", expense: { accountId: 2, id: meal.id, date: "2026-04-05", description: "Client lunch (Bo)", categoryId: meals, amount: 50 } });
  console.log("editing an expense works and is audited:", r.body.expense.description === "Client lunch (Bo)" && r.body.expense.deductible === 25 && audits("expense.updated") === 1);

  console.log("\n=== Summary (Schedule C + Form 4562) ===");
  r = await call({ action: "listExpenses", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  const s = r.body.summary;
  console.log("totals: spent $22,460, deductible $73 (25 + 48), capital $22,300, not deductible $87:",
    s.totals.amount === 22460 && s.totals.deductible === 73 && s.totals.capital === 22300 && s.totals.nonDeductible === 87);
  console.log("by Schedule C line: 24b meals $25, 25 utilities $48:",
    s.byLine.find(l => l.line === "24b").deductible === 25 && s.byLine.find(l => l.line === "25").deductible === 48 && !s.byLine.some(l => l.line === "13"));
  const a2 = s.assets.find(a => a.description === "Embroidery machine #2");
  console.log("asset register: 2 machines, business basis 90% of $9,800 = $8,820:", s.assets.length === 2 && a2.businessBasis === 8820 && a2.method === "Ask CPA");

  console.log("\n=== Deleting ===");
  r = await call({ action: "deleteExpenseCategory", categoryId: meals });
  console.log("category in use can't be deleted:", r.status === 400 && /used by 1 expense/.test(r.body.message));
  r = await call({ action: "deleteExpense", expenseId: meal.id });
  console.log("expense deleted (soft, audited) and dropped from totals:", r.status === 200 && audits("expense.deleted") === 1 &&
    (await call({ action: "listExpenses", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body.summary.totals.deductible === 48 &&
    d1.q("SELECT deletedAt FROM expenses WHERE id=?", meal.id)[0].deletedAt !== null);
  r = await call({ action: "deleteExpenseCategory", categoryId: meals });
  console.log("…a category is still in use by a deleted expense (kept for the record):", r.status === 400);
  r = await call({ action: "deleteExpenseCategory", categoryId: softId });
  console.log("unused category deleted (audited):", r.status === 200 && !r.body.categories.some(c => c.id === softId) && audits("expense_category.deleted") === 1);
  let fkBlocked = false; try { d1._raw.exec(`PRAGMA foreign_keys=ON; DELETE FROM expense_categories WHERE id=${machines}`); } catch (_) { fkBlocked = true; }
  console.log("database also refuses deleting a used category (FK RESTRICT):", fkBlocked);

  console.log("\n=== Closed months ===");
  await call({ action: "closePeriod", month: "2026-04" });
  const phoneExp = (await call({ action: "listExpenses", dateFrom: "2026-04-06", dateTo: "2026-04-06" })).body.expenses[0];
  r = await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-20", description: "Thread", categoryId: byName("Supplies (thread, stabilizer, needles)").id, amount: 40 } });
  const e1 = await call({ action: "saveExpense", expense: { accountId: 2, id: phoneExp.id, date: "2026-05-01", description: "Cell phone", categoryId: phone, amount: 80 } });
  const e2 = await call({ action: "deleteExpense", expenseId: phoneExp.id });
  const e3 = await call({ action: "saveExpense", expense: { accountId: 2, id: m1.id, date: "2026-04-01", description: "Embroidery machine #1", categoryId: machines, amount: 12500 } });
  console.log("adding into / editing out of / deleting from / moving into a closed month → 409:", r.status === 409 && e1.status === 409 && e2.status === 409 && e3.status === 409);
  await call({ action: "reopenPeriod", month: "2026-04" });

  console.log("\n=== Accountant export ===");
  r = await call({ action: "getAccountantExport", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  const rows = r.body.expenses, sm = (k) => Math.round(r.body.summary.reduce((a, m) => a + m[k] * 100, 0)) / 100;
  const phoneRow = rows.find(x => x.description === "Cell phone");
  console.log("expenses rows with Schedule C line, deductible amount, 4562 facts; deleted ones flagged:",
    rows.length === 5 && phoneRow.scheduleCLine === "25" && phoneRow.scheduleCLabel === "Utilities" && phoneRow.deductible === 48 &&
    rows.find(x => x.description === "Embroidery machine #1").method === "Section 179" && rows.find(x => x.description === "Client lunch (Bo)").status === "deleted");
  console.log("monthly summary: deductible expenses $48, capital purchases $22,300:", sm("expensesDeductible") === 48 && sm("capitalPurchases") === 22300);

  console.log("\n=== receipt.js (private bucket) ===");
  const rc = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "let _admin = true; const requireAdmin = async () => _admin ? null : jsonResponse({status:'error', message:'no'}, 401);\n" +
    "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
    strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/api/receipt.js")) +
    "\nreturn { post: onRequestPost, get: onRequestGet, setAdmin: (v) => { _admin = v; } };")();
  const store = new Map();
  const renv = { RECEIPTS: { put: async (k, b, o) => { store.set(k, { b, o }); }, get: async (k) => store.has(k) ? { body: store.get(k).b } : null },
    STRIPE_SECRET_KEY: "sk_test_x" };
  const upReq = (type, bytes, host = "admin.example.com") => ({ url: `https://${host}/api/receipt?name=Receipt%20%231.pdf`,
    headers: { get: (h) => ({ "content-type": type, "content-length": String(bytes.length) })[h.toLowerCase()] || null },
    arrayBuffer: async () => new Uint8Array(bytes).buffer, body: null });
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n");
  let res = await rc.post({ request: upReq("application/pdf", pdf), env: renv });
  let j = JSON.parse(await res.text());
  console.log("PDF receipt stored privately under a server-made key:", res.status === 200 && /^receipts\/\d{4}\/[a-z0-9]{32}\.pdf$/.test(j.key) && store.has(j.key) && j.name === "Receipt 1.pdf");
  const key = j.key;
  res = await rc.post({ request: upReq("application/pdf", Buffer.from("<html>not a pdf")), env: renv });
  console.log("fake PDF (wrong bytes) refused:", res.status === 415);
  res = await rc.post({ request: upReq("text/html", Buffer.from("<html>")), env: renv });
  console.log("other file types refused:", res.status === 400);
  res = await rc.post({ request: upReq("application/pdf", Buffer.alloc(11 * 1024 * 1024)), env: renv });
  console.log("over 10 MB refused:", res.status === 400 && /too large/.test(JSON.parse(await res.text()).message));
  rc.setAdmin(false);
  res = await rc.post({ request: upReq("application/pdf", pdf), env: renv });
  console.log("not logged in → refused:", res.status === 401);
  rc.setAdmin(true);
  const viewReq = (k) => ({ url: "https://admin.example.com/api/receipt", headers: { get: (h) => h.toLowerCase() === "content-type" ? "application/json" : null },
    json: async () => ({ key: k }) });
  res = await rc.post({ request: viewReq("receipts/../../secret"), env: renv });
  console.log("view link refused for a bad key:", res.status === 400);
  res = await rc.post({ request: viewReq(key), env: renv });
  const link = JSON.parse(await res.text()).url;
  console.log("logged-in POST returns a signed 60-second link:", res.status === 200 && /^\/api\/receipt\?key=.+&exp=\d+&sig=[0-9a-f]{64}$/.test(link));
  const getReq = (path, host = "admin.example.com") => ({ url: `https://${host}${path}`, headers: { get: () => null } });
  res = await rc.get({ request: getReq(link), env: renv });
  console.log("link opens the PDF, private and uncached:", res.status === 200 && res.headers.get("Content-Type") === "application/pdf" &&
    res.headers.get("Cache-Control") === "private, no-store" && res.headers.get("X-Content-Type-Options") === "nosniff");
  res = await rc.get({ request: getReq(link.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64))), env: renv });
  const expired = link.replace(/exp=\d+/, "exp=" + (Math.floor(Date.now() / 1000) - 5));
  const res2 = await rc.get({ request: getReq(expired), env: renv });
  const res3 = await rc.get({ request: getReq(link, "league101.example.com"), env: renv });
  console.log("tampered signature / expired link / storefront host → 404:", res.status === 404 && res2.status === 404 && res3.status === 404);

  console.log("\n=== Admin Expenses screen (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const catsNow = (await call({ action: "listExpenseCategories" })).body;
  const listNow = (await call({ action: "listExpenses", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).body;
  listNow.expenses[0].description = "<img src=x onerror=alert(1)>";
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(w){ w.fetch = async (u, init) => { const b = init && init.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const data = b.action === "listExpenseCategories" ? catsNow : b.action === "listExpenses" ? listNow : { status: "error", message: "n/a" };
      return { ok: true, status: 200, json: async () => data }; }; } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  const app = w.document.getElementById("app");
  await w.renderExpenses(app);
  w.document.getElementById("expYear").value = "2026";
  await w.expLoad_();
  const html = app.innerHTML;
  console.log("Expenses is in the Finance nav group:", /label: "Finance"[\s\S]*?\["expenses"/.test(adminJs));
  console.log("form has Date, Description, Category + ⚙, Amount, Vendor, Business use %, Receipt (image/PDF):",
    ["expDate", "expDesc", "expCat", "expCatManage", "expAmount", "expVendor", "expBiz", "expReceipt"].every(id => w.document.getElementById(id)) &&
    /application\/pdf/.test(w.document.getElementById("expReceipt").getAttribute("accept")));
  const sel = w.document.getElementById("expCat");
  sel.value = String(machines); sel.dispatchEvent(new w.Event("change"));
  console.log("choosing a depreciation category shows placed-in-service + method:", w.document.getElementById("expDepFields").style.display === "block");
  sel.value = String(phone); sel.dispatchEvent(new w.Event("change"));
  console.log("…and hides them for an ordinary category:", w.document.getElementById("expDepFields").style.display === "none");
  console.log("list + totals render; customer-typed text escaped:", /Total spent/.test(html) && /Embroidery machine #2/.test(html) && !/<img src=x/.test(html) && /&lt;img src=x/.test(html));
  w.document.getElementById("expCatManage").click();
  const modal = w.document.body.lastElementChild;
  const inUse = modal.querySelector(`[data-del="${machines}"]`), unused = modal.querySelector(`[data-del="${byName("Advertising").id}"]`);
  console.log("category manager: Delete disabled for used categories, enabled for unused:", !!inUse && inUse.disabled && !!unused && !unused.disabled);
})().catch(e => { console.log("test40 crashed:", false); console.error(e); process.exit(1); });
