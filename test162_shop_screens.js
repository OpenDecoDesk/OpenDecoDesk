const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Shop screens, round 2 (2026-10): reserved and taken web addresses refused (www used to fail half-way through
// creating a shop), the web address changed from the wizard, the category and decoration-location lists managed in a
// popup from any picker, and the shop page naming each decoration and where it goes even with no picture.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getPublicCatalogData, getAllBlanks, priceItem, getPublishState, getPublishedOrg, publishShop, getCatalogIssues, signPreviewToken, verifyPreviewToken, planHoopings_ };`)();
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
  console.log("=== Web addresses ===");
  const shopBody = (orgId, subdomain) => ({ action: "createOrg", orgId, subdomain, name: orgId, ready: false, deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }] });
  let r = await call(shopBody("wwwshop", "www"));
  ok("“www” is refused as a shop's web address, with a reason", r.status === 400 && /reserved/.test(r.body.message));
  r = await call(shopBody("api-shop", "api"));
  ok("…so are the site's other reserved names (api, admin, …)", r.status === 400 && (await call(shopBody("adm", "admin"))).status === 400);
  // OpenDecoDesk: one list (hostConfig.js) for the server, the attach-a-hostname step and the browser, plus the admin's
  // configured label (ADMIN_SUBDOMAIN), whatever it is.
  ENV.ADMIN_SUBDOMAIN = "admin,office";   // (this test signs in on admin.<root>)
  ok("…and so is the admin's own configured label", (await call(shopBody("off", "office"))).status === 400);
  delete ENV.ADMIN_SUBDOMAIN;
  const hostList = read("functions/_lib/hostConfig.js").match(/RESERVED_SUBDOMAINS = (\[[^\]]*\])/)[1], pageList = read("public/admin.js").match(/RESERVED_WEB_ADDRESSES_ = (\[[^\]]*\])/)[1];
  ok("…the browser's list is the server's, and attaching a hostname uses the same one", hostList === pageList && /RESERVED_SUBDOMAINS\.includes\(label\)/.test(read("functions/_lib/customDomain.js")));
  r = await call(shopBody("acme", "acme"));
  ok("an ordinary address is fine", r.status === 200);
  r = await call(shopBody("acme2", "acme"));
  ok("an address another shop uses is refused clearly (it used to fail on the database)", r.status === 409 && /already uses the web address/.test(r.body.message));
  r = await call(shopBody("acme", "acmetwo"));
  ok("…and so is a shop ID that's taken", r.status === 409 && /already has the ID/.test(r.body.message));
  const upd = (subdomain) => call({ action: "updateOrg", orgId: "acme", subdomain, name: "Acme", ready: false, deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }] });
  ok("changing a shop's address to www or to another shop's is refused", (await upd("www")).status === 400 && (await upd("northside")).status === 409);
  r = await upd("acmeclub");
  ok("…to a free one works", r.status === 200 && d1.q("SELECT subdomain FROM orgs WHERE orgId='acme'")[0].subdomain === "acmeclub");

  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.open = () => null; win.scrollTo = () => {}; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await wait(150);
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" };');
  w.eval(`window._adminOrgRegistry = ${JSON.stringify((await call({ action: "listOrgsAdmin" })).body.orgs)}; adminOrgs = window._adminOrgRegistry.map(o => ({ orgId: o.orgId, name: o.name }));`);
  ok("the browser says the same before sending (reserved, taken, malformed)", /reserved/.test(w.webAddressProblem_("www")) && /already uses/.test(w.webAddressProblem_("northside", "acme")) &&
    /2–40/.test(w.webAddressProblem_("my-shop")) && w.webAddressProblem_("acmeclub", "acme") === "" && w.webAddressProblem_("freshname") === "");

  console.log("\n=== The web address in the wizard ===");
  const q = (s) => d.querySelector(s);
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await wait(15); return fn(); };
  const next = async () => { q("#wizNext").click(); for (let i = 0; i < 100; i++) { await wait(20); if (!q("#wizNext") || !q("#wizNext").disabled) break; } await wait(60); };
  await w.renderShopWizard(d.getElementById("app"), null);
  q("#wizName").value = "WWW"; q("#wizName").dispatchEvent(new w.Event("input"));
  await next();
  ok("a new shop whose name makes the address “www” is stopped on the first screen, saying why", /reserved/.test(d.getElementById("app").textContent) && !d1.q("SELECT 1 FROM orgs WHERE subdomain='www'").length);
  await w.renderShopWizard(d.getElementById("app"), "acme");
  w.eval(`_wiz.state.step = "name";`); w.wizDraw_(); await until(() => q("#wizSub"));
  ok("once the shop exists the wizard still offers “Change the web address”, filled with the current one", q("#wizSub") && q("#wizSub").value === "acmeclub" && !q("#wizId"));
  q("#wizSub").value = "acmerowing"; q("#wizSub").dispatchEvent(new w.Event("input"));
  await next();
  ok("…and saving it changes the shop's address", d1.q("SELECT subdomain FROM orgs WHERE orgId='acme'")[0].subdomain === "acmerowing");
  w.eval(`_wiz.state.step = "name";`); w.wizDraw_(); await until(() => q("#wizSub"));
  q("#wizSub").value = "www"; await next();
  ok("…but not to a reserved one", d1.q("SELECT subdomain FROM orgs WHERE orgId='acme'")[0].subdomain === "acmerowing" && /reserved/.test(d.getElementById("app").textContent));

  console.log("\n=== Manage… popups ===");
  await w.loadProductCategories_();
  const host = d.createElement("div");
  host.innerHTML = `<select id="tcat">${w.categoryOptionsHtml_("shirt")}</select>${w.manageCategoriesBtn_('data-select="#tcat"')}
    <select id="tloc"><option value="">— decoration location —</option></select>${w.manageLocationsBtn_('data-select="#tloc"')}`;
  d.body.appendChild(host);
  host.querySelector("[data-manage-categories]").click();
  await until(() => d.querySelector(".admin-modal [data-pc-body] table"));
  ok("Manage… beside a category picker opens the categories list in a popup", !!d.querySelector(".admin-modal [data-pc-new]"));
  d.querySelector(".admin-modal [data-pc-new]").click(); await until(() => d.getElementById("pcfName"));
  d.getElementById("pcfName").value = "Tote Bag"; d.getElementById("pcfPlural").value = "Tote Bags"; d.getElementById("pcfSave").click();
  await until(() => [...q("#tcat").options].some(o => o.textContent === "Tote Bag"));
  ok("…a category added there is in the picker at once, which keeps its choice", [...q("#tcat").options].some(o => o.textContent === "Tote Bag") && q("#tcat").value === "shirt");
  host.querySelector("[data-manage-locations]").click();
  await until(() => d.querySelector(".admin-modal [data-loc-new]"));
  ok("Manage… beside a decoration-location picker opens that list in a popup", /Decoration locations/.test(d.querySelector(".admin-modal:last-of-type, .admin-modal").textContent) || !!d.querySelector("[data-loc-new]"));
  d.querySelector("[data-loc-new]").click(); await until(() => d.getElementById("locfName"));
  d.getElementById("locfName").value = "Right sleeve"; d.getElementById("locfSave").click();
  await until(() => [...q("#tloc").options].some(o => o.textContent === "Right sleeve"));
  ok("…and a location added there is in the picker at once", [...q("#tloc").options].some(o => o.textContent === "Right sleeve"));
  ok("the pickers on the product form, wizard, blank form, vendor review, PDF import and Copy products have Manage… buttons",
    /prodFormType"[^]*?manageCategoriesBtn_/.test(adminJs) && /wizPType"[^]*?manageCategoriesBtn_/.test(adminJs) && /blkType"[^]*?manageCategoriesBtn_/.test(adminJs) &&
    /data-f="productType"[^]*?manageCategoriesBtn_/.test(adminJs) && /manageCategoriesBtn_\('data-select="\.pi-type"'\)/.test(adminJs) && /manageCategoriesBtn_\('data-select="\.cpType"'\)/.test(adminJs) &&
    (adminJs.match(/manageLocationsBtn_\('data-after="productFormLocationsChanged_"'\)/g) || []).length === 3 && (adminJs.match(/manageLocationsBtn_\('data-after="wizLocationsChanged_"'\)/g) || []).length === 3 &&
    /manageLocationsBtn_\('data-after="blankFormLocationsChanged_"'\)/.test(adminJs));
  ok("“Location” reads “Decoration location” in the menu and pickers", /\["locations", "Decoration locations"\]/.test(adminJs) && !/>Location<br>/.test(adminJs) && !/— spot —/.test(adminJs));

  console.log("\n=== The shop page names each decoration ===");
  const loc = (await call({ action: "saveLocation", location: { name: "Back" } })).body.id;
  const lc = (await call({ action: "saveLocation", location: { name: "Left chest" } })).body.id;
  const gr = (await call({ action: "saveGraphic", org: "acme", graphic: { name: "Club crest print", kind: "transfer", visible: true } })).body.id;
  const ds = (await call({ action: "saveDesign", org: "acme", design: { name: "Acme oar logo" } })).body.id;
  r = await call({ action: "createBlank", name: "Sample Tee", brand: "Sample Co", sku: "ST1", vendor: "Supplier", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 0, vendorPrice: 5 }] }] });
  r = await call({ action: "buildProductFromBlank", org: "acme", blankId: r.body.id, colors: ["Navy"], sizes: ["M"], name: "Club Tee", decoration: "both", pricingMode: "sized", sizePricing: { M: 20 },
    fixedTransfers: [{ locationId: loc, graphicId: gr, ink: "" }], designs: [{ designId: ds, placement: "Left chest", isMain: true }] });
  ok("(a product with a fixed embroidery design and a printed transfer, no pictures)", r.status === 200);
  const page = JSON.parse(await (await catalogGet({ request: new Request(shopOrigin("acmerowing") + "/api/catalog"), env: ENV })).text());
  const tee = ((page.catalog && page.catalog.products) || []).find(p => p.id === r.body.productId) || {};
  ok("the catalog sends what decorates it, in words: the embroidery and where, the print and where", JSON.stringify(tee.decorations) ===
    JSON.stringify([{ kind: "Embroidered", name: "Acme oar logo", location: "Left chest" }, { kind: "Printed", name: "Club crest print", location: "Back" }]));
  const html = w.decorationsHtml_({ decorations: [{ kind: "Printed", name: "<b>Crest</b>", location: "Back" }] });
  ok("the shop page lists each one (“Printed: Crest — Back”), escaped, with no picture needed", /Printed:<\/span> &lt;b&gt;Crest&lt;\/b&gt; — Back/.test(html) && w.decorationsHtml_({}) === "");
  ok("…on both kinds of product card", (read("public/index.html").match(/\$\{decorationsHtml_\(p\)\}/g) || []).length === 2);

  r = await call({ action: "buildProductFromBlank", org: "acme", productId: tee.id, blankId: d1.q("SELECT id FROM blanks WHERE sku='ST1'")[0].id, colors: ["Navy"], sizes: ["M"], name: "Club Tee", decoration: "both", pricingMode: "sized", sizePricing: { M: 20 },
    fixedTransfers: [{ locationId: loc, graphicId: gr, ink: "" }], designs: [{ designId: ds, placement: "Left chest", isMain: true }],
    mockupGraphics: [{ locationId: lc, graphicId: (await call({ action: "saveGraphic", org: "acme", graphic: { name: "Oar crest", kind: "embroidery", designId: ds, visible: true } })).body.id }] });
  ok("the wizard's picture of the embroidery is saved as the product's embroidered graphic, and the shop page names it", r.status === 200 &&
    JSON.parse(d1.q("SELECT mockupGraphicsJson j FROM products WHERE productId=?", tee.id)[0].j).length === 1 &&
    (JSON.parse(await (await catalogGet({ request: new Request(shopOrigin("acmerowing") + "/api/catalog"), env: ENV })).text()).catalog.products.find(p => p.id === tee.id).decorations[0].name === "Oar crest"));

  console.log("\n=== Graphics first, designs later ===");
  const bareG = (await call({ action: "saveGraphic", org: "acme", graphic: { name: "Plain crest", kind: "embroidery", visible: true } })).body.id;
  ok("an embroidery graphic saves with no design (it's the picture; the stitch file comes later)", !!bareG && d1.q("SELECT designId FROM graphics WHERE id=?", bareG)[0].designId == null);
  r = await call({ action: "createBlank", name: "Option Tee", brand: "Sample Co", sku: "OT1", vendor: "Supplier", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 0, vendorPrice: 5 }] }] });
  r = await call({ action: "buildProductFromBlank", org: "acme", blankId: r.body.id, colors: ["Navy"], sizes: ["M"], name: "Option Tee", decoration: "embroidery", pricingMode: "sized", sizePricing: { M: 20 },
    locations: [{ key: "loc" + lc, label: "Left chest", locationId: lc, graphicIds: [bareG] }] });
  const optIssues = ((await lib.getCatalogIssues(d1)).orgs.acme.products || {})[r.body.productId] || [];
  ok("the catalog check notes the graphic has no stitch file as a warning — never an error that reads as “can't sell”",
    optIssues.some(x => x.code === "graphicNoDesign" && x.level === "warn" && /Plain crest/.test(x.text)) && !optIssues.some(x => x.level === "error"));
  ok("…and a product with no design of its own is a warning about making it, not selling it",
    (await (async () => { const nd = ((await lib.getCatalogIssues(d1)).orgs.acme.products || {}); return Object.values(nd).flat().filter(x => x.code === "noDesign").every(x => x.level === "warn" && /not to sell it/.test(x.text)); })()));
  const plan = lib.planHoopings_({ hoopNames: {}, designs: {}, itemDesigns: {}, itemDesignsAt: {} }, { itemId: 1, configurable: true, config: { locations: [{ location: "loc" + lc, label: "Left chest", kind: "embroidery", designId: null, graphicName: "Plain crest", graphicId: bareG }] } });
  ok("an order for it shows on Run Order as blocked until a stitch file is linked (it used to be dropped silently)",
    plan.length === 1 && /No stitch file linked to “Plain crest”/.test(plan[0].blocked));

  console.log("\n=== Adding blanks from the wizard ===");
  await w.renderShopWizard(d.getElementById("app"), "acme");
  w.eval(`_wiz.state.step = "blanks";`); w.wizDraw_(); await until(() => q("#wizBlankList .wiz-blank"));
  ok("Which blanks? offers Enter a blank and Import from a vendor file; the connected-vendor import only when a vendor is connected",
    !!q("#wizBlankQuick") && !!q("#wizBlankFile") && q("#wizBlankApi").hidden);
  q("#wizBlankQuick").click(); await until(() => q("#qbName"));
  ok("Enter a blank asks for the essentials: name, vendor, category (with Manage…), colors to tick, sizes (S–2XL ticked to start)",
    q("#qbVendor") && q("#qbType") && q(".admin-modal [data-manage-categories]") && d.querySelectorAll(".qbColor").length >= 15 &&
    [...d.querySelectorAll(".qbSize:checked")].map(c => c.value).join() === "S,M,L,XL,2XL" && /More options/.test(q("#qbMore").textContent));
  q("#qbOk").click(); await wait(20);
  ok("…and says what's missing", /name/.test(q("#qbErr").textContent));
  q("#qbName").value = "Quick Tee"; q("#qbVendor").value = "Supplier";
  [...d.querySelectorAll(".qbColor")].find(c => c.value === "Navy").checked = true;
  q("#qbOther").value = "Seafoam"; q("#qbAddColor").click();
  const osfa = [...d.querySelectorAll(".qbSize")].find(c => c.value === "OSFA"); osfa.checked = true; osfa.dispatchEvent(new w.Event("change"));
  ok("…a typed color is added and ticked; OSFA clears a size run (and the other way round)", [...d.querySelectorAll(".qbColor:checked")].map(c => c.value).join() === "Navy,Seafoam" &&
    [...d.querySelectorAll(".qbSize:checked")].map(c => c.value).join() === "OSFA");
  const m = [...d.querySelectorAll(".qbSize")].find(c => c.value === "M"); m.checked = true; m.dispatchEvent(new w.Event("change"));
  const l = [...d.querySelectorAll(".qbSize")].find(c => c.value === "L"); l.checked = true; l.dispatchEvent(new w.Event("change"));
  const x2 = [...d.querySelectorAll(".qbSize")].find(c => c.value === "2XL"); x2.checked = true; x2.dispatchEvent(new w.Event("change"));
  q("#qbPrice").value = "4.50"; q("#qbPriceBig").value = "6.25";
  q("#qbOk").click();
  await until(() => [...d.querySelectorAll("#wizBlankList input:checked")].some(c => /Quick Tee/.test(c.closest("label").textContent)));
  const qb = (await lib.getAllBlanks(d1)).find(b => b.name === "Quick Tee");
  ok("OK makes the blank — every ticked color in every ticked size, nothing in stock — and it's ticked in the list",
    qb && qb.vendor === "Supplier" && qb.colors.map(c => c.color).sort().join() === "Navy,Seafoam" && qb.sizes.length === 6 && qb.sizes.every(z => z.quantity === 0) &&
    [...d.querySelectorAll("#wizBlankList input:checked")].some(c => /Quick Tee/.test(c.closest("label").textContent)));
  ok("…with the vendor price typed — and the 2XL-and-up price for 2XL — as each size's vendor price", qb.sizes.filter(z => z.size !== "2XL").every(z => z.vendorPrice === 4.5) &&
    qb.sizes.filter(z => z.size === "2XL").every(z => z.vendorPrice === 6.25));
  q("#wizBlankQuick").click(); await until(() => q("#qbName"));
  q("#qbName").value = "Fancy Tee"; [...d.querySelectorAll(".qbColor")].find(c => c.value === "Black").checked = true;
  q("#qbMore").click(); await until(() => d.getElementById("blkName"));
  ok("More options… carries what was typed into the full blank form", d.getElementById("blkName").value === "Fancy Tee" && /Black/.test(d.getElementById("blkColors").innerHTML));
  d.querySelectorAll(".admin-modal").forEach(m => m.remove());
  let vfMode = null; w.showVendorFileImport_ = (mode) => { vfMode = mode; };
  q("#wizBlankFile").click();
  ok("Import from a vendor file opens the vendor-file import for new blanks", vfMode === "new");

  console.log("\n=== Live / Coming soon ===");
  w.eval(`window._adminOrgRegistry = ${JSON.stringify((await call({ action: "listOrgsAdmin" })).body.orgs)};`);
  let barHtml = w.shopBarHtml_({ shop: "acme", page: "products" });
  ok("the shop bar has a switch beside Publish: “Coming soon” while the shop is closed", /role="switch" aria-checked="false"[^>]*>[^]*Coming soon/.test(barHtml) && barHtml.indexOf("shop-bar-live") < barHtml.indexOf("shop-bar-pub"));
  w.__confirmAnswer = () => false;
  await w.shopBarLive_("acme", true);
  ok("…changing it asks first; saying no changes nothing", d1.q("SELECT ready FROM orgs WHERE orgId='acme'")[0].ready === 0);
  w.__confirmAnswer = () => true;
  await w.shopBarLive_("acme", true);
  ok("…yes opens the shop for orders, and the switch reads Live", d1.q("SELECT ready FROM orgs WHERE orgId='acme'")[0].ready === 1 && /aria-checked="true"[^>]*>[^]*Live/.test(w.shopBarHtml_({ shop: "acme", page: "products" })));
  await w.shopBarLive_("acme", false);
  ok("…and back to Coming soon", d1.q("SELECT ready FROM orgs WHERE orgId='acme'")[0].ready === 0);
  w.eval(`adminMe = { role: "staff" };`);
  ok("a worker doesn't get the switch", !/shop-bar-live/.test(w.shopBarHtml_({ shop: "acme", page: "designs" })));
  w.eval(`adminMe = { role: "admin", name: "A", email: "a@x" };`);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test151 crashed: false"); process.exit(1); });
