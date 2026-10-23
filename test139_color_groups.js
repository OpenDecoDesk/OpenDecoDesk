const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Products priced by COLOR PRICE GROUP (migrations/0064, Part B of "pricing by color"). A product with garment
// colors can group colors (Heathers, White…), each group with its own price per size (or flat price); a color
// in no group takes the product's own prices ("Standard"). The server prices every line from it, the
// storefront shows it, the product form edits it (with groups suggested from the blank prices), the products
// CSV import takes color_groups / color_group_upcharges, and a group's blank price changing names the group.
// Real db.js / orders.js on sql.js; the storefront and the product form section in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, createTransfer, createGraphic, priceItem, getProductsByOrg, importProductsCsv,
  getProductPriceChanges, getCatalogIssues, suggestColorGroups };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = () => new Promise(res => setTimeout(res, 5));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "club" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const t = await lib.createTransfer(d1, { name: "Crest sheet" });
  const g = await lib.createGraphic(d1, "club", { name: "Crest", kind: "transfer", transferId: t, tier: null });
  const polo = { productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { S: 34, M: 34, "2XL": 36 }, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Black", "Navy", "Oxford Heather"], locations: [{ key: "front", label: "Front", graphicIds: [g] }], images: [], features: [] };
  await lib.createProduct(d1, "club", polo);
  const cfg = (color) => ({ garmentColor: color, locations: { front: { graphicId: g } } });
  const unit = async (productId, color, size) => (await lib.priceItem(d1, "club", productId, size, 1, false, cfg(color))).unitPrice;
  const product = async (id) => (await lib.getProductsByOrg(d1, "club")).find(p => p.productId === id);

  console.log("=== Saving groups ===");
  let r = await call({ action: "updateProduct", ...polo, colorGroups: [{ label: "Heathers", colors: ["Oxford Heather"], sizePricing: { S: 36, M: 36, "2XL": 38 } }] });
  const saved = await product("polo");
  ok("a group is saved with its colors and its price per size", r.status === 200 && saved.colorGroups.length === 1 && saved.colorGroups[0].label === "Heathers" &&
    saved.colorGroups[0].colors.join() === "Oxford Heather" && saved.colorGroups[0].sizePricing["2XL"] === 38);
  ok("…stored in cents", JSON.parse(d1.q("SELECT colorGroupsJson FROM products WHERE productId='polo'")[0].colorGroupsJson)[0].sizePricingCents.S === 3600);
  ok("…and it's in the audit log", d1.q("SELECT detail FROM audit_log WHERE action='product.updated'").some(a => /colorGroups/.test(a.detail)));

  console.log("\n=== Pricing ===");
  ok("a color in the group is priced by the group: Oxford Heather S $36, 2XL $38", await unit("polo", "Oxford Heather", "S") === 36 && await unit("polo", "Oxford Heather", "2XL") === 38);
  ok("every other color keeps the product's own (Standard) price: Black S $34", await unit("polo", "Black", "S") === 34 && await unit("polo", "Navy", "2XL") === 36);
  await lib.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 16, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Black", "Royal"], locations: [{ key: "front", label: "Front", graphicIds: [g] }], images: [], features: [] });
  r = await call({ action: "updateProduct", productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 16, visible: true, configurable: true, garmentColors: ["Black", "Royal"],
    locations: [{ key: "front", label: "Front", graphicIds: [g] }], images: [], features: [], colorGroups: [{ label: "Premium", colors: ["Royal"], flatPrice: 18 }] });
  ok("a flat-priced product's group has one price: Royal $18, Black $16", r.status === 200 && await unit("cap", "Royal", "OSFA") === 18 && await unit("cap", "Black", "OSFA") === 16);

  console.log("\n=== What's refused ===");
  const tryGroups = async (colorGroups, extra = {}) => (await call({ action: "updateProduct", ...polo, ...extra, colorGroups })).body.message || "";
  ok("a color in two groups", /in two color price groups/.test(await tryGroups([{ label: "A", colors: ["Navy"], sizePricing: { S: 1, M: 1, "2XL": 1 } }, { label: "B", colors: ["Navy"], sizePricing: { S: 1, M: 1, "2XL": 1 } }])));
  ok("a color the product doesn't offer", /isn't one of this product's colors/.test(await tryGroups([{ label: "A", colors: ["Pink"], sizePricing: { S: 1, M: 1, "2XL": 1 } }])));
  ok("a size left without a price", /needs a price for 2XL/.test(await tryGroups([{ label: "A", colors: ["Navy"], sizePricing: { S: 1, M: 1 } }])));
  ok("a group with no name, or two with the same name", /needs a name/.test(await tryGroups([{ label: "", colors: ["Navy"], sizePricing: { S: 1, M: 1, "2XL": 1 } }])) &&
    /Two color price groups are called/.test(await tryGroups([{ label: "A", colors: ["Navy"], sizePricing: { S: 1, M: 1, "2XL": 1 } }, { label: "a", colors: ["Black"], sizePricing: { S: 1, M: 1, "2XL": 1 } }])));
  ok("groups on a product with no garment colors", /products customers pick a garment color on/.test(await tryGroups([{ label: "A", colors: ["Navy"], sizePricing: { S: 1, M: 1, "2XL": 1 } }], { configurable: false, garmentColors: [] })));
  ok("…and nothing was changed by the refused saves", (await product("polo")).colorGroups[0].sizePricing.S === 36);

  console.log("\n=== Suggested from the blank prices ===");
  const k8 = (await lib.createBlank(d1, { name: "K8000LS", productType: "shirt", vendor: "SanMar", sku: "K8000LS",
    colors: ["Black", "Navy", "Oxford Heather"].map(color => ({ color, images: [], sizes: ["S", "M", "2XL"].map(size => ({ size, quantity: 0, vendorPrice: color === "Oxford Heather" ? (size === "2XL" ? 18.31 : 17.31) : (size === "2XL" ? 16.97 : 15.97) })) })) })).id;
  for (const color of ["Black", "Navy", "Oxford Heather"]) for (const size of ["S", "M", "2XL"]) await lib.setBlankLink(d1, "club", "polo", color, size, k8, color, size);
  r = await call({ action: "suggestColorGroups", productId: "polo" });
  ok("colors whose blanks cost the same are Standard (Black, Navy)", r.status === 200 && r.body.standard.colors.join() === "Black,Navy");
  ok("…the one that costs more is its own group, its price keeping Standard's margin ($34 + $1.34)", r.body.groups.length === 1 && r.body.groups[0].colors.join() === "Oxford Heather" &&
    r.body.groups[0].sizePricing.S === 35.34 && r.body.groups[0].sizePricing["2XL"] === 37.34 && r.body.groups[0].costs.S === 17.31);
  ok("a worker may ask for suggestions (they price products)", (await call({ action: "suggestColorGroups", productId: "polo" }, { role: "staff" })).status === 200);

  console.log("\n=== Re-pricing names the group ===");
  await tick();
  d1._raw.run(`UPDATE products SET pricesReviewedAt = '2000-01-01T00:00:00.000Z' WHERE productId='polo'`);
  await call({ action: "updateBlank", id: k8, name: "K8000LS", productType: "shirt", vendor: "SanMar", colors: ["Black", "Navy", "Oxford Heather"].map(color => ({ color, images: [],
    sizes: ["S", "M", "2XL"].map(size => ({ size, quantity: 0, baseQuantity: 0, ...(color === "Oxford Heather" && size === "S" ? { vendorPrice: 17.99 } : {}) })) })) });
  // The first price entered is the basis, so the change is the 17.31 → 17.99 one.
  const issues = await lib.getCatalogIssues(d1, "club");
  const warn = (issues.orgs.club.products.polo || []).find(x => x.code === "blankPriceChanged");
  ok("a changed blank price behind a group says which group's price it is", warn && /Oxford Heather S \$17\.31 → \$17\.99 \(Heathers price\)/.test(warn.text));
  await tick();
  r = await call({ action: "updateProduct", ...polo, colorGroups: [{ label: "Heathers", colors: ["Oxford Heather"], sizePricing: { S: 37, M: 36, "2XL": 38 } }] });
  ok("changing a group's price counts as re-pricing the product", (await lib.getProductPriceChanges(d1, { orgId: "club" })).every(p => p.productId !== "polo"));

  console.log("\n=== Products CSV import ===");
  const imp = await lib.importProductsCsv(d1, "club", [{ sku: "hood", name: "Hoodie", category: "shirt", price: "40", sizes: "S|M|2XL", size_upcharges: "2XL:2.00",
    default_colors: "Black|Ash|Sport Grey|White", graphics_locations: "Front", color_groups: "Heathers: ash, Sport Grey | White: White", color_group_upcharges: "Heathers:3.00|White:-1.50" }], {});
  const hood = await product("hood");
  ok("color_groups + color_group_upcharges make the groups, each size's price plus the upcharge", imp.created === 1 && hood.colorGroups.length === 2 &&
    hood.colorGroups[0].colors.join() === "Ash,Sport Grey" && hood.colorGroups[0].sizePricing.S === 43 && hood.colorGroups[0].sizePricing["2XL"] === 45 && hood.colorGroups[1].sizePricing.M === 38.5);
  const bad = await lib.importProductsCsv(d1, "club", [{ sku: "hood2", name: "Hoodie 2", category: "shirt", price: "40", sizes: "S|M", default_colors: "Black", color_groups: "Odd: Purple" }], { dryRun: true });
  ok("…a group naming a color the product doesn't offer is a problem on that row", bad.results[0].problems.some(x => /isn't one of this product's colors/.test(x)));

  console.log("\n=== The storefront ===");
  const sf = new JSDOM(read("public/index.html"), { runScripts: "dangerously", url: "https://club.example.com/", beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "none" }) }); } }).window;
  await new Promise(res => setTimeout(res, 50));
  const sp = { id: "polo", sizePricing: { S: 34, "2XL": 36 }, configurable: true, garmentColors: ["Black", "Oxford Heather"], colorGroups: [{ label: "Heathers", colors: ["Oxford Heather"], sizePricing: { S: 36, "2XL": 38 } }] };
  ok("the shop page prices the color picked by its group, other colors by Standard", sf.cfgBasePrice_(sp, "Oxford Heather", "2XL") === 38 && sf.cfgBasePrice_(sp, "Black", "2XL") === 36 && sf.cfgBasePrice_(sp, "", "S") === 34);
  ok("…flat-priced too", sf.cfgBasePrice_({ flatPrice: 16, colorGroups: [{ label: "P", colors: ["Royal"], flatPrice: 18 }] }, "Royal", "") === 18);
  const catalogSrc = read("functions/api/catalog.js");
  ok("the shop's catalog carries each group's colors and prices", /out\.colorGroups = p\.colorGroups\.map/.test(catalogSrc));

  console.log("\n=== The product form ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  d.getElementById("app").innerHTML = `<div class="admin-panel"><select id="prodFormPricingMode"><option value="sized" selected>sized</option><option value="flat">flat</option></select>
    <input id="prodFormFlatPrice" value=""><input class="prodFormSize" data-size="S" value="34"><input class="prodFormSize" data-size="M" value="34"><input class="prodFormSize" data-size="2XL" value="36">
    <div id="colorGroupsSection"></div><div id="productConfigSection"></div></div>`;
  w._productConfigGet = () => ({ configurable: true, garmentColors: ["Black", "Navy", "Oxford Heather"] });
  w.loadColorGroupsSection_("club", Object.assign(await product("polo"), { colorGroups: [] }));
  await new Promise(res => setTimeout(res, 20));
  const sec = d.getElementById("colorGroupsSection");
  ok("the section shows Standard with the product's own prices", /Color price groups/.test(sec.textContent) && /Standard/.test(sec.textContent) && /\$34\.00/.test(sec.textContent));
  sec.querySelector("#cgSuggest").click();
  for (let i = 0; i < 100 && !sec.querySelector(".cgLabel"); i++) await new Promise(res => setTimeout(res, 10));
  ok("Suggest from blank prices fills in the Oxford Heather group with its blank costs shown", sec.querySelector(".cgLabel").value === "Oxford Heather" && /blank \$17\.99/.test(sec.textContent) &&
    [...sec.querySelectorAll(".cgColor:checked")].map(x => x.value).join() === "Oxford Heather");
  const label = sec.querySelector(".cgLabel"); label.value = "Heathers"; label.dispatchEvent(new w.Event("input", { bubbles: true }));
  const sPrice = sec.querySelector('.cgPrice[data-size="S"]'); sPrice.value = "36.5"; sPrice.dispatchEvent(new w.Event("input", { bubbles: true }));
  const got = w._colorGroupsGet();
  ok("…and what Save sends is the edited group", got.length === 1 && got[0].label === "Heathers" && got[0].sizePricing.S === 36.5 && got[0].sizePricing["2XL"] === 37.34);
  sec.querySelector("#cgAdd").click();
  ok("+ Add group starts a group at Standard's prices, with colors already in a group greyed out", sec.querySelectorAll("[data-cg]").length === 2 &&
    sec.querySelectorAll('[data-cg="1"] .cgColor[disabled]').length === 1 && sec.querySelector('[data-cg="1"] .cgPrice[data-size="S"]').value === "34.00");

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test128 crashed: false"); process.exit(1); });
