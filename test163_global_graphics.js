const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Global graphics (migrations/0078): like global designs, one graphic every shop can use. Listed for every shop, offered
// as another shop's option / printed transfer / mockup graphic and priced on its orders; a global graphic may only use a
// global design and a transfer open to every shop; it can't be made shop-only (nor its design) while other shops use it;
// edited from any shop, deleted only when no shop uses it; copying products keeps it. The Graphics form and list in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getPublicCatalogData, getAllBlanks, priceItem, getPublishState, getPublishedOrg, publishShop, getCatalogIssues, signPreviewToken, verifyPreviewToken, planHoopings_, listGraphics, createTransfer, getCatalogIssues };`)();
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
  for (const id of ["acme", "lakeside"]) await call({ action: "createOrg", orgId: id, subdomain: id, name: id === "acme" ? "Acme" : "Lakeside", ready: false, deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }] });
  const dShop = (await call({ action: "saveDesign", org: "acme", design: { name: "Acme crest stitch" } })).body.id;
  const dGlob = (await call({ action: "saveDesign", org: "acme", design: { name: "Emblem stitch", isGlobal: true } })).body.id;

  console.log("=== A global graphic needs a global design ===");
  let r = await call({ action: "saveGraphic", org: "acme", graphic: { name: "Emblem", kind: "embroidery", designId: dShop, isGlobal: true, visible: true } });
  ok("a global graphic with a shop-only design is refused, saying why", r.status === 400 && /only use a global design/.test(r.body.message));
  r = await call({ action: "saveGraphic", org: "acme", graphic: { name: "Emblem", kind: "embroidery", designId: dGlob, isGlobal: true, visible: true, imageUrl: "https://img.example/emblem.png" } });
  const gEmb = r.body.id;
  ok("…with a global design it's saved as global (audited)", r.status === 200 && d1.q("SELECT isGlobal FROM graphics WHERE id=?", gEmb)[0].isGlobal === 1 &&
    d1.q("SELECT 1 FROM audit_log WHERE action='graphic.made_global'").length === 1);
  r = await call({ action: "saveGraphic", org: "acme", graphic: { name: "Plain emblem", kind: "embroidery", isGlobal: true, visible: true } });
  ok("…and so is one with no design yet", r.status === 200);
  const tShop = await lib.createTransfer(d1, { name: "Acme sheet", orgIds: ["acme"] }), tAll = await lib.createTransfer(d1, { name: "Open sheet", orgIds: [] });
  r = await call({ action: "saveGraphic", org: "acme", graphic: { name: "Emblem print", kind: "transfer", transferId: tShop, isGlobal: true, visible: true } });
  ok("a global printed graphic can't use a transfer limited to some shops", r.status === 400 && /every shop can use/.test(r.body.message));
  r = await call({ action: "saveGraphic", org: "acme", graphic: { name: "Emblem print", kind: "transfer", transferId: tAll, isGlobal: true, visible: true, inkColors: [] } });
  const gPrint = r.body.id;
  ok("…but can use one open to every shop", r.status === 200);
  const gAcmeOnly = (await call({ action: "saveGraphic", org: "acme", graphic: { name: "Acme only", kind: "transfer", visible: true } })).body.id;

  console.log("\n=== Every shop can use it ===");
  const lake = await lib.listGraphics(d1, "northside");
  ok("another shop's graphics list has the global graphics (not the home shop's own)", lake.some(g => g.id === gEmb && g.isGlobal) && lake.some(g => g.id === gPrint) && !lake.some(g => g.id === gAcmeOnly));
  const loc = (await call({ action: "saveLocation", location: { name: "Left chest" } })).body.id, back = (await call({ action: "saveLocation", location: { name: "Back" } })).body.id;
  r = await call({ action: "createBlank", name: "Sample Tee", brand: "Sample Co", sku: "ST1", vendor: "Supplier", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 0, vendorPrice: 5 }] }] });
  const blankId = r.body.id;
  r = await call({ action: "buildProductFromBlank", org: "northside", blankId, colors: ["Navy"], sizes: ["M"], name: "Club Tee", decoration: "both", pricingMode: "sized", sizePricing: { M: 20 },
    locations: [{ key: "loc" + loc, label: "Left chest", locationId: loc, graphicIds: [gEmb] }], fixedTransfers: [{ locationId: back, graphicId: gPrint, ink: "" }] });
  const tee = r.body.productId;
  ok("another shop's product can offer it as an option and carry it as a printed transfer", r.status === 200);
  r = await call({ action: "buildProductFromBlank", org: "northside", blankId, colors: ["Navy"], sizes: ["M"], name: "Plain Tee", decoration: "embroidery", pricingMode: "sized", sizePricing: { M: 18 },
    mockupGraphics: [{ locationId: loc, graphicId: gEmb }] });
  ok("…and picture it as a mockup graphic", r.status === 200);
  r = await call({ action: "buildProductFromBlank", org: "northside", blankId, colors: ["Navy"], sizes: ["M"], name: "Wrong Tee", decoration: "dtf", pricingMode: "sized", sizePricing: { M: 18 },
    fixedTransfers: [{ locationId: back, graphicId: gAcmeOnly, ink: "" }] });
  ok("…but still not another shop's own graphic", r.status === 400);
  await call({ action: "setProductVisible", org: "northside", productId: tee, visible: true });
  const priced = await lib.priceItem(d1, "northside", tee, "M", 1, false, { garmentColor: "Navy", locations: { ["loc" + loc]: { graphicId: gEmb } } }).catch(e => ({ err: e.message }));
  ok("an order on that shop prices the global option, and the line carries the global design", !priced.err && JSON.stringify(priced).includes('"designId":' + dGlob));
  const issues = ((await lib.getCatalogIssues(d1)).orgs.northside.products || {})[tee] || [];
  ok("the catalog check doesn't call the global graphic missing", !issues.some(x => /Missing$/.test(x.code)));

  console.log("\n=== Keeping it consistent ===");
  r = await call({ action: "saveGraphic", org: "acme", graphic: { id: gEmb, name: "Emblem", kind: "embroidery", designId: dGlob, isGlobal: false, visible: true } });
  ok("it can't be made shop-only while another shop's product uses it", r.status === 400 && /Other shops' products use this global graphic/.test(r.body.message));
  r = await call({ action: "saveDesign", org: "acme", design: { id: dGlob, name: "Emblem stitch", isGlobal: false } });
  ok("its design can't be made shop-only while a global graphic uses it", r.status === 400 && /global graphic/.test(r.body.message));
  r = await call({ action: "saveGraphic", org: "northside", graphic: { id: gEmb, name: "Emblem (new art)", kind: "embroidery", designId: dGlob, isGlobal: true, visible: true, imageUrl: "https://img.example/emblem.png" } });
  ok("any shop can edit a global graphic (one edit for every shop); its home shop stays", r.status === 200 && d1.q("SELECT name, orgId FROM graphics WHERE id=?", gEmb)[0].name === "Emblem (new art)" &&
    d1.q("SELECT orgId FROM graphics WHERE id=?", gEmb)[0].orgId === "acme");
  r = await call({ action: "saveGraphic", org: "northside", graphic: { id: gAcmeOnly, name: "Taken over", kind: "transfer", visible: true } });
  ok("…but not another shop's own graphic (that used to be possible by id)", r.status === 404 && d1.q("SELECT name FROM graphics WHERE id=?", gAcmeOnly)[0].name === "Acme only");
  r = await call({ action: "deleteGraphic", org: "acme", id: gEmb });
  ok("deleting it is refused while ANY shop's product offers it", r.status === 400);
  r = await call({ action: "copyProductsFromOrg", org: "lakeside", fromOrg: "northside", products: [{ fromProductId: tee, productId: "tee-copy", name: "Tee copy", sub: "", type: "shirt" }] });
  const copied = d1.q("SELECT locationsJson, fixedTransfersJson FROM products WHERE orgId='lakeside' AND productId='tee-copy'")[0];
  ok("copying the product to a third shop keeps the global graphics as they are", r.status === 200 && copied && JSON.parse(copied.locationsJson)[0].graphicIds.map(Number).includes(gEmb) &&
    JSON.parse(copied.fixedTransfersJson)[0].graphicId == gPrint);

  console.log("\n=== The Graphics screen ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await wait(150); await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" }; adminOrgs = [{ orgId: "acme", name: "Acme" }, { orgId: "northside", name: "Northside" }];');
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await wait(15); return fn(); };
  await w.renderGraphics(d.getElementById("app"), "northside");
  await until(() => d.querySelector("#grBody table"));
  const grText = d.getElementById("grBody").textContent;
  ok("another shop's Graphics list shows the global graphics in their own group, with a GLOBAL badge and the home shop", /🌐 Global — every shop/.test(grText) && /Emblem \(new art\)/.test(grText) && /GLOBAL/.test(grText) && /home: Acme/.test(grText));
  w.showGraphicFormModal_({ id: gAcmeOnly, orgId: "acme", name: "x", kind: "embroidery", designId: dShop, inkColors: [], allowedLocations: [], allowedGarmentColors: [], visible: true }, "acme",
    { designs: [{ id: dShop, name: "Acme crest stitch", isGlobal: false }, { id: dGlob, name: "Emblem stitch", isGlobal: true }], transfers: [], tiers: {}, allLocations: [], allColors: [] }, () => {});
  const opts = () => [...d.querySelectorAll("#gfDesign option")].map(o => o.textContent.trim());
  ok("the graphic form offers every design while shop-only", opts().includes("Acme crest stitch") && opts().includes("🌐 Emblem stitch"));
  d.getElementById("gfGlobal").checked = true; d.getElementById("gfGlobal").dispatchEvent(new w.Event("change"));
  ok("…ticking Global leaves only global designs, and unlinks a shop-only one with a note", !opts().includes("Acme crest stitch") && opts().includes("🌐 Emblem stitch") &&
    d.getElementById("gfDesign").value === "" && /isn't global/.test(d.getElementById("gfGlobalNote").textContent));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test152 crashed: false"); process.exit(1); });
