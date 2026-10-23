const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Production run management: designs (migrations/0024) — real SQL (sql.js), real
// db.js + orders.js admin API, plus functions/api/design.js's upload/signed-link/download flow.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { listDesigns, getDesign, saveDesign, deleteDesign, listDesignVersions, addDesignVersion, updateDesignVersionThreads,
  setProductDesign, getOrderItemFiles, addOrderItemFile, deleteOrderItemFile, createOrg, createProduct, insertOrder, priceItem };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

// ---- functions/api/design.js, built the same eval way test25 builds upload.js ----
const rateLimitSrc = strip(read("functions/_lib/rateLimit.js"));
const adminAuthSrc = (read("functions/_lib/access.js") + "\n" + read("functions/_lib/adminAuth.js"))
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export const/g, "const").replace(/export async function/g, "async function").replace(/export function/g, "function");
const httpSrc = strip(read("functions/_lib/http.js"));
const fileUploadSrc = strip(read("functions/_lib/fileUpload.js"));
const designSrc = read("functions/api/design.js")
  .replace(/import \{ classifyHost \} from ["'].*["'];\n?/, "")
  .replace(/import \{ requireAdmin, timingSafeEqual \} from ["'].*["'];\n?/, "")
  .replace(/import \{ jsonResponse[^}]*\} from ["'].*["'];\n?/, "")
  .replace(/import \{ readBodyWithLimit, hasValidMagicBytes \} from ["'].*["'];\n?/, "")
  .replace(/export (async function|function|const)/g, "$1");
const hostConfigSrc = strip(read("functions/_lib/hostConfig.js"));
const designApi = new Function(hostConfigSrc + "\n" + rateLimitSrc + "\n" + adminAuthSrc + "\n" + httpSrc + "\n" + fileUploadSrc + "\n" + designSrc +
  "\nreturn { post: onRequestPost, get: onRequestGet };")();

if (!global.crypto) global.crypto = {};
if (!global.crypto.randomUUID) global.crypto.randomUUID = (() => { let n = 0; return () => "aaaaaaaa-bbbb-cccc-dddd-" + String(n++).padStart(12, "0"); })();

function designCtx(opts, env){
  const headers = new Map();
  if (opts.key !== undefined) headers.set("x-admin-key", opts.key);
  if (opts.contentType !== undefined) headers.set("content-type", opts.contentType);
  return {
    request: {
      url: opts.url || "https://admin.example.com/api/design" + (opts.qs || ""),
      headers: { get: (k) => (headers.has(String(k).toLowerCase()) ? headers.get(String(k).toLowerCase()) : null) },
      json: async () => opts.jsonBody,
      body: null, // force the arrayBuffer fallback path in readBodyWithLimit
      arrayBuffer: async () => opts.body !== undefined ? opts.body : new ArrayBuffer(0),
    },
    env,
  };
}
function makeDesignsBucket(){
  const store = new Map();
  return {
    put: async (key, body, opts) => { store.set(key, { body, httpMetadata: opts && opts.httpMetadata, customMetadata: opts && opts.customMetadata }); },
    get: async (key) => store.has(key) ? Object.assign({ body: store.get(key).body }, store.get(key)) : null,
    _store: store,
  };
}

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  await lib.createOrg(d1, { orgId: "acme", subdomain: "acme", name: "Acme", eyebrow: "", accent: "#000", desc: "", ready: true });
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, personalizationPrice: 3, visible: true });

  console.log("=== db.js: designs create/update/list/get/delete ===");
  const designId = await lib.saveDesign(d1, "acme", { name: "Club Logo", stabilizer: "medium cutaway", notes: "front left chest", hoopId: null });
  console.log("created:", (await lib.getDesign(d1, designId)).name === "Club Logo");
  await lib.saveDesign(d1, "acme", { id: designId, name: "Club Logo v2", stabilizer: "medium cutaway", notes: "", hoopId: null });
  console.log("updated:", (await lib.getDesign(d1, designId)).name === "Club Logo v2");
  console.log("listDesigns scoped to org:", (await lib.listDesigns(d1, "acme")).length === 1 && (await lib.listDesigns(d1, "other-org")).length === 0);

  console.log("\n=== db.js: design versions — two required files, ordered newest-first ===");
  const v1 = await lib.addDesignVersion(d1, designId, { designFileKey: "designs/1/aaa.emb", designFileName: "logo-v1.emb", designFileExt: "emb",
    machineFileKey: "designs/1/aaa.dst", machineFileName: "logo-v1.dst", machineFileExt: "dst",
    threadColors: [{ needle: 1, threadId: 1 }], notes: "first pass", uploadedAt: "2026-01-01T00:00:00.000Z" });
  const v2 = await lib.addDesignVersion(d1, designId, { designFileKey: "designs/1/bbb.emb", designFileName: "logo-v2.emb", designFileExt: "emb",
    machineFileKey: "designs/1/bbb.dst", machineFileName: "logo-v2.dst", machineFileExt: "dst",
    threadColors: [{ needle: 1, threadId: 1 }, { needle: 2, threadId: 2 }], notes: "added outline", uploadedAt: "2026-02-01T00:00:00.000Z" });
  const versions = await lib.listDesignVersions(d1, designId);
  console.log("both versions present, newest first:", versions.length === 2 && versions[0].id === v2 && versions[1].id === v1);
  console.log("threadColors round-trip as an ordered array:", versions[0].threadColors.length === 2 && versions[0].threadColors[1].threadId === 2);
  console.log("both the design file and the machine file round-trip separately:",
    versions[0].designFileName === "logo-v2.emb" && versions[0].machineFileName === "logo-v2.dst");

  console.log("\n=== db.js: updateDesignVersionThreads edits colors only ===");
  const beforeFiles = { d: versions[1].designFileKey, m: versions[1].machineFileKey, notes: versions[1].notes };
  await lib.updateDesignVersionThreads(d1, v1, [{ needle: 1, threadId: 9 }, { needle: 2, threadId: 8 }, { needle: 3, threadId: 7 }]);
  const afterV1 = (await lib.listDesignVersions(d1, designId)).find(v => v.id === v1);
  console.log("colors replaced on the target version:", JSON.stringify(afterV1.threadColors) === JSON.stringify([{ needle: 1, threadId: 9 }, { needle: 2, threadId: 8 }, { needle: 3, threadId: 7 }]));
  console.log("files/notes on that version untouched:", afterV1.designFileKey === beforeFiles.d && afterV1.machineFileKey === beforeFiles.m && afterV1.notes === beforeFiles.notes);
  console.log("the other version's colors are unaffected:", (await lib.listDesignVersions(d1, designId)).find(v => v.id === v2).threadColors.length === 2);

  console.log("\n=== db.js: setProductDesign links a product to a design ===");
  await lib.setProductDesign(d1, "acme", "cap", designId);
  const linked = d1.q("SELECT designId FROM products WHERE orgId=? AND productId=?", "acme", "cap")[0];
  console.log("product.designId set:", Number(linked.designId) === designId);

  console.log("\n=== db.js: deleteDesign refuses while a product is linked ===");
  let threw = false;
  try { await lib.deleteDesign(d1, designId); } catch (e) { threw = /linked/.test(e.message); }
  console.log("refused with a clear message:", threw);
  await lib.setProductDesign(d1, "acme", "cap", null);
  await lib.deleteDesign(d1, designId);
  console.log("succeeds once unlinked, and it's gone:", (await lib.getDesign(d1, designId)) === null);

  console.log("\n=== db.js: order-item files ===");
  await lib.insertOrder(d1,
    { orderId: "TEST-1", orgId: "acme", customerName: "Test Customer", contact: "t@example.com", paymentMethod: "card", placedAt: new Date().toISOString() },
    [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20, personalized: true, persName: "Team 12", personalizationFee: 3 }]
  );
  const itemId = (d1.q("SELECT id FROM order_items WHERE orderId=?", "TEST-1")[0]).id;
  const fileId = await lib.addOrderItemFile(d1, itemId, { fileKey: "order-files/1/ccc.jpg", fileName: "logo.jpg", fileExt: "jpg", uploadedBy: "customer" });
  let itemFiles = await lib.getOrderItemFiles(d1, itemId);
  console.log("file recorded against the item, uploadedBy preserved:", itemFiles.length === 1 && itemFiles[0].uploadedBy === "customer");
  await lib.deleteOrderItemFile(d1, fileId);
  console.log("deleted:", (await lib.getOrderItemFiles(d1, itemId)).length === 0);

  console.log("\n=== Real admin API ===");
  const designId2 = (await call({ action: "saveDesign", org: "acme", design: { name: "Team Patch" } })).body.id;
  let r = await call({ action: "listDesigns", org: "acme" });
  console.log("listDesigns action:", r.status === 200 && r.body.designs.length === 1 && r.body.designs[0].name === "Team Patch");
  r = await call({ action: "saveDesign", org: "acme", design: { name: "" } });
  console.log("name required:", r.status === 400 && /required/.test(r.body.message));
  r = await call({ action: "getDesign", id: designId2 });
  console.log("getDesign returns design + versions:", r.status === 200 && r.body.design.name === "Team Patch" && Array.isArray(r.body.versions));
  r = await call({ action: "saveDesignVersion", designId: designId2, designFileKey: "designs/x/y.emb", designFileName: "y.emb", designFileExt: "emb",
    machineFileKey: "", machineFileName: "", machineFileExt: "", threadColors: [], notes: "" });
  console.log("saveDesignVersion action refuses without a machine file:", r.status === 400 && /Machine file/.test(r.body.message));
  r = await call({ action: "saveDesignVersion", designId: designId2, designFileKey: "", designFileName: "", designFileExt: "",
    machineFileKey: "designs/x/y.dst", machineFileName: "y.dst", machineFileExt: "dst", threadColors: [], notes: "" });
  console.log("saveDesignVersion action refuses without a design file:", r.status === 400 && /Design file/.test(r.body.message));
  r = await call({ action: "saveDesignVersion", designId: designId2, designFileKey: "designs/x/y.emb", designFileName: "y.emb", designFileExt: "emb",
    machineFileKey: "designs/x/y.dst", machineFileName: "y.dst", machineFileExt: "dst", threadColors: [], notes: "" });
  console.log("saveDesignVersion action records a version once both files are present:", r.status === 200 && !!r.body.id);
  r = await call({ action: "getDesign", id: designId2 });
  console.log("version now shows up with both files:", r.body.versions.length === 1 && r.body.versions[0].designFileName === "y.emb" && r.body.versions[0].machineFileName === "y.dst");
  const apiVid = r.body.versions[0].id;
  r = await call({ action: "updateDesignVersionColors", versionId: apiVid, threadColors: [{ needle: 1, threadId: 5 }] });
  console.log("updateDesignVersionColors action:", r.status === 200);
  r = await call({ action: "getDesign", id: designId2 });
  console.log("...updated the colors, files unchanged:", JSON.stringify(r.body.versions[0].threadColors) === JSON.stringify([{ needle: 1, threadId: 5 }]) && r.body.versions[0].machineFileName === "y.dst");
  r = await call({ action: "updateDesignVersionColors", threadColors: [] });
  console.log("...requires a versionId:", r.status === 400);
  r = await call({ action: "setProductDesign", org: "acme", productId: "cap", designId: designId2 });
  console.log("setProductDesign action:", r.status === 200);
  r = await call({ action: "deleteDesign", id: designId2 });
  console.log("deleteDesign action refuses while linked:", r.status === 400 && /linked/.test(r.body.message));
  await call({ action: "setProductDesign", org: "acme", productId: "cap", designId: null });
  r = await call({ action: "deleteDesign", id: designId2 });
  console.log("deleteDesign action succeeds once unlinked:", r.status === 200);

  r = await call({ action: "saveOrderItemFile", itemId, fileKey: "order-files/1/ddd.png", fileName: "d.png", fileExt: "png", uploadedBy: "admin" });
  console.log("saveOrderItemFile action:", r.status === 200 && !!r.body.id);
  r = await call({ action: "getOrderItemFiles", itemId });
  console.log("getOrderItemFiles action:", r.status === 200 && r.body.files.length === 1);
  r = await call({ action: "deleteOrderItemFile", id: r.body.files[0].id });
  console.log("deleteOrderItemFile action:", r.status === 200);
  r = await call({ action: "getOrderItemFiles", itemId });
  console.log("...and it's gone:", r.body.files.length === 0);

  console.log("\n=== functions/api/design.js: role-restricted design-version upload (no magic-byte check) ===");
  let env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", QUOTE_SIGNING_SECRET: "sekret", DESIGNS: makeDesignsBucket() };
  let res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&role=machine&ext=dst&name=logo.dst", body: new ArrayBuffer(2000) }, env));
  let data = JSON.parse(await res.text());
  console.log("machine-file upload ok, key under designs/<designId>/:", data.status === "ok" && /^designs\/9\/[a-z0-9]{32}\.dst$/.test(data.key));
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&role=design&ext=emb&name=logo.emb", body: new ArrayBuffer(500) }, env));
  data = JSON.parse(await res.text());
  console.log("design-file upload ok too:", data.status === "ok" && /^designs\/9\/[a-z0-9]{32}\.emb$/.test(data.key));
  console.log("exactly two objects stored:", env.DESIGNS._store.size === 2);

  console.log("\n=== functions/api/design.js: role restricts which extensions are accepted ===");
  env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", DESIGNS: makeDesignsBucket() };
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&role=design&ext=dst&name=logo.dst", body: new ArrayBuffer(10) }, env));
  data = JSON.parse(await res.text());
  console.log("a stitch (.dst) file is refused for role=design (that's the machine role's format):", res.status === 400 && /native design format/.test(data.message));
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&role=machine&ext=emb&name=logo.emb", body: new ArrayBuffer(10) }, env));
  data = JSON.parse(await res.text());
  console.log("a native (.emb) file is refused for role=machine (that's the design role's format):", res.status === 400 && /stitch format/.test(data.message));
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&ext=dst&name=logo.dst", body: new ArrayBuffer(10) }, env));
  data = JSON.parse(await res.text());
  console.log("missing role on a design-version upload is rejected:", res.status === 400 && /role/.test(data.message));
  console.log("nothing stored across any of these rejections:", env.DESIGNS._store.size === 0);
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&role=machine&ext=exe&name=virus.exe", body: new ArrayBuffer(10) }, env));
  data = JSON.parse(await res.text());
  console.log("a non-embroidery extension (.exe) is rejected regardless of role:", res.status === 400 && /isn't an embroidery file/.test(data.message) && env.DESIGNS._store.size === 0);
  for (const [role, ext] of [["design", "html"], ["machine", "svg"], ["machine", "png"], ["design", "pdf"], ["machine", "js"], ["machine", ""]]) {
    res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: `?designId=9&role=${role}&ext=${ext}&name=x.${ext}`, body: new ArrayBuffer(10) }, env));
    if (res.status !== 400) console.log(`.${ext} as role=${role} should be refused: false`);
  }
  console.log("web pages, scripts, images, PDFs and a missing extension are refused as design/machine files:", env.DESIGNS._store.size === 0);

  console.log("\n=== functions/api/design.js: any other embroidery format is accepted (2026-10) ===");
  env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", DESIGNS: makeDesignsBucket() };
  const okUp = async (qs, contentType = "application/octet-stream") => JSON.parse(await (await designApi.post(designCtx({ key: "proxy-pass", contentType, qs, body: new ArrayBuffer(10) }, env))).text());
  let up = await okUp("?designId=9&role=machine&ext=pes&name=logo.pes");
  console.log("a Brother .pes machine file is accepted:", up.status === "ok" && /\.pes$/.test(up.key));
  up = await okUp("?designId=9&role=machine&ext=zz9&name=logo.zz9");
  console.log("an extension we've never heard of is accepted as a machine file:", up.status === "ok" && /\.zz9$/.test(up.key));
  up = await okUp("?designId=9&role=design&ext=bx&name=logo.bx");
  console.log("…and as a design file (another brand's project format):", up.status === "ok" && /\.bx$/.test(up.key));
  up = await okUp("?itemId=5&ext=jef&name=name.jef");
  console.log("a line-item upload takes any embroidery format too:", up.status === "ok" && /^order-files\/5\//.test(up.key));
  up = await okUp("?designId=9&role=machine&ext=hus&name=logo.hus", "text/html");
  const stored = env.DESIGNS._store.get(up.key);
  console.log("a non-image upload is always stored as application/octet-stream, whatever Content-Type was sent:", up.status === "ok" && stored && stored.httpMetadata.contentType === "application/octet-stream");

  console.log("\n=== functions/api/design.js: order-item upload accepts an image too, WITH magic-byte check ===");
  env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", DESIGNS: makeDesignsBucket() };
  const pngBuf = new ArrayBuffer(20); new Uint8Array(pngBuf).set([0x89, 0x50, 0x4e, 0x47]);
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "image/png", qs: "?itemId=5&ext=png&name=photo.png", body: pngBuf }, env));
  data = JSON.parse(await res.text());
  console.log("valid PNG accepted under order-files/<itemId>/:", data.status === "ok" && /^order-files\/5\/[a-z0-9]{32}\.png$/.test(data.key));
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "image/png", qs: "?itemId=5&ext=png&name=fake.png", body: new ArrayBuffer(20) }, env));
  data = JSON.parse(await res.text());
  console.log("bytes that don't match declared image type are rejected:", res.status === 415);

  console.log("\n=== functions/api/design.js: signed link + download round trip ===");
  env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", QUOTE_SIGNING_SECRET: "sekret", DESIGNS: makeDesignsBucket() };
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&role=machine&ext=dst&name=logo.dst", body: new ArrayBuffer(50) }, env));
  const uploadedKey = JSON.parse(await res.text()).key;
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/json", jsonBody: { key: uploadedKey } }, env));
  data = JSON.parse(await res.text());
  console.log("signed link returned:", data.status === "ok" && data.url.startsWith("/api/design?key="));
  const linkUrl = new URL("https://admin.example.com" + data.url);
  res = await designApi.get({ request: { url: linkUrl.toString() }, env });
  console.log("GET with a valid signature returns the file:", res.status === 200);
  const badUrl = new URL(linkUrl); badUrl.searchParams.set("sig", "0".repeat(64));
  res = await designApi.get({ request: { url: badUrl.toString() }, env });
  console.log("GET with a tampered signature is refused:", res.status === 404);

  console.log("\n=== functions/api/design.js: rejected from a non-admin subdomain, even with the right passphrase ===");
  env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", DESIGNS: makeDesignsBucket() };
  res = await designApi.post(designCtx({ key: "proxy-pass", contentType: "application/octet-stream", qs: "?designId=9&ext=dst&name=logo.dst", body: new ArrayBuffer(10),
    url: "https://acme.example.com/api/design?designId=9&ext=dst&name=logo.dst" }, env));
  console.log("refused with 403:", res.status === 403 && env.DESIGNS._store.size === 0);
})();
