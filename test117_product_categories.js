const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Product categories (migrations/0056): a managed list instead of shirt / sweatshirt / cap written
// into the code. Real SQL (sql.js), real db.js + orders.js admin API, the real catalog answer, the
// box chooser, the CSV import, and the real storefront and admin screens in jsdom.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { listProductCategories, saveProductCategory, deleteProductCategory, getCategoryPackMap, categoryKeyFromName,
  importTypeFromCategory, importProductsCsv, importBlanksCsv, createProduct, getProductsByOrg, createBlank, getAllBlanks, getPublicCatalogData, priceItem };`)();
const stubs = "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "let _bumps = 0; const invalidateCatalogVersionCache = () => { _bumps++; }; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n";
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  stubs + dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { onRequestPost, bumps: () => _bumps };")();
const selectBox = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn selectBox;")();

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (upTo) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!upTo || f < upTo) d1.execFile(read("migrations/" + f));
  return d1;
};
const tick = (ms) => new Promise(res => setTimeout(res, ms || 60));

(async () => {
  const d1 = await newDb();
  const call = async (body) => {
    const res = await api.onRequestPost({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);

  console.log("=== Migration 0056: seeds ===");
  let cats = await lib.listProductCategories(d1);
  console.log("Shirt, T Shirt, Sweatshirt, Hoodie, Cap, Patch, Other — in that order:", cats.map(c => c.name).join("|") === "Shirt|T Shirt|Sweatshirt|Hoodie|Cap|Patch|Other");
  console.log("the three original keys are unchanged, so existing products keep their category:", ["shirt", "sweatshirt", "cap"].every(k => cats.some(c => c.key === k)));
  console.log("each has a storefront heading:", cats.map(c => c.plural).join("|") === "Shirts|T Shirts|Sweatshirts|Hoodies|Caps|Patches|Other");
  const pack = await lib.getCategoryPackMap(d1);
  console.log("each says what it packs like (T Shirt → shirt, Hoodie → sweatshirt, Patch → other):",
    pack["t-shirt"] === "shirt" && pack.hoodie === "sweatshirt" && pack.cap === "cap" && pack.patch === "other" && pack.shirt === "shirt");

  console.log("\n=== db.js: add / edit / delete ===");
  console.log("a new category's key comes from its name:", lib.categoryKeyFromName("Tote Bag") === "tote-bag" && lib.categoryKeyFromName("  3/4 Zip! ") === "3-4-zip");
  const toteKey = await lib.saveProductCategory(d1, { name: "Tote Bag", plural: "Tote Bags", packAs: "shirt" });
  cats = await lib.listProductCategories(d1);
  console.log("created, and placed last:", toteKey === "tote-bag" && cats[cats.length - 1].key === "tote-bag" && cats[cats.length - 1].packAs === "shirt");
  let threw = "";
  try { await lib.saveProductCategory(d1, { name: "tote bag" }); } catch (e) { threw = e.message; }
  console.log("a duplicate name is refused, whatever its case:", /already a category/.test(threw));
  threw = "";
  try { await lib.saveProductCategory(d1, { name: "  " }); } catch (e) { threw = e.message; }
  console.log("a name is required:", /needs a name/.test(threw));
  threw = "";
  try { await lib.saveProductCategory(d1, { name: "!!!" }); } catch (e) { threw = e.message; }
  console.log("a name with no letters or numbers is refused:", /letters or numbers/.test(threw));
  await lib.saveProductCategory(d1, { key: "tote-bag", name: "Bag", plural: "Bags", packAs: "bogus", sortOrder: 0 });
  cats = await lib.listProductCategories(d1);
  console.log("renaming keeps the key; a bad 'packs like' becomes other; order 0 lists it first:",
    cats[0].key === "tote-bag" && cats[0].name === "Bag" && cats[0].plural === "Bags" && cats[0].packAs === "other");
  await lib.saveProductCategory(d1, { name: "Mug" });
  console.log("a heading left blank falls back to the name:", (await lib.listProductCategories(d1)).find(c => c.key === "mug").plural === "Mug");
  await lib.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { S: 20, M: 20 }, visible: true });
  await lib.createBlank(d1, { name: "Richardson 112", productType: "cap" });
  cats = await lib.listProductCategories(d1, { withCounts: true });
  console.log("each category reports its products and blanks:", cats.find(c => c.key === "shirt").productCount === 1 && cats.find(c => c.key === "cap").blankCount === 1 && cats.find(c => c.key === "mug").productCount === 0);
  threw = "";
  try { await lib.deleteProductCategory(d1, "shirt"); } catch (e) { threw = e.message; }
  console.log("a category a product uses can't be deleted, and says why:", /used by 1 product/.test(threw));
  threw = "";
  try { await lib.deleteProductCategory(d1, "cap"); } catch (e) { threw = e.message; }
  console.log("...nor one a blank uses:", /used by 1 blank/.test(threw));
  await lib.deleteProductCategory(d1, "mug");
  await lib.deleteProductCategory(d1, "tote-bag");
  console.log("unused ones are deleted:", (await lib.listProductCategories(d1)).length === 7);

  console.log("\n=== Real admin API ===");
  let r = await call({ action: "listProductCategories" });
  console.log("listProductCategories returns the list with counts:", r.status === 200 && r.body.categories.length === 7 && r.body.categories.find(c => c.key === "shirt").productCount === 1);
  const bumpsBefore = api.bumps();
  r = await call({ action: "saveProductCategory", category: { name: "Beanie", plural: "Beanies", packAs: "cap" } });
  console.log("saveProductCategory creates one and answers with the new list:", r.status === 200 && r.body.categories.some(c => c.key === "beanie" && c.packAs === "cap"));
  console.log("...and makes the storefront re-read the catalog:", api.bumps() === bumpsBefore + 1);
  r = await call({ action: "saveProductCategory", category: { name: "beanie" } });
  console.log("a duplicate is refused (400):", r.status === 400 && /already a category/.test(r.body.message));
  r = await call({ action: "deleteProductCategory", categoryKey: "shirt" });
  console.log("deleting one in use is refused (400) with the reason:", r.status === 400 && /used by 1 product/.test(r.body.message));
  r = await call({ action: "deleteProductCategory", categoryKey: "beanie" });
  console.log("deleting an unused one works:", r.status === 200 && !r.body.categories.some(c => c.key === "beanie"));
  r = await call({ action: "deleteProductCategory" });
  console.log("delete needs to be told which category (the request's own `key` is the sign-in, not the category):", r.status === 400 && (await lib.listProductCategories(d1)).length === 7);
  const product = (over) => Object.assign({ action: "createProduct", org: "club", name: "X", pricingMode: "flat", flatPrice: 5, images: [], features: [], visible: true }, over);
  r = await call(product({ productId: "mug1", type: "mug" }));
  console.log("a product can't be created in a category that isn't in the list:", r.status === 400 && /Pick a category/.test(r.body.message));
  r = await call(product({ productId: "patch1", type: "patch", name: "Club Patch" }));
  console.log("a product can be created in a new seeded category (Patch):", r.status === 200 && (await lib.getProductsByOrg(d1, "club", false)).some(p => p.productId === "patch1" && p.type === "patch"));
  // A product whose category was later deleted keeps working when it's edited without changing it.
  d1._raw.run("UPDATE products SET type='legacy' WHERE productId='polo'");
  r = await call({ action: "updateProduct", org: "club", productId: "polo", type: "legacy", name: "Polo 2", pricingMode: "sized", sizePricing: { S: 21, M: 21 }, images: [], features: [], visible: true });
  console.log("editing a product that still has a deleted category is allowed if the category isn't changed:", r.status === 200 && (await lib.getProductsByOrg(d1, "club", false)).find(p => p.productId === "polo").name === "Polo 2");
  r = await call({ action: "updateProduct", org: "club", productId: "polo", type: "nope", name: "Polo 2", pricingMode: "sized", sizePricing: { S: 21, M: 21 }, images: [], features: [], visible: true });
  console.log("...but it can't be moved to another one that doesn't exist:", r.status === 400);
  r = await call({ action: "updateProduct", org: "club", productId: "polo", type: "t-shirt", name: "Polo 2", pricingMode: "sized", sizePricing: { S: 21, M: 21 }, images: [], features: [], visible: true });
  console.log("...and can be moved to a real one:", r.status === 200 && (await lib.getProductsByOrg(d1, "club", false)).find(p => p.productId === "polo").type === "t-shirt");

  console.log("\n=== Whether a product has sizes follows its pricing, not its category ===");
  let priced = await lib.priceItem(d1, "club", "patch1", "OSFA", 2, false);
  console.log("a flat-priced Patch prices with no size:", priced.unitPrice === 5 && priced.type === "patch");
  priced = await lib.priceItem(d1, "club", "polo", "M", 1, false);
  console.log("a T Shirt priced by size prices by size:", priced.unitPrice === 21 && priced.type === "t-shirt");

  console.log("\n=== Box chooser: each category counts against the limit it packs like ===");
  const presets = [{ length: 12, width: 9, height: 2, maxShirts: 2, maxCaps: 0, maxSweatshirts: 0, packingCost: 1 }, { length: 12, width: 12, height: 6, maxShirts: 6, maxCaps: 4, maxSweatshirts: 2, packingCost: 2 }];
  const packMap = await lib.getCategoryPackMap(d1);
  const fits = (items, map) => { const b = selectBox(items, presets, map); return b ? b.box.height : null; };
  console.log("a T Shirt counts as a shirt:", fits([{ type: "t-shirt", qty: 2 }], packMap) === "2");
  console.log("a Hoodie counts as a sweatshirt (needs the bigger box):", fits([{ type: "hoodie", qty: 1 }], packMap) === "6");
  console.log("a Patch packs like nothing → no automatic box (quote by hand):", fits([{ type: "patch", qty: 1 }], packMap) === null);
  console.log("...until its category is set to pack like a shirt:", fits([{ type: "patch", qty: 1 }], Object.assign({}, packMap, { patch: "shirt" })) === "2");
  console.log("without the map, the type's wording is still guessed (old callers):", fits([{ type: "sweatshirt", qty: 1 }]) === "6" && fits([{ type: "shirt", qty: 1 }]) === "2");

  console.log("\n=== CSV import maps a file's category onto the list ===");
  cats = await lib.listProductCategories(d1);
  console.log("a category's own name, heading or key wins:", lib.importTypeFromCategory("Patch", cats) === "patch" && lib.importTypeFromCategory("T Shirts", cats) === "t-shirt" && lib.importTypeFromCategory("hoodie", cats) === "hoodie");
  console.log("a vendor's wording is still guessed (Hoodies & Layers → sweatshirt, Headwear → cap):", lib.importTypeFromCategory("Hoodies & Layers", cats) === "sweatshirt" && lib.importTypeFromCategory("Headwear", cats) === "cap");
  console.log("something that's neither → '':", lib.importTypeFromCategory("Mugs", cats) === "");
  const P = (o) => Object.assign({ sku: "", category: "", name: "", price: "", sizes: "" }, o);
  let imp = await lib.importProductsCsv(d1, "club", [P({ sku: "PATCH-A", category: "Patches", name: "Round Patch", price: "6.00" })], { dryRun: false });
  let made = (await lib.getProductsByOrg(d1, "club", false)).find(p => p.productId === "patch-a");
  console.log("a Patches row with no sizes imports as a flat-priced Patch:", imp.created === 1 && made && made.type === "patch" && made.pricingMode === "flat" && made.flatPrice === 6);
  imp = await lib.importProductsCsv(d1, "club", [P({ sku: "TEE-A", category: "T Shirt", name: "Tee", price: "15.00" })], { dryRun: true });
  console.log("a T Shirt row with no sizes is still a problem (a garment needs its sizes):", imp.results[0].problems.some(x => /No sizes/.test(x)));
  imp = await lib.importProductsCsv(d1, "club", [P({ sku: "MUG-A", category: "Mugs", name: "Mug", price: "9.00" })], { dryRun: true });
  console.log("an unknown category names the ones that exist:", imp.results[0].problems.some(x => /isn't one of this site's categories \(.*Patch.*\)/.test(x)));
  const bl = await lib.importBlanksCsv(d1, [{ style: "PT-1", name: "Twill sheet", category: "Patches", cost_OSFA: "1.50" }, { style: "ZZ-1", name: "Odd thing", category: "Widgets", cost_OSFA: "2.00" }], { dryRun: false });
  const blanks = await lib.getAllBlanks(d1);
  console.log("blanks import files a known category under it, an unknown one under Other:",
    bl.created === 2 && blanks.find(b => b.sku === "PT-1").productType === "patch" && blanks.find(b => b.sku === "ZZ-1").productType === "other");

  console.log("\n=== The storefront's catalog answer ===");
  const pub = await lib.getPublicCatalogData(d1);
  console.log("carries the categories in order, key + heading only:", pub.categories.map(c => c.key + "=" + c.label).join("|") === "shirt=Shirts|t-shirt=T Shirts|sweatshirt=Sweatshirts|hoodie=Hoodies|cap=Caps|patch=Patches|other=Other"
    && Object.keys(pub.categories[0]).join() === "key,label");

  console.log("\n=== A database that hasn't had 0056 applied yet behaves as before ===");
  const old = await newDb("0056");
  const oldCats = await lib.listProductCategories(old);
  console.log("the list reads as the built-in one (shirt, sweatshirt, cap, other):", oldCats.map(c => c.key).join() === "shirt,sweatshirt,cap,other");
  console.log("the box chooser's map still works:", (await lib.getCategoryPackMap(old)).sweatshirt === "sweatshirt");
  old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  await lib.createProduct(old, "club", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { S: 20 }, visible: true });
  console.log("the public catalog still builds:", (await lib.getPublicCatalogData(old)).categories.length === 4);

  // ---- The real storefront, in jsdom, on the real catalog answer ---------------------------
  const catalogSrc = strip(read("functions/api/catalog.js"));
  const catalogGet = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "let _data; const getCatalogData = async () => _data; const getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\n" + catalogSrc + "\nreturn { onRequestGet, set: (d) => { _data = d; } };")();
  await lib.createProduct(d1, "club", { productId: "cap1", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 18, visible: true, sortOrder: 5 });
  // A category that normally has sizes, sold at one flat price — used to crash the page.
  await lib.createProduct(d1, "club", { productId: "flattee", type: "shirt", name: "One-Size Poncho", pricingMode: "flat", flatPrice: 12, visible: true, sortOrder: 6 });
  catalogGet.set(await lib.getPublicCatalogData(d1));
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: "usable", url: "https://club.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url) => { const res = await catalogGet.onRequestGet({ request: { url: win.location.origin + url }, env: {} });
      const text = await res.text(); return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text }; }; } });
  const w = dom.window, doc = w.document;
  await tick(200);
  console.log("\n=== Storefront ===");
  const sent = JSON.parse(await (await catalogGet.onRequestGet({ request: { url: "https://club.example.com/api/catalog" }, env: {} })).text());
  console.log("the shop's answer lists only the categories it uses, in the managed order:", sent.catalog.categories.map(c => c.key).join() === "shirt,t-shirt,cap,patch");
  const heads = [...doc.querySelectorAll(".cat-heading")].map(h => h.textContent.trim());
  console.log("the page has a section per category, under its heading, in that order:", heads.join("|") === "Shirts|T Shirts|Caps|Patches");
  console.log("the jump links match:", [...doc.querySelectorAll(".cat-nav-link")].map(a => a.textContent.trim() + a.getAttribute("href")).join("|") === "Shirts#cat-shirt|T Shirts#cat-t-shirt|Caps#cat-cap|Patches#cat-patch");
  const card = (name) => [...doc.querySelectorAll(".product")].find(p => p.textContent.includes(name));
  console.log("a flat-priced Patch shows its price and 'One size fits all' (no size list):", /\$5\.00/.test(card("Club Patch").textContent) && /One size fits all/.test(card("Club Patch").textContent) && !card("Club Patch").querySelector("select[id^='size-']"));
  console.log("a T Shirt priced by size shows its sizes:", [...card("Polo 2").querySelectorAll("select[id^='size-'] option")].map(o => o.value).join() === "S,M");
  console.log("a flat-priced product in a 'sized' category renders too (it used to break the page):", /\$12\.00/.test(card("One-Size Poncho").textContent) && /One size fits all/.test(card("One-Size Poncho").textContent));
  card("Club Patch").querySelector("[data-action='add']").click();
  card("Polo 2").querySelector("[data-action='add']").click();
  await tick(50);
  const cart = w.eval("cart");
  console.log("adding a Patch puts a one-size line in the cart at its flat price:", cart[0].type === "patch" && cart[0].size === "OSFA" && cart[0].unitPrice === 5);
  console.log("adding a sized T Shirt keeps its size:", cart[1].type === "t-shirt" && cart[1].size === "S" && cart[1].unitPrice === 21);
  const ticket = doc.getElementById("ticketPanel").textContent.replace(/\s+/g, " ");
  console.log("the cart names a size only for the sized line:", /Polo 2 · size S/.test(ticket) && !/Club Patch · size/.test(ticket));
  // A catalog answer from before the list existed (no `categories`) still groups the old way.
  const legacy = Object.assign({}, sent.catalog); delete legacy.categories;
  legacy.products = legacy.products.filter(p => p.type === "shirt" || p.type === "cap");
  w.eval("currentOrg").categories = undefined; w.eval("currentOrg").products = legacy.products;
  w.eval('renderOrgPage(document.getElementById("app"), currentOrg.orgId, currentOrg)');
  console.log("an older catalog answer without the list falls back to Shirts / Caps:", [...doc.querySelectorAll(".cat-heading")].map(h => h.textContent.trim()).join("|") === "Shirts|Caps");

  // ---- The real admin screens, in jsdom, talking to the real API ----------------------------
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const adom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) { const res = await call(JSON.parse(opts.body)); return { ok: res.status < 400, status: res.status, json: async () => res.body }; }
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      autoConfirm(win, () => true);
    } });
  const aw = adom.window, adoc = aw.document;
  await tick(150);
  await aw.loadAdminScript();
  aw.eval('adminKey = "x";');
  const app = adoc.getElementById("app");
  const settle = async (pred) => { for (let i = 0; i < 80 && !pred(); i++) await tick(25); };

  console.log("\n=== Admin: Tools → Product categories ===");
  console.log("the page is in the Tools menu and routed:", /\["categories", "Product categories"\]/.test(adminJs) && /renderProductCategories\(app\)/.test(adminJs));
  await aw.renderProductCategories(app);
  await settle(() => app.querySelector("[data-pc-body] table"));
  const rows = () => [...app.querySelectorAll("[data-pc-body] tbody tr")].map(tr => tr.querySelector(".stack-title").textContent.trim());
  console.log("it lists every category in order:", rows().join("|") === "Shirt|T Shirt|Sweatshirt|Hoodie|Cap|Patch|Other");
  console.log("it shows what uses each one:", /2 products/.test(app.querySelector("[data-pc-body]").textContent) && /1 blank/.test(app.querySelector("[data-pc-body]").textContent));
  app.querySelector("[data-pc-new]").click();
  adoc.getElementById("pcfName").value = "Tote Bag"; adoc.getElementById("pcfPlural").value = "Tote Bags"; adoc.getElementById("pcfPack").value = "shirt";
  adoc.getElementById("pcfSave").click();
  await settle(() => rows().includes("Tote Bag"));
  console.log("+ New category adds one and the list redraws:", rows()[rows().length - 1] === "Tote Bag" && !adoc.getElementById("pcfName"));
  app.querySelector('[data-pc-edit="tote-bag"]').click();
  adoc.getElementById("pcfName").value = "Bag"; adoc.getElementById("pcfSort").value = "0";
  adoc.getElementById("pcfSave").click();
  await settle(() => rows()[0] === "Bag");
  console.log("Edit renames it and moves it:", rows()[0] === "Bag");
  app.querySelector('[data-pc-del="shirt"]').click(); await tick(80);
  await tick(80);
  console.log("deleting a category in use is refused (it stays in the list):", rows().includes("Shirt"));
  app.querySelector('[data-pc-del="tote-bag"]').click();
  await settle(() => !rows().includes("Bag"));
  console.log("deleting an unused one removes it:", !rows().includes("Bag") && rows().length === 7);

  console.log("\n=== Admin: the forms pick from the list ===");
  aw._adminOrgRegistry = [{ orgId: "club", name: "Club" }];
  aw.renderProductForm(app, "club", null);
  let opts = [...adoc.querySelectorAll("#prodFormType option")].map(o => o.textContent.trim());
  console.log("the product form's Category offers every category:", opts.join("|") === "Shirt|T Shirt|Sweatshirt|Hoodie|Cap|Patch|Other");
  aw.renderProductForm(app, "club", (await lib.getProductsByOrg(d1, "club", false)).find(p => p.productId === "patch1"));
  console.log("an existing product's category is selected:", adoc.getElementById("prodFormType").value === "patch");
  aw.renderProductForm(app, "club", Object.assign({}, (await lib.getProductsByOrg(d1, "club", false)).find(p => p.productId === "patch1"), { type: "legacy" }));
  console.log("a category that was deleted stays selected instead of silently becoming another one:",
    adoc.getElementById("prodFormType").value === "legacy" && /no longer a category/.test(adoc.getElementById("prodFormType").selectedOptions[0].textContent));
  aw.showBlankModal(null, () => {});
  await settle(() => adoc.getElementById("blkType"));
  console.log("the blank form's Product type offers every category:", [...adoc.querySelectorAll("#blkType option")].map(o => o.value).join() === "shirt,t-shirt,sweatshirt,hoodie,cap,patch,other");
  adoc.getElementById("blkCancel").click();
  await aw.renderAdminBlanks(app);
  await settle(() => /Richardson 112/.test(app.textContent));
  const groupHeads = [...app.querySelectorAll("#blanksPanel h3")].map(h => h.textContent.trim());
  console.log("the Blanks list groups under each category's heading, in the managed order:", groupHeads.join("|") === "Caps|Patches|Other");

  console.log("\n=== Admin: sizes and box limits no longer depend on the category's name ===");
  console.log("a line has a size unless it's one-size (OSFA / blank), whatever its category:",
    aw.itemHasSize_({ type: "hoodie", size: "XL" }) === true && aw.itemHasSize_({ type: "patch", size: "OSFA" }) === false &&
    aw.itemHasSize_({ type: "shirt", size: "" }) === false && aw.itemHasSize_({ type: "cap", size: "OSFA" }) === false && aw.itemHasSize_({ type: "shirt", size: "M" }) === true);
  console.log("each line counts against the limit its category packs like:",
    aw.packClassOf_("t-shirt") === "shirt" && aw.packClassOf_("hoodie") === "sweatshirt" && aw.packClassOf_("patch") === "other" && aw.packClassOf_("cap") === "cap");
  console.log("a line whose category is gone is guessed from its wording:", aw.packClassOf_("fleece pullover") === "sweatshirt" && aw.packClassOf_("mystery") === "other");
  console.log("no screen still decides sizes from the words shirt / sweatshirt:",
    !/type ?=== ?"shirt" ?\|\| ?(it|p|product|c)\.type ?=== ?"sweatshirt"/.test(adminJs) && !/type ?=== ?"shirt" ?\|\| ?(p|product|c)\.type ?=== ?"sweatshirt"/.test(read("public/index.html")));
})().catch(e => { console.log("test117 crashed:", false); console.error(e); process.exit(1); });
