const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Versions of a product (migrations/0059): a shirt in short and long sleeve is two products linked as a
// pair — each its own sizes and prices, blanks, garment colors, photos and overlay mockups — shown on the
// shop page as ONE card with a toggle. Made with "Add a version" (a copy of the shared settings, hidden
// until set up), re-synced with "Copy settings", unlinked with "Separate". Order lines say which version.
// Real db.js / orders.js / catalog.js on sql.js; the shop page and the admin in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createGraphic, createProduct, saveLocation, saveDesign, setProductDesigns, listProductDesigns, setBlankLink, getBlankLinks,
  setProductGraphicImage, getProductsByOrg, getPublicCatalogData, priceItem, getOrderById, setFulfillmentStage, setProductVisible, getCatalogIssues, getProductVersions };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const catalogApi = new Function("lib", hostSrc + "\n" + httpSrc + "\nconst getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\n" +
  "const getCatalogData = async (env) => ({ ...(await lib.getPublicCatalogData(env.DB)), subdomainMap: { club: 'club' } });\n" +
  strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")(lib);
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const call = async (body, { host = "admin", role = "admin" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: `https://${host}.example.com/api/orders`, json: async () => host === "admin" ? Object.assign({ key: "x" }, body) : body, headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const prod = async (id) => (await lib.getProductsByOrg(d1, "club", false)).find(p => p.productId === id);
  const sz = (...names) => names.map(size => ({ size, purchasePrice: 4, quantity: 10 }));

  // Two blanks: a short-sleeve tee in Navy / Black, a long-sleeve tee in Navy / Royal — each with photos.
  const shortBlank = (await lib.createBlank(d1, { name: "Short tee", productType: "shirt", colors: [{ color: "Navy", images: ["img/ss-navy.jpg"], sizes: sz("S", "M") }, { color: "Black", images: ["img/ss-black.jpg"], sizes: sz("S", "M") }] })).id;
  const longBlank = (await lib.createBlank(d1, { name: "Long tee", productType: "shirt", colors: [{ color: "Navy", images: ["img/ls-navy.jpg"], sizes: sz("S", "M") }, { color: "Royal", images: ["img/ls-royal.jpg"], sizes: sz("S", "M") }] })).id;
  const locId = await lib.saveLocation(d1, { name: "Left chest", sortOrder: 1 });
  const g = await lib.createGraphic(d1, "club", { name: "Crest", kind: "transfer", tier: null, imageUrl: "img/crest.png" });
  const design = await lib.saveDesign(d1, "club", { name: "Crest stitch" });
  const designId = Number(design && (design.id || design)) || Number(d1.q("SELECT id FROM designs ORDER BY id DESC LIMIT 1")[0].id);
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Club Tee", sub: "Soft cotton", features: ["Pre-shrunk"], pricingMode: "sized", sizePricing: { S: 20, M: 20 },
    weightOz: 6, visible: true, sortOrder: 10, images: ["img/tee-photo.jpg"], configurable: true, garmentColors: ["Navy", "Black"], reorderQr: "none",
    locations: [{ key: "loc" + locId, label: "Left chest", locationId: locId, graphicIds: [g] }], personalizationPrice: 5 });
  await lib.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 15, visible: true, sortOrder: 20 });
  await lib.setProductDesigns(d1, "club", "tee", [{ designId, placement: "Left chest", isMain: true }]);
  for (const c of ["Navy", "Black"]) for (const s of ["S", "M"]) await lib.setBlankLink(d1, "club", "tee", c, s, shortBlank, c, s);
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "tee", locationId: locId, graphicId: g, garmentColor: "Navy", imageUrl: "img/mock-ss-navy.png" });

  console.log("=== The columns ===");
  const cols = d1.q("PRAGMA table_info(products)").map(c => c.name);
  ok("products have versionGroup and versionLabel; an existing product is in no group", cols.includes("versionGroup") && cols.includes("versionLabel") && (await prod("tee")).versionGroup === "");

  console.log("\n=== Add a version ===");
  let r = await call({ action: "createProductVersion", org: "club", productId: "tee", newProductId: "Tee LS" }, { role: "staff" });
  ok("a worker may add one, as with any product (refused here only for the bad id)", r.status === 400);
  r = await call({ action: "createProductVersion", org: "club", productId: "tee", newProductId: "Tee LS" });
  ok("an id that can't be a product id is refused", r.status === 400);
  r = await call({ action: "createProductVersion", org: "club", productId: "tee", newProductId: "cap" });
  ok("…and so is one that's taken", r.status === 409);
  r = await call({ action: "createProductVersion", org: "club", productId: "tee", newProductId: "tee-ls" });
  const tee = await prod("tee"), ls = await prod("tee-ls");
  ok("it makes the new product and links the two, labelled Short sleeve / Long sleeve by default", r.status === 200 && ls && tee.versionGroup === "tee" && ls.versionGroup === "tee" && tee.versionLabel === "Short sleeve" && ls.versionLabel === "Long sleeve");
  ok("the new one copies the shared settings: category, name, subtitle, features, graphics at each location, personalization, starting prices and weight",
    ls.type === "shirt" && ls.name === "Club Tee" && ls.sub === "Soft cotton" && ls.features.join() === "Pre-shrunk" && ls.configurable && ls.locations.length === 1 && ls.locations[0].graphicIds[0] === g &&
    ls.personalizationPrice === 5 && ls.sizePricing.S === 20 && ls.weightOz === 6);
  ok("…and the designs", (await lib.listProductDesigns(d1, "club", "tee-ls")).map(x => x.designId).join() === String(designId));
  ok("…but not the photos, garment colors, blank links or overlay mockups — those belong to the long-sleeve blank",
    ls.images.length === 0 && ls.garmentColors.length === 0 && (await lib.getBlankLinks(d1, "club")).filter(l => l.productId === "tee-ls").length === 0 &&
    Number(d1.q("SELECT count(*) n FROM product_graphic_images WHERE productId='tee-ls'")[0].n) === 0);
  const order = (await lib.getProductsByOrg(d1, "club", false)).map(p => p.productId);
  ok("it starts hidden, listed right after the short-sleeve one", !ls.visible && order.indexOf("tee-ls") === order.indexOf("tee") + 1);
  ok("the version lookup finds the other one", (await lib.getProductVersions(d1, "club", "tee")).map(x => x.productId + ":" + x.label).join() === "tee-ls:Long sleeve");
  ok("it's in the audit log", Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='product.version_created'")[0].n) === 1);

  // Set the long sleeve up: its own prices, colors, blank links, a photo and a mockup; then show it.
  const ls0 = await prod("tee-ls");
  r = await call(Object.assign({}, ls0, { action: "updateProduct", org: "club", sizePricing: { S: 26, M: 26, L: 28 }, garmentColors: ["Navy", "Royal"], visible: true, versionLabel: "Long sleeve" }));
  ok("(the long sleeve's own prices and colors are saved)", r.status === 200 && (await prod("tee-ls")).sizePricing.L === 28);
  for (const c of ["Navy", "Royal"]) for (const s of ["S", "M"]) await lib.setBlankLink(d1, "club", "tee-ls", c, s, longBlank, c, s);
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "tee-ls", locationId: locId, graphicId: g, garmentColor: "Navy", imageUrl: "img/mock-ls-navy.png" });
  r = await call(Object.assign({}, await prod("tee"), { action: "updateProduct", org: "club", versionGroup: "cap" }));
  ok("a product can't be moved into another group by editing it", r.status === 400);
  r = await call(Object.assign({}, await prod("tee"), { action: "updateProduct", org: "club", name: "Club Tee", versionLabel: "Short sleeve" }));
  ok("saving the product form keeps it linked", r.status === 200 && (await prod("tee")).versionGroup === "tee");

  console.log("\n=== Orders ===");
  const cfg = { garmentColor: "Navy", locations: [{ location: "loc" + locId, graphicId: g }] };
  const pLs = await lib.priceItem(d1, "club", "tee-ls", "L", 1, false, cfg), pSs = await lib.priceItem(d1, "club", "tee", "M", 1, false, cfg);
  ok("each version is priced from its own sizes (long sleeve L $28 — the short sleeve has no L)", pLs.unitPrice === 28 && pSs.unitPrice === 20);
  ok("order lines say which version: 'Club Tee (Long sleeve)'", pLs.name === "Club Tee (Long sleeve)" && pSs.name === "Club Tee (Short sleeve)");
  let refused = ""; try { await lib.priceItem(d1, "club", "tee", "M", 1, false, { garmentColor: "Royal", locations: cfg.locations }); } catch (e) { refused = e.message; }
  ok("each version offers only its own colors (Royal is long sleeve only)", /garment color/.test(refused));
  r = await call({ orderId: "V-1", orgId: "club", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", deliveryOptionId: "pickup",
    items: [{ productId: "tee-ls", size: "M", qty: 2, config: cfg }, { productId: "tee", size: "S", qty: 1, config: cfg }] }, { host: "club" });
  ok("an order with both versions is placed", r.status === 200);
  const o = await lib.getOrderById(d1, "V-1");
  ok("…its lines are named by version", o.items.map(i => i.name).sort().join("|") === "Club Tee (Long sleeve)|Club Tee (Short sleeve)");
  await lib.setFulfillmentStage(d1, "V-1", "manufactured");
  const used = d1.q("SELECT blankId, qtyDelta FROM inventory_movements WHERE kind='consume' AND orderId='V-1' ORDER BY blankId");
  ok("making it uses each version's own blank: 2 long-sleeve tees and 1 short-sleeve", used.length === 2 && used.find(x => x.blankId === longBlank).qtyDelta === -2 && used.find(x => x.blankId === shortBlank).qtyDelta === -1);
  r = await call({ action: "createLocalSale", org: "club", customerName: "Walk-in", paymentMethod: "Cash", items: [{ productId: "tee-ls", name: "anything", type: "shirt", size: "S", qty: 1, config: cfg }] });
  const local = r.body.orderId && await lib.getOrderById(d1, r.body.orderId);
  ok("a local sale's line is named from the catalog too, not from what the form sent", r.status === 200 && local && local.items[0].name === "Club Tee (Long sleeve)");

  console.log("\n=== The shop page ===");
  const cat = JSON.parse(await (await catalogApi({ request: { url: "https://club.example.com/api/catalog", headers: { get: () => null } }, env: { DB: d1 } })).text());
  const cTee = cat.catalog.products.find(p => p.id === "tee"), cLs = cat.catalog.products.find(p => p.id === "tee-ls");
  ok("the catalog tells the shop page which products are versions of each other, and their names", cTee.versionGroup === "tee" && cLs.versionGroup === "tee" && cLs.versionLabel === "Long sleeve");
  ok("…with each version's own colors, blank photos and mockups", cLs.garmentColors.join() === "Navy,Royal" && (cLs.colorImages.Navy || []).includes("img/ls-navy.jpg") &&
    Object.values(cLs.graphicImages || {}).includes("img/mock-ls-navy.png") && !Object.values(cTee.graphicImages || {}).includes("img/mock-ls-navy.png"));
  const orders = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", url: "https://club.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.alert = () => {}; win.fetch = async (url, init) => {
      if (String(url).startsWith("/api/orders")) { orders.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
      return { ok: true, status: 200, json: async () => cat, text: async () => JSON.stringify(cat) }; }; } });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !d.querySelector(".product"); i++) await new Promise(res => setTimeout(res, 10));
  await new Promise(res => setTimeout(res, 50));
  const shirts = () => [...d.querySelectorAll("#cat-shirt .product")];
  const card = () => d.querySelector('.product[data-vgroup="tee"]');
  const toggle = () => [...card().querySelectorAll(".version-toggle button")];
  ok("the two versions are ONE card in the shirts section, with a Short sleeve | Long sleeve toggle", shirts().length === 1 && toggle().map(b => b.textContent).join("|") === "Short sleeve|Long sleeve" &&
    toggle()[0].getAttribute("aria-checked") === "true" && card().dataset.vactive === "tee");
  const swatches = () => [...card().querySelectorAll(".cfg-swatch[data-color]")].map(b => b.dataset.color).join();
  const sizes = (id) => [...d.querySelectorAll("#size-" + id + " option")].map(o => o.value).join();
  ok("it starts on the short sleeve: its colors and sizes", swatches() === "Navy,Black" && sizes("tee") === "S,M");
  w.cfgPickColor_("tee", [...card().querySelectorAll(".cfg-swatch[data-color]")].find(b => b.dataset.color === "Navy"));
  d.getElementById("size-tee").value = "M"; d.getElementById("qty-tee").value = "3";
  toggle()[1].click();
  await new Promise(res => setTimeout(res, 20));
  ok("switching shows the long sleeve's own colors, sizes and price", card().dataset.vactive === "tee-ls" && swatches() === "Navy,Royal" && sizes("tee-ls") === "S,M,L" &&
    toggle()[1].getAttribute("aria-checked") === "true" && /\$26\.00/.test(d.getElementById("price-tee-ls").textContent));
  ok("…and keeps the color, size and quantity that were chosen (both have them)", d.getElementById("gcolor-tee-ls").value === "Navy" && d.getElementById("size-tee-ls").value === "M" && d.getElementById("qty-tee-ls").value === "3");
  const imgs = [...card().querySelectorAll("img")].map(i => i.getAttribute("src") || "").join(" ");
  ok("…its own photos and its own overlay mockup", /ls-navy/.test(imgs) && /mock-ls-navy/.test(imgs) && !/ss-navy|mock-ss-navy/.test(imgs));
  ok("…and the short sleeve's card is gone from the page (the picture viewer only walks this one)", !d.getElementById("size-tee") && shirts().length === 1);
  w.addToCart("tee-ls");
  ok("Add to cart adds the long sleeve, named by its version", (() => { const c = w.eval("cart"); return c.length === 1 && c[0].productId === "tee-ls" && c[0].name === "Club Tee (Long sleeve)" && c[0].unitPrice === 26; })());
  toggle()[0].click();
  await new Promise(res => setTimeout(res, 20));
  ok("switching back shows the short sleeve again", card().dataset.vactive === "tee" && swatches() === "Navy,Black");
  ok("the toggle row wraps on a narrow screen", /\.version-toggle\{margin:0 0 10px;\}/.test(read("public/index.html")) && /\.cfg-swatches\{display:flex; gap:6px; flex-wrap:wrap;/.test(read("public/index.html")));
  // A version that's hidden isn't on the page at all: the other is a plain card.
  await lib.setProductVisible(d1, "club", "tee-ls", false);
  const cat2 = JSON.parse(await (await catalogApi({ request: { url: "https://club.example.com/api/catalog", headers: { get: () => null } }, env: { DB: d1 } })).text());
  w.eval("1"); const html2 = w.versionCardsHtml_(cat2.catalog.products.filter(p => p.type === "shirt"), cat2.catalog);
  ok("with the long sleeve hidden, the short sleeve is a normal card with no toggle", !/version-toggle/.test(html2) && /id="size-tee"/.test(html2));
  await lib.setProductVisible(d1, "club", "tee-ls", true);

  console.log("\n=== Copy settings, the catalog check, Separate ===");
  r = await call(Object.assign({}, await prod("tee"), { action: "updateProduct", org: "club", sub: "Now ring-spun", features: ["Pre-shrunk", "Tagless"] }));
  r = await call({ action: "copyProductVersionSettings", org: "club", productId: "tee-ls", fromProductId: "tee" });
  const ls2 = await prod("tee-ls");
  ok("Copy settings brings the shared settings across", r.status === 200 && ls2.sub === "Now ring-spun" && ls2.features.join() === "Pre-shrunk,Tagless");
  ok("…and leaves the long sleeve's own prices, colors and visibility alone", ls2.sizePricing.L === 28 && ls2.garmentColors.join() === "Navy,Royal" && ls2.visible && ls2.versionLabel === "Long sleeve");
  r = await call({ action: "copyProductVersionSettings", org: "club", productId: "tee-ls", fromProductId: "cap" });
  ok("…only from another version of the same product", r.status === 400);
  d1._raw.run("UPDATE products SET type='cap' WHERE productId='tee-ls'");
  const issues = await lib.getCatalogIssues(d1, "club");
  ok("the catalog check warns when the versions are in different categories (they can't share a card)", ((issues.orgs.club.products.tee || []).some(x => x.code === "versionSplit")));
  d1._raw.run("UPDATE products SET type='shirt' WHERE productId='tee-ls'");

  console.log("\n=== The admin ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const adom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const aw = adom.window, ad = aw.document;
  await new Promise(res => setTimeout(res, 150));
  await aw.loadAdminScript();
  aw.eval('adminKey = "cookie";');
  const app = ad.getElementById("app");
  const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  await aw.renderProductList(app, "club");
  await until(() => ad.querySelector(".prod-cat-table"));
  const rows = [...ad.querySelectorAll('.prod-cat-table[data-category="shirt"] tbody tr')];
  ok("the Products list keeps the versions together, the second indented with its name", rows.length === 2 && /Club Tee · Short sleeve/.test(rows[0].textContent.replace(/\s+/g, " ")) &&
    rows[1].classList.contains("prod-version-row") && /↳ Club Tee · Long sleeve/.test(rows[1].textContent.replace(/\s+/g, " ")) && rows[1].querySelectorAll(".prod-move").length === 0);
  await aw.renderEditProductForm(app, "club", "tee");
  await until(() => ad.getElementById("prodFormVersions"));
  const box = () => ad.getElementById("prodFormVersions");
  ok("the product form has a Versions box: both versions, this one's name, Copy settings and Separate", /Short sleeve/.test(box().textContent) && /Long sleeve/.test(box().textContent) &&
    ad.getElementById("prodFormVersionLabel").value === "Short sleeve" && /Copy settings from Long sleeve/.test(box().textContent) && /Separate from Long sleeve/.test(box().textContent));
  ad.getElementById("prodFormName").value = "Changed"; ad.getElementById("prodFormName").dispatchEvent(new aw.Event("input", { bubbles: true }));
  let asked = ""; autoConfirm(aw, (m) => { asked = m; return false; });
  box().querySelector(".version-tab").click();
  await new Promise(res => setTimeout(res, 30));
  ok("switching to the other version with unsaved changes asks first (and stays when told to)", /aren't saved/.test(asked) && !/tee-ls/.test(aw.location.hash));
  autoConfirm(aw, () => true);
  ok("the local sale and Edit items pickers show the version's name", /p\.versionGroup && p\.versionLabel \? " — " \+ escapeHtml\(p\.versionLabel\)/.test(adminJs) && (adminJs.match(/p\.versionGroup && p\.versionLabel \? " — "/g) || []).length >= 2);
  r = await call({ action: "separateProductVersion", org: "club", productId: "tee-ls" });
  ok("Separate unlinks both (the short sleeve, left alone, is a plain product again)", r.status === 200 && (await prod("tee")).versionGroup === "" && (await prod("tee-ls")).versionGroup === "" && (await prod("tee-ls")).versionLabel === "");
  ok("…and the lines then carry the plain name", (await lib.priceItem(d1, "club", "tee", "M", 1, false, cfg)).name === "Club Tee");
  await aw.renderEditProductForm(app, "club", "cap");
  await until(() => ad.getElementById("prodFormVersions"));
  ok("a product on its own offers “Add a version (e.g. long sleeve)…”", /Add a version \(e\.g\. long sleeve\)/.test(ad.getElementById("prodFormVersions").textContent));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test127 crashed: false"); process.exit(1); });
