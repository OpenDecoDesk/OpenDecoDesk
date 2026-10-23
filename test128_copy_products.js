const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Products → Copy from another shop (2026-10): tick another shop's products, edit each copy's ID, name,
// subtitle, category, version name and visibility in a grid, copy with or without photos. A copy takes
// prices, sizes, colors, locations, settings and blank links; never overlay mockups or stock; the other
// shop's graphics and designs are matched by name or left out (and the result says which). Versions of a
// product are copied together. Real db.js / orders.js on sql.js; the admin window in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createGraphic, createProduct, saveLocation, saveDesign, setProductDesigns, listProductDesigns, setBlankLink, getBlankLinks,
  setProductGraphicImage, setProductGraphicColorBlocked, getProductsByOrg, priceItem, listGraphics };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
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
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club 1','t','t',1), ('chapter','chapter','Chapter 2','t','t',1);`);
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const prod = async (org, id) => (await lib.getProductsByOrg(d1, org, false)).find(p => p.productId === id);
  const count = (sql) => Number(d1.q(sql)[0].n);
  const sz = (...names) => names.map(size => ({ size, purchasePrice: 4, quantity: 10 }));

  // The club (source): a configurable short / long sleeve pair, a cap with a pick list, an old-style id.
  const ss = (await lib.createBlank(d1, { name: "Short tee", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: sz("S", "M") }] })).id;
  const ls = (await lib.createBlank(d1, { name: "Long tee", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: sz("S", "M") }] })).id;
  const locId = await lib.saveLocation(d1, { name: "Left chest", sortOrder: 1 });
  const crest = await lib.createGraphic(d1, "club", { name: "Crest", kind: "transfer", imageUrl: "img/crest.png" });
  const seal = await lib.createGraphic(d1, "club", { name: "Seal", kind: "transfer", imageUrl: "img/seal.png" });
  const chCrest = await lib.createGraphic(d1, "chapter", { name: "crest ", kind: "transfer", imageUrl: "img/ch-crest.png" });   // same name, the chapter's own
  await lib.saveDesign(d1, "club", { name: "Club logo" });
  await lib.saveDesign(d1, "club", { name: "Star badge" });
  await lib.saveDesign(d1, "club", { name: "BADGE", isGlobal: true });
  await lib.saveDesign(d1, "chapter", { name: "Star Badge" });
  const did = (org, name) => Number(d1.q(`SELECT id FROM designs WHERE orgId='${org}' AND name='${name}'`)[0].id);
  const locations = [{ key: "loc" + locId, label: "Left chest", locationId: locId, graphicIds: [crest, seal] }];
  const shared = { type: "shirt", sub: "Soft cotton", features: ["Pre-shrunk"], pricingMode: "sized", weightOz: 6, configurable: true, garmentColors: ["Navy"], locations, personalizationPrice: 5, taxable: true };
  await lib.createProduct(d1, "club", Object.assign({}, shared, { productId: "tee", name: "Club Tee", sizePricing: { S: 20, M: 20 }, visible: true, sortOrder: 10, images: ["img/tee.jpg"], versionGroup: "tee", versionLabel: "Short sleeve" }));
  await lib.createProduct(d1, "club", Object.assign({}, shared, { productId: "tee-ls", name: "Club Tee", sizePricing: { S: 26, M: 28 }, visible: true, sortOrder: 20, images: ["img/tee-ls.jpg"], versionGroup: "tee", versionLabel: "Long sleeve" }));
  await lib.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Club Cap", sub: "Adjustable", pricingMode: "flat", flatPrice: 15, visible: true, sortOrder: 30, images: ["img/cap.jpg", "img/cap-2.jpg"],
    personalizationOptions: ["BADGE", "LOGO"], personalizationOptionDesigns: { BADGE: did("club", "BADGE"), LOGO: did("club", "Club logo") } });
  await lib.createProduct(d1, "club", { productId: "Old Polo 9", type: "shirt", name: "Old Polo", pricingMode: "flat", flatPrice: 30, visible: false, sortOrder: 40 });
  await lib.setProductDesigns(d1, "club", "cap", [{ designId: did("club", "Star badge"), placement: "Front", isMain: true }, { designId: did("club", "BADGE"), placement: "Back" }, { designId: did("club", "Club logo"), placement: "Side" }]);
  for (const s of ["S", "M"]) { await lib.setBlankLink(d1, "club", "tee", "Navy", s, ss, "Navy", s); await lib.setBlankLink(d1, "club", "tee-ls", "Navy", s, ls, "Navy", s); }
  await lib.setProductGraphicColorBlocked(d1, "club", "tee", crest, "Navy", true);
  await lib.setProductGraphicColorBlocked(d1, "club", "tee", seal, "Navy", true);
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "tee", locationId: locId, graphicId: crest, garmentColor: "Navy", imageUrl: "img/mock.png" });
  d1._raw.run(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt) VALUES ('club','cap','',4,'t')`);
  // The chapter (target) already has a cap.
  await lib.createProduct(d1, "chapter", { productId: "cap", type: "cap", name: "Chapter Cap", pricingMode: "flat", flatPrice: 14, visible: true, sortOrder: 50 });
  const row = (fromProductId, productId, extra) => Object.assign({ fromProductId, productId, name: "Copy of " + fromProductId, sub: "", type: fromProductId === "cap" ? "cap" : "shirt" }, extra);

  console.log("=== Refused, and nothing written ===");
  const before = count("SELECT count(*) n FROM products WHERE orgId='chapter'");
  let r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("cap", "Cap 2")] }, { role: "staff" });
  ok("a worker may copy products, as with making one (refused here only for the bad id)", r.status === 400 && /lowercase/.test(r.body.message));
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "chapter", products: [row("cap", "cap-2")] });
  ok("copying a shop onto itself is refused", r.status === 400);
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [] });
  ok("…so is copying nothing", r.status === 400 && /Tick at least one/.test(r.body.message));
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("cap", "Cap 2")] });
  ok("…an ID that can't be a product ID", r.status === 400 && /lowercase/.test(r.body.message));
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("cap", "cap")] });
  ok("…an ID this shop already has", r.status === 400 && /already has a product with the id “cap”/.test(r.body.message));
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("cap", "x"), row("Old Polo 9", "x")] });
  ok("…the same ID twice", r.status === 400 && /used for two copies/.test(r.body.message));
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("tee", "tee")] });
  ok("…one version of a product without the other", r.status === 400 && /comes in versions — copy “Long sleeve” too/.test(r.body.message));
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("cap", "cap-2", { type: "spaceship" })] });
  ok("…a category that isn't on the list", r.status === 400 && /Pick a category/.test(r.body.message));
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("cap", "cap-2", { name: "" })] });
  ok("…a copy with no name", r.status === 400 && /give it a name/.test(r.body.message));
  ok("(none of those wrote anything)", count("SELECT count(*) n FROM products WHERE orgId='chapter'") === before);

  console.log("\n=== Copying, photos included ===");
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", copyImages: true, products: [
    row("tee", "chapter-tee", { name: "Chapter Tee", sub: "Ring-spun", versionLabel: "Short" }), row("tee-ls", "chapter-tee-ls", { name: "Chapter Tee", versionLabel: "Long", visible: true }),
    row("cap", "cap-2", { name: "Chapter Cap 2", sub: "Adjustable" })] });
  ok("it copies", r.status === 200 && r.body.copied.length === 3);
  const t = await prod("chapter", "chapter-tee"), tl = await prod("chapter", "chapter-tee-ls"), c = await prod("chapter", "cap-2");
  ok("each copy takes the ID, name, subtitle and version name typed in the grid", t.name === "Chapter Tee" && t.sub === "Ring-spun" && t.versionLabel === "Short" && tl.versionLabel === "Long" && c.name === "Chapter Cap 2");
  ok("…and its visibility (hidden unless ticked)", !t.visible && tl.visible && !c.visible);
  ok("…and everything else of the original: prices and sizes, weight, features, personalization, colors, settings",
    t.sizePricing.S === 20 && tl.sizePricing.M === 28 && t.weightOz === 6 && t.features.join() === "Pre-shrunk" && t.personalizationPrice === 5 &&
    t.garmentColors.join() === "Navy" && t.configurable && c.flatPrice === 15 && c.personalizationOptions.join() === "BADGE,LOGO");
  ok("the versions are linked again, under the new IDs (the originals untouched)", t.versionGroup === "chapter-tee" && tl.versionGroup === "chapter-tee" && (await prod("club", "tee")).versionGroup === "tee");
  ok("photos are copied when asked", t.images.join() === "img/tee.jpg" && c.images.length === 2 && r.body.copied.find(x => x.productId === "cap-2").images === 2);
  const links = (await lib.getBlankLinks(d1, "chapter"));
  ok("blank links are copied — each version to its own blank", links.filter(l => l.productId === "chapter-tee" && l.blankId === ss).length === 2 && links.filter(l => l.productId === "chapter-tee-ls" && l.blankId === ls).length === 2);
  ok("overlay mockups are never copied", count("SELECT count(*) n FROM product_graphic_images WHERE orgId='chapter'") === 0);
  ok("…nor ready-to-ship stock", count("SELECT count(*) n FROM ready_to_ship WHERE orgId='chapter'") === 0);
  ok("the copies go after the shop's own products", t.sortOrder > (await prod("chapter", "cap")).sortOrder && c.sortOrder > tl.sortOrder);

  console.log("\n=== The other shop's graphics and designs ===");
  ok("a graphic is matched to this shop's one of the same name (ignoring case and spaces); one this shop hasn't got is left out", JSON.stringify(t.locations[0].graphicIds) === JSON.stringify([chCrest]));
  ok("…and the colors blocked for it follow it", JSON.stringify(t.blockedGraphicColors) === JSON.stringify([{ graphicId: chCrest, color: "Navy" }]));
  const notesT = r.body.copied.find(x => x.productId === "chapter-tee").notes.join(" | ");
  ok("the result says which graphics were matched and which left out", /graphic “Crest” → this shop's graphic of the same name/.test(notesT) && /graphic “Seal” isn't in this shop — left out/.test(notesT));
  const cd = await lib.listProductDesigns(d1, "chapter", "cap-2");
  ok("designs: a global one is kept, a private one matched by name, one this shop hasn't got left out", cd.map(x => x.designId + ":" + x.placement).join() === `${did("chapter", "Star Badge")}:Front,${did("club", "BADGE")}:Back` && cd[0].isMain);
  ok("…and the pick list keeps the global design, losing the other shop's", JSON.stringify(c.personalizationOptionDesigns) === JSON.stringify({ BADGE: did("club", "BADGE") }));
  const notesC = r.body.copied.find(x => x.productId === "cap-2").notes.join(" | ");
  ok("…which the result says too", /Design “Star badge” → this shop's design/.test(notesC) && /Design “Club logo” belongs to the other shop — left out/.test(notesC) && /Pick-list option “LOGO”/.test(notesC));
  ok("each copy is in the audit log", count("SELECT count(*) n FROM audit_log WHERE action='product.copied' AND orgId='chapter'") === 3);
  const priced = await lib.priceItem(d1, "chapter", "chapter-tee-ls", "M", 1, false, { garmentColor: "Navy", locations: [{ location: "loc" + locId, graphicId: chCrest }] });
  ok("a copy can be ordered at once, named by its version", priced.unitPrice === 28 && priced.name === "Chapter Tee (Long)");

  console.log("\n=== Without photos ===");
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", copyImages: false, products: [row("cap", "cap-3")] });
  ok("unticked, a copy has no photos", r.status === 200 && (await prod("chapter", "cap-3")).images.length === 0);

  console.log("\n=== The admin window ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); if (b.action === "copyProductsFromOrg") sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  // A fresh shop with nothing in it, so the window offers every club product.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('team','team','Team 3','t','t',1);`);
  await lib.createProduct(d1, "team", { productId: "cap", type: "cap", name: "Team Cap", pricingMode: "flat", flatPrice: 10, visible: true });
  const app = d.getElementById("app");
  await w.renderProductList(app, "team");
  await until(() => d.getElementById("prodCopyBtn"));
  ok("the Products page has a “Copy from another shop…” button", /Copy from another shop/.test(d.getElementById("prodCopyBtn").textContent));
  d.getElementById("prodCopyBtn").click();
  await until(() => d.getElementById("cpFrom"));
  const from = d.getElementById("cpFrom");
  ok("the window lists the other shops (not this one)", [...from.options].map(o => o.value).join() === ",club,chapter" || [...from.options].map(o => o.value).filter(Boolean).sort().join() === "chapter,club");
  from.value = "club"; from.dispatchEvent(new w.Event("change"));
  await until(() => d.querySelector("#cpGrid tr[data-from]"));
  const grow = (id) => d.querySelector(`#cpGrid tr[data-from="${id}"]`);
  const rowsNow = [...d.querySelectorAll("#cpGrid tr[data-from]")].map(x => x.dataset.from);
  ok("its products are listed in a grid, the versions next to each other", rowsNow.join() === "tee,tee-ls,cap,Old Polo 9");
  ok("each row's ID, name, subtitle, category and version can be edited; Visible starts unticked", grow("tee").querySelector(".cpName").value === "Club Tee" && grow("tee").querySelector(".cpSub").value === "Soft cotton" &&
    grow("tee").querySelector(".cpType").value === "shirt" && grow("tee-ls").querySelector(".cpLabel").value === "Long sleeve" && !grow("cap").querySelector(".cpLabel") && !grow("tee").querySelector(".cpVis").checked);
  ok("suggested IDs avoid this shop's own and make an old ID valid", grow("cap").querySelector(".cpId").value === "cap-2" && grow("Old Polo 9").querySelector(".cpId").value === "old-polo-9" && grow("tee").querySelector(".cpId").value === "tee");
  const go = d.getElementById("cpGo");
  ok("nothing ticked, nothing to copy", go.disabled);
  const tick = (id, on) => { const cb = grow(id).querySelector(".cpPick"); cb.checked = on; cb.dispatchEvent(new w.Event("change")); };
  tick("tee-ls", true);
  ok("ticking one version ticks the other", grow("tee").querySelector(".cpPick").checked && /Copy 2 products/.test(go.textContent) && !go.disabled);
  tick("tee", false);
  ok("…and unticking one unticks both", !grow("tee-ls").querySelector(".cpPick").checked && go.disabled);
  tick("cap", true);
  const capId = grow("cap").querySelector(".cpId");
  capId.value = "cap"; capId.dispatchEvent(new w.Event("input"));
  ok("an ID this shop already has is flagged and stops the copy", /already has this ID/.test(grow("cap").querySelector(".cpProblem").textContent) && go.disabled);
  capId.value = "team-cap"; capId.dispatchEvent(new w.Event("input"));
  tick("tee", true);
  grow("tee").querySelector(".cpName").value = "Team Tee"; grow("tee-ls").querySelector(".cpName").value = "Team Tee"; grow("tee").querySelector(".cpVis").checked = true;
  d.getElementById("cpImages").checked = false;
  ok("photos are copied unless unticked; mockups never", /Copy product photos too/.test(d.getElementById("cpMain").textContent) && /Overlay mockups aren't copied/.test(d.getElementById("cpMain").textContent));
  go.click();
  await until(() => d.getElementById("cpDone"));
  const s = sent[sent.length - 1];
  ok("Copy sends what's in the grid", s && s.org === "team" && s.fromOrg === "club" && s.copyImages === false &&
    s.products.map(p => p.fromProductId + ">" + p.productId + ":" + p.name + ":" + p.visible).join() === "tee>tee:Team Tee:true,tee-ls>tee-ls:Team Tee:false,cap>team-cap:Club Cap:false" &&
    s.products[0].versionLabel === "Short sleeve" && s.products[2].versionLabel === undefined);
  const result = d.getElementById("cpMain").textContent.replace(/\s+/g, " ");
  ok("the window then lists what was copied and what was left out", /3 products copied/.test(result) && /Graphic “Seal” isn't in this shop — left out|graphic “Seal” isn't in this shop — left out/.test(result) && /2 blank links/.test(result));
  d.getElementById("cpDone").click();
  await until(() => [...d.querySelectorAll(".prod-cat-table tbody tr")].length === 4);
  ok("Done shows the shop's products with the copies", [...d.querySelectorAll(".prod-cat-table tbody tr")].length === 4 && (await prod("team", "tee")).visible);
  await lib.createProduct(d1, "club", { productId: "evil", type: "cap", name: "<img src=x onerror=alert(1)>", sub: "\"><b>x</b>", pricingMode: "flat", flatPrice: 1, visible: true, sortOrder: 99 });
  d.getElementById("prodCopyBtn").click();
  await until(() => d.getElementById("cpFrom"));
  d.getElementById("cpFrom").value = "club"; d.getElementById("cpFrom").dispatchEvent(new w.Event("change"));
  await until(() => d.querySelector('#cpGrid tr[data-from="evil"]'));
  const evil = d.querySelector('#cpGrid tr[data-from="evil"]');
  ok("another shop's product names are shown escaped in the grid", !d.getElementById("cpGrid").querySelector("img, b") && evil.querySelector(".cpName").value === "<img src=x onerror=alert(1)>" && evil.querySelector(".cpSub").value === '"><b>x</b>');
  d.getElementById("cpCancel").click();
  ok("creating a shop with “copy products from” uses the same copy", /action: "copyProductsFromOrg", key: adminKey, org: body\.orgId, fromOrg: cloneSrc, copyImages: true, products/.test(adminJs));

  console.log("\n=== Every column of a product is copied, or left out on purpose ===");
  // A product with every setting away from its default — the customer's own design and its price per
  // location, No blank / No design needed, not taxable, separate personalization, its own reorder QR —
  // so a column that isn't copied shows up as a difference. A new products column must be copied, or
  // named in KEEP with the reason, or this fails.
  await lib.createProduct(d1, "club", { productId: "upload-tee", type: "shirt", name: "Your Design Tee", sub: "Send us your art", pricingMode: "sized",
    sizePricing: { S: 18, M: 19 }, weightOz: 7, features: ["Your art"], visible: true, taxable: false, personalizationPrice: 3, personalizationOptions: ["A", "B"],
    personalizationMode: "separate", noDesignNeeded: true, noBlankNeeded: true, customDesign: "transfer", customDesignPrice: 4, configurable: true,
    garmentColors: ["Red", "Navy"], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [], customDesignPriceCents: 650 }] });
  // A color price group too (migrations/0064), written as the product form saves it.
  d1._raw.run(`UPDATE products SET colorGroupsJson='[{"key":"g1","label":"Heathers","colors":["Red"],"sizePricingCents":{"S":2100,"M":2200}}]' WHERE orgId='club' AND productId='upload-tee'`);
  r = await call({ action: "copyProductsFromOrg", org: "chapter", fromOrg: "club", products: [row("upload-tee", "upload-tee-2", { name: "Your Design Tee", sub: "Send us your art" })] });
  const KEEP = { orgId: "the shop", productId: "typed in the window", name: "typed in the window", sub: "typed in the window", type: "chosen in the window",
    visible: "ticked in the window", sortOrder: "goes at the end of this shop's list", imagesJson: "only with “copy photos”", createdAt: "new", updatedAt: "new",
    versionGroup: "relinked under the new ids", versionLabel: "typed in the window", blockedGraphicColorsJson: "follows its graphic (mapped)",
    designId: "designs are matched by name", personalizationOptionDesigns: "designs are matched by name" };
  const rawRow = (org, id) => d1.q(`SELECT * FROM products WHERE orgId='${org}' AND productId='${id}'`)[0];
  const a0 = rawRow("club", "upload-tee"), b0 = rawRow("chapter", "upload-tee-2");
  const columns = d1.q("PRAGMA table_info(products)").map(c => c.name);
  const differ = columns.filter(c => !(c in KEEP) && JSON.stringify(a0[c]) !== JSON.stringify(b0[c]));
  if (differ.length) console.log("   not copied:", differ.map(c => `${c} (${JSON.stringify(a0[c])} → ${JSON.stringify(b0[c])})`).join(", "));
  ok("every products column is copied unless it's on the deliberate keep-out list", r.status === 200 && b0 && differ.length === 0);
  ok("…including this install's own settings (customer design and its prices, No blank needed, color price groups)", b0 && b0.customDesign === "transfer" && Number(b0.noBlankNeeded) === 1 &&
    /650/.test(b0.locationsJson) && Number(b0.customDesignPriceCents) === 400 && /Heathers/.test(b0.colorGroupsJson) && /2200/.test(b0.colorGroupsJson));
  ok("…and the keep-out list names only real columns", Object.keys(KEEP).every(c => columns.includes(c)));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test128 crashed: false"); process.exit(1); });
