const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Color as a dimension of a blank (migrations/0037): one blank holds many colors × sizes, stock/COGS
// key on (blankId, color, size), products link each color explicitly, a blank color carries images
// the storefront prefers, and a Merge tool folds old single-color blanks into one.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct, createBlank, updateBlank, getAllBlanks, deleteBlank,
  setBlankLink, getBlankLinks, receiveBlanks, writeOffBlanks, getBlankMovements, voidInventoryMovement, getInventoryValuation,
  consumeBlanksForOrder, setFulfillmentStage, getOrderById, setOrderPaid, mergeBlanks, getPublicCatalogData, planBlankCatchUp };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const audit = () => {};\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  // A legacy single-color blank seeded BEFORE the migrations (the real-world starting point).
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, visible, createdAt, updatedAt)
      VALUES ('tee','acme','shirt','Tee','sized',NULL,'{"L":20}',1,'t','t');
    INSERT INTO blanks (id, name, brand, color, productType, createdAt, updatedAt) VALUES (1,'Gildan 5000','Gildan','Red','shirt','t','t');
    INSERT INTO blank_sizes (blankId, size, purchasePrice, quantity) VALUES (1,'L',4.00,8);
    INSERT INTO product_blank_links (orgId, productId, productSize, blankId, blankSize) VALUES ('acme','tee','L',1,'L');
  `);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p && p.then && p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const stock = (blankId, color, size) => { const r = d1.q("SELECT quantity, purchasePriceCents FROM blank_sizes WHERE blankId=? AND color=? AND size=?", blankId, color, size); return r[0] || null; };

  console.log("=== Migration backfill: an existing blank becomes a one-color blank ===");
  ok("blank_colors has the backfilled Red row", d1.q("SELECT color FROM blank_colors WHERE blankId=1")[0].color === "Red");
  ok("blank_sizes carries the color", (stock(1, "Red", "L") || {}).quantity === 8);
  ok("the link carries productColor '' and blankColor Red", (() => { const l = d1.q("SELECT productColor, blankColor FROM product_blank_links WHERE blankId=1")[0]; return l.productColor === "" && l.blankColor === "Red"; })());
  const b1 = (await lib.getAllBlanks(d1)).find(b => b.id === 1);
  ok("getAllBlanks groups sizes under the color dimension", b1.colors.length === 1 && b1.colors[0].color === "Red" && b1.colors[0].sizes[0].quantity === 8);

  console.log("\n=== One blank, many colors: receive + weighted-average per color ===");
  const id = (await lib.createBlank(d1, { name: "Jerzees 63374", brand: "Jerzees", productType: "shirt", colors: [
    { color: "Navy", images: ["img/navy.jpg"], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] },
    { color: "Heather", images: [], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] },
  ] })).id;
  await lib.receiveBlanks(d1, { blankId: id, lines: [{ color: "Navy", size: "L", qty: 10, unitCost: 5 }, { color: "Heather", size: "L", qty: 4, unitCost: 6 }], receivedAt: "2026-07-01" });
  await lib.receiveBlanks(d1, { blankId: id, lines: [{ color: "Navy", size: "L", qty: 10, unitCost: 7 }], receivedAt: "2026-07-02" });
  ok("Navy/L is 20 @ $6.00 average; Heather/L is 4 @ $6.00 — tracked independently",
    stock(id, "Navy", "L").quantity === 20 && stock(id, "Navy", "L").purchasePriceCents === 600 &&
    stock(id, "Heather", "L").quantity === 4 && stock(id, "Heather", "L").purchasePriceCents === 600);

  console.log("\n=== Explicit color links + consume resolves config.garmentColor ===");
  await lib.createProduct(d1, "acme", { productId: "rag", type: "shirt", name: "Raglan", pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Heather"], reorderQr: "none", locations: [] });
  await lib.setBlankLink(d1, "acme", "rag", "Navy", "L", id, "Navy", "L");
  await lib.setBlankLink(d1, "acme", "rag", "Heather", "L", id, "Heather", "L");
  await lib.insertOrder(d1, { orderId: "N1", orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-07-05T00:00:00Z" },
    [{ productId: "rag", name: "Raglan", type: "shirt", size: "L", qty: 1, unitPrice: 18, config: { garmentColor: "Navy", locations: [] } }]);
  await lib.setOrderPaid(d1, "N1", null, "paid");
  await lib.setFulfillmentStage(d1, "N1", "manufactured");
  ok("the Navy line consumes a Navy/L blank at $6 → COGS $6 (not Heather)", near((await lib.getOrderById(d1, "N1")).items[0].cogs, 6) &&
    stock(id, "Navy", "L").quantity === 19 && stock(id, "Heather", "L").quantity === 4);

  console.log("\n=== Write off + void, per color ===");
  await lib.writeOffBlanks(d1, { blankId: id, color: "Heather", size: "L", qty: 1, note: "Damaged", occurredAt: "2026-07-06" });
  ok("write-off hits Heather only", stock(id, "Heather", "L").quantity === 3 && stock(id, "Navy", "L").quantity === 19);
  const recv = d1.q("SELECT id FROM inventory_movements WHERE blankId=? AND color='Navy' AND kind='purchase' ORDER BY id", id)[0].id;
  await lib.voidInventoryMovement(d1, recv, "duplicate");
  ok("voiding the first Navy receive recomputes Navy stock + average from history", stock(id, "Navy", "L").quantity === 9 && stock(id, "Navy", "L").purchasePriceCents === 700);
  ok("movement history shows color per row", (await lib.getBlankMovements(d1, id)).some(m => m.color === "Navy") && (await lib.getBlankMovements(d1, id)).some(m => m.color === "Heather"));

  console.log("\n=== Valuation is per (blank, color, size) ===");
  const val = (await lib.getInventoryValuation(d1, "2099-01-01T00:00:00Z")).rows.filter(r => r.blankId === id);
  ok("valuation lists Navy and Heather as separate rows with color", val.length === 2 && val.every(r => r.color) && val.find(r => r.color === "Navy").qty === 9);

  console.log("\n=== Blank color images reach the catalog (shown after the product's own — test96) ===");
  const cat = await lib.getPublicCatalogData(d1);
  const rag = cat.orgs.acme.products.find(p => p.productId === "rag" || p.id === "rag");
  ok("the product carries colorImages resolved from its linked blank colors", rag.colorImages && Array.isArray(rag.colorImages.Navy) && rag.colorImages.Navy[0] === "img/navy.jpg");
  ok("a color whose blank has no images is absent from colorImages", !(rag.colorImages.Heather && rag.colorImages.Heather.length));

  console.log("\n=== Color images can be tagged with a location (migrations/0041), tolerant of bare strings ===");
  const taggedId = (await lib.createBlank(d1, { name: "Tagged tee", productType: "shirt", colors: [
    { color: "Royal", images: [{ url: "img/front.jpg", locationId: 7 }, "img/plain.jpg"], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] } ] })).id;
  const tagged = (await lib.getAllBlanks(d1)).find(b => b.id === taggedId).colors[0];
  ok("a {url, locationId} image round-trips with its tag", tagged.images[0].url === "img/front.jpg" && tagged.images[0].locationId === 7);
  ok("a legacy bare-string image parses to {url, locationId:null}", tagged.images[1].url === "img/plain.jpg" && tagged.images[1].locationId === null);

  console.log("\n=== Merge blanks: fold the old single-color blank into the multi-color one ===");
  // Blank 1 is the legacy Red Gildan with 8 @ $4 and a link from product 'tee'. Merge it into `id`.
  const before = stock(1, "Red", "L");
  const r = await call({ action: "mergeBlanks", targetId: id, sourceIds: [1] });
  ok("merge succeeds via the admin API", r.status === 200 && r.body.merged === 1);
  ok("the source blank is gone", !(await lib.getAllBlanks(d1)).some(b => b.id === 1));
  ok("its Red stock now lives on the target (same qty/cost, recomputed from history)", stock(id, "Red", "L").quantity === before.quantity && stock(id, "Red", "L").purchasePriceCents === 400);
  ok("the target now has Navy + Heather + Red colors", (await lib.getAllBlanks(d1)).find(b => b.id === id).colors.map(c => c.color).sort().join(",") === "Heather,Navy,Red");
  ok("the tee's link was re-pointed to the target blank", d1.q("SELECT blankId FROM product_blank_links WHERE orgId='acme' AND productId='tee'")[0].blankId === id);

  console.log("\n=== Legacy single-color callers still work (omitted color → blank's scalar) ===");
  const legacyId = (await lib.createBlank(d1, { name: "Old cap", color: "Black", productType: "cap" }, [{ size: "OSFA", purchasePrice: 3, quantity: 5 }])).id;
  ok("createBlank's legacy (fields.color + sizes) path stocks under that color", stock(legacyId, "Black", "OSFA").quantity === 5);
  await lib.receiveBlanks(d1, { blankId: legacyId, lines: [{ size: "OSFA", qty: 5, unitCost: 3 }], receivedAt: "2026-07-07" });
  ok("receiveBlanks with no color defaults to the blank's scalar color", stock(legacyId, "Black", "OSFA").quantity === 10);

  console.log("\n=== admin + storefront wiring ===");
  const a = read("public/admin.js"), h = read("public/index.html"), catSrc = read("functions/api/catalog.js");
  ok("blank form edits colors × sizes + per-color images", /id="blkColors"/.test(a) && /id="blkAddColor"/.test(a) &&
    /data-img-add=/.test(a) && /colors: cleanColors/.test(a) && /uploadImage\(file, "blanks"\)/.test(a));
  ok("a color can be duplicated (same sizes & prices) and get the standard XS–4XL run",
    /data-color-dup=/.test(a) && /data-size-std=/.test(a) && /Standard sizes \(XS–4XL\)/.test(a) &&
    /SIZE_ORDER\.forEach\(sz => \{ if \(!have\.has\(sz\)\)/.test(a));
  ok("blanks list shows colors and search covers them", /Colors &amp; sizes/.test(a) && /\.\.\.\(b\.colors \|\| \[\]\)\.map\(c => c\.color\)/.test(a));
  ok("a Merge button + modal call mergeBlanks", /onclick="blankMerge/.test(a) && /function showMergeBlanksModal_/.test(a) && /action: "mergeBlanks"/.test(a));
  ok("receive order and write-off send color; the per-blank Receive window is gone (Receive order is the one way in)", /color: q\.dataset\.color \|\| ""/.test(a) && /color: sel\.color \|\| ""/.test(a) &&
    !/function showReceiveBlanksModal/.test(a) && !/onclick="blankReceive\(/.test(a));
  ok("blank-links map (productColor, productSize) → blank color+size", /productColor: pc, productSize: size, blankId: Number\(k\.blankId\), blankColor/.test(a) && /class="bl-color"/.test(a));
  ok("blank-links has an Auto-map-from-first-row button that fills every row by name", /id="blAutoMap"/.test(a) && /Auto-map all from the first row/.test(a) && /section\.querySelectorAll\("\.bl-blank"\)\.forEach/.test(a));
  ok("storefront shows blank color images (after the product's own) and swaps them per garment color", /function productImages_/.test(h) && /colorImages/.test(h) && /function cfgImages_/.test(h) && /id="cfgimg-/.test(h));
  ok("catalog passes colorImages through", /out\.colorImages = ci/.test(catSrc));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
