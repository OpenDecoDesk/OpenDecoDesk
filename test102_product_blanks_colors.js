const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Product form, configurable products: colors aren't typed. Pick the blanks the
// product is made on, tick colors from the colors those blanks come in, and each color and size is
// linked to its blank automatically; the graphic mockup tables follow the ticked colors without a
// save-and-reopen. The real screens in jsdom against the real admin API and a real database.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createGraphic, createProduct, saveLocation, getProductsByOrg, getBlankLinks, setBlankLink, getGraphic, priceItem, getPublicCatalogData };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { league: 'league' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1);`);
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  let r0;
  const sz = (...names) => names.map(size => ({ size, purchasePrice: 6, quantity: 0 }));
  const locId = await lib.saveLocation(d1, { name: "Left chest", sortOrder: 1 });
  const polo = (await lib.createBlank(d1, { name: "Polo A", brand: "Gildan", sku: "64800", productType: "shirt", colors: [
    { color: "Navy", images: [{ url: "img/navy-chest.jpg", locationId: locId }, "img/navy.jpg"], sizes: sz("S", "M", "L") },
    { color: "Black", images: [], sizes: sz("S", "M", "L") }, { color: "Red", images: [], sizes: sz("S", "M", "L") } ] })).id;
  const tall = (await lib.createBlank(d1, { name: "Polo A Tall", brand: "Gildan", sku: "64800T", productType: "shirt", colors: [
    { color: "Navy", images: [], sizes: sz("LT") }, { color: "Black", images: [], sizes: sz("LT") }, { color: "Royal", images: ["img/royal.jpg"], sizes: sz("LT") } ] })).id;
  await lib.createBlank(d1, { name: "Cap X", productType: "cap", colors: [{ color: "Khaki", images: [], sizes: sz("OSFA") }] });
  const gArt = await lib.createGraphic(d1, "league", { name: "Crest", kind: "transfer", tier: null, imageUrl: "img/crest.png" });
  await lib.createProduct(d1, "league", { productId: "polo", type: "shirt", name: "League polo", pricingMode: "sized", sizePricing: { S: 25, M: 25, L: 25, LT: 27 }, visible: true });
  await lib.createProduct(d1, "league", { productId: "old", type: "shirt", name: "Old way", pricingMode: "sized", sizePricing: { L: 25 }, visible: true, configurable: true, garmentColors: ["Custom Teal"], reorderQr: "none", locations: [] });

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
  const open = async (productId) => { app.innerHTML = ""; await w.renderEditProductForm(app, "league", productId); await until(() => d.getElementById("cfgOn") && (d.querySelector(".bl-blank") || /No blanks/.test(text(d.getElementById("blankLinksSection"))))); await tick(); };
  const tickBox = (cb, on) => { cb.checked = on; cb.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const blankBox = (name) => [...d.querySelectorAll(".cfgBlank")].find(c => new RegExp("^\\s*" + name + " ").test(c.parentElement.textContent.replace(/\s+/g, " ") + " "));
  const colorBox = (name) => [...d.querySelectorAll(".cfgColor")].find(c => c.dataset.color === name);
  const block = (color) => [...d.querySelectorAll("details.bl-block")].find(b => b.dataset.pc === color);
  const rowPick = (color, size) => { const q = (cls) => [...d.querySelectorAll("." + cls)].find(s => s.dataset.pc === color && s.dataset.ps === size);
    return [q("bl-blank").value, q("bl-color").value, q("bl-size").value].join("/"); };

  console.log("=== The page, top to bottom ===");
  await open("polo");
  const order = ["productCfgHead", "blankLinksSection", "productConfigSection"].map(id => d.getElementById(id));
  ok("Blanks & colors comes first, then Blank links, then the graphic options", order.every(Boolean) &&
    (order[0].compareDocumentPosition(order[1]) & 4) && (order[1].compareDocumentPosition(order[2]) & 4) && order[0].contains(d.getElementById("cfgOn")));
  ok("no typed-in garment colors box any more", !d.getElementById("cfgColors") && !/Garment colors \(one per line\)/.test(adminJs));
  ok("a product that isn't configurable shows no pickers, and Blank links as before (one row per size)", d.getElementById("cfgBlankPick").style.display === "none" && d.querySelectorAll(".bl-blank").length === 4 && !d.querySelector("details.bl-block"));

  console.log("\n=== 1. Pick the blanks ===");
  tickBox(d.getElementById("cfgOn"), true);
  ok("turning Configurable on shows the blank list — blanks of the product's type only", d.getElementById("cfgBlankPick").style.display !== "none" && !!blankBox("Polo A") && !!blankBox("Polo A Tall") && !blankBox("Cap X"));
  ok("before a blank is ticked there are no colors, just a hint", /Tick a blank above/.test(text(d.getElementById("cfgColorList"))));
  const filter = d.getElementById("cfgBlankFilter"); filter.value = "tall"; filter.dispatchEvent(new w.Event("input"));
  ok("the blank list can be searched", d.querySelectorAll(".cfgBlank").length === 1 && !!blankBox("Polo A Tall"));
  filter.value = ""; filter.dispatchEvent(new w.Event("input"));
  tickBox(blankBox("Polo A"), true);

  console.log("\n=== 2. Tick colors from those blanks ===");
  ok("its colors are listed, none ticked yet", [...d.querySelectorAll(".cfgColor")].map(c => c.dataset.color + (c.checked ? "✓" : "")).join(",") === "Navy,Black,Red" && /0 of 3 offered/.test(text(d.getElementById("cfgColorList"))));
  tickBox(colorBox("Navy"), true);
  ok("ticking a color makes it one of the product's colors", JSON.stringify(w._productConfigGet().garmentColors) === '["Navy"]' && w._productConfigGet().configurable === true);

  console.log("\n=== 3. Blank links fill themselves in ===");
  ok("the color appears under Blank links with every size the blank has linked by name", !!block("Navy") && rowPick("Navy", "S") === `${polo}/Navy/S` && rowPick("Navy", "M") === `${polo}/Navy/M` && rowPick("Navy", "L") === `${polo}/Navy/L`);
  ok("a size that blank doesn't come in is left for you, and the color stays open saying so", rowPick("Navy", "LT") === "//" && block("Navy").open && /⚠ 3 of 4 sizes linked/.test(text(block("Navy").querySelector("summary"))));
  tickBox(blankBox("Polo A Tall"), true);
  ok("ticking a second blank adds its colors to the list (which blank, when not all have it)", [...d.querySelectorAll(".cfgColor")].map(c => c.dataset.color).join(",") === "Navy,Black,Red,Royal" && /Royal Polo A Tall/.test(text(colorBox("Royal").parentElement)) && colorBox("Navy").checked);
  ok("…and the missing size is linked to the blank that has it", rowPick("Navy", "LT") === `${tall}/Navy/LT` && /✓ all 4 sizes linked/.test(text(block("Navy").querySelector("summary"))) && /Navy → Polo A · Navy/.test(text(block("Navy").querySelector("summary"))));
  ok("a row only offers the ticked blanks", [...[...d.querySelectorAll(".bl-blank")][0].options].map(o => o.textContent).join("|") === "— None —|Polo A|Polo A Tall");
  tickBox(colorBox("Royal"), true);
  ok("a color only the tall blank comes in is linked where it can be", rowPick("Royal", "LT") === `${tall}/Royal/LT` && rowPick("Royal", "S") === "//" && /⚠ 1 of 4 sizes linked/.test(text(block("Royal").querySelector("summary"))));
  ok("colors keep the blank's order", JSON.stringify(w._productConfigGet().garmentColors) === '["Navy","Royal"]');
  // A hand pick survives the next change.
  const hand = [...d.querySelectorAll(".bl-size")].find(s => s.dataset.pc === "Navy" && s.dataset.ps === "S"); hand.value = "M"; hand.dispatchEvent(new w.Event("change", { bubbles: true }));
  tickBox(colorBox("Black"), true);
  ok("a link changed by hand is kept when another color is ticked", rowPick("Navy", "S") === `${polo}/Navy/M` && rowPick("Black", "LT") === `${tall}/Black/LT`);
  tickBox(colorBox("Black"), false);
  hand.value = "S"; [...d.querySelectorAll(".bl-size")].find(s => s.dataset.pc === "Navy" && s.dataset.ps === "S").value = "S";
  [...d.querySelectorAll(".bl-size")].find(s => s.dataset.pc === "Navy" && s.dataset.ps === "S").dispatchEvent(new w.Event("change", { bubbles: true }));

  console.log("\n=== 4. Graphic options follow the colors — no save and reopen ===");
  ok("with no location yet the mockup area says what's needed", /Add a location and tick its graphics/.test(text(d.getElementById("cfgMockups"))));
  d.getElementById("cfgAddLoc").click();
  const pick = d.querySelector(".cfgLocPick"); pick.value = String(locId); pick.dispatchEvent(new w.Event("change", { bubbles: true }));
  tickBox(d.querySelector(".cfgLocGraphic"), true);
  const heads = () => [...d.querySelectorAll("#cfgMockups thead th")].map(th => th.textContent.trim()).join(",");
  ok("the mockup table appears at once with a column per ticked color", heads() === "Graphic,Navy,Royal" && d.querySelectorAll(".cfgMockBtn").length === 2 && /Left chest/.test(text(d.getElementById("cfgMockups"))));
  tickBox(colorBox("Red"), true);
  ok("ticking another color adds its column", heads() === "Graphic,Navy,Red,Royal" && !!d.querySelector(".cfgLocGraphic:checked"));
  tickBox(colorBox("Red"), false);
  let offered = null; const realModal = w.showOverlayEditorModal_;
  w.eval(`showOverlayEditorModal_ = (o) => { window.__ov = o; };`);
  [...d.querySelectorAll(".cfgMockBtn")].find(b => b.dataset.color === "Navy").click();
  offered = w.__ov;
  ok("the mockup editor is offered the blank color's photos (the one tagged to this location first) before anything is saved", offered && offered.baseCandidates[0] === "img/navy-chest.jpg" && offered.baseCandidates.includes("img/navy.jpg") && offered.graphicUrl === "img/crest.png");
  [...d.querySelectorAll(".cfgMockBtn")].find(b => b.dataset.color === "Royal").click();
  ok("…and for a color from the other blank, that blank's photos", w.__ov.baseCandidates.join(",") === "img/royal.jpg");

  console.log("\n=== Don't offer a graphic on one color ===");
  const cell = (color) => [...d.querySelectorAll(".cfgMockBtn")].find(b => b.dataset.color === color);
  cell("Royal").click();
  ok("the mockup editor is told which combination it is, and that it's offered", /Crest on Royal/.test(w.__ov.comboLabel) && w.__ov.blocked === false && typeof w.__ov.onBlock === "function");
  ok("the editor has a 'Don't offer …' box that needs no mockup", /id="ovBlock"/.test(adminJs) && /Don't offer \$\{escapeHtml\(opts\.comboLabel/.test(adminJs) && /if \(blockBox && blockBox\.checked\) \{ close\(\); opts\.onBlock\(true\); return; \}/.test(adminJs));
  w.__ov.onBlock(true);
  ok("ticking it marks that cell 'Not offered' and leaves the others alone", /Not offered/.test(text(cell("Royal"))) && !!cell("Royal").closest(".cfgMockOff") && !cell("Navy").closest(".cfgMockOff"));
  const blocksOf = async (id) => JSON.stringify((await lib.getProductsByOrg(d1, "league", false)).find(x => x.productId === id).blockedGraphicColors);
  ok("nothing is written until Save", (await blocksOf("polo")) === "[]");
  cell("Royal").click();
  ok("opening it again shows it switched off, so it can be switched back on", w.__ov.blocked === true);

  console.log("\n=== Save ===");
  await w.submitProductForm("league", true); await tick();
  let p = (await lib.getProductsByOrg(d1, "league", false)).find(x => x.productId === "polo");
  const linksOf = async () => (await lib.getBlankLinks(d1, "league")).filter(l => l.productId === "polo").map(l => `${l.productColor}|${l.productSize}>${l.blankId}/${l.blankColor}/${l.blankSize}`).sort();
  ok("one Save writes the colors, the location and every link", p.configurable === true && JSON.stringify(p.garmentColors) === '["Navy","Royal"]' && p.locations.length === 1 && p.locations[0].locationId === locId &&
    JSON.stringify(await linksOf()) === JSON.stringify([`Navy|L>${polo}/Navy/L`, `Navy|LT>${tall}/Navy/LT`, `Navy|M>${polo}/Navy/M`, `Navy|S>${polo}/Navy/S`, `Royal|LT>${tall}/Royal/LT`].sort()));

  ok("Save stores the switch on the PRODUCT, audited", (await blocksOf("polo")) === JSON.stringify([{ graphicId: gArt, color: "Royal" }]) && Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='product.graphic_color_blocked'")[0].n) === 1);
  const cfgOf = (color) => ({ garmentColor: color, locations: { ["loc" + locId]: { graphicId: gArt } } });
  const refused = async (color) => { try { await lib.priceItem(d1, "league", "polo", "LT", 1, false, cfgOf(color)); return ""; } catch (e) { return e.userFacing ? e.message : "?"; } };
  ok("an order for that combination is refused; the same graphic on another color is fine", /Crest isn't available on Royal/.test(await refused("Royal")) && (await refused("Navy")) === "");
  const pub = await lib.getPublicCatalogData(d1);
  ok("the storefront is told (on the product), and hides the graphic for that color", JSON.stringify(pub.orgs.league.products.find(x => x.id === "polo" || x.productId === "polo").blockedGraphicColors) === JSON.stringify([{ graphicId: gArt, color: "Royal" }]) &&
    /\(p\.blockedGraphicColors \|\| \[\]\)\.some\(b => Number\(b\.graphicId\) === g\.id && b\.color === color\)/.test(html));
  // It's this product's own: another product with the same graphic and a color of the same name still offers it.
  await lib.createProduct(d1, "league", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, configurable: true, garmentColors: ["Royal"], reorderQr: "none",
    locations: [{ key: "loc" + locId, label: "Left chest", locationId: locId, graphicIds: [gArt] }] });
  let teeOk = true; try { await lib.priceItem(d1, "league", "tee", "OSFA", 1, false, cfgOf("Royal")); } catch (e) { teeOk = false; }
  ok("another product's 'Royal' is unaffected — the switch is per product", teeOk && (await blocksOf("tee")) === "[]");
  r0 = await call({ action: "updateProduct", org: "league", productId: "tee", type: "shirt", name: "Tee renamed", pricingMode: "flat", flatPrice: 20, visible: true, images: [], features: [] });
  ok("saving the product form itself doesn't clear the list", (await blocksOf("polo")) !== "[]");

  console.log("\n=== Reopening, and taking things away ===");
  await open("polo");
  ok("the linked blanks come back ticked and listed first, the colors ticked", blankBox("Polo A").checked && blankBox("Polo A Tall").checked && colorBox("Navy").checked && colorBox("Royal").checked && !colorBox("Red").checked);
  ok("a fully linked color is folded away; one that still needs sizes is open", !block("Navy").open && block("Royal").open && heads() === "Graphic,Navy,Royal");
  const cell2 = (color) => [...d.querySelectorAll(".cfgMockBtn")].find(b => b.dataset.color === color);
  ok("the switched-off cell comes back marked", /Not offered/.test(text(cell2("Royal"))));
  cell2("Royal").click(); w.__ov.onBlock(false);
  ok("switching it back on returns the normal cell", !cell2("Royal").closest(".cfgMockOff"));
  cell2("Royal").click(); w.__ov.onBlock(true);
  tickBox(blankBox("Polo A Tall"), false);
  ok("unticking a blank drops the colors only it came in, and the sizes only it had", !colorBox("Royal") && JSON.stringify(w._productConfigGet().garmentColors) === '["Navy"]' && !block("Royal") && rowPick("Navy", "LT") === "//" && rowPick("Navy", "S") === `${polo}/Navy/S`);
  await w.submitProductForm("league", true); await tick();
  ok("saving removes the links of a color that's no longer offered and of the unticked blank", JSON.stringify(await linksOf()) === JSON.stringify([`Navy|L>${polo}/Navy/L`, `Navy|M>${polo}/Navy/M`, `Navy|S>${polo}/Navy/S`].sort()));

  console.log("\n=== A product set up the old way ===");
  await open("old");
  // With no blank ticked it's simply "typed in" (a blank is optional); next to ticked blanks it's flagged.
  ok("a typed-in color no blank has is kept, ticked, and labelled", !!colorBox("Custom Teal") && colorBox("Custom Teal").checked && /typed in/.test(text(colorBox("Custom Teal").parentElement)) && JSON.stringify(w._productConfigGet().garmentColors) === '["Custom Teal"]');
  ok("its Blank links still let you map it by hand", !!block("Custom Teal") && [...d.querySelectorAll(".bl-blank")][0].options.length === 3);

  console.log("\n=== A new product opens on its own page ===");
  ok("after Create the form goes to the product's edit page, not back to the list", /if\(!isEdit\)\{\s*showToast\("Created\. Now pick its blanks and colors\."\);\s*location\.hash = "#catalog\/orgs\/" \+ encodeURIComponent\(orgId\) \+ "\/products\/" \+ encodeURIComponent\(body\.productId\) \+ "\/edit";/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
