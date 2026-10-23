const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Configurable products (migrations/0042): per-location graphic × garment-color mockups.
// Real SQL (sql.js) + real db.js/orders.js, the base-image resolution from location-tagged blank
// photos, catalog attach, FK cascades, the same-origin image proxy, and admin/storefront wiring.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, createGraphic, createBlank, setBlankLink, saveLocation, listLocations,
  setProductGraphicImage, listProductGraphicImages, deleteProductGraphicImage, getProductLocationBaseImages, getPublicCatalogData };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const imageProxy = new Function(strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/api/image-proxy.js")) + "\nreturn onRequestGet;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.run("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t')");
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  // Fixtures: a location, two graphics, a configurable product using the location, and a blank whose
  // Navy color photo is tagged with that location + linked to the product's Navy color.
  const locId = await lib.saveLocation(d1, { name: "Front", sortOrder: 1 });
  const g1 = await lib.createGraphic(d1, "acme", { name: "Logo", kind: "transfer", visible: 1 });
  const g2 = await lib.createGraphic(d1, "acme", { name: "Crest", kind: "transfer", visible: 1 });
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true,
    configurable: true, garmentColors: ["Navy", "Red"], reorderQr: "none",
    locations: [{ key: "loc" + locId, label: "Front", locationId: locId, graphicIds: [g1, g2] }] });
  const blankId = (await lib.createBlank(d1, { name: "Jerzees", productType: "shirt", colors: [
    { color: "Navy", images: [{ url: "https://img.example/navy-front.jpg", locationId: locId }, { url: "https://img.example/navy-plain.jpg", locationId: null }], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] } ] })).id;
  await lib.setBlankLink(d1, "acme", "tee", "Navy", "L", blankId, "Navy", "L");

  console.log("=== Base-image resolution (location tags → overlay base) ===");
  const bases = await lib.getProductLocationBaseImages(d1, "acme", "tee");
  ok("location-tagged blank photo keyed by '<color>|<locationId>'", (bases["Navy|" + locId] || [])[0] === "https://img.example/navy-front.jpg");
  ok("untagged photo keyed by '<color>|' as a fallback", (bases["Navy|"] || [])[0] === "https://img.example/navy-plain.jpg");
  ok("every photo of the color is offered under '<color>|*' (so photos tagged to another location still appear)",
    (bases["Navy|*"] || []).length === 2 && bases["Navy|*"].includes("https://img.example/navy-front.jpg") && bases["Navy|*"].includes("https://img.example/navy-plain.jpg"));

  console.log("\n=== Mockup CRUD (upsert / list / delete) ===");
  await lib.setProductGraphicImage(d1, { orgId: "acme", productId: "tee", locationId: locId, graphicId: g1, garmentColor: "Navy",
    imageUrl: "https://img.example/mockup1.png", thumbUrl: "", placement: { xPct: 0.5, yPct: 0.4, wPct: 0.3 } });
  let list = await lib.listProductGraphicImages(d1, "acme", "tee");
  ok("mockup stored + listed with its placement", list.length === 1 && list[0].imageUrl === "https://img.example/mockup1.png" && list[0].placement.wPct === 0.3);
  await lib.setProductGraphicImage(d1, { orgId: "acme", productId: "tee", locationId: locId, graphicId: g1, garmentColor: "Navy", imageUrl: "https://img.example/mockup1b.png" });
  list = await lib.listProductGraphicImages(d1, "acme", "tee");
  ok("re-saving the same tuple upserts (no duplicate row)", list.length === 1 && list[0].imageUrl === "https://img.example/mockup1b.png");
  await lib.setProductGraphicImage(d1, { orgId: "acme", productId: "tee", locationId: locId, graphicId: g1, garmentColor: "Navy", imageUrl: "" });
  ok("setting an empty imageUrl deletes the cell", (await lib.listProductGraphicImages(d1, "acme", "tee")).length === 0);

  console.log("\n=== A huge data: URL in placement (uploaded base/graphic) is stripped, not stored ===");
  const bigData = "data:image/png;base64," + "A".repeat(2 * 1024 * 1024);  // ~2MB — would blow D1's row/param limit if stored
  await lib.setProductGraphicImage(d1, { orgId: "acme", productId: "tee", locationId: locId, graphicId: g2, garmentColor: "Navy",
    imageUrl: "https://img.example/ok.png", placement: { xPct: 0.5, yPct: 0.5, wPct: 0.4, baseUrl: bigData, graphicUrl: bigData } });
  const saved = (await lib.listProductGraphicImages(d1, "acme", "tee")).find(m => m.graphicId === g2 && m.garmentColor === "Navy");
  ok("the mockup still saves and placement keeps only coords (no data: URL)",
    !!saved && saved.placement.wPct === 0.4 && !saved.placement.baseUrl && !saved.placement.graphicUrl);
  await lib.deleteProductGraphicImage(d1, { orgId: "acme", productId: "tee", locationId: locId, graphicId: g2, garmentColor: "Navy" });

  console.log("\n=== Catalog attaches graphicImages for the storefront ===");
  await lib.setProductGraphicImage(d1, { orgId: "acme", productId: "tee", locationId: locId, graphicId: g2, garmentColor: "Red", imageUrl: "https://img.example/red-crest.png" });
  const cat = await lib.getPublicCatalogData(d1);
  const tee = cat.orgs.acme.products.find(p => (p.productId || p.id) === "tee");
  ok("product carries graphicImages keyed '<locationId>|<graphicId>|<color>'",
    tee.graphicImages && tee.graphicImages[`${locId}|${g2}|Red`] === "https://img.example/red-crest.png");
  // Regression: graphicImages must survive catalog.js's toClientProduct whitelist.
  ok("catalog.js passes graphicImages through to the client product",
    /graphicImages/.test(read("functions/api/catalog.js")) && /out\.graphicImages\s*=/.test(read("functions/api/catalog.js")));

  console.log("\n=== FK cascades (migrations/0042) ===");
  await lib.setProductGraphicImage(d1, { orgId: "acme", productId: "tee", locationId: locId, graphicId: g1, garmentColor: "Navy", imageUrl: "https://img.example/x.png" });
  d1._raw.run("DELETE FROM graphics WHERE id=?", [g1]);
  ok("deleting a graphic cascades its mockups", !(await lib.listProductGraphicImages(d1, "acme", "tee")).some(m => m.graphicId === g1));
  d1._raw.run("DELETE FROM products WHERE orgId='acme' AND productId='tee'");
  ok("deleting the product cascades all its mockups", d1.q("SELECT count(*) n FROM product_graphic_images WHERE productId='tee'")[0].n === 0);

  console.log("\n=== Real admin API ===");
  await lib.createProduct(d1, "acme", { productId: "tee2", type: "shirt", name: "Tee2", pricingMode: "flat", flatPrice: 20, visible: true,
    configurable: true, garmentColors: ["Navy"], reorderQr: "none", locations: [{ key: "loc" + locId, label: "Front", locationId: locId, graphicIds: [g2] }] });
  let r = await call({ action: "setProductGraphicImage", org: "acme", mockup: { productId: "tee2", locationId: locId, graphicId: g2, garmentColor: "Navy", imageUrl: "https://img.example/api.png", placement: {} } });
  ok("setProductGraphicImage action saves", r.status === 200);
  r = await call({ action: "listProductGraphicImages", org: "acme", productId: "tee2" });
  ok("listProductGraphicImages action returns mockups + baseImages", r.status === 200 && r.body.mockups.length === 1 && typeof r.body.baseImages === "object");
  r = await call({ action: "deleteProductGraphicImage", org: "acme", mockup: { productId: "tee2", locationId: locId, graphicId: g2, garmentColor: "Navy" } });
  ok("deleteProductGraphicImage action removes it", r.status === 200 && (await lib.listProductGraphicImages(d1, "acme", "tee2")).length === 0);

  console.log("\n=== Same-origin image proxy (anti-taint, reads the R2 binding, not an open proxy) ===");
  // Mock R2 binding: returns an object for a known key, null otherwise.
  const IMAGES = { get: async (key) => key === "uploads/x.png" ? { body: "BYTES", httpMetadata: { contentType: "image/png" } } : null };
  const proxyCall = (src) => imageProxy({ request: { url: "https://admin.example.com/api/image-proxy?src=" + encodeURIComponent(src) }, env: { R2_PUBLIC_BASE: "https://img.example", IMAGES } });
  let pr = await proxyCall("https://evil.example/secret.png");
  ok("refuses a src outside the R2 image base (400)", pr.status === 400);
  pr = await proxyCall("https://img.example/uploads/x.png");
  ok("serves an R2 image from the binding with its content-type", pr.status === 200 && pr.headers.get("Content-Type") === "image/png");
  pr = await proxyCall("https://img.example/uploads/missing.png");
  ok("a missing object is 404 (not a same-zone fetch)", pr.status === 404);

  console.log("\n=== Admin + storefront wiring ===");
  const a = read("public/admin.js"), h = read("public/index.html");
  ok("product form builds per-location mockup tables + Overlay buttons",
    /id="cfgMockups"/.test(a) && /function drawMockups/.test(a) && /class="admin-btn cfgMockBtn"/.test(a));
  ok("the custom-canvas overlay editor + proxy + flatten/upload exist",
    /async function showOverlayEditorModal_/.test(a) && /function overlayProxiedSrc_/.test(a) && /\/api\/image-proxy\?src=/.test(a) && /out\.toBlob\(/.test(a) && /uploadImage\(blob/.test(a));
  ok("mockups persist via the one-Save flow",
    /_productGraphicImagesSave/.test(a) && /action: "setProductGraphicImage"/.test(a));
  ok("storefront shows the mockup per color+location+graphic (one image per location)",
    /p\.graphicImages/.test(h) && /mockups\[x\.locationId \+ "\|" \+ x\.graphic\.id \+ "\|" \+ color\]/.test(h));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
