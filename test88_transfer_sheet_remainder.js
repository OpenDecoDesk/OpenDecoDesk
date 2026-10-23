const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Receive a transfer sheet: the sheet is split by percentage into the rows (stock), a WRITTEN OFF part (an
// expense) and a PERSONAL part (an owner draw) — both default to 0 and can be used together. The three must add up
// to 100%; each non-zero part needs a description. The cost recorded on the inventory plus the other two parts
// always adds back up to the sheet total.
// Part 1: real SQL + real db.js + real orders.js admin API. Part 2: the form, in jsdom with the real admin.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer, listTransfers, getTransferMovements, transferSheetShares };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
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
  const A = await lib.createTransfer(d1, { name: "Lockup" }), B = await lib.createTransfer(d1, { name: "Capital" });
  const supplies = d1.q("SELECT id FROM expense_categories WHERE name LIKE 'Supplies%' LIMIT 1")[0].id;
  const acct = d1.q("SELECT id FROM accounts WHERE active=1 ORDER BY id LIMIT 1")[0].id;
  const invCents = () => d1.q("SELECT COALESCE(SUM(qtyDelta*unitCostCents),0) c FROM transfer_movements WHERE kind='purchase' AND voidedAt IS NULL")[0].c;
  const expenses = () => d1.q("SELECT description, amountCents, categoryId, accountId, paidPersonally FROM expenses ORDER BY id");
  const draws = () => d1.q("SELECT amountCents, kind, note, accountId FROM owner_transactions ORDER BY id");
  const movementCount = () => d1.q("SELECT count(*) n FROM transfer_movements")[0].n;
  const base = { action: "receiveTransferSheet", receivedAt: "2026-09-10", vendorRef: "INV-1", accountId: acct };

  console.log("=== Rows + written off + personal must add up to 100% of the sheet ===");
  let r = await call({ ...base, total: 100, rows: [{ transferId: A, count: 6, pctOfSheet: 60 }] });
  console.log("rows at 60% with nothing else assigned are refused:", r.status === 400 && /Only 60%/.test(r.body.message) && /40% is left over/.test(r.body.message));
  console.log("…and nothing was recorded (no movements, no expense, no draw):", movementCount() === 0 && expenses().length === 0 && draws().length === 0);
  r = await call({ ...base, total: 100, rows: [{ transferId: A, count: 6, pctOfSheet: 70 }, { transferId: B, count: 4, pctOfSheet: 50 }] });
  console.log("rows over 100% are refused:", r.status === 400 && /120%/.test(r.body.message) && /more than the whole sheet/.test(r.body.message) && movementCount() === 0);
  r = await call({ ...base, total: 100, rows: [{ transferId: A, count: 6, pctOfSheet: 70 }], writeoff: { pct: 20, description: "x", categoryId: supplies }, personal: { pct: 20, description: "y" } });
  console.log("rows + written off + personal over 100% are refused:", r.status === 400 && /110%/.test(r.body.message) && movementCount() === 0);
  r = await call({ ...base, total: 100, rows: [{ transferId: A, count: 6, pctOfSheet: 60 }], writeoff: { pct: 10, description: "x", categoryId: supplies } });
  console.log("rows 60% + written off 10% = 70% is refused (30% unaccounted for):", r.status === 400 && /Only 70%/.test(r.body.message) && movementCount() === 0 && expenses().length === 0);
  r = await call({ ...base, total: 30, rows: [{ transferId: A, count: 10, pctOfSheet: 60 }, { transferId: B, count: 5, pctOfSheet: 40 }] });
  console.log("rows at exactly 100% save as before (both extra boxes default to 0):", r.status === 200 && invCents() === 3000 && r.body.writeoff === null && r.body.personal === null && expenses().length === 0 && draws().length === 0);
  r = await call({ ...base, total: 90, rows: [{ transferId: A, count: 3, pctOfSheet: 33.3 }, { transferId: B, count: 3, pctOfSheet: 33.3 }, { transferId: A, count: 3, pctOfSheet: 33.4 }] });
  console.log("33.3 + 33.3 + 33.4 counts as 100% (typed percentages get a little slack):", r.status === 200 && invCents() === 3000 + 9000);
  r = await call({ ...base, total: 10, rows: [{ transferId: A, count: 2, pctOfSheet: 100 }], writeoff: { pct: 0, description: "", categoryId: 0 }, personal: { pct: 0 } });
  console.log("explicit 0% boxes are fine (nothing recorded for them):", r.status === 200 && r.body.writeoff === null && r.body.personal === null);
  const before = invCents();

  console.log("\n=== Written off (an expense) ===");
  const lastMove = d1.q("SELECT COALESCE(MAX(id),0) m FROM transfer_movements")[0].m;
  r = await call({ ...base, total: 100.01, rows: [{ transferId: A, count: 7, pctOfSheet: 70 }], writeoff: { pct: 30, description: "test prints and scrap", categoryId: supplies } });
  const exp = expenses().at(-1);
  console.log("saves:", r.status === 200 && r.body.writeoff && r.body.writeoff.pct === 30 && r.body.personal === null);
  console.log("rows take 70% and the write-off 30%, to the cent ($70.01 + $30.00 = $100.01):", invCents() - before === 7001 && exp.amountCents === 3000);
  console.log("the expense carries the description, the chosen category and the paid-from account:", /test prints and scrap/.test(exp.description) && /INV-1/.test(exp.description) && exp.categoryId === supplies && exp.accountId === acct && !exp.paidPersonally);
  const perUnit = d1.q("SELECT qtyDelta q, unitCostCents c FROM transfer_movements WHERE id > ? AND kind='purchase'", lastMove);
  console.log("unit costs come from the 70% ($70.01 over 7 pieces ≈ $10.00 each, not $14.29 from spreading the whole $100.01):",
    perUnit.reduce((a, x) => a + x.q, 0) === 7 && perUnit.every(x => x.c === 1000 || x.c === 1001));

  console.log("\n=== Personal use (an owner draw) ===");
  r = await call({ ...base, total: 50, rows: [{ transferId: B, count: 5, pctOfSheet: 80 }], personal: { pct: 20, description: "my own shirts" } });
  const dr = draws().at(-1);
  console.log("saves; the personal part is an owner draw from the paid-from account:", r.status === 200 && dr.kind === "draw" && dr.amountCents === 1000 && dr.accountId === acct && /my own shirts/.test(dr.note) && r.body.writeoff === null);
  let nDraws = draws().length, nExp = expenses().length;
  r = await call({ ...base, total: 50, paidPersonally: true, accountId: undefined, rows: [{ transferId: B, count: 5, pctOfSheet: 80 }], personal: { pct: 20, description: "my own shirts" } });
  console.log("paid with personal funds, the personal part isn't recorded at all:", r.status === 200 && r.body.personal.notRecorded === true && draws().length === nDraws && expenses().length === nExp);
  r = await call({ ...base, total: 50, paidPersonally: true, accountId: undefined, rows: [{ transferId: B, count: 5, pctOfSheet: 80 }], writeoff: { pct: 20, description: "scrap", categoryId: supplies } });
  console.log("paid with personal funds, a written-off part is still a business expense (owner paid):", r.status === 200 && expenses().length === nExp + 1 && expenses().at(-1).paidPersonally === 1);

  console.log("\n=== Both at the same time ===");
  nDraws = draws().length; nExp = expenses().length;
  const mBefore = invCents();
  r = await call({ ...base, total: 200, rows: [{ transferId: A, count: 10, pctOfSheet: 50 }, { transferId: B, count: 5, pctOfSheet: 25 }],
    writeoff: { pct: 15, description: "misprints", categoryId: supplies }, personal: { pct: 10, description: "gifts for family" } });
  const e2 = expenses().at(-1), d2 = draws().at(-1);
  console.log("saves with rows 50% + 25%, written off 15%, personal 10%:", r.status === 200 && r.body.writeoff.amount === 30 && r.body.personal.amount === 20);
  console.log("$150.00 into stock, a $30.00 expense and a $20.00 draw — adding back to the $200.00 sheet exactly:",
    invCents() - mBefore === 15000 && e2.amountCents === 3000 && d2.amountCents === 2000 && expenses().length === nExp + 1 && draws().length === nDraws + 1);
  const aud = JSON.parse(d1.q("SELECT detail FROM audit_log WHERE action='transfer.received' ORDER BY id DESC LIMIT 1")[0].detail);
  console.log("the audit entry records both parts (pct, amount, description):", aud.writeoff.pct === 15 && aud.writeoff.amount === 30 && aud.writeoff.description === "misprints" &&
    aud.personal.pct === 10 && aud.personal.amount === 20 && aud.personal.description === "gifts for family");
  const mark = d1.q("SELECT COALESCE(MAX(id),0) m FROM transfer_movements")[0].m;
  r = await call({ ...base, total: 100.01, rows: [{ transferId: A, count: 3, pctOfSheet: 33.3 }], writeoff: { pct: 33.3, description: "a", categoryId: supplies }, personal: { pct: 33.4, description: "b" } });
  const e3 = expenses().at(-1), d3 = draws().at(-1);
  const stock3 = d1.q("SELECT COALESCE(SUM(qtyDelta*unitCostCents),0) c FROM transfer_movements WHERE id > ? AND kind='purchase'", mark)[0].c;
  console.log("an awkward split ($100.01 over 33.3/33.3/33.4) still adds back up to the cent:", r.status === 200 && stock3 + e3.amountCents + d3.amountCents === 10001);

  console.log("\n=== What each part needs ===");
  const mc = movementCount();
  const rows60 = [{ transferId: A, count: 6, pctOfSheet: 60 }];
  r = await call({ ...base, total: 100, rows: rows60, writeoff: { pct: 40, description: "  ", categoryId: supplies } });
  console.log("a written-off part needs a description:", r.status === 400 && /Describe what was written off/.test(r.body.message));
  r = await call({ ...base, total: 100, rows: rows60, personal: { pct: 40, description: "" } });
  console.log("a personal part needs a description:", r.status === 400 && /Describe the personal part/.test(r.body.message));
  r = await call({ ...base, total: 100, rows: rows60, writeoff: { pct: 40, description: "scrap", categoryId: 999999 } });
  console.log("a written-off part needs a real expense category:", r.status === 400 && /category/.test(r.body.message));
  r = await call({ ...base, accountId: undefined, total: 100, rows: rows60, writeoff: { pct: 40, description: "scrap", categoryId: supplies } });
  console.log("it needs to know what the sheet was paid from:", r.status === 400 && /paid from/.test(r.body.message));
  console.log("every refusal above left no trace:", movementCount() === mc);
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-09','t','test')");
  r = await call({ ...base, total: 100, rows: rows60, writeoff: { pct: 40, description: "scrap", categoryId: supplies } });
  console.log("a closed month still refuses the whole thing:", r.status === 409 && movementCount() === mc);
  d1._raw.run("DELETE FROM closed_periods");

  console.log("\n=== The split itself ===");
  const sh = lib.transferSheetShares([33.3, 33.3], 33.3, 0.1, 10000);
  console.log("cents always add back up to the total:", sh.rowCents.reduce((a, b) => a + b, 0) + sh.writeoffCents + sh.personalCents === 10000);
  const odd = lib.transferSheetShares([70], 30, 0, 10001);
  console.log("an odd cent lands somewhere, never lost ($100.01 at 70/30):", odd.rowCents[0] + odd.writeoffCents + odd.personalCents === 10001 && odd.rowCents[0] === 7001);

  // ---------------------------------------------------------------- the form
  console.log("\n=== The form (jsdom, real admin.js) ===");
  const adminJs = read("public/admin.js");
  const calls = [];
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        calls.push(body);
        const ok = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
        if (body.action === "listAccounts") return ok({ accounts: [{ id: 3, name: "Visa", type: "credit_card", active: true }, { id: 1, name: "Checking", type: "checking", active: true }] });
        if (body.action === "listExpenseCategories") return ok({ categories: [{ id: 5, name: "Office" }, { id: 9, name: "Supplies" }] });
        if (body.action === "receiveTransferSheet") return ok({ ids: [1], transfers: [] });
        return ok({});
      };
    } });
  const w = dom.window, tick = (ms = 40) => new Promise(res => setTimeout(res, ms));
  await tick(150); await w.loadAdminScript(); w.eval('adminKey = "cookie";');
  const doc = w.document;
  const set = (el, v, ev = "input") => { el.value = v; el.dispatchEvent(new w.Event(ev, { bubbles: true })); };
  w.showReceiveTransferModal_([{ id: 1, name: "Lockup" }, { id: 2, name: "Capital" }], () => {});
  await tick(80);
  const q = (s) => doc.querySelector(s), row = () => doc.querySelector(".trRow");
  const save = q("#trSave");
  console.log("Save starts disabled (nothing entered) with no error shown:", save.disabled && q("#trErr").textContent === "");
  console.log("both extra boxes start at 0, with their detail fields hidden:", q("#trWoPct").value === "0" && q("#trPePct").value === "0" &&
    q("#trWoDescWrap").style.display === "none" && q("#trWoCatWrap").style.display === "none" && q("#trPeDescWrap").style.display === "none");
  set(q("#trTotal"), "100"); set(row().querySelector(".trCount"), "10"); set(row().querySelector(".trPct"), "100");
  console.log("one row at 100% → Save enabled and the line shows ✓:", !save.disabled && /= 100% of the sheet ✓/.test(q("#trSum").textContent));
  set(row().querySelector(".trPct"), "60");
  console.log("60% → Save disabled, and it says 40% is still to assign:", save.disabled && /40% still to assign/.test(q("#trSum").textContent) && /Only 60%/.test(q("#trErr").textContent));
  set(q("#trWoPct"), "25");
  console.log("written off 25% → the dollar amount ($25.00), category and description appear; still short of 100%:", q("#trWoAmt").textContent === "$25.00" &&
    q("#trWoCatWrap").style.display !== "none" && q("#trWoDescWrap").style.display !== "none" && q("#trWoCat").value === "9" && save.disabled && /15% still to assign/.test(q("#trSum").textContent));
  set(q("#trPePct"), "15");
  console.log("personal 15% → shows $15.00 and the personal description; the line reads 60 + 25 + 15 = 100% ✓:", q("#trPeAmt").textContent === "$15.00" &&
    q("#trPeDescWrap").style.display !== "none" && /Rows 60% \+ written off 25% \+ personal 15% = 100% of the sheet ✓/.test(q("#trSum").textContent));
  console.log("…but Save stays disabled until both are described:", save.disabled && /Describe what was written off/.test(q("#trErr").textContent));
  set(q("#trWoDesc"), "test prints");
  console.log("…the personal description is still needed:", save.disabled && /Describe what the personal part/.test(q("#trErr").textContent));
  set(q("#trPeDesc"), "my own shirts");
  console.log("with everything described (and the card preselected as Paid from), Save is enabled:", !save.disabled && q("#trPaid").value === "3");
  set(q("#trPaid"), "", "change");
  console.log("clearing Paid from disables Save (the extra parts need an account):", save.disabled && /paid from/.test(q("#trErr").textContent));
  set(q("#trPaid"), "3", "change");
  set(q("#trPePct"), "30");
  console.log("rows 60 + 25 + 30 = 115% → Save disabled, the line turns red and says over 100%:", save.disabled && /over 100%/.test(q("#trSum").textContent) && /more than 100%/.test(q("#trErr").textContent));
  set(q("#trPePct"), "15");
  calls.length = 0; save.click(); await tick(120);
  const sent = calls.find(c => c.action === "receiveTransferSheet");
  console.log("saving sends the rows plus both parts:", !!sent && sent.rows[0].pctOfSheet === 60 && sent.writeoff.pct === 25 && sent.writeoff.description === "test prints" && sent.writeoff.categoryId === 9 &&
    sent.personal.pct === 15 && sent.personal.description === "my own shirts" && sent.accountId === 3 && !("remainder" in sent));
  w.close();
  w.showReceiveTransferModal_ && 0;
})().catch((e) => { console.log("test88 crashed:", false); console.error(e); process.exit(1); });
