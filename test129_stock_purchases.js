const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Accounts & money → "Blanks & transfers bought" (2026-10): every garment-blank and transfer-sheet
// purchase in the year, one row per receive, with what was bought, the vendor and invoice, where the
// money came from and its receipt (opened like an expense's). And transfer-sheet purchases now move the
// account they were paid from (MONEY_MOVE_SOURCES), as blank purchases always did.
// Real db.js and orders.js on sql.js; the screen in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank, receiveBlanks, createTransfer, receiveTransferSheet, voidInventoryMovement, listStockPurchases, listAccounts, getMoneySummary };")();
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
  d1._raw.run("UPDATE accounts SET openingDate='2026-01-01', openingBalanceCents=100000 WHERE id IN (1, 3)");
  const checking = 1, card = 3;
  const tee = (await lib.createBlank(d1, { name: "Gildan 64000", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "S", purchasePrice: 0, quantity: 0 }, { size: "M", purchasePrice: 0, quantity: 0 }] }] })).id;
  const before = await lib.listAccounts(d1, "2026-12-31");
  const bal = (list, id) => list.find(a => a.id === id).balance;

  // A blank order paid from checking, with its invoice; one paid personally; one entered twice and voided.
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 4, unitCost: 3.5 }, { color: "Navy", size: "M", qty: 6, unitCost: 3.5 }],
    vendor: "S&S Activewear", vendorRef: "INV-1001", receivedAt: "2026-03-02", accountId: checking, receiptKey: "receipts/2026/" + "a".repeat(32) + ".pdf", receiptName: "ss-invoice.pdf" });
  await new Promise(r => setTimeout(r, 5));
  await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "M", qty: 2, unitCost: 4 }], vendor: "Walmart", receivedAt: "2026-04-10", paidPersonally: true });
  await new Promise(r => setTimeout(r, 5));
  const dupIds = await lib.receiveBlanks(d1, { blankId: tee, lines: [{ color: "Navy", size: "S", qty: 1, unitCost: 3.5 }], vendor: "S&S Activewear", vendorRef: "INV-1001", receivedAt: "2026-03-02", accountId: checking });
  const dupRow = d1.q("SELECT id FROM inventory_movements WHERE kind='purchase' ORDER BY id DESC LIMIT 1")[0].id;
  await lib.voidInventoryMovement(d1, dupRow, "entered twice");
  // A transfer sheet, $60, split over two transfers, paid by card, with its receipt.
  const crest = await lib.createTransfer(d1, { name: "Club crest" }), qr = await lib.createTransfer(d1, { name: "Reorder QR" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: crest.id || crest, count: 20, pctOfSheet: 75 }, { transferId: qr.id || qr, count: 30, pctOfSheet: 25 }], totalCents: 6000,
    vendor: "Ninja Transfers", vendorRef: "NT-77", receivedAt: "2026-05-05", accountId: card, receiptKey: "receipts/2026/" + "b".repeat(32) + ".png", receiptName: "ninja.png" });

  console.log("=== The list ===");
  const list = await lib.listStockPurchases(d1, "2026-01-01", "2026-12-31");
  ok("one row per receive — the blank order, the personal one, the transfer sheet; the voided entry left out", list.length === 3);
  const ss = list.find(x => x.vendorRef === "INV-1001"), wm = list.find(x => x.vendor === "Walmart"), nt = list.find(x => x.vendor === "Ninja Transfers");
  ok("the blank order: what was bought by size, its total, paid from checking, with its receipt", ss && ss.kind === "blanks" && ss.items.join() === "Gildan 64000 · Navy: S×4, M×6" &&
    ss.total === 35 && ss.accountId === checking && ss.accountName === "Business checking" && ss.receiptKey.endsWith(".pdf") && ss.receiptName === "ss-invoice.pdf" && ss.date === "2026-03-02");
  ok("a purchase paid personally says so, and has no receipt", wm && wm.paidPersonally && wm.accountId == null && wm.receiptKey === "" && wm.total === 8);
  ok("the transfer sheet: each transfer and its count, the sheet's total, paid by card, with its receipt", nt && nt.kind === "transfers" && nt.items.join("|") === "Club crest ×20|Reorder QR ×30" && nt.total === 60 &&
    nt.accountId === card && nt.receiptName === "ninja.png");
  ok("newest first", list.map(x => x.date).join() === "2026-05-05,2026-04-10,2026-03-02");
  ok("only the year asked for", (await lib.listStockPurchases(d1, "2025-01-01", "2025-12-31")).length === 0);

  console.log("\n=== Balances ===");
  const after = await lib.listAccounts(d1, "2026-12-31");
  ok("the blank order came out of checking (as before)", Math.abs((bal(before, checking) - bal(after, checking)) - 35) < 0.001);
  ok("the transfer sheet now comes out of the card it was paid with (it used to move no account)", Math.abs((bal(before, card) - bal(after, card)) - 60) < 0.001);
  const sum = await lib.getMoneySummary(d1, "2026-01-01", "2026-12-31");
  ok("stock paid personally counts as money the owner put in", sum.owner.paidPersonally === 8);
  const src = dbSrc.match(/MONEY_MOVE_SOURCES = \[[\s\S]*?\n\];/)[0];
  ok("…and a transfer sheet is a movement Reconcile can match a card or bank line to", /'transfer_sheet' AS src/.test(src) && /FROM transfer_movements m WHERE m\.kind = 'purchase' AND m\.accountId IS NOT NULL AND m\.paidPersonally = 0 AND m\.voidedAt IS NULL/.test(src));

  console.log("\n=== The admin API and screen ===");
  const r = await call({ action: "listMoney", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  ok("listMoney returns the year's stock purchases", r.status === 200 && Array.isArray(r.body.stockPurchases) && r.body.stockPurchases.length === 3);
  const accountsNow = (await call({ action: "listAccounts" })).body, moneyNow = r.body;
  moneyNow.stockPurchases[0].vendor = "<img src=x onerror=alert(1)>";
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const data = b.action === "listAccounts" ? accountsNow : b.action === "listMoney" ? moneyNow : { status: "error", message: "n/a" };
      return { ok: true, status: 200, json: async () => data }; }; } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  const app = w.document.getElementById("app");
  await w.renderMoney(app);
  w.document.getElementById("mnYear").innerHTML = "<option>2026</option>";
  await w.mnLoad_();
  const box = w.document.getElementById("mnStock"), txt = (app.textContent || "").replace(/\s+/g, " ");
  ok("Accounts & money has a 'Blanks & transfers bought' section saying it's inventory, not an expense", /Blanks & transfers bought/.test(txt) && /isn't an expense: it's inventory, and becomes cost of goods sold as it's used/.test(txt));
  ok("…with the year's count and total, split blanks / transfers", /3 purchases · \$103\.00 \(blanks \$43\.00, transfers \$60\.00\)/.test(txt));
  ok("…a row per purchase: what, vendor and invoice, paid from, amount", box && box.querySelectorAll("tbody tr").length === 3 && /Gildan 64000 · Navy: S×4, M×6/.test(box.textContent) && /#INV-1001/.test(box.textContent) &&
    /Business checking/.test(box.textContent) && /Personal funds/.test(box.textContent) && /\$35\.00/.test(box.textContent));
  const btns = [...box.querySelectorAll("button")].filter(b => /Receipt/.test(b.textContent));
  let opened = "";
  w.expViewReceipt_ = (k) => { opened = k; };
  w.eval("expViewReceipt_ = (k) => { window.__opened = k; };");
  btns[0] && btns[0].click();
  ok("a receipt opens the same way an expense's does; a purchase without one says so", btns.length === 2 && /^receipts\/2026\//.test(w.__opened || "") && /no receipt/.test(box.textContent));
  ok("text from the database is escaped", !box.innerHTML.includes("<img src=x") && box.innerHTML.includes("&lt;img src=x"));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test129 crashed: false"); process.exit(1); });
