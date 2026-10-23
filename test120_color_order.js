const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Product form, configurable products (2026-10): the order the colors are offered in can be arranged
// by hand — ↑ ↓ and First under the tick boxes — and that's the order customers see the swatches in
// (the first one is shown when the product opens). Until it's arranged the list follows the blank's own
// order, as before; after that a newly ticked color goes on the end. The real product form in jsdom
// against the real admin API and a real database, then the real storefront renderer.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createGraphic, createProduct, saveLocation, getProductsByOrg, getBlankLinks, getPublicCatalogData };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const toClientProduct = new Function(strip(read("functions/api/catalog.js")) + "\nreturn toClientProduct;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const sz = (...names) => names.map(size => ({ size, purchasePrice: 6, quantity: 0 }));
  const locId = await lib.saveLocation(d1, { name: "Left chest", sortOrder: 1 });
  const polo = (await lib.createBlank(d1, { name: "Polo A", brand: "Gildan", sku: "64800", productType: "shirt", colors: [
    { color: "Navy", images: [], sizes: sz("S", "M") }, { color: "Black", images: [], sizes: sz("S", "M") },
    { color: "Red", images: [], sizes: sz("S", "M") }, { color: "Royal", images: [], sizes: sz("S", "M") } ] })).id;
  await lib.createGraphic(d1, "club", { name: "Crest", kind: "transfer", tier: null, imageUrl: "img/crest.png" });
  await lib.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Club polo", pricingMode: "sized", sizePricing: { S: 25, M: 25 }, visible: true });
  await lib.createProduct(d1, "club", { productId: "old", type: "shirt", name: "Old way", pricingMode: "sized", sizePricing: { S: 25 }, visible: true, configurable: true, garmentColors: ["Custom Teal", "Royal", "Navy"], reorderQr: "none", locations: [] });

  const html = read("public/index.html"), adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie";`);
  const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  const tick = () => new Promise(res => setTimeout(res, 30));
  const text = (el) => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  const app = d.getElementById("app");
  const open = async (productId) => { app.innerHTML = ""; await w.renderEditProductForm(app, "club", productId); await until(() => d.getElementById("cfgOn") && (d.querySelector(".bl-blank") || /No blanks/.test(text(d.getElementById("blankLinksSection"))))); await tick(); };
  const tickBox = (cb, on) => { cb.checked = on; cb.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const blankBox = (name) => [...d.querySelectorAll(".cfgBlank")].find(c => new RegExp("^\\s*" + name + " ").test(c.parentElement.textContent.replace(/\s+/g, " ") + " "));
  const colorBox = (name) => [...d.querySelectorAll(".cfgColor")].find(c => c.dataset.color === name);
  const saved = () => w._productConfigGet().garmentColors.join(",");
  const rows = () => [...d.querySelectorAll("#cfgColorOrder .cfgColorRow")].map(r => r.dataset.color).join(",");
  const btn = (color, dir) => [...d.querySelectorAll("#cfgColorOrder .cfg-move")].find(b => b.dataset.color === color && b.dataset.dir === String(dir));
  const boxes = () => [...d.querySelectorAll(".cfgColor")].map(c => c.dataset.color + (c.checked ? "✓" : "")).join(",");
  const blocks = () => [...d.querySelectorAll("details.bl-block")].map(b => b.dataset.pc).join(",");
  const heads = () => [...d.querySelectorAll("#cfgMockups thead th")].map(th => th.textContent.trim()).join(",");

  console.log("=== Until it's arranged, the colors follow the blank's order ===");
  await open("polo");
  tickBox(d.getElementById("cfgOn"), true);
  tickBox(blankBox("Polo A"), true);
  ok("with no color ticked there's no order list", !d.getElementById("cfgColorOrder"));
  tickBox(colorBox("Royal"), true);
  ok("…nor with one — there's nothing to arrange", !d.getElementById("cfgColorOrder") && saved() === "Royal");
  tickBox(colorBox("Navy"), true);
  tickBox(colorBox("Red"), true);
  ok("colors ticked in any order are kept in the blank's order", saved() === "Navy,Red,Royal");
  ok("the order list appears under the tick boxes, in that order, numbered", rows() === "Navy,Red,Royal" && /1 Navy shown first/.test(text(d.querySelector(".cfgColorRow"))) && /Order on the shop's page/.test(text(d.getElementById("cfgColorOrder"))));
  ok("the first can't go up, the last can't go down, the first has no First button", btn("Navy", -1).disabled && !btn("Navy", 1).disabled && btn("Royal", 1).disabled && !btn("Royal", -1).disabled && !btn("Navy", "first") && !!btn("Red", "first"));
  ok("each arrow says what it does", btn("Red", -1).getAttribute("aria-label") === "Move Red up" && btn("Red", 1).getAttribute("aria-label") === "Move Red down" && btn("Red", "first").getAttribute("aria-label") === "Move Red to first");
  ok("nothing to undo yet — no 'Use the blank's order' button", !d.getElementById("cfgColorReset"));
  ok("the tick boxes still list every color the blank comes in, in the blank's order", boxes() === "Navy✓,Black,Red✓,Royal✓");

  console.log("\n=== Arranging them ===");
  d.getElementById("cfgAddLoc").click();
  const pick = d.querySelector(".cfgLocPick"); pick.value = String(locId); pick.dispatchEvent(new w.Event("change", { bubbles: true }));
  tickBox(d.querySelector(".cfgLocGraphic"), true);
  ok("(Blank links and the mockup table start in the same order)", blocks() === "Navy,Red,Royal" && heads() === "Graphic,Navy,Red,Royal");
  btn("Royal", -1).click();
  ok("↑ moves a color up one place", saved() === "Navy,Royal,Red" && rows() === "Navy,Royal,Red");
  ok("the keyboard stays on the color that moved", d.activeElement === btn("Royal", -1));
  ok("Blank links and the mockup columns follow at once", blocks() === "Navy,Royal,Red" && heads() === "Graphic,Navy,Royal,Red");
  ok("the tick boxes don't move — they stay in the blank's order", boxes() === "Navy✓,Black,Red✓,Royal✓");
  ok("now there's a 'Use the blank's order' button", !!d.getElementById("cfgColorReset"));
  btn("Navy", 1).click();
  ok("↓ moves a color down one place", saved() === "Royal,Navy,Red" && /1 Royal shown first/.test(text(d.querySelector(".cfgColorRow"))));
  btn("Red", "first").click();
  ok("First puts a color at the top — the one shown when the product opens", saved() === "Red,Royal,Navy" && !btn("Red", "first") && btn("Red", -1).disabled);
  ok("…and the keyboard follows it to an arrow that still works", d.activeElement === btn("Red", 1));
  btn("Red", -1).click();
  ok("a greyed-out arrow does nothing", saved() === "Red,Royal,Navy");

  console.log("\n=== Ticking and unticking after that ===");
  tickBox(colorBox("Black"), true);
  ok("a newly ticked color goes on the end, leaving the arrangement alone", saved() === "Red,Royal,Navy,Black" && /4 of 4 offered/.test(text(d.getElementById("cfgColorList"))));
  tickBox(colorBox("Royal"), false);
  ok("unticking one takes it out and keeps the others where they were", saved() === "Red,Navy,Black" && rows() === "Red,Navy,Black");
  d.getElementById("cfgColorAll").click();
  ok("Select all adds the rest on the end", saved() === "Red,Navy,Black,Royal");
  d.getElementById("cfgColorNone").click();
  ok("Clear empties the list (and the order list goes)", saved() === "" && !d.getElementById("cfgColorOrder"));
  d.getElementById("cfgColorAll").click();
  ok("Select all from nothing is the blank's order again", saved() === "Navy,Black,Red,Royal" && !d.getElementById("cfgColorReset"));
  btn("Royal", "first").click(); btn("Black", 1).click();
  ok("(arranged again for the save)", saved() === "Royal,Navy,Red,Black");

  console.log("\n=== Save, and what customers see ===");
  await w.submitProductForm("club", true); await tick();
  let p = (await lib.getProductsByOrg(d1, "club", false)).find(x => x.productId === "polo");
  ok("Save changes stores the colors in that order", JSON.stringify(p.garmentColors) === '["Royal","Navy","Red","Black"]');
  const links = (await lib.getBlankLinks(d1, "club")).filter(l => l.productId === "polo");
  ok("every color is still linked to its blank (8 color + size links)", links.length === 8 && links.every(l => Number(l.blankId) === polo && l.blankColor === l.productColor));
  const pub = (await lib.getPublicCatalogData(d1)).orgs.club.products.find(x => x.productId === "polo" || x.id === "polo");
  const client = toClientProduct(pub);
  ok("the shop's catalog hands the colors over in that order", JSON.stringify(client.garmentColors) === '["Royal","Navy","Red","Black"]');
  const holder = d.createElement("div"); holder.innerHTML = w.renderConfigurableProduct(client, { orgId: "club" });
  const sw = [...holder.querySelectorAll(".cfg-swatch")];
  ok("the shop's page draws the swatches in that order, with the first one selected", sw.map(b => b.dataset.color).join(",") === "Royal,Navy,Red,Black" && sw[0].classList.contains("sel") && sw.filter(b => b.classList.contains("sel")).length === 1 &&
    holder.querySelector(`#gcolor-${client.id}`).value === "Royal");
  // An ordinary product-form save that doesn't carry the colors leaves the order alone.
  await call({ action: "updateProduct", org: "club", productId: "polo", type: "shirt", name: "Club polo", pricingMode: "sized", sizePricing: { S: 26, M: 26 }, visible: true, images: [], features: [] });
  p = (await lib.getProductsByOrg(d1, "club", false)).find(x => x.productId === "polo");
  ok("a price change made elsewhere doesn't disturb the order", JSON.stringify(p.garmentColors) === '["Royal","Navy","Red","Black"]' && p.sizePricing.S === 26);

  console.log("\n=== Reopening ===");
  await open("polo");
  ok("the saved order comes back", saved() === "Royal,Navy,Red,Black" && rows() === "Royal,Navy,Red,Black" && blocks() === "Royal,Navy,Red,Black" && heads() === "Graphic,Royal,Navy,Red,Black");
  ok("…and can be put back to the blank's order in one click", !!d.getElementById("cfgColorReset"));
  d.getElementById("cfgColorReset").click();
  ok("'Use the blank's order' restores it and the button goes away", saved() === "Navy,Black,Red,Royal" && rows() === "Navy,Black,Red,Royal" && !d.getElementById("cfgColorReset") && heads() === "Graphic,Navy,Black,Red,Royal");
  tickBox(colorBox("Black"), false); tickBox(colorBox("Black"), true);
  ok("back in the blank's order, a re-ticked color goes to its place in it", saved() === "Navy,Black,Red,Royal");
  await w.submitProductForm("club", true); await tick();
  p = (await lib.getProductsByOrg(d1, "club", false)).find(x => x.productId === "polo");
  ok("…and that saves too", JSON.stringify(p.garmentColors) === '["Navy","Black","Red","Royal"]');

  console.log("\n=== A product with a typed-in color and an order of its own ===");
  await open("old");
  ok("its saved order is shown as it is, not re-sorted on opening", saved() === "Custom Teal,Royal,Navy" && rows() === "Custom Teal,Royal,Navy");
  btn("Navy", "first").click();
  ok("a color no blank has can be arranged like any other", saved() === "Navy,Custom Teal,Royal");
  tickBox(blankBox("Polo A"), true);
  d.getElementById("cfgColorReset").click();
  ok("the blank's order puts the blank's colors first and a typed-in one last", saved() === "Navy,Royal,Custom Teal");

  console.log("\n=== On a phone ===");
  ok("the color arrows get the same thumb-sized style as the product arrows", /\.prod-move, \.cfg-move\{min-width:44px; min-height:38px;/.test(html));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
