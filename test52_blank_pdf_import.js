const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Blanks -> Import from PDF. Only
// extractPdfItems_ talks to pdf.js and can't run outside a browser — everything else
// is a pure function over plain {str,x,y,page} items, tested here (via jsdom loading
// the real admin.js, same pattern test44/test45 use for client-side parsers) against
// position data captured by running pdf.js itself against 8 real supplier invoices (4 S&S, 4 SanMar) —
// testlib/fixtures/pdf-order-items.json. The layout (every x / y) is the real one; every value in it —
// prices (doubled), order / invoice / tracking numbers, the buyer's name, address, email and card, the
// SanMar product names and styles — is made up. Each sample's parsed line-item sum is checked against that
// invoice's own printed subtotal, so a drift in the parsing logic shows up as a
// concrete dollar mismatch, not just a changed snapshot.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const items = JSON.parse(read("testlib/fixtures/pdf-order-items.json"));

(async () => {
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  const qtySum = (r) => r.groups.reduce((t, g) => t + g.lines.reduce((a, l) => a + l.qty, 0), 0);
  const lineSum = (r) => Math.round(r.groups.reduce((t, g) => t + g.lines.reduce((a, l) => a + l.qty * l.unitCost, 0), 0) * 100) / 100;

  console.log("=== Each sample invoice (real layouts, made-up values): parsed totals match the invoice's own printed numbers ===");
  const expect = {
    // [vendor, invoice/order ref, receivedAt, shipping&other, groups, total pieces, line-item $ total]
    ss1: ["S&S", "910000001", "2026-06-22", 0, 9, 43, 404.26],
    ss2: ["S&S", "910000003", "2026-05-14", 0, 6, 61, 478.78],
    ss3: ["S&S", "910000005", "2026-05-14", 0, 4, 8, 82],
    ss4: ["S&S", "910000006", "2026-05-14", 0, 3, 5, 89.04],
    sm1: ["SanMar", "SO-110000007", "2026-09-08", 0, 11, 37, 447.3],
    sm2: ["SanMar", "SO-110000010", "2026-08-24", 0, 4, 21, 415.64],
    sm3: ["SanMar", "SO-110000013", "2026-04-28", 76.9, 14, 43, 319.7],
    sm4: ["SanMar", "SO-110000016", "2026-06-21", 35.2, 3, 17, 131.54],
  };
  const results = {};
  for (const [key, [vendor, ref, date, ship, groups, qty, total]] of Object.entries(expect)) {
    const r = w.parseVendorOrderPdf_(items[key]);
    results[key] = r;
    console.log(`${key}: vendor, invoice #, date, shipping all read correctly:`,
      r.vendor === vendor && r.vendorRef === ref && r.receivedAt === date && Math.round(r.extraCost * 100) / 100 === ship);
    console.log(`${key}: ${groups} candidate blanks, ${qty} pieces, $${total} matching the invoice's own subtotal:`,
      r.groups.length === groups && qtySum(r) === qty && lineSum(r) === total);
  }

  console.log("\n=== Wrapped cells reassembled correctly (not split or bled into the next/previous row) ===");
  const ss1 = results.ss1;
  const ind = ss1.groups.find(g => g.sku === "20476656");
  console.log("a description wrapping onto a line ABOVE its own row's numbers (S&S) is still whole, not merged with the row before it:",
    !!ind && ind.description === "Independent Trading Co. - Unisex Heavyweight Full-Zip Hooded Sweatshirt - IND4000Z" &&
    ss1.groups.find(g => g.sku === "09285125").description === "C2 Sport - Unisex Performance T-Shirt - 5100");
  const sm1 = results.sm1;
  const trueNavy = sm1.groups.find(g => g.color === "True Navy");
  console.log("a color wrapping across two lines with different x (SanMar's 'True'/'Navy') reassembles as one color, and its two sizes stay one blank:",
    !!trueNavy && trueNavy.description === "Demo Sport® Fine Pique Quick-Dry® Polo" &&
    JSON.stringify(trueNavy.lines.map(l => l.size).sort()) === '["L","XL"]');
  const cap = sm1.groups.find(g => g.color === "True Kelly Green");
  console.log("a color wrapping across two lines with EACH line itself having two words (SanMar's 'True Kelly'/'Green') still comes out whole:", !!cap);
  console.log("the ignored Warehouse column ('Richmond, VA') never leaks into Size:", sm1.groups.every(g => g.lines.every(l => !/Richmond|VA/.test(l.size))));
  console.log("a leading '*' (S&S's not-returnable flag) is stripped from the description, not kept as a separate near-duplicate blank:",
    results.ss2.groups.some(g => g.description === "JERZEES - Men's Dri-Power® Polo - 437R") && !results.ss2.groups.some(g => /^\*/.test(g.description)));

  console.log("\n=== A PDF with no recognizable line-item table ===");
  const bad = w.parseVendorOrderPdf_([{ str: "Not an invoice", x: 10, y: 10, page: 1 }]);
  console.log("returns a clear error and no groups, rather than guessing:", bad.groups.length === 0 && /Could not find/.test(bad.error));

  console.log("\n=== blankFieldsFromParsedGroup_: a starting name/brand/color for a new blank ===");
  const f1 = w.blankFieldsFromParsedGroup_({ description: "Richardson - Five-Panel Gramps Cap - 356", color: "Navy" });
  console.log("brand split off, color-first name, trailing internal SKU code dropped:", f1.brand === "Richardson" && f1.color === "Navy" && f1.name === "Navy Five-Panel Gramps Cap");
  const f2 = w.blankFieldsFromParsedGroup_({ description: "Port Authority® Pro Mesh Cap", color: "Royal" });
  console.log("no brand-dash in the description (SanMar) still gives a clean, ®-stripped name:", f2.brand === "" && f2.name === "Royal Port Authority Pro Mesh Cap");

  console.log("\n=== matchBlanksForImport_: SKU first, then fuzzy name/color, else leave unmatched ===");
  const blanks = [
    { id: 1, sku: "CP86-NVY", name: "Navy Five-Panel Twill Cap", brand: "Port Authority", color: "Navy" },
    { id: 2, sku: "", name: "Navy SportTek ST650 Performance Polo", brand: "SportTek", color: "Navy" },
    { id: 3, sku: "", name: "White Five-Panel Twill Cap", brand: "Port Authority", color: "White" },
  ];
  const groupsIn = [
    { description: "Five-Panel Twill Cap", color: "Navy", sku: "CP86-NVY", lines: [] },     // exact sku match
    { description: "Micropique Sport-Wick Polo", color: "Navy", sku: "", lines: [] },        // no name match at all -> unmatched
    { description: "Five-Panel Twill Cap", color: "White", sku: "", lines: [] },             // fuzzy name+color match
    { description: "Something Nobody Has", color: "Purple", sku: "", lines: [] },            // unmatched
  ];
  const matched = w.matchBlanksForImport_(groupsIn, blanks);
  console.log("exact vendor-SKU match wins even without checking the name:", matched[0].blankId === 1 && matched[0].matchedBy === "sku");
  console.log("no candidate at all (wrong color, no name overlap) is left unmatched, never a wrong guess:", matched[1].blankId === null);
  console.log("a same color + overlapping name matches by name when there's no SKU on file:", matched[2].blankId === 3 && matched[2].matchedBy === "name");
  console.log("nothing close at all stays unmatched:", matched[3].blankId === null);

  console.log("\n=== Blanks screen wiring ===");
  console.log("an Import from PDF button sits next to Receive order:", /id="blankOrderBtn"[\s\S]{0,400}id="blankImportPdfBtn"[\s\S]{0,250}Import from PDF/.test(adminJs));
  console.log("picking a file opens the PDF-import preview (showPdfImportModal_), which hands off into Receive order pre-filled:",
    /blankImportPdfFile"\).onchange[\s\S]{0,150}showPdfImportModal_/.test(adminJs) && /showReceiveOrderModal\(onDone, \{ groups/.test(adminJs));
  console.log("Receive order can upload and attach a receipt (reusing the same upload/view functions Expenses uses):",
    /uploadReceipt_\(receiptFile\)/.test(adminJs) && /body\.receiptKey = r\.key/.test(adminJs) && /onclick="expViewReceipt_\(this\.dataset\.key\)"/.test(adminJs));

  console.log("\n=== New-blank category (productType) is mappable, not hardcoded ===");
  console.log("guessBlankType_ reads the description: cap / sweatshirt / shirt fallback:",
    w.guessBlankType_({ description: "Richardson 112 Trucker Cap" }) === "cap" &&
    w.guessBlankType_({ description: "Independent Trading Co. Hooded Sweatshirt" }) === "sweatshirt" &&
    w.guessBlankType_({ description: "C2 Sport Performance T-Shirt" }) === "shirt" &&
    w.guessBlankType_({ description: "mystery item" }) === "shirt");
  console.log("the import preview has a per-row Type dropdown and no longer hardcodes productType:",
    /class="pi-type"/.test(adminJs) && /categoryOptionsHtml_\(guessBlankType_\(g\)\)/.test(adminJs) && !/productType: "shirt"/.test(adminJs) && /productType: type/.test(adminJs));
  console.log("the Type dropdown disables when a row is mapped to an existing blank:",
    /\.pi-blank"\)\.forEach\(sel => sel\.addEventListener\("change"[\s\S]{0,180}pi-type/.test(adminJs));
})();
