const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Vendor blanks (2026-10, Part A of "pricing by color"): complete blanks and per-color vendor prices from a
// vendor's product file. One pipeline — planVendorBlanks / applyVendorBlanks — matched on vendor + style
// strictly; an existing blank only gains what was ticked (never renamed, stock and average untouched); a new
// blank comes in complete (description, features, colors, sizes, per-color prices, images). The blank CSV
// import takes a `color` column (one row per style + color) and matches vendor + style strictly too. Images
// come from the vendor's bulk image download on this computer (matched by file name), or, as a fallback,
// are fetched once into the image bucket. Real db.js / orders.js / vendorImages.js on sql.js; the parser,
// image matching and review window in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, getAllBlanks, importBlanksCsv, planVendorBlanks, receiveBlanks };`)();
const fileUpload = strip(read("functions/_lib/fileUpload.js"));
const vendorImages = new Function(fileUpload + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\nreturn { copyVendorImage };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + fileUpload + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('team','team','TEAM','t','t',1);`);
  const env = { DB: d1 };
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "team" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const size = (id, color, sz) => d1.q("SELECT * FROM blank_sizes WHERE blankId=? AND color=? AND size=?", id, color, sz)[0];
  const audits = (a) => d1.q("SELECT * FROM audit_log WHERE action=?", a);

  // On file: the SanMar K8000LS (Black has 3 in stock at $12.00) and the same style number from S&S.
  const k8 = (await lib.createBlank(d1, { name: "Port Authority EZCotton Long Sleeve Polo", productType: "shirt", vendor: "SanMar", sku: "K8000LS",
    colors: ["Black", "Navy", "Oxford Heather"].map(color => ({ color, images: [], sizes: ["S", "M", "L"].map(s => ({ size: s, purchasePrice: color === "Black" && s === "M" ? 12 : 0, quantity: color === "Black" && s === "M" ? 3 : 0 })) })) })).id;
  const ssTwin = (await lib.createBlank(d1, { name: "Some S&S thing", productType: "shirt", vendor: "S&S", sku: "K8000LS", colors: [{ color: "Black", images: [], sizes: [{ size: "S", purchasePrice: 1, quantity: 0 }] }] })).id;
  await lib.createProduct(d1, "team", { productId: "polo", type: "shirt", name: "TEAM Polo", pricingMode: "sized", sizePricing: { S: 30, M: 30, L: 30 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "team", "polo", "", "M", k8, "Black", "M");
  const sanmar = (over = {}) => Object.assign({ vendor: "SanMar", style: "K8000LS", name: "Port Authority EZCotton Long Sleeve Polo", brand: "Port Authority",
    description: "A wrinkle-resistant cotton polo.", features: ["5.3-ounce", "Flat knit collar"], category: "shirt",
    colors: [{ color: "Black", hex: "#000000", images: [{ url: "https://cdnm.sanmar.com/imglib/K8000LS_black_model_front.jpg", type: "front", fileName: "K8000LS_black_model_front.jpg" }] },
             { color: "Navy", images: [] }, { color: "Oxford Heather", images: [] }, { color: "True Royal", images: [] }],
    prices: { black: { S: 15.97, M: 15.97, L: 15.97, "2XL": 16.97 }, navy: { S: 15.97, M: 15.97, L: 15.97, "2XL": 16.97 },
              oxfordheather: { S: 17.31, M: 17.31, L: 17.31, "2XL": 18.31 }, trueroyal: { S: 15.97, M: 15.97, L: 15.97, "2XL": 16.97 } } }, over);

  console.log("=== The plan ===");
  // A worker may import vendor blanks, as they may import blanks from a CSV.
  let r = await call({ action: "previewVendorBlanks", products: [sanmar()] }, { role: "staff" });
  let plan = r.body.plans[0];
  ok("matched on vendor + style: the SanMar blank, not the S&S one with the same style number", r.status === 200 && plan.action === "update" && plan.blankId === k8 && plan.otherVendors.some(b => b.id === ssTwin));
  ok("every price of the colors it has is a change (none entered yet): 3 colors × 3 sizes", plan.priceChanges === 9);
  ok("a color the blank doesn't have and the sizes its colors are missing are offered, not taken", plan.newColors === 1 && plan.newSizes === 3 &&
    plan.colors.find(c => c.vendorColor === "True Royal").onBlank === false);
  ok("the color priced differently from the rest is called out", plan.colors.find(c => c.color === "Oxford Heather").differs === true && !plan.colors.find(c => c.color === "Black").differs);
  const fewer = (await lib.planVendorBlanks(d1, [{ vendor: "S&S", style: "ZZ1", colors: [{ color: "White" }, { color: "Gold" }], prices: { white: { S: 3.72, "2XL": 4.11 }, gold: { S: 3.72 } } }]))[0];
  ok("…but a color that only comes in fewer sizes isn't", fewer.colors.every(c => !c.differs));
  ok("…and the product priced on a changing price is listed", plan.repricing.length === 1 && plan.repricing[0].productId === "polo");
  ok("the vendor's description differs from the blank's (empty)", plan.descriptionDiffers && plan.featuresDiffer);

  console.log("\n=== Applying only what was ticked ===");
  r = await call({ action: "applyVendorBlanks", products: [sanmar()], selections: [{ key: "SanMar|K8000LS|Port Authority", prices: true, colors: [], newSizes: false }], source: "SanMar file" });
  ok("the per-color vendor prices are set — Oxford Heather at its own price", r.status === 200 && size(k8, "Black", "S").vendorPriceCents === 1597 && size(k8, "Oxford Heather", "L").vendorPriceCents === 1731 && size(k8, "Navy", "M").vendorPriceCents === 1597);
  ok("…nothing unticked came in: no True Royal, no 2XL", !d1.q("SELECT 1 FROM blank_sizes WHERE blankId=? AND (color='True Royal' OR size='2XL')", k8).length);
  ok("…the name, vendor, stock and average cost are untouched", d1.q("SELECT name, vendor FROM blanks WHERE id=?", k8)[0].name === "Port Authority EZCotton Long Sleeve Polo" &&
    size(k8, "Black", "M").quantity === 3 && size(k8, "Black", "M").purchasePriceCents === 1200);
  ok("…the description wasn't replaced (not ticked)", d1.q("SELECT description FROM blanks WHERE id=?", k8)[0].description === "");
  ok("each change is in the price history, noted as from the SanMar file", d1.q("SELECT count(*) n FROM blank_vendor_prices WHERE blankId=? AND note='SanMar file' AND actor='owner@test'", k8)[0].n === 9);
  ok("the prices count as checked, and it's audited", !!d1.q("SELECT pricesCheckedAt FROM blanks WHERE id=?", k8)[0].pricesCheckedAt && audits("inventory.blank_updated_from_vendor").length === 1);
  ok("the S&S blank with the same style number is untouched", size(ssTwin, "Black", "S").vendorPriceCents === null);

  r = await call({ action: "applyVendorBlanks", products: [sanmar()], selections: [{ key: "SanMar|K8000LS|Port Authority", prices: true, colors: ["True Royal"], newSizes: true, description: true, features: true,
    images: [{ color: "Black", url: "https://images.example.com/uploads/blanks/abc.jpg", fileName: "K8000LS_black_model_front.jpg", locationId: 7 }] }], source: "SanMar file" });
  ok("a ticked new color comes in with its sizes and prices", size(k8, "True Royal", "S").vendorPriceCents === 1597 && size(k8, "True Royal", "2XL").vendorPriceCents === 1697 && size(k8, "True Royal", "S").quantity === 0);
  ok("…ticked missing sizes are added to the colors it has, priced", size(k8, "Black", "2XL").vendorPriceCents === 1697 && size(k8, "Oxford Heather", "2XL").vendorPriceCents === 1831);
  const bk = (await lib.getAllBlanks(d1)).find(b => b.id === k8);
  ok("…the image lands on its color, with its garment location", bk.colors.find(c => c.color === "Black").images.some(im => im.url === "https://images.example.com/uploads/blanks/abc.jpg" && im.locationId === 7));
  ok("…the description and features were replaced (ticked)", bk.description === "A wrinkle-resistant cotton polo." && bk.features.join("|") === "5.3-ounce|Flat knit collar");
  ok("…and where it came from is kept, with the image's vendor file name", bk.source.vendor === "SanMar" && bk.source.style === "K8000LS" && bk.source.images.includes("K8000LS_black_model_front.jpg"));
  plan = (await call({ action: "previewVendorBlanks", products: [sanmar()] })).body.plans[0];
  ok("a second look says nothing left to change, and that image is already in", plan.priceChanges === 0 && plan.newColors === 0 &&
    plan.colors.find(c => c.color === "Black").images[0].have === true);
  r = await call({ action: "applyVendorBlanks", products: [sanmar()], selections: [{ key: "SanMar|K8000LS|Port Authority", images: [{ color: "Black", url: "javascript:alert(1)", fileName: "x.jpg" }] }] });
  ok("an image address that isn't allowed is refused", r.status === 400);

  console.log("\n=== A complete new blank ===");
  const st650 = { vendor: "SanMar", style: "ST650", name: "Sport-Tek Micropique Sport-Wick Polo", brand: "Sport-Tek", category: "shirt",
    description: "Moisture-wicking micropique.", features: ["100% polyester", "Snag resistant"],
    colors: [{ color: "True Navy", hex: "#1f2a44", images: [] }, { color: "Black", images: [] }, { color: "Lime Shock", images: [] }],
    prices: { "*": { XS: 12.48, S: 12.48, M: 12.48, "2XL": 13.48 } } };
  plan = (await call({ action: "previewVendorBlanks", products: [st650] })).body.plans[0];
  ok("a style with no blank on file is a NEW blank with every color offered", plan.action === "create" && plan.colors.length === 3 && plan.colors.every(c => !c.onBlank));
  r = await call({ action: "applyVendorBlanks", products: [st650], selections: [{ key: "SanMar|ST650|Sport-Tek", colors: [] , create: {} }] });
  ok("a new blank with no color ticked isn't created", r.status === 200 && r.body.results.length === 0 && !d1.q("SELECT 1 FROM blanks WHERE sku='ST650'").length);
  r = await call({ action: "applyVendorBlanks", products: [st650], source: "SanMar file", selections: [{ key: "SanMar|ST650|Sport-Tek", colors: ["True Navy", "Black"],
    create: { name: "Sport-Tek ST650 Polo", productType: "shirt" }, images: [{ color: "True Navy", url: "https://images.example.com/uploads/blanks/n.jpg", fileName: "ST650_TrueNavy_front.jpg", locationId: null }] }] });
  const nb = (await lib.getAllBlanks(d1)).find(b => b.sku === "ST650");
  ok("the new blank comes in complete: the name typed, its vendor, description and features", r.body.results[0].created && nb && nb.name === "Sport-Tek ST650 Polo" && nb.vendor === "SanMar" &&
    nb.description === "Moisture-wicking micropique." && nb.features.length === 2);
  ok("…only the ticked colors, every size, nothing in stock, each priced", nb.colors.map(c => c.color).sort().join() === "Black,True Navy" && nb.sizes.length === 8 &&
    nb.sizes.every(z => z.quantity === 0 && z.vendorPrice != null) && nb.sizes.find(z => z.color === "Black" && z.size === "2XL").vendorPrice === 13.48);
  ok("…with its image, its source, prices checked, and audited", nb.colors.find(c => c.color === "True Navy").images[0].url === "https://images.example.com/uploads/blanks/n.jpg" &&
    nb.source.style === "ST650" && !!nb.pricesCheckedAt && audits("inventory.blank_created_from_vendor").length === 1);
  ok("…its prices are in the history as from the file", d1.q("SELECT count(*) n FROM blank_vendor_prices WHERE blankId=? AND note='SanMar file'", nb.id)[0].n === 8);
  r = await call({ action: "applyVendorBlanks", products: [{ vendor: "SanMar", style: "ST650", prices: { "*": { S: 12.99 } } }], selections: [{ key: "SanMar|ST650" }] });
  ok("a price list with no colors prices that size on every color the blank has", size(nb.id, "Black", "S").vendorPriceCents === 1299 && size(nb.id, "True Navy", "S").vendorPriceCents === 1299 && size(nb.id, "Black", "M").vendorPriceCents === 1248);

  console.log("\n=== Image fallback: fetched once into the image bucket ===");
  const stored = [];
  const bucket = { put: async (k, b, o) => { stored.push({ k, n: b.byteLength, type: o.httpMetadata.contentType }); } };
  const imgRes = (type, bytes) => new Response(bytes, { status: 200, headers: { "Content-Type": type } });
  let out = await vendorImages.copyVendorImage({}, "https://cdnm.sanmar.com/a.jpg", async () => imgRes("image/png", PNG));
  ok("no image bucket → it says so", !out.ok && /isn't set up/.test(out.message));
  const ienv = { IMAGES: bucket, R2_PUBLIC_BASE: "https://images.example.com/" };
  out = await vendorImages.copyVendorImage(ienv, "https://cdnm.sanmar.com/a.png", async () => imgRes("image/png", PNG));
  ok("a vendor image is stored under uploads/blanks with a key made here", out.ok && /^https:\/\/images\.example\.com\/uploads\/blanks\/[0-9a-f]{32}\.png$/.test(out.url) && stored[0].type === "image/png");
  ok("…and its id comes back, for the browser to make its -thumb copy", /^[0-9a-f]{32}$/.test(out.id) && out.url.endsWith("/" + out.id + ".png"));
  out = await vendorImages.copyVendorImage({ IMAGES: bucket, R2_PUBLIC_BASE: "images.example.com" }, "https://cdnm.sanmar.com/a.png", async () => imgRes("image/png", PNG));
  ok("an image base set without https:// still gives an https address (like upload.js)", out.ok && /^https:\/\/images\.example\.com\/uploads\/blanks\//.test(out.url));
  out = await vendorImages.copyVendorImage(ienv, "http://cdnm.sanmar.com/a.png", async () => imgRes("image/png", PNG));
  ok("only https", !out.ok);
  out = await vendorImages.copyVendorImage(ienv, "https://10.0.0.5/a.png", async () => imgRes("image/png", PNG));
  ok("never a private address", !out.ok);
  out = await vendorImages.copyVendorImage(ienv, "https://cdnm.sanmar.com/a.png", async () => imgRes("text/html", Buffer.from("<html>")));
  ok("a page that isn't an image is refused", !out.ok && /isn't a JPEG/.test(out.message));
  out = await vendorImages.copyVendorImage(ienv, "https://cdnm.sanmar.com/a.png", async () => imgRes("image/png", Buffer.from("GIF89a....")));
  ok("an image that isn't what it claims (magic bytes) is refused", !out.ok);

  console.log("\n=== Blanks → Import CSV: one row per style + color, vendor matched strictly ===");
  const csv = await lib.importBlanksCsv(d1, [
    { style: "K8000LS", supplier: "SanMar", name: "Port Authority EZCotton Long Sleeve Polo", category: "shirt", color: "Oxford Heather", cost_S: "18.00" },
    { style: "K8000LS", supplier: "SanMar", name: "Port Authority EZCotton Long Sleeve Polo", category: "shirt", color: "Black", cost_S: "16.25" },
    { style: "K8000LS", supplier: "SanMar", name: "Port Authority EZCotton Long Sleeve Polo", category: "shirt", color: "Black", cost_S: "1" },
    { style: "K8000LS", supplier: "SanMar", name: "x", category: "shirt", cost_S: "1" },
  ], { actor: "owner@test" });
  ok("each color row prices only its color", size(k8, "Oxford Heather", "S").vendorPriceCents === 1800 && size(k8, "Black", "S").vendorPriceCents === 1625 && size(k8, "Navy", "S").vendorPriceCents === 1597);
  ok("…the same style + color twice is refused, and so is a no-color row after color rows", csv.results[2].problems.length && csv.results[3].problems.length);
  ok("…the S&S blank of the same style is untouched", size(ssTwin, "Black", "S").vendorPriceCents === null && d1.q("SELECT vendor FROM blanks WHERE id=?", ssTwin)[0].vendor === "S&S");
  const before = d1.q("SELECT count(*) n FROM blanks")[0].n;
  const csv2 = await lib.importBlanksCsv(d1, [
    { style: "NEW1", supplier: "SanMar", name: "New one", category: "shirt", color: "Red", cost_M: "5" },
    { style: "NEW1", supplier: "SanMar", name: "New one", category: "shirt", color: "Blue", cost_M: "6" },
    { style: "K8000LS", supplier: "Alpha Broder", name: "Alpha K8000LS", category: "shirt", cost_M: "9" },
  ], { actor: "owner@test" });
  const new1 = d1.q("SELECT id FROM blanks WHERE sku='NEW1'");
  ok("a new style's color rows make ONE blank, each color at its own price", new1.length === 1 && size(new1[0].id, "Red", "M").vendorPriceCents === 500 && size(new1[0].id, "Blue", "M").vendorPriceCents === 600);
  ok("the same style from another vendor becomes its own blank — the SanMar one isn't re-vendored", d1.q("SELECT count(*) n FROM blanks")[0].n === before + 2 &&
    d1.q("SELECT vendor FROM blanks WHERE id=?", k8)[0].vendor === "SanMar" && /separate Alpha Broder blank/.test(csv2.results[2].notes.join(" ")));

  console.log("\n=== The vendor file, the image folder and the review window ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/#inventory", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.URL.createObjectURL = () => "blob:x"; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b);
        if (b.action === "applyVendorBlanks" && win.__failApply) return { ok: false, status: 500, json: async () => ({ status: "error", message: "Server down" }) };
        if (b.action === "copyVendorImage") { const id = String((win.__copied = win.__copied || []).push(b.url)).padStart(32, "a"); return { ok: true, status: 200, json: async () => ({ status: "ok", url: "https://images.example.com/uploads/blanks/" + id + ".jpg", id }) }; }
        const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const ss = [
    "sku,styleName,title,brandName,colorName,color1,sizeName,piecePrice,customerPrice,mapPrice,colorFrontImage,colorBackImage,description",
    'B1,5100,Unisex Performance T-Shirt,C2 Sport,White,#FFFFFF,S,4.10,3.72,7.22,Images/Color/5100_white_fm.jpg,Images/Color/5100_white_bm.jpg,"<p>Light and fast.</p><ul><li>100% polyester</li><li>Tear away label</li></ul>"',
    "B2,5100,Unisex Performance T-Shirt,C2 Sport,White,#FFFFFF,2XL,4.50,4.11,7.22,Images/Color/5100_white_fm.jpg,Images/Color/5100_white_bm.jpg,",
    "B3,5100,Unisex Performance T-Shirt,C2 Sport,Gold,#FFC72C,S,4.10,3.72,7.22,Images/Color/5100_gold_fm.jpg,,",
  ].join("\n");
  const pss = w.parseVendorProductFile_(ss, "S&S Activewear");
  const p5100 = pss.products[0];
  ok("an S&S-style file: the style # from styleName, the name from title, the brand", pss.products.length === 1 && p5100.style === "5100" && p5100.name === "Unisex Performance T-Shirt" && p5100.brand === "C2 Sport");
  ok("…the customer (account) price, not the piece or MAP price", p5100.prices.White.S === 3.72 && p5100.prices.White["2XL"] === 4.11 && p5100.prices.Gold.S === 3.72);
  ok("…colors with their hex and front / back images on S&S's host, file names kept", p5100.colors.length === 2 && p5100.colors[0].hex === "#FFFFFF" &&
    p5100.colors[0].images[0].url === "https://www.ssactivewear.com/Images/Color/5100_white_fm.jpg" && p5100.colors[0].images[1].fileName === "5100_white_bm.jpg");
  ok("…the description as text and its bullet points as features", p5100.description === "Light and fast." && p5100.features.join("|") === "100% polyester|Tear away label");
  const sm = [
    "UNIQUE_KEY,PRODUCT_TITLE,PRODUCT_DESCRIPTION,STYLE#,COLOR_NAME,SIZE,PIECE_PRICE,MSRP,CATEGORY_NAME,MILL,FRONT_MODEL_IMAGE_URL,BACK_MODEL_IMAGE",
    "1,Sport-Tek Micropique Polo,Wicks moisture.,ST650,True Navy,S,12.48,25.98,Polos/Knits,Sport-Tek,https://cdnm.sanmar.com/imglib/ST650_TrueNavy_Model_Front.jpg,https://cdnm.sanmar.com/imglib/ST650_TrueNavy_Model_Back.jpg",
    "2,Sport-Tek Micropique Polo,Wicks moisture.,ST650,True Navy,2XL,13.48,27.98,Polos/Knits,Sport-Tek,https://cdnm.sanmar.com/imglib/ST650_TrueNavy_Model_Front.jpg,",
  ].join("\n");
  const psm = w.parseVendorProductFile_(sm, "SanMar").products[0];
  ok("a SanMar-style file: STYLE#, the title, the mill as brand, the piece price (not MSRP), the images", psm.style === "ST650" && psm.name === "Sport-Tek Micropique Polo" && psm.brand === "Sport-Tek" &&
    psm.prices["True Navy"].S === 12.48 && psm.prices["True Navy"]["2XL"] === 13.48 && psm.colors[0].images[1].fileName === "ST650_TrueNavy_Model_Back.jpg");
  const wide = w.parseVendorProductFile_("style,color,supplier,cost_S,cost_M\nK8000LS,Oxford Heather,SanMar,17.31,17.31\nK8000LS,Black,SanMar,15.97,", "SanMar").products[0];
  ok("a long CSV: one row per style + color with cost_<size> columns", wide.prices["Oxford Heather"].M === 17.31 && wide.prices.Black.S === 15.97 && wide.prices.Black.M === undefined);
  ok("a file with no style column says so", /No style column/.test(w.parseVendorProductFile_("color,price\nRed,1", "x").error));
  ok("the vendor is guessed from the file", w.guessVendorOfFile_(["sku", "customerPrice", "colorFrontImage"], "products.csv") === "S&S" && w.guessVendorOfFile_(["STYLE#"], "SanMar_SDL_N.csv") === "SanMar");

  const files = ["5100_white_fm.jpg", "5100_white_bm.jpg", "5100_GOLD_front.jpg", "5100_gold_back.jpg", "other_style_white.jpg", "readme.txt"].map(n => ({ name: n }));
  const m = w.matchLocalImages_(p5100, files);
  ok("images are found by the vendor's own file name", m.byColor.White.map(x => files[x.file].name).join() === "5100_white_fm.jpg,5100_white_bm.jpg" && m.byColor.White[1].type === "back");
  ok("…a color whose listed image isn't in the folder falls back to style + color in the file name, with the view read from it", m.byColor.Gold.length === 2 && m.byColor.Gold[0].type === "front" && m.byColor.Gold[1].type === "back");
  const m2 = w.matchLocalImages_(Object.assign({}, p5100, { colors: [{ color: "Royal", images: [{ url: "https://x.example/5100_royal_fm.jpg", type: "front", fileName: "5100_royal_fm.jpg" }] }] }), files);
  ok("…and an image found nowhere is listed as missing, with its vendor address for the download fallback", m2.byColor.Royal.length === 0 && m2.missing[0].url === "https://x.example/5100_royal_fm.jpg");

  // The review window, with the SanMar K8000LS update and a new C2 Sport 5100, and a folder already picked.
  w.eval("window.__uploads = []; uploadImage = async (file, folder) => { window.__uploads.push(file.name + '|' + folder); return 'https://images.example.com/uploads/blanks/' + file.name.replace(/[^a-z0-9]/gi, '') + '.jpg'; };");
  const s5100 = Object.assign({}, p5100, { vendor: "S&S Activewear" });
  const k8file = sanmar({ prices: { black: { S: 15.5, M: 15.5, L: 15.5 }, navy: { S: 15.5, M: 15.5, L: 15.5 }, oxfordheather: { S: 17.31, M: 17.31, L: 17.31 } }, colors: [{ color: "Black", images: [] }, { color: "Navy", images: [] }, { color: "Oxford Heather", images: [] }] });
  let doneWith = null;
  sent.length = 0;
  const reviewDone = w.showVendorBlankReview_([k8file, s5100], { source: "SanMar file", files, onDone: (res) => { doneWith = res; } });
  for (let i = 0; i < 200 && !d.querySelector(".vb-card"); i++) await new Promise(res => setTimeout(res, 10));
  const cards = [...d.querySelectorAll(".vb-card")];
  ok("one card per style: an UPDATE of the SanMar blank and a NEW BLANK", cards.length === 2 && /UPDATE/.test(cards[0].textContent) && /NEW BLANK/.test(cards[1].textContent));
  ok("the update shows its price changes and the color priced differently", /Update the vendor prices of the colors it has — 7 changes/.test(cards[0].textContent) && /DIFFERENT PRICE/.test(cards[0].textContent));
  ok("the new blank's colors are ticked, with the images found in the folder", cards[1].querySelectorAll(".vbColor:checked").length === 2 && cards[1].querySelectorAll(".vbImg").length === 4);
  const goldBox = [...cards[1].querySelectorAll(".vbColor")].find(x => x.value === "Gold");
  goldBox.checked = false; goldBox.dispatchEvent(new w.Event("change", { bubbles: true }));
  d.getElementById("vbApply").click();
  ok("clicking Create / apply swaps the review for a progress view at once — the button is gone, so it can't be clicked twice",
    !!d.getElementById("vbWork") && !d.getElementById("vbApply") && !!d.getElementById("vbBarFill") && /Saving 2 styles/.test(d.getElementById("vbWork").textContent));
  ok("…the ✕ is hidden while it works", d.querySelector("[data-modal-close]").style.visibility === "hidden");
  d.getElementById("vbStep").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("…and Escape doesn't close it", !!d.getElementById("vbWork"));
  const seenSteps = new Set([d.getElementById("vbStep").textContent]);
  new w.MutationObserver(() => { const st = d.getElementById("vbStep"); if (st) seenSteps.add(st.textContent); }).observe(d.getElementById("vbStep"), { childList: true, characterData: true, subtree: true });
  for (let i = 0; i < 300 && !doneWith; i++) await new Promise(res => setTimeout(res, 10));
  ok("…the step shows the image uploads, then the save", ["Uploading images 0 of 2…", "Uploading images 2 of 2…", "Saving 2 styles…", "Done."].every(t => seenSteps.has(t)));
  const work = d.getElementById("vbWork");
  ok("when it's finished the bar is full and the window says what was done, with a Done button",
    work && parseFloat(d.getElementById("vbBarFill").style.width) === 100 && d.getElementById("vbPct").textContent === "100%" && /^\s*Saved/.test(work.textContent) &&
    /1 new blank, 1 updated/.test(work.textContent) && /2 images added/.test(work.textContent) && !!d.getElementById("vbDone"));
  d.getElementById("vbDone").click();
  ok("…Done closes it", !d.getElementById("vbWork"));
  const applied = sent.filter(b => b.action === "applyVendorBlanks");
  ok("Apply uploads the ticked images from the folder (only White's — Gold was unticked) into the blanks folder", w.__uploads.sort().join() === "5100_white_bm.jpg|blanks,5100_white_fm.jpg|blanks");
  const blanksNow = await lib.getAllBlanks(d1);
  const c2 = blanksNow.find(b => b.sku === "5100");
  ok("…creates the new blank with its picked color, images, description and S&S prices", applied.length === 1 && c2 && c2.vendor === "S&S Activewear" && c2.colors.map(c => c.color).join() === "White" &&
    c2.colors[0].images.length === 2 && c2.description === "Light and fast." && c2.sizes.find(z => z.size === "2XL").vendorPrice === 4.11);
  ok("…and updates the SanMar blank's prices", size(k8, "Black", "S").vendorPriceCents === 1550 && size(k8, "Oxford Heather", "S").vendorPriceCents === 1731);
  ok("…then reports back", Array.isArray(doneWith) && doneWith.length === 2);
  await reviewDone;

  console.log("\n=== The real vendor files' layouts, streamed ===");
  // Big files are streamed (Blob.stream → TextDecoderStream; an .xlsx unzipped with DecompressionStream).
  w.DecompressionStream = DecompressionStream; w.TextDecoderStream = TextDecoderStream; w.TextDecoder = TextDecoder;
  const named = (data, name) => { const b = new Blob([data]); Object.defineProperty(b, "name", { value: name }); return b; };
  const smScan = await w.scanVendorFiles_([named(read("testlib/fixtures/vendor-sdl-sample.csv"), "SanMar_SDL_N.csv")], "SanMar", { only: new w.Set(["sp200", "dm300", "sc100"]) });
  const k540 = smScan.products.find(p => p.style === "SP200"), s18810 = smScan.products.find(p => p.style === "DM300");
  ok("SanMar's SDL file (its real columns): the account price is CASE_PRICE, not the PIECE_PRICE list price", !smScan.error && k540.prices.Black.S === 7 && k540.prices.Black.XS === 7 &&
    s18810.prices.White.S === 9 && s18810.prices.Ash.S === 10);
  ok("…the title without the style # on its end, the mill as brand, the category", k540.name === "Sample Co Performance Polo" && k540.brand === "Sample Co" && /Polos/.test(k540.category));
  ok("…its relative image names kept as file names to find in the download, with the full URLs where it has them", k540.colors[0].images.some(im => im.fileName === "SP200_black_model_front.jpg" && /^https:\/\/images\.example\.com\//.test(im.url)) &&
    k540.colors[0].images.some(im => im.type === "flat"));
  ok("…sizes in the usual order (its SIZE_INDEX restarts at each price break)", k540.sizes.slice(0, 4).join() === "XS,S,M,L");
  ok("…the style index lists every style in the file", smScan.index.size === 3 && smScan.kinds[0].kind === "products");
  // A quoted field (commas, a line break, doubled quotes) that straddles the stream's 64 KB chunks.
  const pad = "x".repeat(65520);
  const tricky = `style,color,supplier,cost_S,notes\nA1,Red,SanMar,5,"${pad}"\nA2,Blue,SanMar,6,"a, ""quoted""\nline"\nA3,Green,SanMar,7,z\n`;
  const rowsSeen = [];
  await w.readCsvRows_(named(tricky, "t.csv"), (r) => { rowsSeen.push(r); });
  ok("the CSV reader keeps quoted commas, line breaks and doubled quotes across chunk boundaries", rowsSeen.length === 3 && rowsSeen[1].notes === 'a, "quoted"\nline' && rowsSeen[2].cost_S === "7" && rowsSeen[0].notes.length === 65520);

  // S&S's Data Library: Products.xlsx (its real header row) + Styles.xlsx, joined by styleID.
  const zlib = require("zlib");
  const zip = (entries) => {
    const parts = [], central = []; let off = 0;
    for (const [name, text] of entries) {
      const data = Buffer.from(text), comp = zlib.deflateRawSync(data), nm = Buffer.from(name);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
      parts.push(lh, nm, comp);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
      central.push(ch, nm);
      off += lh.length + nm.length + comp.length;
    }
    const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, eocd]);
  };
  const xlsx = (rows) => {
    const shared = [], sidx = new Map();
    const col = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const sheet = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => v === "" || v == null ? "" : (typeof v === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
      : `<c r="${col(ci)}${ri + 1}" t="s"><v>${sidx.has(v) ? sidx.get(v) : (sidx.set(v, shared.length), shared.push(v), shared.length - 1)}</v></c>`)).join("") + "</row>").join("");
    return zip([["xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet><sheetData>${sheet}</sheetData></worksheet>`],
      ["xl/sharedStrings.xml", `<?xml version="1.0"?><sst>${shared.map(t => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join("")}</sst>`]]);
  };
  const PH = ["sku","gtin","skuID_Master","styleID","brandName","styleName","colorName","colorCode","colorPriceCodeName","colorGroup","colorFamily","colorSwatchImage","colorSwatchTextColor","colorFrontImage","colorSideImage","colorBackImage","colorDirectSideImage","colorOnModelFrontImage","colorOnModelSideImage","colorOnModelBackImage","color1","color2","sizeName","sizeCode","sizeOrder","sizePriceCodeName","CaseQty","unitWeight","MAPPrice","RetailPrice","piecePrice","dozenPrice","casePrice","salePrice","customerPrice","saleExpireDate","closeout","excludeFreeFreight","Qty"];
  const prow = (o) => PH.map(h => o[h] == null ? "" : o[h]);
  const products = xlsx([PH,
    prow({ sku: "B1", styleID: 9001, brandName: "C2 Sport", styleName: "5100", colorName: "White", colorSwatchImage: "Images/ColorSwatch/1_fm.jpg", colorFrontImage: "Images/Color/101_f_fm.jpg", colorBackImage: "Images/Color/101_b_fm.jpg", color1: "#FFFFFF", sizeName: "S", sizeOrder: "B1", piecePrice: 4.1, customerPrice: 3.72 }),
    prow({ sku: "B2", styleID: 9001, brandName: "C2 Sport", styleName: "5100", colorName: "White", colorFrontImage: "Images/Color/101_f_fm.jpg", color1: "#FFFFFF", sizeName: "2XL", sizeOrder: "B6", piecePrice: 4.5, customerPrice: 4.11 }),
    prow({ sku: "B3", styleID: 9001, brandName: "C2 Sport", styleName: "5100", colorName: "Gold", colorFrontImage: "Images/Color/102_f_fm.jpg", color1: "#FFC72C", sizeName: "S", sizeOrder: "B1", piecePrice: 4.1, customerPrice: 3.72 }),
    prow({ sku: "B4", styleID: 9002, brandName: "Bayside", styleName: "5100", colorName: "Ash", colorFrontImage: "Images/Color/201_f_fm.jpg", sizeName: "S", sizeOrder: "B1", piecePrice: 5, customerPrice: 3.61 }),
    prow({ sku: "B5", styleID: 9003, brandName: "Gildan", styleName: "5000", colorName: "Black", sizeName: "M", sizeOrder: "B2", customerPrice: 2.5 }),
  ]);
  const styles = xlsx([["styleID","partNumber","brandName","styleName","uniqueStyleName","title","description","baseCategory","categories"],
    [9001, "49695", "C2 Sport", "5100", "5100", "Unisex Performance T-Shirt", "<p>Light &amp; fast.</p><ul><li>100% polyester</li><li>Tear away label</li></ul>", "T-Shirts", "11,71"],
    [9002, "49696", "Bayside", "5100", "5100BY", "Unisex USA-Made Heavyweight T-Shirt", "<ul><li>6.1 oz. 100% cotton</li></ul>", "T-Shirts - Premium", "1"]]);
  const specs = xlsx([["specID","styleID","partNumber","brandName","styleName","sizeName","sizeOrder","specName","value"], [1, 9001, "x", "C2 Sport", "5100", "S", "B1", "Chest", "18"]]);
  const ssScan = await w.scanVendorFiles_([named(products, "Products.xlsx"), named(styles, "Styles.xlsx"), named(specs, "Specs.xlsx")], "S&S Activewear", { only: new w.Set(["5100"]) });
  ok("S&S's Data Library: Products.xlsx and Styles.xlsx are told apart from Specs.xlsx by their columns", !ssScan.error && ssScan.kinds.map(k => k.kind).join() === "products,styles,other");
  const ssC2 = ssScan.products.find(p => p.brand === "C2 Sport"), bay = ssScan.products.find(p => p.brand === "Bayside");
  ok("…the same style number from two brands stays two styles (C2 Sport 5100 and Bayside 5100)", ssScan.products.length === 2 && ssC2 && bay && ssScan.index.size === 3);
  ok("…the customer price (not the piece price), per color and size", ssC2.prices.White.S === 3.72 && ssC2.prices.White["2XL"] === 4.11 && ssC2.prices.Gold.S === 3.72 && bay.prices.Ash.S === 3.61);
  ok("…the title, description, bullet points and category from Styles.xlsx (joined by styleID)", ssC2.name === "Unisex Performance T-Shirt" && ssC2.description === "Light & fast." &&
    ssC2.features.join("|") === "100% polyester|Tear away label" && ssC2.category === "T-Shirts");
  ok("…colors with their hex, and images on S&S's host with the file names its image download uses", ssC2.colors[0].hex === "#FFFFFF" &&
    ssC2.colors[0].images.find(im => im.type === "front").url === "https://www.ssactivewear.com/Images/Color/101_f_fm.jpg" && ssC2.colors[0].images.some(im => im.fileName === "101_b_fm.jpg" && im.type === "back"));
  const c2blank = (await lib.createBlank(d1, { name: "C2 Sport 5100", productType: "shirt", vendor: "S&S", brand: "C2 Sport", sku: "5100", colors: [{ color: "White", images: [], sizes: [{ size: "S", purchasePrice: 0, quantity: 0 }] }] })).id;
  const brandPlans = await lib.planVendorBlanks(d1, [ssC2, bay]);
  ok("a blank only matches the vendor's style when the brand agrees too: C2 Sport updates, Bayside is a new blank",
    brandPlans.find(p => p.brand === "C2 Sport").action === "update" && brandPlans.find(p => p.brand === "C2 Sport").candidates.some(b => b.id === c2blank) &&
    brandPlans.find(p => p.brand === "Bayside").action === "create" && !brandPlans.find(p => p.brand === "Bayside").candidates.length &&
    brandPlans.find(p => p.brand === "C2 Sport").key === "S&S Activewear|5100|C2 Sport");

  // Blanks made from an S&S invoice were filed under its size-specific ITEM # (the file's sku without its B).
  const ucWhite = (await lib.createBlank(d1, { name: "White Men's Classic Piqué Polo", productType: "shirt", vendor: "S&S", brand: "UltraClub", sku: "922E1001", colors: [{ color: "White", images: [], sizes: [{ size: "M", purchasePrice: 9, quantity: 2 }] }] })).id;
  const ucRed = (await lib.createBlank(d1, { name: "Red Men's Classic Piqué Polo", productType: "shirt", vendor: "S&S", brand: "UltraClub", sku: "922E1709", colors: [{ color: "Red", images: [], sizes: [{ size: "M", purchasePrice: 9, quantity: 0 }] }] })).id;
  const ucFile = xlsx([PH,
    prow({ sku: "B922E1001", styleID: 9100, brandName: "UltraClub", styleName: "8535", colorName: "White", sizeName: "M", customerPrice: 8.25 }),
    prow({ sku: "B922E1002", styleID: 9100, brandName: "UltraClub", styleName: "8535", colorName: "White", sizeName: "L", customerPrice: 8.25 }),
    prow({ sku: "B922E1709", styleID: 9100, brandName: "UltraClub", styleName: "8535", colorName: "Red", sizeName: "M", customerPrice: 8.75 }),
  ]);
  const codes = new w.Map([[w.eval("vendorItemCode_")("922E1001"), { id: ucWhite }], [w.eval("vendorItemCode_")("922E1709"), { id: ucRed }]]);
  const ucScan = await w.scanVendorFiles_([named(ucFile, "Products.xlsx")], "S&S Activewear", { only: new w.Set(["922e1001", "922e1709"]), itemCodes: codes });
  ok("a blank's SKU that is a vendor ITEM # is found in the file (B922E1001 = 922E1001), naming its style", ucScan.aliases.get("922E1001").style === "8535" && ucScan.aliases.get("922E1709").style === "8535" && w.eval("vendorItemCode_")("B922E1001") === "922E1001");
  const ucProducts = (await w.scanVendorFiles_([named(ucFile, "Products.xlsx")], "S&S Activewear", { only: new w.Set(["8535"]) })).products;
  const ucKey = "S&S Activewear|8535|UltraClub";
  let ucPlan = (await call({ action: "previewVendorBlanks", products: ucProducts, aliases: { [ucKey]: [ucWhite, ucRed] } })).body.plans[0];
  ok("…so the blank is updated rather than a duplicate made, and the other blank of that style is named for merging", ucPlan.action === "update" && ucPlan.blankId === ucWhite &&
    ucPlan.aliasSku === "922E1001" && ucPlan.alsoFiled.length === 1 && ucPlan.alsoFiled[0].id === ucRed && ucPlan.priceChanges === 1);
  r = await call({ action: "applyVendorBlanks", products: ucProducts, aliases: { [ucKey]: [ucWhite, ucRed] }, selections: [{ key: ucKey, prices: true, setSku: true }], source: "S&S Activewear file" });
  ok("…and with the box ticked its SKU becomes the style # (the next import matches by style); its stock is untouched", d1.q("SELECT sku FROM blanks WHERE id=?", ucWhite)[0].sku === "8535" &&
    size(ucWhite, "White", "M").vendorPriceCents === 825 && size(ucWhite, "White", "M").quantity === 2 && r.body.results[0].skuFrom === "922E1001");
  ucPlan = (await call({ action: "previewVendorBlanks", products: ucProducts })).body.plans[0];
  ok("…and the next time it's matched by style with no item # needed", ucPlan.action === "update" && ucPlan.blankId === ucWhite && !ucPlan.aliasSku);

  console.log("\n=== Photos for blanks you already have: add, replace, or only colors with none ===");
  const ph = (await lib.createBlank(d1, { name: "Photo polo", productType: "shirt", vendor: "SanMar", brand: "Sport-Tek", sku: "ST640",
    colors: [{ color: "Black", images: [{ url: "https://images.example.com/old-black-1.jpg", locationId: null }, { url: "https://images.example.com/old-black-2.jpg", locationId: null }], sizes: [{ size: "M", purchasePrice: 9, quantity: 1 }] },
             { color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 9, quantity: 0 }] }] })).id;
  const phProduct = { vendor: "SanMar", style: "ST640", brand: "Sport-Tek", colors: [
    { color: "Black", images: [{ url: "https://cdnm.sanmar.com/imglib/ST640_black_model_front.jpg", type: "front", fileName: "ST640_black_model_front.jpg" }] },
    { color: "Navy", images: [{ url: "https://cdnm.sanmar.com/imglib/ST640_navy_model_front.jpg", type: "front", fileName: "ST640_navy_model_front.jpg" }] }],
    prices: { "*": { M: 10 } } };
  const phKey = "SanMar|ST640|Sport-Tek";
  const phPlan = (await call({ action: "previewVendorBlanks", products: [phProduct] })).body.plans[0];
  ok("the plan says how many photos each color has now", phPlan.colors.find(c => c.color === "Black").imagesNow === 2 && phPlan.colors.find(c => c.color === "Navy").imagesNow === 0);
  const colorImgs = async (color) => (await lib.getAllBlanks(d1)).find(b => b.id === ph).colors.find(c => c.color === color).images.map(i => i.url);
  r = await call({ action: "applyVendorBlanks", products: [phProduct], selections: [{ key: phKey, prices: false, replaceImages: true,
    images: [{ color: "Black", url: "https://images.example.com/uploads/blanks/new-black.jpg", fileName: "ST640_black_model_front.jpg", locationId: 7 }] }] });
  ok("Replace: a color that gets new images has them instead of its old photos", (await colorImgs("Black")).join() === "https://images.example.com/uploads/blanks/new-black.jpg" &&
    r.body.results[0].imagesReplaced === 2);
  ok("…a color with nothing ticked keeps what it had", (await colorImgs("Navy")).length === 0);
  r = await call({ action: "applyVendorBlanks", products: [phProduct], selections: [{ key: phKey, prices: false,
    images: [{ color: "Navy", url: "https://images.example.com/uploads/blanks/new-navy.jpg", fileName: "ST640_navy_model_front.jpg" }] }] });
  ok("Add (the default) adds to the color's photos", (await colorImgs("Navy")).join() === "https://images.example.com/uploads/blanks/new-navy.jpg" && (await colorImgs("Black")).length === 1);
  // The review window: the two options, and the default ticks they give.
  d1._raw.run(`UPDATE blanks SET sourceJson='{}' WHERE id=${ph}`);
  d1._raw.run(`UPDATE blank_colors SET imagesJson='[]' WHERE blankId=${ph} AND color='Navy'`);
  const phFiles = ["ST640_black_model_front.jpg", "ST640_navy_model_front.jpg"].map(n => ({ name: n }));
  w.showVendorBlankReview_([phProduct], { source: "SanMar file", files: phFiles, onDone: () => {} });
  for (let i = 0; i < 200 && !d.querySelector(".vb-photos"); i++) await new Promise(res => setTimeout(res, 10));
  const phCard = [...d.querySelectorAll(".vb-card")].pop();
  const ticks = () => Object.fromEntries([...phCard.ownerDocument.querySelectorAll(".vb-card")].pop().querySelectorAll(".vbImg").length ? [...[...d.querySelectorAll(".vb-card")].pop().querySelectorAll(".vbImg")].map(x => [x.dataset.id.split("|")[0], x.checked]) : []);
  ok("an existing blank's card offers Add / Replace and Only colors with no photos yet, with each color's photo count", /Add to the current photos/.test(phCard.textContent) &&
    /Replace this blank's photos/.test(phCard.textContent) && /1 photo now/.test(phCard.textContent) && /no photos yet/.test(phCard.textContent));
  ok("…every matched image starts ticked (none brought in by an import yet)", ticks().Black === true && ticks().Navy === true);
  ok("…but a color swatch starts unticked (a chip, not a photo)", /x\.type !== "swatch"/.test(adminJs));
  const only = [...d.querySelectorAll(".vb-card")].pop().querySelector('.vbOpt[data-o="onlyEmpty"]');
  only.checked = true; only.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("…Only colors with no photos yet unticks the colors that have some", ticks().Black === false && ticks().Navy === true);
  const rep = [...[...d.querySelectorAll(".vb-card")].pop().querySelectorAll(".vbPhotoMode")].find(x => x.value === "replace");
  rep.checked = true; rep.dispatchEvent(new w.Event("change", { bubbles: true }));
  sent.length = 0;
  d.getElementById("vbApply").click();
  for (let i = 0; i < 300 && !sent.some(b => b.action === "applyVendorBlanks"); i++) await new Promise(res => setTimeout(res, 10));
  await new Promise(res => setTimeout(res, 50));
  const phSel = sent.find(b => b.action === "applyVendorBlanks").selections[0];
  ok("…and Apply sends Replace with only the ticked color's image", phSel.replaceImages === true && phSel.images.length === 1 && phSel.images[0].color === "Navy");

  // A save that fails: nothing saved → Back to review, with the review as it was.
  for (let i = 0; i < 100 && d.getElementById("vbWork") && !d.getElementById("vbDone"); i++) await new Promise(res => setTimeout(res, 10));
  if (d.getElementById("vbDone")) d.getElementById("vbDone").click();
  w.__failApply = true;
  w.showVendorBlankReview_([Object.assign({}, s5100, { style: "9999", colors: [s5100.colors[0]], prices: { White: s5100.prices.White } })], { source: "S&S file" });
  for (let i = 0; i < 200 && !d.getElementById("vbApply"); i++) await new Promise(res => setTimeout(res, 10));
  d.getElementById("vbApply").click();
  for (let i = 0; i < 300 && !d.getElementById("vbBack"); i++) await new Promise(res => setTimeout(res, 10));
  ok("a failed save stops with the server's message and says nothing was saved", /Server down/.test(d.getElementById("vbWork").textContent) && /Nothing was saved/.test(d.getElementById("vbWork").textContent) &&
    d.querySelector("[data-modal-close]").style.visibility === "");
  d.getElementById("vbBack").click();
  ok("…Back to review brings the review back to try again", !!d.querySelector(".vb-card") && !!d.getElementById("vbApply") && !d.getElementById("vbApply").disabled);
  w.__failApply = false;
  for (let i = 0; i < 50 && d.querySelector("[data-modal-close]"); i++) { d.querySelector("[data-modal-close]").click(); }

  console.log("\n=== The review window: a tick never redraws; select-all; downloads without a folder ===");
  w._blanksAll = JSON.parse(JSON.stringify(await lib.getAllBlanks(d1)));
  const many = ["White", "Gold", ...Array.from({ length: 10 }, (_, i) => "Tone " + (i + 1))];
  const s7777 = Object.assign({}, s5100, { style: "7777", colors: many.map(cn => ({ color: cn, hex: "#FFFFFF", images: [{ url: "https://www.ssactivewear.com/Images/Color/7777_" + cn.replace(/ /g, "") + "_fm.jpg", type: "front", fileName: "7777_" + cn.replace(/ /g, "") + "_fm.jpg" }, { url: "https://www.ssactivewear.com/Images/Color/7777_" + cn.replace(/ /g, "") + "_sw.jpg", type: "swatch", fileName: "7777_" + cn.replace(/ /g, "") + "_sw.jpg" }] })),
    prices: Object.fromEntries(many.map(cn => [cn, { S: 3.5, M: 3.5 }])) });
  let done2 = null;
  w.showVendorBlankReview_([s5100, s7777], { source: "S&S file", onDone: (r) => { done2 = r; } });
  for (let i = 0; i < 200 && d.querySelectorAll(".vb-card").length < 2; i++) await new Promise(res => setTimeout(res, 10));
  const cardOf = (style) => [...d.querySelectorAll(".vb-card")].find(el => el.querySelector(".vbInclude").parentNode.textContent.trim() === style);
  const c5100 = cardOf("5100"), c7777 = cardOf("7777");
  ok("with no image folder picked, a color's vendor images are offered as a download", /download 1 from the vendor/.test(c7777.textContent));
  ok("…swatches aren't (a color chip, not a photo)", !/download 2 from the vendor/.test(c7777.textContent));
  const dlColors = [...c5100.querySelectorAll(".vbDl")].map(x => x.dataset.color);
  ok("…and images the blank already has (by the vendor's file name) aren't offered again — White's are on file, Gold's isn't", !dlColors.includes("White") && dlColors.includes("Gold"));
  const toneBox = [...c7777.querySelectorAll(".vbColor")].find(x => x.value === "Tone 3");
  toneBox.checked = false; toneBox.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("unticking a color changes nothing else on screen — the same cards, the same checkbox", cardOf("7777") === c7777 && cardOf("5100") === c5100 && toneBox.isConnected && !toneBox.checked);
  const bulk = (act) => d.querySelector(`.vbBulk[data-act="${act}"]`).click();
  const applyBtn = () => d.getElementById("vbApply");
  bulk("inc-new");
  ok("Include → New blanks: only the new style stays in, and the button counts it", !c5100.querySelector(".vbInclude").checked && c7777.querySelector(".vbInclude").checked && /\(1\)/.test(applyBtn().textContent) && c5100.style.opacity === "0.55");
  bulk("inc-on");
  ok("…Blanks on file: only the update", c5100.querySelector(".vbInclude").checked && !c7777.querySelector(".vbInclude").checked);
  bulk("inc-none");
  ok("…None disables Create / apply", applyBtn().disabled && /\(0\)/.test(applyBtn().textContent));
  bulk("inc-all");
  ok("…All brings both back, still without redrawing", /\(2\)/.test(applyBtn().textContent) && cardOf("7777") === c7777);
  bulk("col-none");
  ok("Colors → None unticks every new color in every style", [...d.querySelectorAll(".vbColor")].every(x => !x.checked));
  bulk("col-all");
  ok("…Tick every new color ticks them all (Gold on the update too)", [...d.querySelectorAll(".vbColor")].every(x => x.checked));
  const dlAll = d.getElementById("vbDlAll");
  dlAll.checked = true; dlAll.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("Download every image from the vendor ticks every color's download", [...d.querySelectorAll(".vbDl")].length === 13 && [...d.querySelectorAll(".vbDl")].every(x => x.checked));
  const q7777 = c7777.querySelector(".vbColorQ");
  q7777.focus(); q7777.value = "gold"; q7777.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("finding a color redraws only that style's color list — the search box stays (and keeps focus)", c7777.querySelectorAll(".vb-colors .vbColor").length === 1 && c7777.querySelector(".vbColorQ") === q7777 && d.activeElement === q7777 && cardOf("7777") === c7777);
  q7777.value = ""; q7777.dispatchEvent(new w.Event("input", { bubbles: true }));
  const rep5100 = [...c5100.querySelectorAll(".vbPhotoMode")].find(x => x.value === "replace");
  rep5100.checked = true; rep5100.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("an option that changes what a card shows redraws THAT card only", cardOf("5100") !== c5100 && cardOf("7777") === c7777 && /Replace this blank's photos/.test(cardOf("5100").textContent));
  const realThumb = w.eval("makeStoredThumb_");
  let thumbErr = ""; try { await realThumb("https://cdnm.sanmar.com/x.jpg"); } catch (e) { thumbErr = e.message; }
  ok("a thumbnail is only made for an image in the shop's own store", /Not an uploaded image/.test(thumbErr));
  w.eval("window.__thumbs = []; makeStoredThumb_ = async (u) => { window.__thumbs.push(u); return true; };");
  w.__copied = [];
  sent.length = 0;
  applyBtn().click();
  for (let i = 0; i < 400 && !done2; i++) await new Promise(res => setTimeout(res, 10));
  const sel7777 = sent.filter(b => b.action === "applyVendorBlanks").flatMap(b => b.selections).find(x => /7777/.test(x.key));
  ok("Apply downloads each ticked color's vendor image (never the swatch)", w.__copied.length === 13 && w.__copied.every(u => /_fm\.jpg$/.test(u)));
  ok("…and makes each one's thumbnail, so pages don't show a broken image", w.__thumbs.length === 13 && w.__thumbs.every(u => /\/uploads\/blanks\/a+\d+\.jpg$/.test(u)));
  ok("…the copies are what's saved on the new blank", sel7777 && sel7777.images.length === 12 && sel7777.images.every(im => /^https:\/\/images\.example\.com\/uploads\/blanks\//.test(im.url)));
  if (d.getElementById("vbDone")) d.getElementById("vbDone").click();

  console.log("\n=== A missing -thumb copy falls back to the full image ===");
  const timg = d.createElement("img"); timg.setAttribute("src", "https://images.example.com/uploads/blanks/abc-thumb.jpg"); d.body.appendChild(timg);
  timg.dispatchEvent(new w.Event("error"));
  ok("an image whose -thumb copy fails to load shows the full image instead", timg.getAttribute("src") === "https://images.example.com/uploads/blanks/abc.jpg");
  timg.dispatchEvent(new w.Event("error"));
  ok("…once (no loop if the full image fails too)", timg.getAttribute("src") === "https://images.example.com/uploads/blanks/abc.jpg");
  const oimg = d.createElement("img"); oimg.setAttribute("src", "https://images.example.com/x.jpg"); d.body.appendChild(oimg);
  oimg.dispatchEvent(new w.Event("error"));
  ok("…other images are left alone", oimg.getAttribute("src") === "https://images.example.com/x.jpg");

  console.log("\n=== The style picker: ticks without redraws, select all / on file / clear ===");
  w._blanksAll = [{ id: 999, sku: "SP200", vendor: "SanMar", brand: "Sample Co", name: "SP200", colors: [], sizes: [] }];
  w.showVendorFileImport_("update", () => {});
  const vfFile = d.getElementById("vfFile");
  d.getElementById("vfVendor").value = "SanMar";
  Object.defineProperty(vfFile, "files", { value: [named(read("testlib/fixtures/vendor-sdl-sample.csv"), "SanMar_SDL_N.csv")], configurable: true });
  vfFile.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 300 && !d.getElementById("vfList"); i++) await new Promise(res => setTimeout(res, 10));
  const count = () => d.getElementById("vfCount").textContent;
  ok("update mode starts with the styles on file picked, and offers Select all on file", /^1 picked/.test(count()) && /Select all on file \(1\)/.test(d.getElementById("vfPickOnFile").textContent));
  d.getElementById("vfPickNone").click();
  ok("Clear unpicks everything (and Review… waits for a pick)", /^0 picked/.test(count()) && d.getElementById("vfNext").disabled && [...d.querySelectorAll(".vfPick")].every(x => !x.checked));
  const list = d.getElementById("vfList"), firstPick = d.querySelector(".vfPick");
  firstPick.checked = true; firstPick.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("ticking a style only updates the count — the list isn't redrawn", /^1 picked/.test(count()) && d.getElementById("vfList") === list && firstPick.isConnected && !d.getElementById("vfNext").disabled);
  d.getElementById("vfPickShown").click();
  const nShown = d.querySelectorAll(".vfPick").length;
  ok("Select all shown picks every style listed", new RegExp("^" + nShown + " picked").test(count()) && [...d.querySelectorAll(".vfPick")].every(x => x.checked));
  d.getElementById("vfPickNone").click(); d.getElementById("vfPickOnFile").click();
  ok("Select all on file picks just the styles you have", /^1 picked/.test(count()));
  const vfSearch = d.getElementById("vfSearch");
  vfSearch.value = "DM300"; vfSearch.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("searching redraws only the list — the search box stays", d.querySelectorAll(".vfPick").length === 1 && d.getElementById("vfSearch") === vfSearch && /1 match\b/.test(count()));
  d.getElementById("vfCancel").click();

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test127 crashed: false"); process.exit(1); });
