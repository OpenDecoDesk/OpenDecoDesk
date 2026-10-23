const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// MAP — the vendor's minimum advertised price (2026-10, migrations/0070). Read from the vendor files: S&S's Products
// sheet (MAPPrice, where 0.01 means "no MAP") and SanMar's SDL file (MAP_PRICING, blank = none); PromoStandards has no
// MAP, so a refresh from a connected vendor (or a CSV without the column) leaves it alone. It can be typed on the blank.
// A product's price for a size may not be below the MAP of the blank sizes it's linked to (the highest, across a color
// group's colors): saving such a price is refused, a link that would cause it is refused (and put back), and products
// that fall below after a MAP change are a catalog error, flagged in the analysis, the lists and the roll-up.
// Real db.js / orders.js on sql.js; the parser and screens in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { setPricingSettings, createBlank, createProduct, setBlankLink, getAllBlanks, planVendorBlanks, applyVendorBlanks, analyzePricing, getCatalogIssues, getNewPricingAlerts, suggestColorGroups, cleanVendorProduct_ };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" + strip(read("functions/_lib/orphanImages.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => (globalThis.__role ? { role: globalThis.__role } : null);\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (cond, n = 300) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)); return cond(); };

(async () => {
  const adminJs = read("public/admin.js");
  class Ld extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  let call;
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new Ld(), url: "https://admin.example.com/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.CSS = win.CSS || { escape: (x) => String(x) }; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: false, status: 404, json: async () => ({ status: "error" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Acme" }]; window._adminOrgRegistry = [{ orgId: "acme", name: "Acme" }];');

  console.log("=== Reading MAP from the vendor files ===");
  const ss = ["sku,styleName,title,brandName,colorName,sizeName,MAPPrice,piecePrice,customerPrice",
    "B1,5100,Unisex Tee,C2 Sport,White,S,7.65,4.10,3.61", "B2,5100,Unisex Tee,C2 Sport,White,M,7.65,4.10,3.61", "B3,5100,Unisex Tee,C2 Sport,Gold,S,0.01,4.10,3.61"].join("\n");
  const pss = w.parseVendorProductFile_(ss, "S&S Activewear").products[0];
  ok("S&S: MAPPrice is read per color + size", pss.maps && pss.maps.White.S === 7.65 && pss.maps.White.M === 7.65);
  ok("…and its $0.01 placeholder means no MAP", pss.maps.Gold.S === null);
  const smFile = w.parseVendorProductFile_(read("testlib/fixtures/vendor-sdl-sample.csv"), "SanMar").products;
  const k540 = smFile.find(p => p.style === "SP200"), s18810 = smFile.find(p => p.style === "DM300");
  ok("SanMar (its real SDL columns): MAP_PRICING is read; a blank cell is no MAP", k540.maps.Black.S === 12.99 && s18810.maps.Ash.S === null);
  const noMap = w.parseVendorProductFile_("style,color,supplier,cost_S\nK8000LS,Black,SanMar,15", "SanMar").products[0];
  ok("a file with no MAP column carries no MAP at all (so it can't clear one)", noMap.maps === undefined && lib.cleanVendorProduct_(noMap).maps === undefined);

  console.log("\n=== Storing it ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  const vp = { ...pss, vendor: "S&S Activewear" };
  let plan = (await lib.planVendorBlanks(d1, [vp]))[0];
  ok("a new blank's plan shows each size's MAP", plan.action === "create" && plan.colors.find(c => c.vendorColor === "White").prices.find(z => z.size === "S").map === 7.65 &&
    plan.colors.find(c => c.vendorColor === "Gold").prices[0].map === null);
  let r = await lib.applyVendorBlanks(d1, [vp], [{ key: plan.key, colors: ["White", "Gold"], create: { name: "C2 Sport 5100", productType: "shirt" } }], { note: "S&S file" });
  const blankId = r[0].blankId;
  const size = (c, z) => d1.q("SELECT * FROM blank_sizes WHERE blankId=? AND color=? AND size=?", blankId, c, z)[0];
  ok("creating the blank stores MAP with each size (none where the file says none)", size("White", "S").mapPriceCents === 765 && size("Gold", "S").mapPriceCents === null);
  const vp2 = { ...vp, maps: { White: { S: 8.25, M: 7.65 }, Gold: { S: null } } };
  plan = (await lib.planVendorBlanks(d1, [vp2]))[0];
  const ws = plan.colors.find(c => c.vendorColor === "White").prices.find(z => z.size === "S");
  ok("an update's plan marks the MAP change (was $7.65, now $8.25)", ws.mapChange === true && ws.mapCurrent === 7.65 && ws.map === 8.25);
  r = await lib.applyVendorBlanks(d1, [vp2], [{ key: plan.key, prices: true }], { note: "S&S file" });
  ok("…and applying it updates the MAP", size("White", "S").mapPriceCents === 825 && r[0].mapsChanged === 1);
  const psProduct = { vendor: "S&S Activewear", style: "5100", brand: "C2 Sport", colors: [{ color: "White", images: [] }], prices: { White: { S: 3.7 } } };
  plan = (await lib.planVendorBlanks(d1, [psProduct]))[0];
  await lib.applyVendorBlanks(d1, [psProduct], [{ key: plan.key, prices: true }], { note: "PromoStandards" });
  ok("a refresh with no MAP (PromoStandards) changes the price but leaves the MAP", size("White", "S").vendorPriceCents === 370 && size("White", "S").mapPriceCents === 825);
  const blank = (await lib.getAllBlanks(d1)).find(b => b.id === blankId);
  ok("the blank's sizes carry mapPrice", blank.sizes.find(z => z.color === "White" && z.size === "S").mapPrice === 8.25);
  r = await call({ action: "updateBlank", id: blankId, name: "C2 Sport 5100", productType: "shirt", colors: blank.colors.map(c => ({ color: c.color, images: [], sizes: c.sizes.map(z => ({ size: z.size, quantity: z.quantity, baseQuantity: z.quantity })) })) });
  ok("saving the blank form without touching MAP keeps it", r.status === 200 && size("White", "S").mapPriceCents === 825);

  console.log("\n=== Enforcing it on products ===");
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { S: 9, M: 9 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "acme", "tee", "", "S", blankId, "White", "S");
  let a = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  ok("the analysis shows each row's MAP and the blank it comes from", a.rows.find(x => x.size === "S").map === 8.25 && /C2 Sport 5100 White S/.test(a.rows.find(x => x.size === "S").mapOf) && !a.belowMap);
  const save = (sizePricing) => call({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing, visible: true, noDesignNeeded: true });
  r = await save({ S: 8, M: 9 });
  ok("saving a price below the blank's MAP is refused, saying which size and the MAP", r.status === 400 && r.body.code === "belowMap" && /S \$8\.00 is below the MAP of \$8\.25/.test(r.body.message));
  ok("…and nothing was written", d1.q("SELECT sizePricingCents FROM products WHERE productId='tee'")[0].sizePricingCents.includes('"S":900'));
  r = await save({ S: 8.25, M: 9 });
  ok("a price exactly at MAP is fine", r.status === 200);
  r = await call({ action: "setBlankLink", org: "acme", productId: "tee", productColor: "", productSize: "M", blankId, blankColor: "White", blankSize: "M" });
  ok("linking a size whose price is above its MAP is fine", r.status === 200);
  d1._raw.run("UPDATE blank_sizes SET mapPriceCents=950 WHERE blankId=? AND color='White' AND size='M'", [blankId]);
  d1._raw.run("DELETE FROM product_blank_links WHERE productId='tee' AND productSize='M'");
  r = await call({ action: "setBlankLink", org: "acme", productId: "tee", productColor: "", productSize: "M", blankId, blankColor: "White", blankSize: "M" });
  ok("linking a blank whose MAP is above the price is refused…", r.status === 409 && r.body.code === "belowMap" && /M \$9\.00 is below the MAP of \$9\.50/.test(r.body.message));
  ok("…and the link isn't left behind", !d1.q("SELECT 1 FROM product_blank_links WHERE productId='tee' AND productSize='M'").length);

  console.log("\n=== A MAP that rises later ===");
  d1._raw.run("UPDATE blank_sizes SET mapPriceCents=1000 WHERE blankId=? AND color='White' AND size='S'", [blankId]);
  a = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  ok("a product left below MAP is flagged, with why", a.belowMap && a.mapProblems.some(t => /S \$8\.25 is below the MAP of \$10\.00/.test(t)) && a.rows.find(x => x.size === "S").flags.includes("map"));
  const issues = await lib.getCatalogIssues(d1, "acme");
  ok("…it's a catalog error", (issues.orgs.acme.products.tee || []).some(x => x.code === "belowMap" && x.level === "error"));
  ok("…the 6 AM roll-up reports it", (await lib.getNewPricingAlerts(d1)).products.some(p => p.productId === "tee" && p.problems.some(t => /MAP/.test(t))));
  r = await call({ action: "updateBlank", id: blankId, name: "C2 Sport 5100", productType: "shirt", colors: (await lib.getAllBlanks(d1)).find(b => b.id === blankId).colors.map(c => ({ color: c.color, images: [], sizes: c.sizes.map(z => ({ size: z.size, quantity: z.quantity, baseQuantity: z.quantity, ...(c.color === "White" && z.size === "S" ? { mapPrice: 10.5 } : {}) })) })) });
  ok("typing a higher MAP on the blank saves it and names the products now below it", r.status === 200 && size("White", "S").mapPriceCents === 1050 && r.body.belowTarget.some(p => p.productId === "tee" && p.belowMap));
  // OpenDecoDesk: costs and targets are a manager's; a worker who edits a blank hears only of MAP (a vendor's public price).
  await lib.setPricingSettings(d1, { cardPctBps: 290, cardFixedCents: 30, suppliesCents: 0, targetIncomeCents: 5000 });
  const blankBody = { action: "updateBlank", id: blankId, name: "C2 Sport 5100", productType: "shirt", colors: (await lib.getAllBlanks(d1)).find(b => b.id === blankId).colors.map(c => ({ color: c.color, images: [], sizes: c.sizes.map(z => ({ size: z.size, quantity: z.quantity, baseQuantity: z.quantity })) })) };
  const mgr = await call(blankBody);
  globalThis.__role = "staff"; const wkr = await call(blankBody); globalThis.__role = null;
  const tee = (x) => x.body.belowTarget.find(p => p.productId === "tee") || { problems: [] };
  ok("a manager is told of the MAP and the missed income target", tee(mgr).problems.some(t => /MAP/.test(t)) && tee(mgr).problems.some(t => !/MAP/.test(t)));
  ok("…a worker only of the MAP — no costs or targets", wkr.status === 200 && tee(wkr).belowMap && tee(wkr).problems.length > 0 && tee(wkr).problems.every(t => /MAP/.test(t)) &&
    !JSON.stringify(wkr.body.belowTarget).match(/income|target|\/hr/i));
  await lib.setPricingSettings(d1, { cardPctBps: 290, cardFixedCents: 30, suppliesCents: 0 });
  r = await save({ S: 9, M: 9 });
  ok("the product can't be saved again until it's raised to the MAP", r.status === 400 && /below the MAP of \$10\.50/.test(r.body.message));
  r = await save({ S: 10.5, M: 9 });
  ok("…raised, it saves", r.status === 200);

  console.log("\n=== Color groups ===");
  d1._raw.run("UPDATE blank_sizes SET mapPriceCents=1200 WHERE blankId=? AND color='Gold' AND size='S'", [blankId]);
  await lib.createProduct(d1, "acme", { productId: "cfg", type: "shirt", name: "Color Tee", pricingMode: "sized", sizePricing: { S: 11 }, visible: true,
    configurable: true, garmentColors: ["White", "Gold"], colorGroupsCents: [{ key: "gold", label: "Gold", colors: ["Gold"], sizePricingCents: { S: 1300 } }] });
  await lib.setBlankLink(d1, "acme", "cfg", "White", "S", blankId, "White", "S");
  await lib.setBlankLink(d1, "acme", "cfg", "Gold", "S", blankId, "Gold", "S");
  a = (await lib.analyzePricing(d1, { orgId: "acme", productId: "cfg" })).products[0];
  ok("each color group is held to its own colors' MAP (Standard $11 vs $10.50 ok, Gold $13 vs $12 ok)", !a.belowMap && a.rows.find(x => x.group === "Gold").map === 12 && a.rows.find(x => x.group === "Standard").map === 10.5);
  const sug = await lib.suggestColorGroups(d1, "acme", "cfg");
  ok("suggested group prices never go below the group's MAP", sug.groups.every(g => Object.entries(g.sizePricing || {}).every(([z, v]) => z !== "S" || v >= 12)));

  console.log("\n=== The screens ===");
  w.renderProductForm(d.getElementById("app"), "acme", (await call({ action: "listProducts", org: "acme" })).body.products.find(p => p.productId === "tee"));
  await wait(() => d.querySelectorAll("#pricingTable .pricing-row").length === 2);
  const heads = [...d.querySelectorAll("#pricingTable th")].map(th => th.textContent);
  ok("the product's Pricing panel has a MAP column", heads.includes("MAP") && /\$10\.50/.test(d.getElementById("pricingTable").textContent));
  const sInput = [...d.querySelectorAll(".prodFormSize")].find(x => x.dataset.size === "S");
  sInput.value = "10"; sInput.dispatchEvent(new w.Event("input", { bubbles: true }));
  await wait(() => /below the MAP/.test(d.getElementById("pricingTable").textContent), 200);
  ok("typing a price under MAP shows it in red with the reason, before saving", /S \$10\.00 is below the MAP of \$10\.50/.test(d.getElementById("pricingTable").textContent) && d.querySelector("#pricingTable .pricing-flagged"));
  d1._raw.run("UPDATE products SET sizePricingCents=? WHERE productId='tee'", [JSON.stringify({ S: 900, M: 900 })]);
  await w.renderProductList(d.getElementById("app"), "acme");
  await wait(() => (d.querySelector('.prod-pricing[data-product="tee"]') || {}).textContent);
  ok("the Products list says ⚠ Below MAP", /⚠ Below MAP/.test(d.querySelector('.prod-pricing[data-product="tee"]').textContent));
  w.showBlankModal((await lib.getAllBlanks(d1)).find(b => b.id === blankId), () => {});
  await wait(() => d.querySelector('[data-sf="mapPrice"]'));
  const mapInputs = [...d.querySelectorAll('[data-sf="mapPrice"]')];
  ok("the blank form has a MAP column, filled in", mapInputs.length >= 3 && mapInputs.some(x => x.value === "10.50") && [...d.querySelectorAll("th")].some(th => /MAP/.test(th.textContent)));
  const goldMap = mapInputs.find(x => x.value === "12.00");
  goldMap.value = "12.75"; goldMap.dispatchEvent(new w.Event("input", { bubbles: true }));
  sent.length = 0;
  d.getElementById("blkSaveBtn").click();
  await wait(() => sent.some(b => b.action === "updateBlank"));
  const up = sent.find(b => b.action === "updateBlank");
  const sentSizes = up.colors.flatMap(c => c.sizes.map(z => ({ c: c.color, ...z })));
  ok("saving sends only the MAP that was changed", sentSizes.find(z => z.c === "Gold" && z.size === "S").mapPrice === 12.75 && !("mapPrice" in sentSizes.find(z => z.c === "White" && z.size === "M")));
  ok("the vendor review window shows the file's MAP under each color, changes marked", /const mapLine = \(c\) =>/.test(adminJs) && /\$\{priceLine\(c\)\}<\/div>\$\{mapLine\(c\)\}/.test(adminJs));
  ok("a products CSV import names what it left below MAP", /result\.belowMap = /.test(read("functions/api/orders.js")) && /priced below a blank's MAP/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test150 crashed: false"); process.exit(1); });
