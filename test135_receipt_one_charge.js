const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// One stock receipt = one charge (2026-10). A Receive order writes a stock row per blank / color / size, plus
// an R&D / testing expense and a personal-items owner draw when it has them — but the card or bank statement
// shows ONE charge. The Account viewer and Reconcile now show it as one line (with the parts behind an
// expander), Match… ticks all its records at once, and auto-match matches the whole receipt to one statement
// line. Receives made before receiptGroup existed group by what they share. Real db.js / orders.js on sql.js;
// the two screens in jsdom against that API.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank, receiveBlanks, getAccountRegister, getReconciliationData, autoMatchStatement, listAccounts };")();
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
  const card = d1.q("SELECT id FROM accounts WHERE name = 'Credit card'")[0].id;
  d1._raw.run("UPDATE accounts SET openingDate='2026-01-01', openingBalanceCents=0");
  const mk = async (name, sizes) => (await lib.createBlank(d1, { name, productType: "shirt", colors: [{ color: "Navy", images: [], sizes: sizes.map(s => ({ size: s, purchasePrice: 0, quantity: 0 })) }] })).id;
  const tee = await mk("Gildan 64000", ["S", "M"]), polo = await mk("Polo", ["L"]);
  const supplies = d1.q("SELECT id FROM expense_categories WHERE name LIKE 'Supplies%' LIMIT 1")[0].id;

  // Receipt A: 3 sizes over 2 blanks + $18 R&D + $6.50 personal = $89.50, on the card.
  let r = await call({ action: "receiveBlankOrder", groups: [{ blankId: tee, lines: [{ color: "Navy", size: "S", qty: 4, total: 14 }, { color: "Navy", size: "M", qty: 6, total: 21 }] }, { blankId: polo, lines: [{ color: "Navy", size: "L", qty: 3, total: 30 }] }],
    receivedAt: "2026-03-10", accountId: card, vendor: "SanMar", vendorRef: "SM-100", rdAmount: 18, rdCategoryId: supplies, personalAmount: 6.5, extraCost: 0 });
  ok("(setup) a Receive order of $89.50: 3 sizes, R&D and personal", r.status === 200 && r.body.total === 89.5);
  // Receipt B: one size only — stays a plain line.
  await call({ action: "receiveBlankOrder", groups: [{ blankId: tee, lines: [{ color: "Navy", size: "S", qty: 2, total: 8 }] }], receivedAt: "2026-03-12", accountId: card, vendor: "SanMar", vendorRef: "SM-101", extraCost: 0 });
  // Receipt C: an older receive with no receiptGroup (made before 0059) — two sizes written moments apart.
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 1, unitCost: 5 }, { color: "Navy", size: "M", qty: 1, unitCost: 5 }], vendor: "S&S", vendorRef: "OLD-1", receivedAt: "2026-03-14", accountId: card });
  d1._raw.run("UPDATE inventory_movements SET receiptGroup = NULL WHERE vendorRef = 'OLD-1'");
  // Receipt D: an older SanMar invoice received in two sittings 6 minutes apart (a color added to the blank in
  // between), each with its own copy of the PDF, plus its R&D part — no receiptGroup on any of it.
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 3, unitCost: 4 }, { color: "Navy", size: "M", qty: 2, unitCost: 4 }], vendor: "SanMar", vendorRef: "SO-200", receivedAt: "2026-03-20", accountId: card, receiptKey: "receipts/2026/" + "a".repeat(32) + ".pdf", receiptName: "a.pdf" });
  await lib.receiveBlanks(d1, { blankId: polo, lines: [{ color: "Navy", size: "L", qty: 1, unitCost: 10 }], vendor: "SanMar", vendorRef: "SO-200", receivedAt: "2026-03-20", accountId: card, receiptKey: "receipts/2026/" + "b".repeat(32) + ".pdf", receiptName: "b.pdf" });
  d1._raw.run("UPDATE inventory_movements SET receiptGroup = NULL WHERE vendorRef = 'SO-200'");
  d1._raw.run("UPDATE inventory_movements SET createdAt = '2026-09-27T18:41:18.000Z' WHERE vendorRef = 'SO-200' AND size = 'L'");
  await call({ action: "saveExpense", expense: { date: "2026-03-20", description: "R&D / testing — SanMar #SO-200", categoryId: supplies, amount: 6, accountId: card } });
  // Receipt E: two receives with NO invoice # the same day, minutes apart — still two receipts.
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 1, unitCost: 4 }, { color: "Navy", size: "M", qty: 1, unitCost: 4 }], vendor: "Walmart", vendorRef: "", receivedAt: "2026-03-22", accountId: card });
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 1, unitCost: 5 }, { color: "Navy", size: "M", qty: 1, unitCost: 5 }], vendor: "Walmart", vendorRef: "", receivedAt: "2026-03-22", accountId: card });
  d1._raw.run("UPDATE inventory_movements SET receiptGroup = NULL WHERE vendor = 'Walmart'");
  d1._raw.run("UPDATE inventory_movements SET createdAt = '2026-09-27T19:00:00.000Z' WHERE vendor = 'Walmart' AND unitCostCents = 500");
  // An unrelated expense the same day as receipt A, entered separately.
  await call({ action: "saveExpense", expense: { date: "2026-03-10", description: "Bobbins", categoryId: supplies, amount: 7, accountId: card } });

  console.log("=== The Account viewer ===");
  const reg = await lib.getAccountRegister(d1, card, "2026-03-01", "2026-03-31");
  const rows = reg.rows, blanks = rows.filter(x => x.category === "Blanks");
  const a = blanks.find(x => /SM-100/.test(x.description));
  ok("receipt A is ONE line for the whole charge — every size, its R&D and its personal part", a && a.amount === -89.5 && a.parts.length === 5 && /^Blanks — SanMar #SM-100 \(5 items\)$/.test(a.description));
  ok("…its parts say what each was", a.parts.filter(p => /^Gildan 64000 · Navy [SM] ×\d+$|^Polo · Navy L ×3$/.test(p.description)).length === 3 &&
    a.parts.some(p => /R&D/.test(p.description) && p.amount === -18) && a.parts.some(p => p.amount === -6.5));
  ok("…an unrelated expense the same day stays its own line", rows.some(x => x.category === "Expense" && x.description === "Bobbins" && x.amount === -7));
  const b = blanks.find(x => /SM-101/.test(x.description) || (x.parts && x.parts.some(p => /SM-101/.test(p.description))));
  ok("a one-size receipt stays a plain line", blanks.some(x => !x.parts && x.amount === -8));
  ok("an older receive (no receipt id) is grouped by what its rows share", blanks.some(x => /S&S #OLD-1 \(2 items\)/.test(x.description) && x.amount === -10));
  ok("an older invoice received in two sittings (each with its own copy of the PDF) is ONE line, with its R&D part found by its wording",
    blanks.some(x => /SanMar #SO-200 \(4 items\)/.test(x.description) && x.amount === -36 && x.parts.some(p => /R&D/.test(p.description))) &&
    !rows.some(x => x.category === "Expense" && /SO-200/.test(x.description)));
  ok("two receives with no invoice # entered minutes apart stay two lines", blanks.filter(x => /Walmart/.test(x.description)).length === 2);
  ok("the running balance still adds up row by row, and ends on the account's balance", rows.slice(0, -1).every((x, i) => Math.abs(x.balance - rows[i + 1].balance - x.amount) < 0.0001) &&
    Math.abs(rows[0].balance - (await lib.listAccounts(d1, "2026-03-31")).find(x => x.id === card).balance) < 0.0001);
  ok("the receipt button of the combined line works on the purchase (a stock row)", a.src === "blanks" && a.srcId > 0);

  console.log("\n=== Reconcile ===");
  await call({ action: "importStatement", accountId: card, lines: [{ date: "2026-03-11", description: "SANMAR 100", amount: -89.5 }, { date: "2026-03-15", description: "S&S OLD", amount: -10 }] });
  let rec = await lib.getReconciliationData(d1, card, "2026-03");
  ok("auto-match matched receipt A's whole charge (5 records) to its one statement line", (() => { const l = rec.lines.find(x => x.description === "SANMAR 100"); return l && l.status === "matched" && l.matched.length === 1 && l.matched[0].keys.length === 5; })());
  ok("…and the older receive's two sizes to its line", rec.lines.find(x => x.description === "S&S OLD").status === "matched");
  ok("in the books but not on the statement: each receipt and the expense one line each", rec.unmatchedBook.filter(x => x.label === "Bobbins").length === 1 &&
    rec.unmatchedBook.filter(x => /SO-200/.test(x.label)).length === 1 && rec.unmatchedBook.find(x => /SO-200/.test(x.label)).keys.length === 4 &&
    rec.unmatchedBook.filter(x => x.keys.some(k => k.startsWith("blanks:"))).length === 4);   // SM-101, SO-200, and the two Walmart receives
  // Undo A's match, then match it by hand: the candidate list shows it as one entry.
  const lineA = rec.lines.find(x => x.description === "SANMAR 100");
  await call({ action: "unmatchStatementLine", lineId: lineA.id });
  rec = await lib.getReconciliationData(d1, card, "2026-03");
  const candA = rec.candidates.find(x => x.keys.length === 5);
  ok("Match… offers receipt A as one entry for $89.50 with its parts", candA && candA.amount === -89.5 && candA.parts.length === 5 && /SM-100/.test(candA.label));

  console.log("\n=== The screens ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async (u, init) => { if (!String(u).includes("/api/orders")) return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; const body = JSON.parse(init.body); sent.push(body); const x = await call(body); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const app = d.getElementById("app");
  // The Match… window for line A: the purchase is one checkbox; ticking it sends all 5 records.
  let acted = null;
  w.rcMatchModal_(rec, rec.lines.find(x => x.id === lineA.id), async (body) => { acted = body; });
  const box = [...d.querySelectorAll('input[type="checkbox"]')].find(x => x.value.split(",").length === 5);
  ok("in the Match… window the purchase is one checkbox, its parts behind an expander", box && box.closest("label").querySelector("details.receipt-parts") &&
    box.closest("label").querySelectorAll(".receipt-part").length === 5);
  box.checked = true; box.dispatchEvent(new w.Event("change"));
  ok("…ticking it adds up to the line", /✓/.test(d.getElementById("rcmSum").textContent));
  d.getElementById("rcmOk").click();
  await new Promise(res => setTimeout(res, 20));
  ok("…and Match sends every one of its records", acted && acted.action === "matchStatementLine" && acted.keys.length === 5);
  // The Account viewer screen.
  await w.renderAccountViewer(app);
  for (let i = 0; i < 100 && !d.querySelector("#avList tbody tr"); i++) await new Promise(res => setTimeout(res, 10));
  d.getElementById("avAccount").value = String(card); d.getElementById("avFrom").value = "2026-03-01"; d.getElementById("avTo").value = "2026-03-31";
  await w.avSearch_();
  const trs = [...d.querySelectorAll("#avList tbody tr")];
  const aRow = trs.find(t => /SM-100/.test(t.textContent));
  ok("the Account viewer shows receipt A as one row with an expander listing its 5 parts", aRow && aRow.querySelector("details.receipt-parts") && aRow.querySelectorAll(".receipt-part").length === 5 && /−\$89\.50/.test(aRow.textContent));
  ok("…and only real rows are in its table (the parts aren't rows)", trs.length === rows.length);

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test135 crashed: false"); process.exit(1); });
