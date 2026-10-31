const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN, shopOrigin, ROOT } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// New shop setup wizard (#wizard/…): its saved state (getShopWizard / saveShopWizard / listShopWizards), building a
// product from a blank in one call (buildProductFromBlank — links, color price groups, designs, never taking another
// product's id, MAP, roles), the prices worked out from a blank (wizardPrices_ — every method, rounding, MAP, groups),
// a colors-only product needing no option pick, and the whole wizard in jsdom on the real API: a new shop → its
// questions → blanks → two products → Check (a design still to come) → Go live, and Resume landing where it was left.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getPublicCatalogData, getAllBlanks, priceItem, getPublishState, getPublishedOrg, publishShop, getCatalogIssues, signPreviewToken, verifyPreviewToken };`)();
const common = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/setupStatus.js")) + "\n";
const api = new Function(common +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const catalogGet = new Function(common + dbSrc +
  "\nconst getCatalogData = async (env) => getPublicCatalogData(env.DB);\n" + strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('northside','northside','Northside','t','t',1);`);
  const ENV = { DB: d1, SIGNING_SECRET: "a-signing-secret-for-tests-0123456789abcdef" };
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: ENV, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const shopPage = async (org, query = "") => JSON.parse(await (await catalogGet({ request: new Request(shopOrigin(org) + "/api/catalog" + query), env: ENV })).text());

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  // Two blanks: a polo (Heather costs more; 2XL more again; MAP on Navy M) and a one-size cap with a MAP.
  const sz = (prices, maps) => ["S", "M", "L", "XL", "2XL"].map((s, i) => ({ size: s, quantity: 0, purchasePrice: prices[i], vendorPrice: prices[i], mapPrice: maps ? maps[i] : null }));
  let r = await call({ action: "createBlank", name: "Sample Polo", brand: "Sample Co", sku: "SP200", vendor: "Supplier", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: sz([7, 7, 7, 7, 9], [null, 20, null, null, null]) }, { color: "Black", images: [], sizes: sz([7, 7, 7, 7, 9]) }, { color: "Heather Grey", images: [], sizes: sz([8, 8, 8, 8, 10]) }] });
  const poloId = r.body.id;
  r = await call({ action: "createBlank", name: "Sample Cap", brand: "Sample Co", sku: "SC100", vendor: "Supplier", productType: "cap",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "OSFA", quantity: 0, purchasePrice: 3, vendorPrice: 3, mapPrice: 14.99 }] }, { color: "Khaki", images: [], sizes: [{ size: "OSFA", quantity: 0, purchasePrice: 3, vendorPrice: 3, mapPrice: 14.99 }] }] });
  const capId = r.body.id;
  r = await call({ action: "updateBrandRules", rules: Object.assign((await call({ action: "getBrandRules" })).body.rules, { brandPrices: [{ brand: "Sample Co", add: 5, unit: "amount" }] }) });
  ok("a brand's price rule saves on Brand rules", r.status === 200 && r.body.rules.brandPrices[0].add === 5);
  const blanks = await lib.getAllBlanks(d1);
  const polo = blanks.find(b => b.id === poloId), cap = blanks.find(b => b.id === capId);

  console.log("=== Prices from a blank (wizardPrices_) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.open = () => null; win.scrollTo = () => {}; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin", site: { rootDomain: ROOT } }) }; }; } });
  const w = dom.window, d = w.document;
  await wait(150);
  await w.loadAdminScript();
  const S = ["S", "M", "L", "XL", "2XL"];
  let p = w.wizardPrices_(polo, ["Navy", "Black", "Heather Grey"], S, "over", { amount: 12, keepMap: true }, "none");
  ok("$ over cost: cost + $12 per size, Navy M raised to its MAP ($20)", p.pricingMode === "sized" && p.cells["Navy|S"].price === 19 && p.cells["Navy|2XL"].price === 21 &&
    p.cells["Navy|M"].price === 20 && p.cells["Navy|M"].raised && !p.problems.length);
  ok("…colors priced the same share the product's price; the others become color price groups (Navy, raised at M, and Heather Grey)",
    p.standardColors.join() === "Black" && p.colorGroups.length === 2 && p.colorGroups.some(g => g.colors.join() === "Heather Grey" && g.sizePricing.S === 20 && g.sizePricing["2XL"] === 22));
  p = w.wizardPrices_(polo, ["Black", "Heather Grey"], S, "pct", { pct: 100 }, "99");
  ok("% over cost with rounding up to .99: $7 → $14 → $14.99, $9 → $18.99, Heather $8 → $16.99", p.sizePricing.S === 14.99 && p.sizePricing["2XL"] === 18.99 && p.colorGroups[0].sizePricing.S === 16.99);
  p = w.wizardPrices_(polo, ["Black"], S, "over", { amount: 3.2 }, "whole");
  ok("rounding up to the next whole dollar: $10.20 → $11", p.sizePricing.S === 11);
  p = w.wizardPrices_(polo, ["Navy"], S, "over", { amount: 1, keepMap: false }, "none");
  ok("with “Never below MAP” off, a price below MAP is a problem, not a quiet change", p.problems.some(x => /Navy M is below MAP/.test(x)));
  p = w.wizardPrices_(cap, ["Navy", "Khaki"], ["OSFA"], "map", { amount: 5 }, "none");
  ok("MAP pricing on a one-size cap: a flat price of its MAP", p.pricingMode === "flat" && p.flatPrice === 14.99 && !p.colorGroups.length);
  p = w.wizardPrices_(cap, ["Navy", "Khaki"], ["OSFA"], "map", { mapAdd: 5, amount: 5 }, "none");
  ok("MAP + $5: $14.99 → $19.99", p.flatPrice === 19.99);
  p = w.wizardPrices_(cap, ["Navy", "Khaki"], ["OSFA"], "map", { mapAdd: 10, mapUnit: "pct" }, "99");
  ok("MAP + 10%, rounded up to .99: $14.99 → $16.49 → $16.99", p.flatPrice === 16.99);
  p = w.wizardPrices_(polo, ["Black"], S, "manual", { manual: { S: 25, M: 25, L: 25, XL: 25, "2XL": "" } }, "none");
  ok("typed prices: each size as typed; one left blank is a problem", p.sizePricing.S === 25 && p.problems.some(x => /No price for 2XL/.test(x)));

  console.log("\n=== Building a product from a blank (buildProductFromBlank) ===");
  await call({ action: "createOrg", orgId: "acme", subdomain: "acme", name: "Acme", ready: false, deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }] });
  const priced = w.wizardPrices_(polo, ["Navy", "Black", "Heather Grey"], S, "over", { amount: 12 }, "none");
  const build = (extra, role) => call(Object.assign({ action: "buildProductFromBlank", org: "acme", blankId: poloId, colors: ["Navy", "Black", "Heather Grey"], sizes: S,
    name: "Acme Polo", decoration: "embroidery", pricingMode: priced.pricingMode, sizePricing: priced.sizePricing, colorGroups: priced.colorGroups }, extra), { role });
  r = await build({}, "staff");
  ok("a worker can't build products", r.status === 403);
  r = await build({});
  const pid = r.body.productId;
  const row = d1.q("SELECT visible, colorGroupsJson, garmentColorsJson, configurable FROM products WHERE orgId='acme' AND productId=?", pid)[0];
  ok("a manager builds it in one call: shown (the shop isn't open yet, so Preview has it), every color as a choice, its color price groups", r.status === 200 && pid === "acme-polo" && r.body.created &&
    row.visible === 1 && row.configurable === 1 && JSON.parse(row.garmentColorsJson).length === 3 && JSON.parse(row.colorGroupsJson).length === 2);
  ok("…every color × size linked to the blank (3 × 5)", r.body.linked === 15 && Number(d1.q("SELECT count(*) n FROM product_blank_links WHERE orgId='acme' AND productId=?", pid)[0].n) === 15);
  ok("…audited as created and built from a blank", d1.q("SELECT action FROM audit_log WHERE action IN ('product.created','product.built_from_blank')").length === 2);
  r = await build({});
  ok("building another from the same name never takes the first one's ID", r.status === 200 && r.body.productId === "acme-polo-2");
  r = await build({ productId: pid, colors: ["Black"], colorGroups: [] });
  ok("rebuilding by ID updates it, and the links of colors no longer offered go", r.status === 200 && r.body.productId === pid && !r.body.created &&
    Number(d1.q("SELECT count(*) n FROM product_blank_links WHERE orgId='acme' AND productId=?", pid)[0].n) === 5);
  r = await build({ productId: pid, colors: ["Navy"], colorGroups: [], sizePricing: { S: 19, M: 19, L: 19, XL: 19, "2XL": 21 } });
  ok("below MAP (Navy M at $19, MAP $20): saved hidden, and the problem comes back to say what to raise", r.status === 200 && r.body.belowMap && /M/.test(r.body.mapProblems.join(" ")));
  r = await call({ action: "buildProductFromBlank", org: "acme", blankId: capId, colors: ["Navy"], sizes: ["OSFA"], name: "Acme Cap", decoration: "dtf", pricingMode: "flat", flatPrice: 15 });
  ok("a DTF product is marked as needing no embroidery design; a one-size product is flat-priced", r.status === 200 &&
    d1.q("SELECT noDesignNeeded, pricingMode FROM products WHERE orgId='acme' AND productId=?", r.body.productId)[0].noDesignNeeded === 1);
  r = await call({ action: "buildProductFromBlank", org: "northside", blankId: capId, colors: ["Navy"], sizes: ["OSFA"], name: "North Cap", decoration: "dtf", pricingMode: "flat", flatPrice: 15, weightOz: 3.5 });
  ok("in a shop that's open, a new product starts hidden; a weight sent is saved as the product's override",
    d1.q("SELECT visible, weightOz FROM products WHERE orgId='northside' AND productId=?", r.body.productId).map(x => x.visible === 0 && x.weightOz === 3.5)[0]);
  r = await call({ action: "buildProductFromBlank", org: "northside", productId: "north-cap", blankId: capId, colors: ["Navy"], sizes: ["OSFA"], name: "North Cap", decoration: "dtf", pricingMode: "flat", flatPrice: 15 });
  ok("…rebuilding without a weight keeps it", d1.q("SELECT weightOz FROM products WHERE orgId='northside' AND productId='north-cap'")[0].weightOz === 3.5);
  r = await call({ action: "buildProductFromBlank", org: "acme", blankId: 99999, colors: [], sizes: ["S"], name: "X", pricingMode: "flat", flatPrice: 1 });
  ok("an unknown blank is refused", r.status === 404);
  await call({ action: "setProductVisible", org: "acme", productId: "acme-cap", visible: true });
  ok("a product offering colors only (no option spots) can be ordered without picking a graphic",
    await lib.priceItem(d1, "acme", "acme-cap", "OSFA", 1, false, { garmentColor: "Navy" }).then(x => x.unitPrice === 15, e => (console.log(e.message), false)));

  console.log("\n=== Saved state ===");
  r = await call({ action: "saveShopWizard", org: "acme", state: { step: "p0:pricing", products: [{ blankId: poloId }] } }, { role: "staff" });
  ok("a worker can't save a setup", r.status === 403);
  r = await call({ action: "saveShopWizard", org: "acme", state: { step: "p0:pricing", products: [{ blankId: poloId }] } });
  ok("a manager saves it; it comes back as saved, with when", r.status === 200 && (await call({ action: "getShopWizard", org: "acme" })).body.state.step === "p0:pricing" && !!r.body.state.updatedAt);
  ok("…and the shop is listed as having a setup in progress", (await call({ action: "listShopWizards" })).body.wizards.some(x => x.orgId === "acme" && !x.done));
  r = await call({ action: "saveShopWizard", org: "acme", state: { big: "x".repeat(250000) } });
  ok("an oversized setup is refused", r.status === 400);
  r = await call({ action: "getShopWizard", org: "nope" });
  ok("an unknown shop is refused", r.status === 404);

  console.log("\n=== The wizard, end to end ===");
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" }; adminOrgs = [{orgId: "northside", name: "Northside"}];');
  await call({ action: "saveLocation", location: { name: "Back" } });
  await call({ action: "saveLocation", location: { name: "Left chest" } });
  await call({ action: "saveThread", thread: { brand: "Sample", type: "Poly", weight: "40", code: "1001", name: "Red", colorHex: "ff0000" } });
  const q = (s) => d.querySelector(s);
  const next = async () => { q("#wizNext").click(); for (let i = 0; i < 100; i++) { await wait(20); if (!q("#wizNext") || !q("#wizNext").disabled) break; } await wait(60); };
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await wait(15); return fn(); };
  await w.renderShopWizard(d.getElementById("app"), null);
  ok("New shop setup opens on its first question, with the steps down the left (only the first open until the shop exists)",
    /What's the shop called/.test(q(".wiz-q").textContent) && d.querySelectorAll(".wiz-step").length === 9 && d.querySelectorAll(".wiz-step[disabled]").length === 8);
  q("#wizName").value = "Lakeside Club"; q("#wizName").dispatchEvent(new w.Event("input"));
  await next();
  const shop = d1.q("SELECT orgId, ready FROM orgs WHERE orgId='lakeside-club'")[0];
  ok("Save makes the shop (closed for orders) and moves to the next question", shop && shop.ready === 0 && /decorate/.test(q(".wiz-q").textContent) && w.location.hash === "#wizard/lakeside-club");
  d.querySelector('input[name="wizDeco"][value="both"]').click(); await next();
  d.querySelector('input[name="wizDel"][value="shipping"]').click(); await next();
  ok("each answer is saved to the shop as it goes (shipping added)", JSON.parse(d1.q("SELECT deliveryOptionsJson j FROM orgs WHERE orgId='lakeside-club'")[0].j).some(x => x.type === "shipping"));
  await next(); await next(); await next();
  ok("…and the setup itself is saved (resume point)", JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='shopWizard:lakeside-club'")[0].value).step === "blanks");
  await until(() => d.querySelectorAll("#wizBlankList input").length === 2);
  ok("Products start with “Which blanks?” — a list of the blanks", /Which blanks/.test(q(".wiz-q").textContent) && d.querySelectorAll("#wizBlankList .wiz-blank").length === 2);
  d.querySelectorAll("#wizBlankList input").forEach(c => { c.checked = true; c.dispatchEvent(new w.Event("change")); });
  await next();
  ok("ticking two blanks queues two products, each with its own steps in the left list", d.querySelectorAll(".wiz-step.wiz-sub").length === 12 && /Which colors/.test(q(".wiz-q").textContent));
  // First product (the cap, alphabetical): embroidery, one fixed design left “to come”, MAP pricing.
  await until(() => d.querySelectorAll(".wiz-swatch").length); await next();
  d.querySelector('input[name="wizPDeco"][value="embroidery"]').click(); await next();
  await until(() => q("#wizFxDesign"));
  // Upload a new design… hands the thread catalog to the upload window (it used to open with an empty thread list).
  let gotThreads = null;
  w.showDesignFormModal_ = (org, design, hoops, cb) => cb(999);
  w.showDesignVersionUploadModal_ = (id, cb, opts) => { gotThreads = (opts && opts.threads) || []; };
  q("#wizNewDesign").click(); await until(() => gotThreads);
  ok("“Upload a new design…” in the wizard opens the upload with the thread list filled in", gotThreads && gotThreads.length === 1 && gotThreads[0].code === "1001");
  await until(() => q("#wizFxDesign")); q("#wizFxDesign").value = ""; q("#wizFxDesign").dispatchEvent(new w.Event("change"));
  ok("the design (stitch file) is a secondary, optional section after the graphic (a fold, open only once one's picked)", q("#wizFxPic").compareDocumentPosition(q("#wizFxDesign")) & 4 &&
    /Stitch file \(design\) — for production, optional/.test(q("#wizFxDesign").closest("details").querySelector("summary").textContent) && /isn't needed to sell/.test(q("#wizDesigns").textContent));
  // Graphics first: Add image… uploads a picture and makes it a graphic behind the scenes (no design), picked at once.
  w.uploadImage = async () => "https://img.example/uploads/cap_crest.png";
  const addImg = q('input[data-add-img="embroidery"]');
  Object.defineProperty(addImg, "files", { value: [{ name: "Cap_crest.png" }] });
  addImg.dispatchEvent(new w.Event("change"));
  await until(() => q("#wizFxPic") && q("#wizFxPic").value);
  const madeG = d1.q("SELECT name, kind, designId, imageUrl FROM graphics WHERE orgId='lakeside-club' AND name='Cap crest'")[0];
  ok("Add image… makes an embroidery graphic from the upload (named from the file, no design needed) and picks it",
    madeG && madeG.kind === "embroidery" && madeG.designId == null && /cap_crest\.png/.test(madeG.imageUrl) && /Cap crest/.test(q("#wizFxPic").selectedOptions[0].textContent));
  // New graphic… opens the Graphics form preset to the kind; the new one is picked.
  let gotCtx = null;
  w.showGraphicFormModal_ = async (g, org, ctx, cb) => { gotCtx = ctx;
    cb((await call({ action: "saveGraphic", org, graphic: { name: "Cap crest 2", kind: ctx.kind, visible: true } })).body.id); };
  q('[data-wiz-new-graphic="embroidery"]').click(); await until(() => q("#wizFxPic") && /Cap crest 2/.test(q("#wizFxPic").selectedOptions[0].textContent));
  ok("…and New graphic… opens the full form preset to embroidery, with no design required; the new graphic is picked", gotCtx && gotCtx.kind === "embroidery" &&
    /Cap crest 2/.test(q("#wizFxPic").selectedOptions[0].textContent));
  await next();
  ok("…a picture needs its decoration location", /decoration location for the embroidery/.test(q("#wizErr").textContent));
  q("#wizFxLoc").value = q("#wizFxLoc").options[1].value; q("#wizFxLoc").dispatchEvent(new w.Event("change"));
  await next();
  // The price rule (Brand rules) for the blank's brand starts the pricing off at MAP + $5.
  await until(() => q('input[name="wizMethod"]'));
  ok("a blank with a MAP starts at the price rule for its brand (Brand rules: Sample Co MAP + $5)", d.querySelector('input[name="wizMethod"][value="map"]').checked &&
    q("#wizMapAdd").value === "5" && /Your price rule for Sample Co: MAP \+ \$5\.00/.test(q("#wizPricing").textContent) && /\$19\.99/.test(q(".wiz-grid").textContent));
  q("#wizMapAdd").value = "0"; q("#wizMapAdd").dispatchEvent(new w.Event("change")); await wait(30);
  ok("…priced under the rule (but not under MAP) it's a warning, softer than MAP, with Use it to go back", /under your price rule \(\$19\.99, MAP \+ \$5\.00\)/.test(q(".wiz-rule-warn").textContent) &&
    !q(".wiz-warn") && q(".wiz-grid td.wiz-soft") && q("#wizUseRule"));
  await next();
  await until(() => q("#wizPName")); await next();
  await until(() => q("#wizMock") && !/Loading/.test(q("#wizMock").textContent));
  ok("after Name & details comes an optional Mockups screen, one row per decoration (here the cap's crest)", /optional/.test(q(".wiz-q").textContent) &&
    /Cap crest/.test(q("#wizMock").textContent) && /Add a picture to the graphic first/.test(q("#wizMock").textContent) && /Mockups \(optional\)/.test(q(".wiz-rail, #wizRoot").textContent));
  await next();
  // Second product (the polo): DTF options at Back, % over cost.
  await call({ action: "saveGraphic", org: "lakeside-club", graphic: { name: "Crest print", kind: "transfer", visible: true } });
  await until(() => d.querySelectorAll(".wiz-swatch").length); await next();
  d.querySelector('input[name="wizPDeco"][value="dtf"]').click(); await next();
  await until(() => q('input[name="wizMode"]')); d.querySelector('input[name="wizMode"][value="options"]').click(); await wait(20);
  const backId = [...d.querySelectorAll(".wizLoc")].find(c => /Back/.test(c.closest("label").textContent)).value;
  [...d.querySelectorAll(".wizLoc")].find(c => /Back/.test(c.closest("label").textContent)).click(); await wait(20);
  [...d.querySelectorAll(".wizLoc")].find(c => /Left chest/.test(c.closest("label").textContent)).click(); await wait(20);
  ok("graphics aren't required: a spot can be ticked with nothing offered yet", !!d.querySelector(`.wizLocG[data-loc="${backId}"]`));
  d.querySelector(`.wizLocG[data-loc="${backId}"]`).click(); await next();
  await until(() => q('input[name="wizMethod"]')); d.querySelector('input[name="wizMethod"][value="pct"]').click(); await wait(30); await next();
  await until(() => q("#wizPName"));
  ok("Name & details offers an optional weight, saying the blank has none yet", q("#wizPWeight") && /blank has no weight yet/.test(q("#wizDetails").textContent));
  q("#wizPWeight").value = "7"; await next();
  await until(() => q("#wizMock") && !/Loading/.test(q("#wizMock").textContent));
  ok("…the polo's lists the graphic it offers at Back", /Crest print/.test(q("#wizMock").textContent) && /Back/.test(q("#wizMock").textContent));
  await next();
  const made = d1.q("SELECT productId, visible, locationsJson, flatPriceCents, pricingMode FROM products WHERE orgId='lakeside-club' ORDER BY productId");
  ok("both products are built (shown while the shop isn't open, so Preview has them): the cap flat at its MAP, the polo with its DTF options at Back only (Left chest offers nothing yet)", made.length === 2 && made.every(x => x.visible === 1) &&
    made.some(x => /"Back"/.test(x.locationsJson) && !/Left chest/.test(x.locationsJson)) && d1.q("SELECT weightOz FROM products WHERE orgId='lakeside-club' AND weightOz = 7").length === 1 &&
    made.some(x => x.pricingMode === "flat" && x.flatPriceCents === 1499) && made.some(x => /"Back"/.test(x.locationsJson)));
  await until(() => q("#wizCheck .wiz-issues, #wizCheck .wiz-ok"));
  ok("a missing stitch file never holds the shop back: the cap's is listed under “Before it can be made — not needed to publish”",
    /Before it can be made/.test(q("#wizCheck .wiz-later summary").textContent) && /No stitch file/.test(q("#wizCheck .wiz-later").textContent) &&
    ![...d.querySelectorAll("#wizCheck > .wiz-issues li")].some(li => /stitch file|design/i.test(li.textContent)));
  ok("…while a decoration location with nothing to offer is listed, with a Fix back to the polo's Graphics step", /Left chest has no graphics to offer yet/.test(q("#wizCheck").textContent) && q('#wizCheck [data-goto="p1:designs"]'));
  ok("…the cap's missing weight (its blank has none, the shop ships) is fixed on its Name & details screen", /No weight/.test(q("#wizCheck").textContent) && q('#wizCheck [data-goto="p0:details"]'));
  ok("…the progress bar shows how far to publish, and the left list marks the polo's Graphics step (not the cap's) as needing attention",
    /\d+% to publish/.test(q(".wiz-pct").textContent) && q('.wiz-step[data-step="p1:designs"]').classList.contains("wiz-warn") && !q('.wiz-step[data-step="p0:designs"]').classList.contains("wiz-warn") &&
    /Graphics/.test(q('.wiz-step[data-step="p0:designs"]').textContent));
  await next();
  ok("Go live summarises the shop", /Ready to open the shop/.test(q(".wiz-q").textContent) && /2 products/.test(q(".wiz-body").textContent));
  await next(); await until(() => /open/.test(q(".wiz-q").textContent) && !/Ready/.test(q(".wiz-q").textContent));
  ok("Open for orders & publish: the shop is open, its products shown and published, and the last screen links onward",
    d1.q("SELECT ready FROM orgs WHERE orgId='lakeside-club'")[0].ready === 1 && d1.q("SELECT visible FROM products WHERE orgId='lakeside-club'").every(x => x.visible === 1) &&
    (await call({ action: "getPublishState" })).body.publishState["lakeside-club"].state === "current" && q('.wiz-body a[href="#orders/lakeside-club"]'));
  await until(() => q("#shopBar .shop-bar-live.on") && /✓ Published/.test(q("#shopBar").textContent));
  ok("…and the shop bar above follows at once: Live, ✓ Published, and Shop setup (no longer Resume)", !!q("#shopBar .shop-bar-live.on") &&
    /✓ Published/.test(q("#shopBar").textContent) && !/Resume shop setup/.test(q("#shopBar").textContent) && /Shop setup/.test(q("#shopBar").textContent));
  // Resume: open the shop's setup again — it lands where it was left, with the answers kept.
  await w.renderShopWizard(d.getElementById("app"), "lakeside-club");
  ok("Resume opens where it was left, with every product and answer kept", /open/.test(q(".wiz-q").textContent) && d.querySelectorAll(".wiz-step.wiz-sub").length === 12);
  await w.renderShopWizard(d.getElementById("app"), "lakeside-club", { products: true });
  ok("“Add products from blanks” opens the same wizard at Which blanks?", /Which blanks/.test(q(".wiz-q").textContent));
  ok("the Products page offers “Add products from blanks”", /onclick="location\.hash='#wizard\/'\+encodeURIComponent\(this\.dataset\.org\)\+'\/products'"[^>]*>＋ Add products from blanks/.test(adminJs));
  ok("a box shown only when its choice is ticked stays hidden until then (the flex rule doesn't override hidden)", /\.wiz-inline\[hidden\]\{display:none;\}/.test(read("public/index.html")));
  // OpenDecoDesk: the wizard follows the Feature switches.
  w.eval(`siteFeatures = Object.assign({}, siteFeatures, { shipping: false });`);
  const del = w.wizScreen_({ id: "delivery" });
  ok("with Shipping off, Delivery offers no carrier shipping (and keeps a shop's existing setting when saved)", /value="pickup"/.test(del.html) && !/value="shipping"/.test(del.html) && /if \(!shipOn && has\("shipping"\)\) on\.push\("shipping"\);/.test(read("public/admin.js")));
  w.eval(`siteFeatures = Object.assign({}, siteFeatures, { shipping: true });`);
  const delOn = w.wizScreen_({ id: "delivery" });
  ok("…and with it on, it does", /value="shipping"/.test(delOn.html));
  ok("with Production off, the Graphics step has no stitch-file (design) section", /\$\{adminFeatureOn_\("production"\) \? `<details class="wiz-more"\$\{p\.fixed\.designId \? " open" : ""\}><summary>Stitch file \(design\)/.test(read("public/admin.js")));
  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test160 crashed: false"); process.exit(1); });
