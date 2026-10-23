// Customers upload their own design (migrations/0054). A product set to take the customer's own
// design (Embroidery or Transfer, with an optional add-on per piece) shows an upload box on the shop
// page; the image is uploaded to /api/customer-design before the order, and the cart line names it.
//   * The header reader (functions/_lib/imageInfo.js): PNG, baseline and progressive JPEG, the three
//     WebP kinds, and junk.
//   * The upload endpoint: every refusal, and a good upload's key and row.
//   * Placing an order: required uploads, someone else's / expired uploads, the add-on, the line's copy
//     of its options, the customer's file on the order; configurable products' "Custom" choice.
//   * Making it: approval and digitizing for stitched designs, the Run Order hooping waiting for the
//     stitch file, Run Transfer Sheets and the gang sheet for transfers, an old database.
//   * The admin: local sale, Edit items, Update from catalog, the catalog check, the catalog the shop
//     page gets, the product setting and its audit, the daily clean-up, the Files window's rules.
//   * jsdom: the shop page (required upload, the Custom option and its price, the cart thumbnail, the
//     object URLs freed) and the admin (the product form's fields, Edit items keeping the design).
// Real SQL (sql.js) with every migration + the real db.js, orders.js, catalog.js, customer-design.js.
const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, createGraphic, createHoop, saveDesign, addDesignVersion, setProductDesign, priceItem, getOrderById, getOpenOrders, insertOrder,
  getProductionQueue, getTransferQueue, getGangSheet, addOrderItemDesign, stagePrereqError, refreshOrderLinesFromCatalog, getCatalogIssues, getProductsByOrg,
  getPublicCatalogData, setOrgReorderQrTransfer, createTransfer, makeTransferLine, getOrderItemFiles };`)();
const { imageSize } = new Function(strip(read("functions/_lib/imageInfo.js")) + "\nreturn { imageSize };")();
const DESIGN_KEY_RE = eval(read("functions/api/design.js").match(/DESIGN_KEY_RE = (\/.*\/);/)[1]);
const SUBS = { league: "league", other: "other", closed: "closed" };
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: " + JSON.stringify(SUBS) + ", orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
// The upload endpoint, with the rate limit and the bot check under the test's control.
const gate = { blocked: false, bot: true };
const upload = new Function("gate", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/imageInfo.js")) + "\n" + dbSrc + "\n" +
  "const rateLimited = async () => ({ blocked: gate.blocked, retryAfter: 30 }); const rateLimitResponse = (s) => new Response('{\"status\":\"error\"}', { status: 429 });\n" +
  "const verifyTurnstile = async (env, token) => gate.bot && token === 'tok' ? { ok: true } : { ok: false, message: 'Bot check failed' };\n" +
  "const getCatalogData = async () => ({ subdomainMap: " + JSON.stringify(SUBS) + ", orgs: {}, features: {} });\n" +
  strip(read("functions/api/customer-design.js")) + "\nreturn { post: onRequestPost, cleanUp: cleanUpCustomerDesigns };")(gate);
const catalogApi = new Function("lib", hostSrc + "\n" + httpSrc + "\nconst getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\nlet DB_;\n" +
  "const getCatalogData = async (env) => ({ ...(await lib.getPublicCatalogData(env.DB)), subdomainMap: " + JSON.stringify(SUBS) + " });\n" +
  strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")(lib);

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// ---- Test images: just enough of each format's header ----
const bytes = (...parts) => Uint8Array.from(parts.flat());
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], be16 = (n) => [(n >> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255], le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const ascii = (s) => [...s].map(c => c.charCodeAt(0));
const pad = (n) => new Array(n).fill(0);
const png = (w, h) => bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], be32(13), ascii("IHDR"), be32(w), be32(h), [8, 6, 0, 0, 0], pad(4), be32(0), ascii("IEND"), pad(4));
const jpeg = (w, h, sof = 0xC0) => bytes([0xFF, 0xD8], [0xFF, 0xE0], be16(16), ascii("JFIF"), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xFF, 0xDB], be16(67), pad(65), [0xFF, 0xFF], [0xFF, sof], be16(17), [8], be16(h), be16(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xFF, 0xDA], be16(12), pad(10), [0xFF, 0xD9]);
const riff = (chunk, body) => bytes(ascii("RIFF"), le16(body.length + 12), [0, 0], ascii("WEBP"), ascii(chunk), le16(body.length), [0, 0], body, pad(16));
const webpLossy = (w, h) => riff("VP8 ", [0x30, 0x01, 0x00, 0x9D, 0x01, 0x2A, ...le16(w), ...le16(h), ...pad(10)]);
const webpLossless = (w, h) => { const v = (w - 1) | ((h - 1) << 14); return riff("VP8L", [0x2F, v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255, ...pad(10)]); };
const webpExtended = (w, h) => riff("VP8X", [0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), ...pad(10)]);

// A fake R2 bucket.
const bucket = () => { const m = new Map(); return { m, put: async (k, b, o) => { m.set(k, { b, o }); }, get: async (k) => m.get(k) || null, delete: async (k) => { m.delete(k); } }; };

(async () => {
  console.log("=== Reading the size from the header ===");
  const same = (r, w, h) => !!r && r.width === w && r.height === h;
  ok("PNG", same(imageSize(png(1200, 800), "image/png"), 1200, 800));
  ok("baseline JPEG (after APP0 and DQT segments and fill bytes)", same(imageSize(jpeg(640, 480), "image/jpeg"), 640, 480));
  ok("progressive JPEG", same(imageSize(jpeg(3000, 2000, 0xC2), "image/jpeg"), 3000, 2000));
  ok("WebP lossy (VP8)", same(imageSize(webpLossy(800, 600), "image/webp"), 800, 600));
  ok("WebP lossless (VP8L)", same(imageSize(webpLossless(4000, 3000), "image/webp"), 4000, 3000));
  ok("WebP extended (VP8X)", same(imageSize(webpExtended(16383, 501), "image/webp"), 16383, 501));
  ok("junk, a PNG named as a JPEG, a cut-off header, an unknown type: null", imageSize(bytes(pad(64)), "image/png") === null && imageSize(png(10, 10), "image/jpeg") === null &&
    imageSize(png(10, 10).slice(0, 20), "image/png") === null && imageSize(png(10, 10), "image/gif") === null && imageSize(bytes([0xFF, 0xD8, 0xFF, 0xDA, 0, 4, 0, 0]), "image/jpeg") === null);

  // ---- The database ----
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1), ('other','other','Other','t','t',1), ('closed','closed','Closed','t','t',0);`);
  const call = async (body, host = "admin", env = { DB: d1, DESIGNS: {} }) => { const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `https://${host}.example.com/api/orders`, json: async () => (host === "admin" ? Object.assign({ key: "x" }, body) : body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const settle = () => new Promise(res => setTimeout(res, 20));
  const hoop = await lib.createHoop(d1, { name: "5.5in", isCapFrame: false });
  const design = await lib.saveDesign(d1, "league", { name: "Crest", hoopIds: [hoop] });
  await lib.addDesignVersion(d1, design, { machineFileKey: "designs/1/a.dst", machineFileName: "A.DST", machineFileExt: "dst", threadColors: [] });
  const tArt = await lib.createTransfer(d1, { name: "Crest sheet" });
  const gArt = await lib.createGraphic(d1, "league", { name: "Crest transfer", kind: "transfer", transferId: tArt, tier: null });
  const plain = (productId, extra) => lib.createProduct(d1, "league", Object.assign({ productId, type: "shirt", name: productId, pricingMode: "sized", sizePricing: { M: 25, L: 25 }, visible: true, reorderQr: "none" }, extra));
  // No design of its own: the upload is required. A transfer, $5 a piece.
  let r = await call({ action: "createProduct", org: "league", productId: "logo-tee", type: "shirt", name: "Your Logo Tee", pricingMode: "sized", sizePricing: { M: 25, L: 25 }, visible: true, reorderQr: "none",
    customDesign: "transfer", customDesignPrice: "5" });
  ok("a product is created with the setting (the add-on as typed in the form)", r.status === 200);
  // Has a design: the upload is optional and replaces it. Stitched, free.
  await plain("polo", { customDesign: "embroidery" }); await lib.setProductDesign(d1, "league", "polo", design);
  await plain("plain-tee");
  // Configurable: a cap whose only location has no graphics (Custom is the only choice); a hoodie with
  // two locations and a graphic (transfers); a hat with two locations (stitched: one custom spot).
  const cfg = (productId, kind, locations, extra) => lib.createProduct(d1, "league", Object.assign({ productId, type: "cap", name: productId, pricingMode: "flat", flatPrice: 20, visible: true,
    configurable: true, garmentColors: ["Navy", "Red"], reorderQr: "none", locations, customDesign: kind }, extra));
  await cfg("cap", "embroidery", [{ key: "front", label: "Front", graphicIds: [] }], { customDesignPrice: 3 });
  await cfg("hood", "transfer", [{ key: "front", label: "Front", graphicIds: [gArt] }, { key: "back", label: "Back", graphicIds: [gArt] }]);
  await cfg("hat", "embroidery", [{ key: "front", label: "Front", graphicIds: [gArt] }, { key: "back", label: "Back", graphicIds: [gArt] }]);

  console.log("\n=== Uploading (/api/customer-design) ===");
  const R2 = bucket();
  const env = { DB: d1, DESIGNS: R2 };
  const post = async (body, { host = "league", product = "logo-tee", type = "image/png", token = "tok", name = "My logo (1).png", length } = {}) => {
    const h = { "content-type": type, "x-turnstile-token": token, "x-file-name": encodeURIComponent(name), ...(length != null ? { "content-length": String(length) } : {}) };
    const res = await upload.post({ env, request: { url: `https://${host}.example.com/api/customer-design?product=${product}`, method: "POST", body: null,
      headers: { get: (n) => h[String(n).toLowerCase()] ?? null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const good = png(1200, 900);
  ok("refused on the admin address", (await post(good, { host: "admin" })).status === 403);
  ok("refused on an unknown address", (await post(good, { host: "nope" })).status === 403);
  gate.blocked = true; ok("rate limited", (await post(good)).status === 429); gate.blocked = false;
  ok("refused for a shop that isn't open", (await post(good, { host: "closed" })).status === 403);
  ok("refused for a product that doesn't take a design", /doesn't take your own design/.test((await post(good, { product: "plain-tee" })).body.message));
  ok("refused for another shop's product", (await post(good, { host: "other" })).status === 404);
  ok("refused for a product id that can't be one", (await post(good, { product: "Bad%20Id" })).status === 404);
  await d1.prepare("UPDATE products SET visible=0 WHERE productId='polo'").run();
  ok("refused for a hidden product", (await post(good, { product: "polo" })).status === 404);
  await d1.prepare("UPDATE products SET visible=1 WHERE productId='polo'").run();
  ok("refused without the bot check", (await post(good, { token: "" })).status === 403);
  ok("refused: a GIF", (await post(good, { type: "image/gif" })).status === 415);
  ok("refused: over 10 MB (said up front)", (await post(good, { length: 10 * 1024 * 1024 + 1 })).status === 413);
  ok("refused: over 10 MB (counted)", (await post(new Uint8Array(10 * 1024 * 1024 + 1))).status === 413);
  ok("refused: bytes that aren't the type they say", (await post(jpeg(800, 800))).status === 415);
  ok("refused: a header that can't be read", (await post(png(800, 800).slice(0, 18))).status === 415);
  r = await post(png(499, 300));
  ok("refused: under 500 px on the long side, saying the size", r.status === 400 && /too small to reproduce \(499 × 300 px\)/.test(r.body.message));
  ok("refused: over 10,000 px on a side", /at most 10,000 px/.test((await post(png(10001, 600))).body.message));
  d1._raw.run("INSERT INTO customer_design_uploads (id, orgId, productId, fileKey, fileName, fileExt, contentType, bytes, width, height, createdAt) VALUES ('f'||hex(randomblob(15)), 'league', 'logo-tee', 'order-files/pending/x.png', 'x', 'png', 'image/png', ?, 1, 1, ?)",
    [2 * 1024 * 1024 * 1024, new Date().toISOString()]);
  ok("refused: the whole site is over 2 GB in 48 hours", (await post(good)).status === 503);
  d1._raw.run("DELETE FROM customer_design_uploads");
  ok("nothing refused was stored", R2.m.size === 0 && d1.q("SELECT count(*) n FROM customer_design_uploads")[0].n === 0);
  r = await post(good);
  const up1 = r.body.uploadId;
  const row1 = d1.q("SELECT * FROM customer_design_uploads WHERE id=?", up1)[0];
  ok("a good upload: its id, and the size read from the file", r.status === 200 && /^[a-f0-9]{32}$/.test(up1) && r.body.width === 1200 && r.body.height === 900);
  ok("stored privately under order-files/pending/, a key the admin's signed download accepts", /^order-files\/pending\/[a-f0-9]{32}\.png$/.test(row1.fileKey) && DESIGN_KEY_RE.test(row1.fileKey) &&
    R2.m.has(row1.fileKey) && R2.m.get(row1.fileKey).o.httpMetadata.contentType === "image/png" && !row1.fileKey.includes(up1));
  ok("its row: shop, product, cleaned-up name, type, size", row1.orgId === "league" && row1.productId === "logo-tee" && row1.fileName === "My logo (1).png" && row1.fileExt === "png" &&
    row1.bytes === good.length && row1.width === 1200 && row1.height === 900);
  const up2 = (await post(webpLossless(2000, 2000), { type: "image/webp", name: "second.webp" })).body.uploadId;
  const upCap = (await post(jpeg(900, 900, 0xC2), { product: "cap", type: "image/jpeg", name: "cap.jpg" })).body.uploadId;
  const upHood1 = (await post(png(1600, 1600), { product: "hood" })).body.uploadId, upHood2 = (await post(png(1700, 1700), { product: "hood" })).body.uploadId;
  const upHat = (await post(png(800, 800), { product: "hat" })).body.uploadId, upPolo = (await post(png(800, 800), { product: "polo" })).body.uploadId;
  const keyOf = (id) => d1.q("SELECT fileKey FROM customer_design_uploads WHERE id=?", id)[0].fileKey;

  console.log("\n=== Placing an order ===");
  const place = (orderId, items, host = "league") => call({ orderId, orgId: "league", customerName: "Cust " + orderId, contact: "c@x.com", paymentMethod: "Venmo", items }, host);
  r = await place("N1", [{ productId: "logo-tee", size: "M", qty: 1 }]);
  ok("a product with no design of its own is refused without an upload", r.status === 400 && r.body.message === "Upload your design to order Your Logo Tee.");
  ok("…but a quote for it still prices (priceItem never refuses for a missing upload)", (await lib.priceItem(d1, "league", "logo-tee", "M", 1, false)).needsCustomUpload === true);
  const otherUp = (await post(png(800, 800), { host: "other", product: "logo-tee" }));
  await lib.createProduct(d1, "other", { productId: "logo-tee", type: "shirt", name: "Other tee", pricingMode: "sized", sizePricing: { M: 25 }, visible: true, customDesign: "transfer" });
  const otherId = (await post(png(800, 800), { host: "other", product: "logo-tee" })).body.uploadId;
  ok("(another shop's upload exists)", otherUp.status === 404 && /^[a-f0-9]{32}$/.test(otherId));
  r = await place("N2", [{ productId: "logo-tee", size: "M", qty: 1, customUploadId: otherId }]);
  ok("refused: an upload made on another shop", r.status === 400 && /couldn't find your uploaded design/.test(r.body.message));
  r = await place("N3", [{ productId: "logo-tee", size: "M", qty: 1, customUploadId: upCap }]);
  ok("refused: an upload made for another product", r.status === 400 && /couldn't find/.test(r.body.message));
  r = await place("N4", [{ productId: "logo-tee", size: "M", qty: 1, customUploadId: "../../etc" }]);
  ok("refused: an id that can't be one", r.status === 400 && /couldn't find/.test(r.body.message));
  d1._raw.run("UPDATE customer_design_uploads SET createdAt=? WHERE id=?", [new Date(Date.now() - 25 * 3600e3).toISOString(), up2]);
  r = await place("N5", [{ productId: "logo-tee", size: "M", qty: 1, customUploadId: up2 }]);
  ok("refused: an upload over 24 hours old", r.status === 400 && /expired/.test(r.body.message));
  r = await place("N6", [{ productId: "plain-tee", size: "M", qty: 1, customUploadId: up1 }]);
  ok("refused: a design on a product that doesn't take one", r.status === 400);
  ok("nothing refused was recorded", d1.q("SELECT count(*) n FROM orders")[0].n === 0 && d1.q("SELECT count(*) n FROM order_item_files")[0].n === 0);

  r = await place("A1", [{ productId: "logo-tee", size: "M", qty: 2, customUploadId: up1 }, { productId: "logo-tee", size: "L", qty: 1, customUploadId: up1 }]);
  let o = await lib.getOrderById(d1, "A1");
  const e1 = o.items[0].config && o.items[0].config.locations[0];
  ok("a good order: the add-on is in the price ($25 + $5)", r.status === 200 && o.items[0].unitPrice === 30 && o.items[0].lineTotal === 60 && o.effectiveTotal === 90);
  ok("the line's copy of its options carries the customer's design", o.items[0].config.plain === true && o.items[0].config.locations.length === 1 && e1.location === "customdesign" && e1.custom === true &&
    e1.kind === "transfer" && e1.graphicId === null && e1.graphicName === "Your own design" && e1.uploadId === up1 && e1.fileKey === keyOf(up1) && e1.fileName === "My logo (1).png" &&
    e1.fileExt === "png" && e1.addOnCents === 500 && e1.imageUrl === "" && e1.thumbUrl === "");
  const files1 = await lib.getOrderItemFiles(d1, o.items[0].sheetRow), files1b = await lib.getOrderItemFiles(d1, o.items[1].sheetRow);
  ok("the customer's file is recorded on each line it's on (the same art in M and L)", files1.length === 1 && files1[0].uploadedBy === "customer" && files1[0].fileKey === keyOf(up1) &&
    files1[0].fileName === "My logo (1).png" && files1b.length === 1 && files1b[0].fileKey === keyOf(up1));
  r = await place("A2", [{ productId: "cap", size: "OSFA", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", custom: true }] } }]);
  ok("a configurable product's Custom choice needs its upload", r.status === 400 && /Upload your design to order cap/.test(r.body.message));
  r = await place("A2", [{ productId: "cap", size: "OSFA", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", custom: true, uploadId: upCap }] } }]);
  o = await lib.getOrderById(d1, "A2");
  const capItem = o.items[0];
  ok("a configurable order with Custom as the only option: priced $20 + $3, the entry in its copy, the file on the line", r.status === 200 && capItem.unitPrice === 23 &&
    capItem.config.locations.length === 1 && capItem.config.locations[0].custom === true && capItem.config.locations[0].kind === "embroidery" && capItem.config.locations[0].label === "Front" &&
    capItem.config.locations[0].fileKey === keyOf(upCap) && (await lib.getOrderItemFiles(d1, capItem.sheetRow)).length === 1);
  r = await place("A3", [{ productId: "hat", size: "OSFA", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", custom: true, uploadId: upHat }, { location: "back", custom: true, uploadId: upHat }] } }]);
  o = await lib.getOrderById(d1, "A3");
  ok("stitched: the customer's design can go in as many spots as they like", r.status === 200 && o.items[0].config.locations.filter(l => l.custom && l.kind === "embroidery").length === 2);
  r = await place("A3G", [{ productId: "hat", size: "OSFA", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", custom: true, uploadId: upHat }, { location: "back", graphicId: gArt }] } }]);
  ok("…and one custom spot plus a graphic is fine", r.status === 200);
  r = await place("A4", [{ productId: "hood", size: "OSFA", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", custom: true, uploadId: upHood1 }, { location: "back", custom: true, uploadId: upHood2 }] } }]);
  o = await lib.getOrderById(d1, "A4");
  ok("printed: two custom spots are allowed, each with its own file", r.status === 200 && o.items[0].config.locations.filter(l => l.custom).length === 2 &&
    (await lib.getOrderItemFiles(d1, o.items[0].sheetRow)).length === 2);
  r = await place("A5", [{ productId: "polo", size: "M", qty: 1 }, { productId: "polo", size: "L", qty: 1, customUploadId: upPolo }]);
  o = await lib.getOrderById(d1, "A5");
  ok("a product with its own design: no upload needed; with one it's on that line only (free here)", r.status === 200 && !o.items[0].config && o.items[1].config.locations[0].custom === true && o.items[1].unitPrice === 25);

  console.log("\n=== Stages ===");
  o = await lib.getOrderById(d1, "A2");
  ok("a stitched customer design needs design approval and digitizing", o.needsDesignApproval === true && o.needsDigitizing === true && o.orderDesignsMissing === 1);
  ok("Digitizing complete waits for its stitch file", lib.stagePrereqError(Object.assign({}, o, { paid: true }), "digitizingComplete") === "1 order design hasn't been uploaded yet (Edit items → Files → Order design)");
  o = await lib.getOrderById(d1, "A3");
  ok("two stitched spots need two order designs, one each", o.orderDesignsMissing === 2 && lib.stagePrereqError(Object.assign({}, o, { paid: true }), "digitizingComplete") === "2 order designs haven't been uploaded yet (Edit items → Files → Order design)");
  o = await lib.getOrderById(d1, "A1");
  ok("a printed customer design needs neither (v1: printed as uploaded)", o.needsDesignApproval === false && o.orderDesignsMissing === 0);
  ok("the order lists show the same", (await lib.getOpenOrders(d1)).find(x => x.orderId === "A2").needsDesignApproval === true && (await lib.getOpenOrders(d1)).find(x => x.orderId === "A2").orderDesignsMissing === 1);
  const ready = (id) => { for (const [col, v] of Object.entries({ paid: 1, blankReceivedAt: "2026-10-03", designApprovedAt: "2026-10-04", digitizingCompleteAt: "2026-10-03" })) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]); };
  ["A1", "A2", "A3", "A3G", "A4", "A5"].forEach(ready);
  let jobs = await lib.getProductionQueue(d1);
  const job = (id) => jobs.filter(j => j.orderId === id);
  ok("Run Order: the custom spot is a hooping that waits for the stitch file", job("A2").length === 1 && job("A2")[0].steps.length === 1 && job("A2")[0].steps[0].kind === "itemDesign" &&
    job("A2")[0].steps[0].designName === "Customer design" && /Upload the digitized stitch file/.test(job("A2")[0].steps[0].blocked));
  ok("…next to the graphic's own hooping on a line that has both", job("A3G").length === 1 && job("A3G")[0].steps.length === 1 && job("A3G")[0].steps[0].kind === "itemDesign");
  const hatSteps = () => job("A3")[0].steps;
  ok("two stitched spots are two hoopings, each waiting for its own stitch file", hatSteps().length === 2 && hatSteps().every(st => st.kind === "itemDesign") &&
    hatSteps().map(st => st.itemDesignLocation).join() === "front,back" && /at Front/.test(hatSteps()[0].blocked) && /at Back/.test(hatSteps()[1].blocked));
  const hatItem = (await lib.getOrderById(d1, "A3")).items[0].sheetRow;
  r = await call({ action: "saveOrderItemDesign", org: "league", itemId: hatItem, location: "sleeve", machineFileKey: `order-files/${hatItem}/bbbb.dst`, machineFileName: "X.DST", machineFileExt: "dst" });
  ok("a stitch file for a location the item doesn't have is refused", r.status === 400 && /doesn't have the customer's design/.test(r.body.message));
  r = await call({ action: "saveOrderItemDesign", org: "league", itemId: hatItem, location: "front", machineFileKey: `order-files/${hatItem}/ffff.dst`, machineFileName: "FRONT.DST", machineFileExt: "dst" });
  jobs = await lib.getProductionQueue(d1);
  ok("uploading the Front's stitch file frees the Front hooping only", r.status === 200 && hatSteps()[0].blocked === "" && hatSteps()[0].machineFileKey === `order-files/${hatItem}/ffff.dst` &&
    !!hatSteps()[1].blocked && (await lib.getOrderById(d1, "A3")).orderDesignsMissing === 1);
  await call({ action: "saveOrderItemDesign", org: "league", itemId: hatItem, location: "back", machineFileKey: `order-files/${hatItem}/eeee.dst`, machineFileName: "BACK.DST", machineFileExt: "dst" });
  jobs = await lib.getProductionQueue(d1);
  ok("…and the Back's the Back's", hatSteps()[1].machineFileKey === `order-files/${hatItem}/eeee.dst` && hatSteps()[0].machineFileKey === `order-files/${hatItem}/ffff.dst` &&
    (await lib.getOrderById(d1, "A3")).orderDesignsMissing === 0);
  const poloJob = job("A5").find(j => j.itemSize === "L"), poloPlain = job("A5").find(j => j.itemSize === "M");
  ok("an ordinary line's design is replaced by one Customer design hooping on the main design's hoops", poloJob && poloJob.steps.length === 1 && poloJob.steps[0].designName === "Customer design" &&
    JSON.stringify(poloJob.steps[0].hoopIds) === JSON.stringify([hoop]) && !!poloJob.steps[0].blocked && poloPlain.steps[0].designId === design);
  ok("printed lines aren't on Run Order", job("A1").length === 0 && job("A4").length === 0);
  await lib.addOrderItemDesign(d1, capItem.sheetRow, { machineFileKey: "order-files/9/aaaa.dst", machineFileName: "CAP.DST", machineFileExt: "dst", threadColors: [{ needle: 1, threadId: 1 }] });
  jobs = await lib.getProductionQueue(d1);
  ok("once the stitch file is uploaded the hooping can run (a design with no location counts for a line's only spot)", job("A2")[0].steps[0].blocked === "" && job("A2")[0].steps[0].machineFileKey === "order-files/9/aaaa.dst");
  o = await lib.getOrderById(d1, "A2");
  ok("…and Digitizing complete is allowed", o.orderDesignsMissing === 0 && lib.stagePrereqError(Object.assign({}, o, { paid: true }), "digitizingComplete") === "");

  console.log("\n=== Run Transfer Sheets ===");
  const q = await lib.getTransferQueue(d1), cards = q.ready.concat(q.waiting);
  const card = cards.find(c => c.orderId === "A1" && c.itemSize === "M");
  ok("a printed customer design is on Run Transfer Sheets with its file", card && card.transfers.length === 1 && card.transfers[0].custom === true && card.transfers[0].fileKey === keyOf(up1) &&
    card.transfers[0].fileName === "My logo (1).png" && card.hasEmbroidery === false);
  ok("…and both of the hoodie's spots", cards.find(c => c.orderId === "A4").transfers.filter(t => t.custom).length === 2);
  const gang = await lib.getGangSheet(d1);
  const customRows = gang.filter(g => g.custom);
  ok("the gang sheet keeps every customer's art apart (by file), never adding two designs up", customRows.length === 4 && new Set(customRows.map(g => g.fileKey + g.size)).size === 4 &&
    customRows.find(g => g.fileKey === keyOf(up1) && g.size === "M").count === 2 && customRows.every(g => /^Customer design — Cust A\d \(A\d\)$/.test(g.graphic)));
  d1._raw.run("UPDATE order_items SET transferReceivedAt='2026-10-05' WHERE orderId='A1'");
  r = await call({ action: "makeTransferLine", orderId: "A1", itemId: (await lib.getOrderById(d1, "A1")).items[0].sheetRow, org: "league" });
  ok("making it uses no transfer stock (there's no stock transfer for a customer's art)", r.status === 200 && d1.q("SELECT count(*) n FROM transfer_movements WHERE kind='consume'")[0].n === 0);

  console.log("\n=== An old database (migrations up to 0031) still loads orders ===");
  const old = await createD1();
  old._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < "0032").sort()) old.execFile(read("migrations/" + f));
  old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1);`);
  let oldOk = true;
  try {
    await lib.insertOrder(old, { orderId: "OLD1", orgId: "league", customerName: "Old", contact: "o@x.com", placedAt: new Date().toISOString() }, [{ productId: "", name: "Tee", type: "shirt", size: "M", qty: 1, unitPrice: 10, personalizationFee: 0 }]);
    const oo = await lib.getOrderById(old, "OLD1"), open = await lib.getOpenOrders(old);
    oldOk = !!oo && oo.items.length === 1 && open.some(x => x.orderId === "OLD1");
  } catch (e) { console.error(e); oldOk = false; }
  ok("getOrderById and the order lists work without order_items.configJson", oldOk);

  console.log("\n=== The admin ===");
  r = await call({ action: "createLocalSale", org: "league", customerName: "Walk-in", items: [{ productId: "logo-tee", name: "Your Logo Tee", type: "shirt", size: "M", qty: 1 }] });
  ok("a local sale of a product that needs an upload isn't refused (the admin attaches the file with Files)", r.status === 200);
  const a1 = await lib.getOrderById(d1, "A1");
  const lineL = a1.items[1];
  r = await call({ action: "editOrder", org: "league", orderId: "A1", updates: [{ itemId: lineL.sheetRow, productId: "logo-tee", size: "M", qty: 3,
    config: { locations: [{ location: "customdesign", custom: true, fileKey: "order-files/1/evil.png", uploadId: up2 }] } }] });
  let edited = (await lib.getOrderById(d1, "A1")).items[1];
  ok("Edit items keeps the customer's design, from the line's own copy — never the request's", r.status === 200 && edited.size === "M" && edited.qty === 3 && edited.unitPrice === 30 &&
    edited.config.locations.length === 1 && edited.config.locations[0].fileKey === keyOf(up1) && edited.config.locations[0].uploadId === up1);
  r = await call({ action: "editOrder", org: "league", orderId: "A2", updates: [{ itemId: capItem.sheetRow, productId: "cap", size: "OSFA", qty: 1, config: { garmentColor: "Red", locations: [{ location: "front", custom: true }] } }] });
  edited = (await lib.getOrderById(d1, "A2")).items[0];
  ok("…and a configurable line's Custom pick, with a new color", r.status === 200 && edited.config.garmentColor === "Red" && edited.config.locations[0].custom === true &&
    edited.config.locations[0].fileKey === keyOf(upCap) && edited.unitPrice === 23);
  await d1.prepare("UPDATE products SET customDesign='', customDesignPriceCents=NULL WHERE productId='cap'").run();
  r = await call({ action: "editOrder", org: "league", orderId: "A2", updates: [{ itemId: capItem.sheetRow, productId: "cap", size: "OSFA", qty: 2, config: { garmentColor: "Red", locations: [{ location: "front", custom: true }] } }] });
  edited = (await lib.getOrderById(d1, "A2")).items[0];
  ok("…even after the product stops offering it (kept at what it was ordered with)", r.status === 200 && edited.qty === 2 && edited.config.locations[0].kind === "embroidery" && edited.unitPrice === 23);
  ok("a new order can't have it any more", /no longer takes your own design/.test((await place("N7", [{ productId: "cap", size: "OSFA", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", custom: true, uploadId: upCap }] } }])).body.message));
  await d1.prepare("UPDATE products SET customDesign='embroidery', customDesignPriceCents=300 WHERE productId='cap'").run();
  const tQr = await lib.createTransfer(d1, { name: "QR" });
  await lib.setOrgReorderQrTransfer(d1, "league", tQr);
  await d1.prepare("UPDATE products SET reorderQr='default' WHERE productId='logo-tee'").run();
  await lib.refreshOrderLinesFromCatalog(d1, "A1");
  const refreshed = (await lib.getOrderById(d1, "A1")).items[1].config;
  ok("Update from catalog keeps the customer's design and adds the QR", refreshed.plain === true && refreshed.locations.length === 2 && refreshed.locations[0].custom === true &&
    refreshed.locations[0].fileKey === keyOf(up1) && refreshed.locations[1].auto === true);

  const issues = async () => ((await lib.getCatalogIssues(d1, "league")).orgs.league.products["logo-tee"] || []).map(i => i.code);
  ok("the catalog check doesn't flag a product the customer supplies the design for", !(await issues()).includes("noDesign"));
  await d1.prepare("UPDATE products SET customDesign='' WHERE productId='logo-tee'").run();
  ok("…and does once the setting is off", (await issues()).includes("noDesign"));
  await d1.prepare("UPDATE products SET customDesign='transfer' WHERE productId='logo-tee'").run();
  const cat = JSON.parse(await (await catalogApi({ request: { url: "https://league.example.com/api/catalog", headers: { get: () => null } }, env: { DB: d1 } })).text());
  const cp = (id) => cat.catalog.products.find(p => p.id === id);
  ok("the shop page gets the setting: how, the add-on, and whether it's required", JSON.stringify(cp("logo-tee").customDesign) === JSON.stringify({ kind: "transfer", price: 5, required: true }) &&
    JSON.stringify(cp("polo").customDesign) === JSON.stringify({ kind: "embroidery", price: null, required: false }) && cp("cap").customDesign.required === false && !cp("plain-tee").customDesign);
  const prodOf = async (id) => (await lib.getProductsByOrg(d1, "league", false)).find(p => p.productId === id);
  r = await call({ action: "updateProduct", org: "league", productId: "logo-tee", type: "shirt", name: "Your Logo Tee", pricingMode: "sized", sizePricing: { M: 26, L: 26 }, visible: true });
  let lp = await prodOf("logo-tee");
  ok("an update that doesn't send the field leaves it alone", r.status === 200 && lp.customDesign === "transfer" && lp.customDesignPrice === 5);
  r = await call({ action: "updateProduct", org: "league", productId: "logo-tee", type: "shirt", name: "Your Logo Tee", pricingMode: "sized", sizePricing: { M: 26, L: 26 }, visible: true, customDesign: "embroidery", customDesignPrice: 7.5 });
  await settle();
  lp = await prodOf("logo-tee");
  const auditRow = d1.q("SELECT detail FROM audit_log WHERE action='product.updated' ORDER BY id DESC LIMIT 1")[0];
  const changes = auditRow && JSON.parse(auditRow.detail).changes;
  ok("changing it is saved and audited, from → to", lp.customDesign === "embroidery" && lp.customDesignPrice === 7.5 && changes && changes.customDesign.from === "transfer" &&
    changes.customDesign.to === "embroidery" && changes.customDesignPrice.from === 5 && changes.customDesignPrice.to === 7.5);
  ok("without file storage the setting can't be turned on", /needs file storage/.test((await call({ action: "updateProduct", org: "league", productId: "logo-tee", type: "shirt", name: "x", pricingMode: "flat", flatPrice: 1, visible: true, customDesign: "transfer" }, "admin", { DB: d1 })).body.message));
  ok("a kind it doesn't know is refused", (await call({ action: "updateProduct", org: "league", productId: "logo-tee", type: "shirt", name: "x", pricingMode: "flat", flatPrice: 1, visible: true, customDesign: "laser" })).status === 400);
  ok("an add-on over $1,000 or below $0 is refused", (await call({ action: "updateProduct", org: "league", productId: "logo-tee", type: "shirt", name: "x", pricingMode: "flat", flatPrice: 1, visible: true, customDesign: "transfer", customDesignPrice: 1000.01 })).status === 400 &&
    (await call({ action: "updateProduct", org: "league", productId: "logo-tee", type: "shirt", name: "x", pricingMode: "flat", flatPrice: 1, visible: true, customDesign: "transfer", customDesignPrice: -1 })).status === 400);
  r = await call({ action: "updateProduct", org: "league", productId: "logo-tee", type: "shirt", name: "Your Logo Tee", pricingMode: "sized", sizePricing: { M: 25, L: 25 }, visible: true, customDesign: "transfer", customDesignPrice: "" });
  ok("a blank add-on is free (saved as none)", r.status === 200 && (await prodOf("logo-tee")).customDesignPrice === null);

  console.log("\n=== A price for each upload location ===");
  const hoodLocs = (extra) => [{ key: "front", label: "Front", graphicIds: [gArt], ...extra }, { key: "back", label: "Back", graphicIds: [gArt] }];
  const hoodBody = (locations, more) => Object.assign({ action: "updateProduct", org: "league", productId: "hood", type: "cap", name: "hood", pricingMode: "flat", flatPrice: 20, visible: true,
    configurable: true, garmentColors: ["Navy", "Red"], locations, customDesign: "transfer", customDesignPrice: 2 }, more);
  r = await call(hoodBody(hoodLocs({ customDesignPrice: "1001" })));
  ok("a location's add-on over $1,000 is refused, naming the location", r.status === 400 && /at Front must be between \$0 and \$1,000/.test(r.body.message));
  r = await call(hoodBody(hoodLocs({ customDesignPrice: "4.25" })));
  const hoodNow = await prodOf("hood");
  ok("a location's add-on is saved in whole cents on the location; a blank one isn't stored", r.status === 200 && hoodNow.locations[0].customDesignPriceCents === 425 &&
    !("customDesignPrice" in hoodNow.locations[0]) && !("customDesignPriceCents" in hoodNow.locations[1]));
  const upH1 = (await post(png(1600, 1600), { product: "hood" })).body.uploadId, upH2 = (await post(png(1600, 1600), { product: "hood" })).body.uploadId;
  r = await place("LP1", [{ productId: "hood", size: "OSFA", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", custom: true, uploadId: upH1 }, { location: "back", custom: true, uploadId: upH2 }] } }]);
  let lp1 = (await lib.getOrderById(d1, "LP1")).items[0];
  ok("each location is priced at its own add-on, else the product's ($20 + $4.25 + $2)", r.status === 200 && lp1.unitPrice === 26.25 &&
    lp1.config.locations.find(l => l.location === "front").addOnCents === 425 && lp1.config.locations.find(l => l.location === "back").addOnCents === 200);
  const catNow = JSON.parse(await (await catalogApi({ request: { url: "https://league.example.com/api/catalog", headers: { get: () => null } }, env: { DB: d1 } })).text());
  ok("the shop page gets each location's add-on", catNow.catalog.products.find(p => p.id === "hood").locations[0].customDesignPriceCents === 425);
  r = await call(hoodBody(hoodLocs({ customDesignPrice: "" })));
  ok("clearing it goes back to the product's", r.status === 200 && !("customDesignPriceCents" in (await prodOf("hood")).locations[0]));
  r = await call(hoodBody(hoodLocs({ customDesignPrice: 0 })));
  ok("…and $0 makes that location free", r.status === 200 && (await prodOf("hood")).locations[0].customDesignPriceCents === 0);
  await call(hoodBody(hoodLocs({ customDesignPrice: "4.25" })));

  const custFile = (await lib.getOrderItemFiles(d1, a1.items[0].sheetRow))[0];
  r = await call({ action: "deleteOrderItemFile", id: custFile.id });
  ok("the customer's file can't be deleted from Files", r.status === 409 && (await lib.getOrderItemFiles(d1, a1.items[0].sheetRow)).length === 1);
  r = await call({ action: "saveOrderItemFile", itemId: a1.items[0].sheetRow, fileKey: "order-files/1/bbbb.png", fileName: "b.png", fileExt: "png", uploadedBy: "customer" });
  ok("a file the admin adds is always the shop's, whatever the request says", r.status === 200 && (await lib.getOrderItemFiles(d1, a1.items[0].sheetRow)).find(f => f.fileName === "b.png").uploadedBy === "admin");

  console.log("\n=== The daily clean-up ===");
  const stale = new Date(Date.now() - 49 * 3600e3).toISOString();
  d1._raw.run("UPDATE customer_design_uploads SET createdAt=? WHERE id IN (?, ?, ?)", [stale, up1, up2, upHat]);
  d1._raw.run("INSERT INTO customer_design_uploads (id, orgId, productId, fileKey, fileName, fileExt, contentType, bytes, width, height, createdAt) VALUES (?, 'league', 'x', 'designs/1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'x', 'png', 'image/png', 1, 1, 1, ?)",
    ["e".repeat(32), stale]);
  const before = R2.m.size, key2 = keyOf(up2);
  const c = await upload.cleanUp(env);
  const left = d1.q("SELECT id FROM customer_design_uploads").map(x => x.id);
  ok("it deletes only stale uploads no order points to (the file and the row)", c.deleted === 1 && !left.includes(up2) && !R2.m.has(key2) && R2.m.has(keyOf(up1)) && R2.m.size === before - 1);
  ok("…keeping a stale one an order uses, recent ones, and anything outside order-files/pending/", left.includes(up1) && left.includes(upHat) && left.includes(upCap) && left.includes("e".repeat(32)));

  // ---- The shop page (jsdom) ----
  console.log("\n=== The shop page ===");
  const shopCatalog = { status: "ok", orgId: "league", catalog: { name: "League", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
    enabledPayments: [], salesTaxRate: 0, deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }],
    graphics: [{ id: 1, name: "Logo", kind: "embroidery", imageUrl: "", thumbUrl: "", addOnCents: 0, inkColors: [], allowedLocations: [], allowedGarmentColors: [] }],
    products: [
      { id: "logo-tee", type: "shirt", name: "Your Logo Tee", sub: "", images: [], features: [], sizePricing: { M: 25, L: 25 }, customDesign: { kind: "transfer", price: 5, required: true } },
      { id: "polo", type: "shirt", name: "Polo", sub: "", images: [], features: [], sizePricing: { M: 30 }, customDesign: { kind: "embroidery", price: null, required: false } },
      { id: "cap", type: "cap", name: "Cap", sub: "", images: [], features: [], configurable: true, garmentColors: ["Navy"], flatPrice: 20,
        locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [] }], customDesign: { kind: "embroidery", price: 3, required: false } },
      { id: "hat", type: "cap", name: "Hat", sub: "", images: [], features: [], configurable: true, garmentColors: ["Navy"], flatPrice: 10,
        locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [1], customDesignPriceCents: 250 }, { key: "back", label: "Back", locationId: 2, graphicIds: [1] }], customDesign: { kind: "embroidery", price: null, required: false } },
    ] } };
  const uploads = [], orders = [], revoked = [];
  let nUrl = 0, bitmap = null;
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", url: "https://league.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.alert = (m) => { win._alerts = (win._alerts || []).concat(m); };
      win.URL.createObjectURL = () => "blob:https://league.example.com/u" + (++nUrl);
      win.URL.revokeObjectURL = (u) => { revoked.push(u); };
      win.createImageBitmap = async () => bitmap || { width: 1200, height: 900, close(){} };
      win.fetch = async (url, init) => {
        if (String(url).startsWith("/api/customer-design")) { uploads.push({ url: String(url), headers: init.headers, body: init.body });
          return { ok: true, status: 200, json: async () => ({ status: "ok", uploadId: "a".repeat(32), width: 1200, height: 900 }) }; }
        if (String(url).startsWith("/api/orders")) { orders.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
        return { ok: true, status: 200, json: async () => shopCatalog, text: async () => JSON.stringify(shopCatalog) };
      };
    } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 200));
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  const choose = async (input, name, type = "image/png") => {
    Object.defineProperty(input, "files", { value: [new w.File([new Uint8Array(100)], name, { type })], configurable: true });
    input.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  const box = (pid, loc) => d.getElementById("cd-" + pid + "-" + loc);
  ok("a product that needs the customer's design shows the box, saying so and the add-on", !!box("logo-tee", "customdesign") && !box("logo-tee", "customdesign").hidden &&
    /Your design \(required\) \+\$5\.00/.test(d.querySelector("#price-logo-tee").closest(".product").textContent) && /PNG, JPG or WebP \(an iPhone or iPad photo is fine\) · up to 10 MB · at least 500 px/.test(box("logo-tee", "customdesign").textContent));
  ok("its listed price includes the add-on", d.getElementById("price-logo-tee").textContent === "$30.00");
  ok("the file box doesn't trigger the price refresh (no data-pid)", !box("logo-tee", "customdesign").querySelector(".cd-file").hasAttribute("data-pid"));
  d.querySelector('[data-action="add"][data-pid="logo-tee"]').click();
  ok("Add is refused until the design is uploaded", d.getElementById("cmsg-logo-tee").textContent === "Upload your design to order this item." && w.eval("cart").length === 0);
  bitmap = { width: 400, height: 300, close(){} };
  await choose(box("logo-tee", "customdesign").querySelector(".cd-file"), "tiny.png");
  await until(() => /too small/.test(box("logo-tee", "customdesign").querySelector(".cd-status").textContent));
  ok("an image too small is refused in the browser, before uploading", /too small to reproduce \(400 × 300 px\)/.test(box("logo-tee", "customdesign").querySelector(".cd-status").textContent) && uploads.length === 0);
  bitmap = null;
  await choose(box("logo-tee", "customdesign").querySelector(".cd-file"), "a.gif", "image/gif");
  await until(() => /PNG, JPG or WebP image/.test(box("logo-tee", "customdesign").querySelector(".cd-status").textContent));
  ok("so is a GIF", uploads.length === 0);
  await choose(box("logo-tee", "customdesign").querySelector(".cd-file"), "<b>my logo</b>.png");
  await until(() => /Uploaded/.test(box("logo-tee", "customdesign").querySelector(".cd-status").textContent));
  ok("a good image is uploaded: the product, the type, the file name in a header (not the address)", uploads.length === 1 && uploads[0].url === "/api/customer-design?product=logo-tee" &&
    uploads[0].headers["Content-Type"] === "image/png" && uploads[0].headers["X-File-Name"] === encodeURIComponent("<b>my logo</b>.png") && !uploads[0].url.includes("logo</b>"));
  ok("the preview opens in the zoom viewer (a.zoom-link > img)", !!box("logo-tee", "customdesign").querySelector(".cd-preview a.zoom-link > img") &&
    box("logo-tee", "customdesign").getAttribute("role") === null && box("logo-tee", "customdesign").querySelector(".cd-status").getAttribute("role") === "alert");
  ok("a printed design under 1500 px gets the soft warning", /may print soft/.test(box("logo-tee", "customdesign").querySelector(".cd-status").textContent));
  d.querySelector('[data-action="add"][data-pid="logo-tee"]').click();
  d.getElementById("size-logo-tee").value = "L";
  d.querySelector('[data-action="add"][data-pid="logo-tee"]').click();
  const cart = w.eval("cart");
  ok("added with its upload and the add-on, and the upload stays picked for another size", cart.length === 2 && cart[0].customUploadId === "a".repeat(32) && cart[0].unitPrice === 30 &&
    cart[1].size === "L" && cart[1].customUploadId === "a".repeat(32));
  const lines = d.querySelectorAll("#ticketPanel .cd-cart");
  ok("the cart shows a thumbnail and the file name, escaped", lines.length === 2 && lines[0].querySelector("img").getAttribute("src").startsWith("blob:") &&
    lines[0].textContent.includes("<b>my logo</b>.png") && !lines[0].querySelector("b"));
  const firstUrl = cart[0].cdPreviews[0].url;
  d.querySelector('#ticketPanel [data-action="remove"]').click();
  ok("removing a line frees its preview", revoked.includes(firstUrl) && w.eval("cart").length === 1);

  // Ordinary product with a design: optional.
  ok("a product with its own design offers “Use my own design instead”, box hidden", !!d.getElementById("cdon-polo") && box("polo", "customdesign").hidden && /Use my own design instead/.test(d.getElementById("cdon-polo").parentNode.textContent));
  d.querySelector('[data-action="add"][data-pid="polo"]').click();
  ok("…which can be added without one", w.eval("cart").length === 2 && !w.eval("cart")[1].customUploadId);
  d.getElementById("cdon-polo").checked = true; d.getElementById("cdon-polo").dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("ticking it shows the box", !box("polo", "customdesign").hidden);
  d.querySelector('[data-action="add"][data-pid="polo"]').click();
  ok("…and then needs the upload", /untick “Use my own design instead”/.test(d.getElementById("cmsg-polo").textContent) && w.eval("cart").length === 2);

  // Configurable.
  const capSel = d.getElementById("loc-cap-front");
  ok("a configurable product offers Custom — upload your own, with its price; with no graphics it's preselected", [...capSel.options].map(o => o.textContent).join("|") === "Custom — upload your own (+$3.00)" &&
    capSel.value === "custom" && !box("cap", "front").hidden);
  ok("its price and breakdown include the add-on", d.getElementById("price-cap").textContent === "$23.00" && /Front: Your own design[\s\S]*\+\$3\.00/.test(d.getElementById("cbd-cap").textContent));
  ok("Add waits for the upload", d.getElementById("cadd-cap").disabled === true && /Upload your design/.test(d.getElementById("chint-cap").textContent));
  await choose(box("cap", "front").querySelector(".cd-file"), "cap.png");
  await until(() => d.getElementById("cadd-cap").disabled === false);
  ok("once uploaded Add is enabled and the preview shows", d.getElementById("cadd-cap").disabled === false && !!d.querySelector("#cpreview-cap a.zoom-link img"));
  d.getElementById("cadd-cap").click();
  const capLine = w.eval("cart")[2];
  ok("the cart line sends {location, custom: true, uploadId}", capLine && JSON.stringify(capLine.config.locations) === JSON.stringify([{ location: "front", custom: true, uploadId: "a".repeat(32) }]) && capLine.unitPrice === 23);
  const hatFront = d.getElementById("loc-hat-front"), hatBack = d.getElementById("loc-hat-back");
  ok("a location's own add-on is in its Custom label; another location uses the product's (free here)", hatFront.querySelector('option[value="custom"]').textContent === "Custom — upload your own (+$2.50)" &&
    hatBack.querySelector('option[value="custom"]').textContent === "Custom — upload your own");
  hatFront.value = "custom"; hatFront.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("…and in the price", d.getElementById("price-hat").textContent === "$12.50");
  d.getElementById("loc-hat-back").value = "custom"; d.getElementById("loc-hat-back").dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("stitched: Custom can be picked at every location, each with its own upload box", d.getElementById("loc-hat-front").value === "custom" && d.getElementById("loc-hat-back").value === "custom" &&
    !box("hat", "front").hidden && !box("hat", "back").hidden && !d.getElementById("loc-hat-back").querySelector('option[value="custom"]').disabled);

  // Placing the order: previews stay in the page.
  d.getElementById("custName").value = "Pat"; d.getElementById("custContact").value = "pat@x.com";
  const kept = w.eval("cart").flatMap(c => (c.cdPreviews || []).map(p => p.url));
  await w.placeOrder("league");
  await until(() => orders.length === 1);
  ok("the order POST carries the upload ids and none of the preview fields", orders.length === 1 && orders[0].items[0].customUploadId === "a".repeat(32) &&
    orders[0].items.every(i => !("cdPreviews" in i)) && orders[0].items[2].config.locations[0].uploadId === "a".repeat(32));
  ok("clearing the cart frees the cart's previews", kept.length === 2 && kept.every(u => revoked.includes(u)));

  // ---- The admin (jsdom) ----
  console.log("\n=== The admin ===");
  const adminJs = read("public/admin.js");
  const calls = [];
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const adom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true);
      win.fetch = async (url, init) => {
        const b = init && init.body ? JSON.parse(init.body) : {};
        if (b.action) calls.push(b);
        if (String(url).includes("/api/orders") && b.action) { const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
        return { ok: true, status: 200, json: async () => ({ status: "admin" }) };
      }; } });
  const aw = adom.window, ad = aw.document;
  await new Promise(res => setTimeout(res, 150));
  await aw.loadAdminScript();
  aw.eval(`adminKey = "cookie"; adminOrgs = [{orgId:"league", name:"League"}];`);
  const app = ad.getElementById("app");
  aw.renderProductForm(app, "league", await prodOf("polo"));
  await new Promise(res => setTimeout(res, 120));
  const kindSel = ad.getElementById("prodFormCustomDesign");
  ok("the product form has the setting and the add-on", !!kindSel && [...kindSel.options].map(o => o.textContent).join("|") ===
    "Off|Embroidery (you upload the stitch file before Digitizing complete)|Transfer (printed from their image)" && kindSel.value === "embroidery" && ad.getElementById("prodFormCustomDesignPrice").value === "" &&
    /Add-on per piece \(blank = free\)/.test(ad.getElementById("prodFormCustomDesignPrice").parentNode.textContent));
  kindSel.value = "transfer"; ad.getElementById("prodFormCustomDesignPrice").value = "4.5";
  calls.length = 0;
  await aw.submitProductForm("league", true);
  await until(() => calls.some(x => x.action === "updateProduct"));
  const sent = calls.find(x => x.action === "updateProduct");
  ok("…and sends both", sent && sent.customDesign === "transfer" && sent.customDesignPrice === 4.5 && (await prodOf("polo")).customDesign === "transfer");

  console.log("\n=== A configurable product: a price per upload location, colors without a blank ===");
  aw.renderProductForm(app, "league", await prodOf("hood"));
  await until(() => ad.querySelector(".cfgLocCustomPrice") && ad.getElementById("cfgColorAdd"));
  const lpInputs = [...ad.querySelectorAll(".cfgLocCustomPrice")];
  ok("each location has its own add-on box, showing what's saved (blank = the product's)", lpInputs.length === 2 && lpInputs[0].value === "4.25" && lpInputs[1].value === "" &&
    lpInputs[0].closest(".cfgLocCustomWrap").style.display === "block");
  ad.getElementById("prodFormCustomDesign").value = ""; ad.getElementById("prodFormCustomDesign").dispatchEvent(new aw.Event("change", { bubbles: true }));
  ok("…hidden while the customer's own design is off", lpInputs[0].closest(".cfgLocCustomWrap").style.display === "none");
  ad.getElementById("prodFormCustomDesign").value = "transfer"; ad.getElementById("prodFormCustomDesign").dispatchEvent(new aw.Event("change", { bubbles: true }));
  lpInputs[1].value = "1.5";
  ok("with no blanks in the catalog a color can be typed in", /No blanks in the catalog yet/.test(ad.getElementById("cfgBlankPick").textContent) && /optional/.test(ad.getElementById("cfgBlankPick").textContent));
  ad.getElementById("cfgColorAdd").value = "Forest Green"; ad.getElementById("cfgColorAddBtn").click();
  ad.getElementById("cfgColorAdd").value = "forest green"; ad.getElementById("cfgColorAddBtn").click();
  calls.length = 0;
  await aw.submitProductForm("league", true);
  await until(() => calls.some(x => x.action === "updateProduct"));
  const sentHood = calls.find(x => x.action === "updateProduct");
  const hoodSaved = await prodOf("hood");
  ok("saving sends each location's add-on and the typed color (once)", sentHood && hoodSaved.locations[0].customDesignPriceCents === 425 && hoodSaved.locations[1].customDesignPriceCents === 150 &&
    JSON.stringify(hoodSaved.garmentColors) === JSON.stringify(["Navy", "Red", "Forest Green"]));
  ok("a product with no blank still saves, and the catalog check still warns about it", ((await lib.getCatalogIssues(d1, "league")).orgs.league.products.hood || []).some(i => i.code === "noBlankLink" && i.level === "warn"));

  // Files: one Order design slot per stitched spot.
  aw.showOrderItemFilesModal_(hatItem, "hat", null, [{ location: "front", label: "Front" }, { location: "back", label: "Back" }]);
  await until(() => ad.querySelectorAll(".oifDesignUp").length === 2);
  const oif = ad.getElementById("oifDesign");
  ok("the Files window has an Order design slot per stitched spot, each showing its own file", /Front[\s\S]*FRONT\.DST[\s\S]*Back[\s\S]*BACK\.DST/.test(oif.textContent) && oif.querySelectorAll(".oifDesignDl").length === 2);
  [...ad.querySelectorAll(".admin-pass-overlay, .inv-modal-overlay")].forEach(x => x.remove());

  // Edit items: a configurable line keeps its Custom pick; changing the color doesn't drop it.
  const a2 = await lib.getOrderById(d1, "A2");
  const products = await lib.getProductsByOrg(d1, "league", false);
  const pending = aw.showEditOrderModal(a2, products, { graphics: [], tiersCents: {} });
  await new Promise(res => setTimeout(res, 50));
  const locSel = ad.querySelector('select[data-cfgfield="graphic"][data-loc="front"]');
  ok("Edit items shows the line's Customer design, selected", locSel && locSel.value === "custom" && /Customer design/.test(locSel.selectedOptions[0].textContent));
  ok("…with the Files button (a line with the customer's design)", !!ad.querySelector('#editOrderRows [data-action="files"]'));
  const colorSel = ad.querySelector('select[data-cfgfield="color"]');
  colorSel.value = "Navy"; colorSel.dispatchEvent(new aw.Event("change", { bubbles: true }));
  ok("changing the color keeps it, at its own price", ad.querySelector('select[data-cfgfield="graphic"][data-loc="front"]').value === "custom" && /\$46\.00/.test(ad.getElementById("editOrderRows").textContent));
  ad.getElementById("editOrderSave").click();
  const result = await pending;
  ok("…and saving sends the Custom pick (the server fills the file in from the line's copy)", result && result.updates.length === 1 &&
    JSON.stringify(result.updates[0].config) === JSON.stringify({ garmentColor: "Navy", locations: [{ location: "front", custom: true }] }));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.log("test111 crashed:", false); console.error(e); process.exit(1); });
