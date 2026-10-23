const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Accounts & money → Blanks & transfers bought → "Change account…" (2026-10): when the wrong "Paid from" was chosen on a
// received receipt, ONE change moves everything that receipt wrote — the stock rows for every blank (or transfer sheet)
// on it, its R&D / written-off expense and its personal-use owner draw — and nothing else. Real db.js and orders.js on
// sql.js; the window in jsdom, talking to that real API.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank, receiveBlanks, createTransfer, listAccounts, listStockPurchases, getMoneySummary, getInventoryValuation, getReceiptRecords, voidInventoryMovement };")();
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

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const acct = (n) => d1.q("SELECT id FROM accounts WHERE name = ?", n)[0].id;
  const checking = acct("Business checking"), card = acct("Credit card"), venmo = acct("Venmo");
  d1._raw.run("UPDATE accounts SET openingDate='2026-01-01', openingBalanceCents=100000");
  const bal = async (id, asOf = "2026-12-31") => (await lib.listAccounts(d1, asOf)).find(a => a.id === id).balance;
  const mk = async (name, sizes) => (await lib.createBlank(d1, { name, productType: "shirt", colors: [{ color: "Navy", images: [], sizes: sizes.map(s => ({ size: s, purchasePrice: 0, quantity: 0 })) }] })).id;
  const tee = await mk("Gildan 64000", ["S", "M"]), polo = await mk("Polo", ["L"]);
  const supplies = d1.q("SELECT id FROM expense_categories WHERE name LIKE 'Supplies%' LIMIT 1")[0].id;
  const purchase = (id) => d1.q("SELECT * FROM inventory_movements WHERE id = ?", id)[0];
  const stockRows = () => d1.q("SELECT id, accountId, paidPersonally FROM inventory_movements WHERE kind='purchase' AND voidedAt IS NULL ORDER BY id");

  // ---- Receipt R1: two blank types, an R&D part, a personal part — all paid from checking (WRONG: it was the card).
  const r1 = await call({ action: "receiveBlankOrder", groups: [{ blankId: tee, lines: [{ color: "Navy", size: "S", qty: 4, total: 14 }, { color: "Navy", size: "M", qty: 6, total: 21 }] }, { blankId: polo, lines: [{ color: "Navy", size: "L", qty: 3, total: 30 }] }],
    receivedAt: "2026-03-10", accountId: checking, vendor: "SanMar", vendorRef: "SM-100", rdAmount: 18, rdCategoryId: supplies, personalAmount: 6.5, extraCost: 0 });
  ok("(setup) a Receive order: 3 sizes over 2 blanks + $18 R&D + $6.50 personal = $89.50", r1.status === 200 && r1.body.total === 89.5 && r1.body.parts.rd === 18 && r1.body.parts.personal === 6.5);
  // Another receipt with the same vendor and date but a different invoice — must never be touched.
  const r2 = await call({ action: "receiveBlankOrder", groups: [{ blankId: tee, lines: [{ color: "Navy", size: "S", qty: 2, total: 8 }] }], receivedAt: "2026-03-10", accountId: checking, vendor: "SanMar", vendorRef: "SM-101", extraCost: 0 });
  ok("(setup) a second receive from the same vendor, same day, other invoice", r2.status === 200);
  const rows1 = d1.q("SELECT id FROM inventory_movements WHERE vendorRef = 'SM-100' ORDER BY id").map(x => x.id);
  const other = d1.q("SELECT id FROM inventory_movements WHERE vendorRef = 'SM-101'").map(x => x.id);
  const group = purchase(rows1[0]).receiptGroup;
  ok("every record of the receive carries the same receiptGroup — all stock rows, the R&D expense and the personal draw", /^[0-9a-f]{24}$/.test(group) &&
    rows1.length === 3 && rows1.every(id => purchase(id).receiptGroup === group) && d1.q("SELECT count(*) n FROM expenses WHERE receiptGroup = ?", group)[0].n === 1 && d1.q("SELECT count(*) n FROM owner_transactions WHERE receiptGroup = ?", group)[0].n === 1 &&
    purchase(other[0]).receiptGroup && purchase(other[0]).receiptGroup !== group);

  const valuation = JSON.stringify((await lib.getInventoryValuation(d1, "2026-12-31")));
  const sizes = JSON.stringify(d1.q("SELECT blankId, size, quantity, purchasePriceCents FROM blank_sizes ORDER BY blankId, size"));
  const beforeChecking = await bal(checking), beforeCard = await bal(card);

  console.log("\n=== Preview ===");
  const pv = await call({ action: "previewReceiptAccountChange", kind: "blanks", movementId: rows1[1] });   // any row of the receipt
  ok("the preview lists every record: 3 stock lines, the R&D expense, the personal draw", pv.status === 200 && pv.body.receipt.stock.length === 3 && pv.body.receipt.expense && pv.body.receipt.expense.amount === 18 && pv.body.receipt.draw && pv.body.receipt.draw.amount === 6.5 && pv.body.receipt.via === "group");
  ok("…and not the other invoice's", !pv.body.receipt.stock.some(s => other.includes(s.id)));
  ok("…the stock part is the blanks' total ($65) and it is currently paid from checking", pv.body.receipt.stockTotal === 65 && pv.body.receipt.accountId === checking && pv.body.receipt.paidPersonally === false);
  ok("nothing stands in the way", pv.body.blockers.length === 0);
  ok("the Accounts page row now lists the extra parts of a linked receipt", (await lib.listStockPurchases(d1, "2026-01-01", "2026-12-31")).find(x => x.vendorRef === "SM-100").extras.map(e => e.label).join() === "R&D / written-off expense,Personal-use draw");

  console.log("\n=== One change moves the whole receipt ===");
  const mv = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: card, expectStockIds: rows1 });
  ok("the change is accepted and reports what moved", mv.status === 200 && mv.body.moved.stock === 3 && mv.body.moved.expense === 1 && mv.body.moved.draw === 1);
  ok("all three stock rows are on the card now", rows1.every(id => purchase(id).accountId === card && purchase(id).paidPersonally === 0));
  ok("the R&D expense and the personal draw are on the card too", d1.q("SELECT accountId, paidPersonally FROM expenses WHERE receiptGroup = ?", group).every(e => e.accountId === card && e.paidPersonally === 0) &&
    d1.q("SELECT accountId FROM owner_transactions WHERE receiptGroup = ?", group)[0].accountId === card);
  const afterChecking = await bal(checking), afterCard = await bal(card);
  ok("checking got the whole $89.50 back; the card paid it", Math.abs(afterChecking - beforeChecking - 89.5) < 0.001 && Math.abs(beforeCard - afterCard - 89.5) < 0.001);
  ok("the other invoice stayed on checking", other.every(id => purchase(id).accountId === checking));
  ok("stock, average cost and inventory value did not change", JSON.stringify(await lib.getInventoryValuation(d1, "2026-12-31")) === valuation && JSON.stringify(d1.q("SELECT blankId, size, quantity, purchasePriceCents FROM blank_sizes ORDER BY blankId, size")) === sizes);
  const audit = d1.q("SELECT detail FROM audit_log WHERE action = 'inventory.receipt_account_changed'");
  const ad = audit.length && JSON.parse(audit[0].detail);
  ok("it is audited, with every record and the account it came from and went to", audit.length === 1 && ad.stockIds.length === 3 && ad.expenseId && ad.drawId && ad.from.accountId === checking && ad.to.accountId === card && ad.total === 89.5);
  ok("moving it to the account it is already on is refused", (await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: card })).status === 400);

  console.log("\n=== Refusals change nothing ===");
  const snapshot = () => JSON.stringify([stockRows(), d1.q("SELECT id, accountId, paidPersonally FROM expenses ORDER BY id"), d1.q("SELECT id, accountId FROM owner_transactions ORDER BY id")]);
  const snap = snapshot();
  d1._raw.run("UPDATE accounts SET active = 0 WHERE id = ?", [venmo]);
  ok("an inactive account is refused", (await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: venmo })).status === 400);
  d1._raw.run("UPDATE accounts SET active = 1 WHERE id = ?", [venmo]);
  ok("a stale window (the receipt changed since it was opened) is refused", (await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: checking, expectStockIds: [rows1[0]] })).status === 409);
  ok("an unknown purchase is 404; an unknown kind is 400", (await call({ action: "setReceiptAccount", kind: "blanks", movementId: 99999, accountId: checking })).status === 404 && (await call({ action: "setReceiptAccount", kind: "orders", movementId: rows1[0], accountId: checking })).status === 400);
  // A statement line matched to one of the rows.
  d1._raw.run("INSERT INTO statement_lines (accountId, lineDate, description, amountCents, fingerprint, importBatch, importedAt) VALUES (?, '2026-03-11', 'SANMAR', -1400, 'fp1', 'b', 't')", [card]);
  const lineId = d1.q("SELECT id FROM statement_lines")[0].id;
  d1._raw.run("INSERT INTO statement_matches (lineId, src, srcId, matchedAt, auto) VALUES (?, 'blanks', ?, 't', 0)", [lineId, rows1[0]]);
  const m1 = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: checking });
  ok("a receipt matched to a bank-statement line is refused — unmatch it first", m1.status === 409 && /Unmatch/.test(m1.body.message));
  d1._raw.run("DELETE FROM statement_matches");
  // A reconciled month on the account it would move to.
  d1._raw.run("INSERT INTO reconciliations (accountId, month, statementEndingBalanceCents, bookBalanceCents, reconciledAt, reconciledBy) VALUES (?, '2026-03', 0, 0, 't', 'x')", [checking]);
  const m2 = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: checking });
  ok("a reconciled month on the account it would move TO is refused", m2.status === 409 && /reconciled/.test(m2.body.message));
  d1._raw.run("DELETE FROM reconciliations");
  d1._raw.run("INSERT INTO reconciliations (accountId, month, statementEndingBalanceCents, bookBalanceCents, reconciledAt, reconciledBy) VALUES (?, '2026-03', 0, 0, 't', 'x')", [card]);
  const m3 = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: checking });
  ok("…and on the account it moves FROM", m3.status === 409 && /reconciled/.test(m3.body.message));
  d1._raw.run("DELETE FROM reconciliations");
  // Personal funds while a personal draw exists.
  const m4 = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], paidPersonally: true });
  ok("Personal funds is refused while the receipt has a 'Personal items' owner draw", m4.status === 409 && /Personal items/.test(m4.body.message));
  // The audit log being unavailable.
  d1._raw.exec("ALTER TABLE audit_log RENAME TO audit_log_x");
  const m5 = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: checking });
  d1._raw.exec("ALTER TABLE audit_log_x RENAME TO audit_log");
  ok("if the audit entry can't be written, nothing is changed (503)", m5.status === 503);
  ok("…and after all those refusals nothing moved", snapshot() === snap);
  // A closed month.
  const closed = await call({ action: "closePeriod", month: "2026-03" });
  const m6 = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[0], accountId: checking });
  ok("a closed tax month is refused", closed.status === 200 && m6.status === 409 && snapshot() === snap);
  await call({ action: "reopenPeriod", month: "2026-03" });

  console.log("\n=== Back again, and Personal funds ===");
  const back = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[2], accountId: checking, expectStockIds: rows1 });
  ok("with nothing in the way it moves back to checking", back.status === 200 && Math.abs(await bal(checking) - beforeChecking) < 0.001);
  // A receipt with no personal draw can be marked as paid with personal funds.
  const r3 = await call({ action: "receiveBlankOrder", groups: [{ blankId: tee, lines: [{ color: "Navy", size: "M", qty: 1, total: 5 }] }], receivedAt: "2026-03-12", accountId: checking, vendor: "Walmart", vendorRef: "W-1", rdAmount: 4, rdCategoryId: supplies, extraCost: 0 });
  const r3row = d1.q("SELECT id FROM inventory_movements WHERE vendorRef = 'W-1'")[0].id;
  const ownerBefore = (await lib.getMoneySummary(d1, "2026-01-01", "2026-12-31")).owner.paidPersonally;
  const pers = await call({ action: "setReceiptAccount", kind: "blanks", movementId: r3row, paidPersonally: true });
  ok("to Personal funds: the stock row and the expense become personally paid, with no account", pers.status === 200 && purchase(r3row).accountId === null && purchase(r3row).paidPersonally === 1 &&
    d1.q("SELECT accountId, paidPersonally FROM expenses WHERE description LIKE 'R&D%Walmart%'")[0].paidPersonally === 1);
  ok("…and it now counts as money the owner put in ($9)", Math.abs((await lib.getMoneySummary(d1, "2026-01-01", "2026-12-31")).owner.paidPersonally - ownerBefore - 9) < 0.001);
  const fromPers = await call({ action: "setReceiptAccount", kind: "blanks", movementId: r3row, accountId: venmo });
  ok("from Personal funds to an account works", fromPers.status === 200 && purchase(r3row).accountId === venmo && purchase(r3row).paidPersonally === 0);

  console.log("\n=== A receipt recorded before records were linked ===");
  d1._raw.run("UPDATE inventory_movements SET receiptGroup = NULL WHERE vendorRef IN ('SM-100', 'SM-101')");
  d1._raw.run("UPDATE expenses SET receiptGroup = NULL");
  d1._raw.run("UPDATE owner_transactions SET receiptGroup = NULL");
  const old = await call({ action: "previewReceiptAccountChange", kind: "blanks", movementId: rows1[1] });
  ok("it is found by what it shares — same day, vendor, invoice, payer — and listed in full", old.status === 200 && old.body.receipt.via === "match" && old.body.receipt.stock.length === 3 && old.body.receipt.expense && old.body.receipt.draw && !old.body.receipt.stock.some(s => other.includes(s.id)));
  // Same vendor/invoice/day but written long before: a separate receive.
  d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, vendor, vendorRef, note, occurredAt, createdAt, accountId, paidPersonally) SELECT blankId, blankName, color, size, 1, 100, kind, vendor, vendorRef, note, occurredAt, '2026-03-10T08:00:00.000Z', accountId, paidPersonally FROM inventory_movements WHERE id = ?", [rows1[0]]);
  const old2 = await call({ action: "previewReceiptAccountChange", kind: "blanks", movementId: rows1[1] });
  ok("a row with the same details written hours earlier is another purchase, not part of it", old2.body.receipt.stock.length === 3);
  const oldMove = await call({ action: "setReceiptAccount", kind: "blanks", movementId: rows1[1], accountId: card, expectStockIds: rows1 });
  ok("…and it moves as a whole (stock rows, expense, draw)", oldMove.status === 200 && rows1.every(id => purchase(id).accountId === card) && d1.q("SELECT accountId FROM expenses WHERE description LIKE 'R&D%SanMar%'")[0].accountId === card &&
    d1.q("SELECT accountId FROM owner_transactions WHERE note LIKE 'Personal items%SanMar%'")[0].accountId === card);

  console.log("\n=== Transfer sheets ===");
  const crest = (await lib.createTransfer(d1, { name: "Crest" })).id || 1;
  const ts = await call({ action: "receiveTransferSheet", receivedAt: "2026-03-15", vendor: "Ninja", vendorRef: "NT-1", accountId: checking, total: 100, rows: [{ transferId: crest, count: 10, pctOfSheet: 80 }],
    writeoff: { pct: 12, description: "spoiled", categoryId: supplies }, personal: { pct: 8, description: "mine" } });
  ok("(setup) a transfer sheet: 80% stock, 12% written off, 8% personal", ts.status === 200 && ts.body.writeoff.expenseId && ts.body.personal.ownerEntryId);
  const tmv = d1.q("SELECT id, receiptGroup FROM transfer_movements WHERE kind = 'purchase'")[0];
  const tpv = await call({ action: "previewReceiptAccountChange", kind: "transfers", movementId: tmv.id });
  ok("the sheet's receipt lists its stock, the written-off expense and the personal draw", tpv.status === 200 && tpv.body.receipt.stock.length === 1 && tpv.body.receipt.expense.amount === 12 && tpv.body.receipt.draw.amount === 8 && tmv.receiptGroup);
  const bc = await bal(checking), bcard = await bal(card);
  const tm = await call({ action: "setReceiptAccount", kind: "transfers", movementId: tmv.id, accountId: card });
  ok("one change moves the sheet's stock, its expense and its draw — $100 off the card, back onto checking", tm.status === 200 && Math.abs(await bal(checking) - bc - 100) < 0.001 && Math.abs(bcard - await bal(card) - 100) < 0.001 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action = 'transfer.receipt_account_changed'")[0].n === 1);

  console.log("\n=== A purchase with no account at all ===");
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 1, unitCost: 2 }], vendor: "Old vendor", vendorRef: "OLD-1", receivedAt: "2026-03-20" });
  const unassigned = async () => (await lib.getMoneySummary(d1, "2026-01-01", "2026-12-31")).unassigned;
  const u0 = await unassigned();
  const oldId = d1.q("SELECT id FROM inventory_movements WHERE vendorRef = 'OLD-1'")[0].id;
  const fix = await call({ action: "setReceiptAccount", kind: "blanks", movementId: oldId, accountId: checking });
  ok("a receive with no account can be given one — the 'no account yet' count drops", u0 >= 1 && fix.status === 200 && await unassigned() === u0 - 1);

  console.log("\n=== Role gate, schema, voided ===");
  const src = read("functions/api/orders.js");
  const mgr = src.match(/const MANAGER_ACTIONS = \[[\s\S]*?\];/)[0], staff = src.match(/const STAFF_ACTIONS = \[[\s\S]*?\];/)[0];
  ok("both actions need the manager role", /"previewReceiptAccountChange"/.test(mgr) && /"setReceiptAccount"/.test(mgr) && !/ReceiptAccount/.test(staff));
  await lib.voidInventoryMovement(d1, oldId, "dup");
  ok("a voided purchase can't be used to find a receipt", (await call({ action: "previewReceiptAccountChange", kind: "blanks", movementId: oldId })).status === 404);

  d1._raw.run("DELETE FROM inventory_movements WHERE createdAt = '2026-03-10T08:00:00.000Z'");   // the stray hours-earlier row from above
  console.log("\n=== The window ===");
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
  const app = w.document.getElementById("app");
  await w.renderMoney(app);
  w.document.getElementById("mnYear").innerHTML = "<option>2026</option>";
  await w.mnLoad_();
  const box = w.document.getElementById("mnStock");
  ok("every purchase row has a Change account… button", box.querySelectorAll(".mn-stock-acct").length === box.querySelectorAll("tbody tr").length && box.querySelectorAll(".mn-stock-acct").length >= 3);
  const row = [...box.querySelectorAll("tbody tr")].find(t => /SM-100/.test(t.textContent));
  row.querySelector(".mn-stock-acct").click();
  await new Promise(res => setTimeout(res, 150));
  const modal = w.document.querySelector("#rcaBody");
  ok("the window lists everything that will move — stock lines, the expense, the draw — and the invoice", modal && /SM-100/.test(modal.textContent) && /3 stock lines/.test(modal.textContent) && /Expense: R&D/.test(modal.textContent) && /Owner draw: Personal items/.test(modal.textContent));
  const save = modal.querySelector("#rcaSave"), sel = modal.querySelector("#rcaAccount");
  ok("it starts on the current account with Move disabled", save.disabled === true && Number(sel.value) === card);
  sel.value = String(checking); sel.dispatchEvent(new w.Event("change"));
  await new Promise(res => setTimeout(res, 150));
  ok("choosing another account enables Move (nothing in the way)", save.disabled === false && modal.querySelector("#rcaProblem").textContent === "");
  const before2 = rows1.map(id => purchase(id).accountId).join();
  save.click();
  await new Promise(res => setTimeout(res, 250));
  const sent = calls.filter(c => c.action === "setReceiptAccount").pop();
  ok("Move sends the choice with the stock ids the window showed", sent && sent.kind === "blanks" && sent.accountId === checking && sent.expectStockIds.length === 3);
  ok("…the whole receipt moved and the window closed", rows1.every(id => purchase(id).accountId === checking) && before2 !== rows1.map(id => purchase(id).accountId).join() && !w.document.querySelector("#rcaBody"));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test134 crashed: false"); process.exit(1); });
