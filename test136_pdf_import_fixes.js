const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Import from PDF fixes, from receipts that came out wrong on a real install:
//  1. An invoice line whose color / size the blank didn't have was LEFT OUT of Receive order (and when
//     it was then received separately, its shipping was counted a second time). Now the missing color / size is added to the blank (addBlankSizes)
//     and the line is received; lines are placed by color AND size (several colors of one blank share OSFA),
//     and lines of one blank arrive as one box.
//  2. SanMar's INVOICE layout ("Invoice Number: INV-…", "Sales Order: SO-…", a two-line "Item / Number"
//     heading, quantities like "3.00") couldn't be read at all.
// Real db.js / orders.js on sql.js for the server; the admin's parser and forms in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank, getAllBlanks };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body, role = "admin") => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async (u, init) => { if (!String(u).includes("/api/orders")) return { ok: true, status: 200, json: async () => ({ status: "admin" }) };
      const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');

  console.log("=== SanMar's invoice layout ===");
  const inv = JSON.parse(read("testlib/fixtures/pdf-sanmar-invoice-layout.json")).items;
  const p = w.parseVendorOrderPdf_(inv);
  ok("it's read: vendor SanMar, the SO number (what other SanMar receipts use), the invoice date", p.vendor === "SanMar" && p.vendorRef === "SO-100200301" && p.receivedAt === "2026-10-07");
  ok("…the two-line Item / Number heading is found, so each line is its own item: 4 colors of the SC100 cap", p.groups.length === 4 &&
    p.groups.map(g => g.color).join() === "Black,Khaki,Royal,White" && p.groups.every(g => /Five-Panel Cap/.test(g.description) && g.lines.length === 1 && g.lines[0].size === "OSFA"));
  ok("…quantities printed like 3.00 are whole pieces, and the lines add up to the invoice's $55.00", p.groups.map(g => g.lines[0].qty).join() === "3,5,10,2" &&
    Math.abs(p.groups.reduce((t, g) => t + g.lines[0].qty * g.lines[0].unitCost, 0) - 55) < 0.001 && p.extraCost === 0);

  console.log("\n=== A color / size the blank doesn't have ===");
  const cap = (await lib.createBlank(d1, { name: "Port Authority Pro Mesh Cap", productType: "cap", colors: [{ color: "Navy", images: [], sizes: [{ size: "OSFA", purchasePrice: 4.23, quantity: 3 }] }] })).id;
  // A worker may add them: they may receive the order too.
  let r = await call({ action: "addBlankSizes", blankId: cap, sizes: [{ color: "Royal", size: "OSFA" }, { color: "Navy", size: "OSFA" }] }, "staff");
  const sizes = d1.q(`SELECT color, size, quantity, purchasePriceCents FROM blank_sizes WHERE blankId=${cap} ORDER BY color`);
  ok("the missing color is added with nothing in stock and no cost; what was there is untouched", r.status === 200 && r.body.added === 1 &&
    JSON.stringify(sizes) === JSON.stringify([{ color: "Navy", size: "OSFA", quantity: 3, purchasePriceCents: 423 }, { color: "Royal", size: "OSFA", quantity: 0, purchasePriceCents: 0 }]) &&
    d1.q(`SELECT count(*) n FROM blank_colors WHERE blankId=${cap} AND color='Royal'`)[0].n === 1);
  ok("…and it's audited", Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.blank_sizes_added'")[0].n) === 1);
  const blank = { sizes: [{ color: "Navy", size: "OSFA" }, { color: "Black", size: "OSFA" }], colors: [{ color: "Navy" }, { color: "Black" }] };
  let pl = w.pdfLinePlace_(blank, "navy", "One Size");
  ok("an invoice line takes the blank's own spelling of its color and size ('navy' / 'One Size' → Navy / OSFA)", pl.color === "Navy" && pl.size === "OSFA" && !pl.missing);
  pl = w.pdfLinePlace_(blank, "Royal", "OSFA");
  ok("…a color the blank doesn't have is marked to be added", pl.color === "Royal" && pl.size === "OSFA" && pl.missing);
  pl = w.pdfLinePlace_({ sizes: [{ color: "True Navy", size: "L" }] }, "Navy", "XL");
  ok("…a one-color blank keeps its one color (vendors word colors differently), adding just the size", pl.color === "True Navy" && pl.size === "XL" && pl.missing);

  console.log("\n=== Receive order places each line by color and size ===");
  const twill = (await lib.createBlank(d1, { name: "Port Authority CP86 5 Panel Cap", productType: "cap", colors: ["Black", "Khaki", "Royal", "White"].map(c => ({ color: c, images: [], sizes: [{ size: "OSFA", purchasePrice: 3.12, quantity: 0 }] })) })).id;
  const blanks = await lib.getAllBlanks(d1);
  const el = d.createElement("div"); d.body.appendChild(el);
  w.blankOrderForm_(el, { blanks, cats: [], target: () => null, onChange: () => {},
    prefill: { vendor: "SanMar", vendorRef: "SO-100200301", groups: [{ blankId: twill, lines: [{ color: "Black", size: "OSFA", qty: 3, total: 9.36 }, { color: "Khaki", size: "OSFA", qty: 5, total: 15.6 },
      { color: "Royal", size: "OSFA", qty: 10, total: 31.2 }, { color: "White", size: "OSFA", qty: 2, total: 6.24 }] }] } });
  const qtyOf = (c) => (el.querySelector(`.rcc-qty[data-color="${c}"]`) || {}).value;
  ok("four colors of one OSFA cap each land on their own row (they all used to land on the first)", qtyOf("Black") === "3" && qtyOf("Khaki") === "5" && qtyOf("Royal") === "10" && qtyOf("White") === "2");
  ok("…one box for the blank, and nothing left out", el.querySelectorAll(".rcc-group").length === 1 && el.querySelector("#rccUnmatched").textContent === "");

  console.log("\n=== The whole import, in the browser ===");
  // The Import window hands off to Receive order: the Pro Mesh cap line in Royal (not on the blank before) is
  // added and received with the rest.
  const handed = [];
  w.eval("showReceiveOrderModal = async (onDone, prefill) => { window.__handed = prefill; };");
  const missingInv = { vendor: "SanMar", vendorRef: "SO-1", receivedAt: "2026-09-08", extraCost: 0,
    groups: [{ description: "Port Authority Pro Mesh Cap", color: "Royal", sku: "", lines: [{ size: "OSFA", qty: 1, unitCost: 4.23, lineTotal: 4.23 }] },
             { description: "Port Authority CP86 5 Panel Cap", color: "Black", sku: "", lines: [{ size: "OSFA", qty: 5, unitCost: 3.12, lineTotal: 15.6 }] },
             { description: "Port Authority CP86 5 Panel Cap", color: "Navy", sku: "", lines: [{ size: "OSFA", qty: 10, unitCost: 3.12, lineTotal: 31.2 }] }] };
  w.extractPdfItems_ = async () => [];
  w.eval("extractPdfItems_ = async () => []; parseVendorOrderPdf_ = () => window.__inv;");
  w.__inv = missingInv;
  await w.showPdfImportModal_({ name: "SO-1.pdf" }, () => {});
  for (let i = 0; i < 100 && !d.getElementById("piNext"); i++) await new Promise(res => setTimeout(res, 10));
  const rowSel = (i) => d.querySelector(`.pi-blank[data-i="${i}"]`);
  rowSel(0).value = String(cap); rowSel(1).value = String(twill); rowSel(2).value = String(twill);
  d.getElementById("piNext").click();
  for (let i = 0; i < 200 && !w.__handed; i++) await new Promise(res => setTimeout(res, 10));
  const h = w.__handed;
  ok("lines of one blank are handed over as one box, each line with its color", h && h.groups.length === 2 && h.groups.find(g => g.blankId === twill).lines.map(l => l.color + " " + l.qty).join() === "Black 5,Navy 10");
  ok("the CP86 blank had no Navy: it was added, so the 10 Navy caps can be received", d1.q(`SELECT count(*) n FROM blank_sizes WHERE blankId=${twill} AND color='Navy' AND size='OSFA'`)[0].n === 1);
  ok("the Royal Pro Mesh cap goes to the blank's Royal row (added a moment ago)", h.groups.find(g => g.blankId === cap).lines[0].color === "Royal");

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test125 crashed: false"); process.exit(1); });
