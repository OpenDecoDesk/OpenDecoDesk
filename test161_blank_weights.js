const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Weight on blanks (migrations/0077): blank_sizes.weightOz per color + size, typed on the blank form or read from a
// vendor's product file (S&S unitWeight / SanMar PIECE_WEIGHT, both pounds) or PromoStandards Product Data (a part's
// Dimension weight + weightUom). A product's shipping weight is its own weightOz (an optional override), else its
// linked blank size's — so the catalog check no longer wants a weight on every product. Kept unless sent; a vendor
// update only fills sizes with no weight. Real db.js / orders.js on sql.js; the vendor parser in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { getAllBlanks, getProductsByOrg, productShipWeightOz, getCatalogIssues, planVendorBlanks, applyVendorBlanks, cleanVendorProduct_ };`)();
const psSrc = strip(read("functions/_lib/promostandards.js"));
const ps = new Function(psSrc + `\nreturn { psWeightOz_, fetchVendorProduct };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
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
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Acme','t','t',0,1);`);
  const ENV = { DB: d1, SIGNING_SECRET: "a-signing-secret-for-tests-0123456789abcdef" };
  const call = async (body) => { const res = await api({ env: ENV, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };

  console.log("=== On the blank ===");
  let r = await call({ action: "createBlank", name: "Sample Tee", brand: "Sample Co", sku: "ST100", vendor: "Supplier", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "S", quantity: 0, vendorPrice: 4, weightOz: 4.6 }, { size: "2XL", quantity: 0, vendorPrice: 6, weightOz: 6.2 }] },
             { color: "White", images: [], sizes: [{ size: "S", quantity: 0, vendorPrice: 4 }, { size: "2XL", quantity: 0, vendorPrice: 6 }] }] });
  const teeId = r.body.id;
  let tee = (await lib.getAllBlanks(d1)).find(b => b.id === teeId);
  const wOf = (b, c, z) => (b.sizes.find(s => s.color === c && s.size === z) || {}).weightOz;
  ok("a weight typed per color + size is saved; one left blank is null (not known)", wOf(tee, "Navy", "S") === 4.6 && wOf(tee, "Navy", "2XL") === 6.2 && wOf(tee, "White", "S") === null);
  r = await call({ action: "updateBlank", id: teeId, name: "Sample Tee", brand: "Sample Co", sku: "ST100", vendor: "Supplier", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "S", quantity: 0 }, { size: "2XL", quantity: 0, weightOz: "" }] }, { color: "White", images: [], sizes: [{ size: "S", quantity: 0, weightOz: 4.5 }, { size: "2XL", quantity: 0 }] }] });
  tee = (await lib.getAllBlanks(d1)).find(b => b.id === teeId);
  ok("an edit keeps a weight it doesn't send, clears one sent empty and sets a new one", r.status === 200 && wOf(tee, "Navy", "S") === 4.6 && wOf(tee, "Navy", "2XL") === null && wOf(tee, "White", "S") === 4.5);
  await call({ action: "updateBlank", id: teeId, name: "Sample Tee", brand: "Sample Co", sku: "ST100", vendor: "Supplier", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "S", quantity: 0 }, { size: "2XL", quantity: 0, weightOz: 6.2 }] }, { color: "White", images: [], sizes: [{ size: "S", quantity: 0 }, { size: "2XL", quantity: 0, weightOz: "heavy" }] }] });
  ok("a weight that isn't a number is saved as not known", wOf((await lib.getAllBlanks(d1)).find(b => b.id === teeId), "White", "2XL") === null);

  console.log("\n=== The product's weight comes from its blank ===");
  const S = { S: 15, "2XL": 18 };
  r = await call({ action: "buildProductFromBlank", org: "acme", blankId: teeId, colors: ["Navy", "White"], sizes: ["S", "2XL"], name: "Acme Tee", decoration: "dtf", pricingMode: "sized", sizePricing: S });
  const pid = r.body.productId;
  let prod = (await lib.getProductsByOrg(d1, "acme")).find(p => p.productId === pid);
  ok("no weight on the product: each size takes its heaviest linked color's weight, the product the heaviest size's", prod.weightOz == null &&
    lib.productShipWeightOz(prod, "S") === 4.6 && lib.productShipWeightOz(prod, "2XL") === 6.2 && prod.shipWeightOz === 6.2 && prod.blankWeightOz === 6.2);
  let issues = (await lib.getCatalogIssues(d1)).orgs.acme;
  ok("…so the catalog check doesn't ask for a weight", !((issues && issues.products && issues.products[pid]) || []).some(x => x.code === "noWeight"));
  r = await call({ action: "buildProductFromBlank", org: "acme", productId: pid, blankId: teeId, colors: ["Navy", "White"], sizes: ["S", "2XL"], name: "Acme Tee", decoration: "dtf", pricingMode: "sized", sizePricing: S, weightOz: 5 });
  prod = (await lib.getProductsByOrg(d1, "acme")).find(p => p.productId === pid);
  ok("a weight on the product overrides the blank's for every size", lib.productShipWeightOz(prod, "S") === 5 && lib.productShipWeightOz(prod, "2XL") === 5 && prod.shipWeightOz === 5);
  r = await call({ action: "createBlank", name: "Plain Cap", brand: "Sample Co", sku: "PC1", vendor: "Supplier", productType: "cap",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "OSFA", quantity: 0, vendorPrice: 3 }] }] });
  r = await call({ action: "buildProductFromBlank", org: "acme", blankId: r.body.id, colors: ["Navy"], sizes: ["OSFA"], name: "Acme Cap", decoration: "dtf", pricingMode: "flat", flatPrice: 12 });
  issues = (await lib.getCatalogIssues(d1)).orgs.acme;
  const capIssue = ((issues.products || {})[r.body.productId] || []).find(x => x.code === "noWeight");
  ok("a product whose blank has no weight still gets the check — pointing to the blank first", capIssue && /on its blank/.test(capIssue.text) && lib.productShipWeightOz((await lib.getProductsByOrg(d1, "acme")).find(p => p.productId === r.body.productId)) === null);
  r = await call({ action: "listProducts", org: "acme" });
  ok("the product list carries the blank weights (the product form shows them under its optional weight)", r.body.products.find(p => p.productId === pid).blankWeightOz === 6.2);

  console.log("\n=== From vendor files ===");
  const adminJs = read("public/admin.js");
  class Ld extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new Ld(), url: ADMIN_ORIGIN + "/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "admin" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  const sm = w.parseVendorProductFile_(read("testlib/fixtures/vendor-sdl-sample.csv"), "SanMar").products.find(p => p.style === "SC100");
  ok("SanMar's SDL file: PIECE_WEIGHT (pounds) is read as ounces per color + size (0.14 lb = 2.24 oz)", sm && sm.weights && sm.weights.Navy.OSFA === 2.24);
  const ss = w.parseVendorProductFile_(["sku,styleName,title,brandName,colorName,sizeName,customerPrice,unitWeight",
    "B1,ST100,Sample Tee,Sample Co,Navy,S,3.61,0.3", "B2,ST100,Sample Tee,Sample Co,Navy,M,3.61,0.33"].join("\n"), "Supplier").products[0];
  ok("S&S's unitWeight (pounds) likewise", ss.weights.Navy.S === 4.8 && ss.weights.Navy.M === 5.28);
  const noW = w.parseVendorProductFile_("style,color,supplier,cost_S\nST9,Black,Supplier,15", "Supplier").products[0];
  ok("a file with no weight column carries none", noW.weights === undefined && lib.cleanVendorProduct_(noW).weights === undefined);

  const vp = { vendor: "Supplier", style: "ST100", brand: "Sample Co", name: "Sample Tee", colors: [{ color: "Navy", images: [] }, { color: "White", images: [] }, { color: "Red", images: [] }],
    sizes: ["S", "2XL"], prices: { "*": { S: 4, "2XL": 6 } }, weights: { "*": { S: 4.9, "2XL": 6.9 } } };
  const plan = await lib.planVendorBlanks(d1, [vp]);
  ok("the vendor plan shows each size's weight from the file and what the blank has", plan[0].colors[0].prices.some(z => z.size === "S" && z.weightOz === 4.9 && z.weightCurrent === 4.6));
  await lib.applyVendorBlanks(d1, [vp], [{ key: plan[0].key, colors: ["Navy", "White", "Red"], prices: true }], {});
  tee = (await lib.getAllBlanks(d1)).find(b => b.id === teeId);
  ok("updating a blank from the file fills only the sizes with no weight — typed weights stay", wOf(tee, "Navy", "S") === 4.6 && wOf(tee, "White", "S") === 4.5 && wOf(tee, "White", "2XL") === 6.9 && wOf(tee, "Red", "S") === 4.9 && wOf(tee, "Red", "2XL") === 6.9);
  const vp2 = { vendor: "Supplier", style: "NEW1", brand: "Sample Co", name: "New Tee", colors: [{ color: "Black", images: [] }], sizes: ["M"], prices: { "*": { M: 5 } }, weights: { "*": { M: 5.1 } } };
  const plan2 = await lib.planVendorBlanks(d1, [vp2]);
  await lib.applyVendorBlanks(d1, [vp2], [{ key: plan2[0].key, colors: ["Black"], create: {} }], {});
  const made = (await lib.getAllBlanks(d1)).find(b => b.sku === "NEW1");
  ok("a new blank from the file gets its weights", made && wOf(made, "Black", "M") === 5.1);

  console.log("\n=== From PromoStandards ===");
  ok("a part's Dimension weight in LB / OZ / KG / G becomes ounces; none or junk is null", ps.psWeightOz_("0.45", "LB") === 7.2 && ps.psWeightOz_("8", "OZ") === 8 &&
    ps.psWeightOz_("0.2", "KG") === 7.05 && ps.psWeightOz_("100", "G") === 3.53 && ps.psWeightOz_("", "LB") === null && ps.psWeightOz_("1", "stone") === null && ps.psWeightOz_("0.5", "") === 8);
  const env = (b) => `<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>${b}</S:Body></S:Envelope>`;
  const P = 'xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"';
  const part = (id, size, wt) => `<ns2:ProductPart><ns2:partId>${id}</ns2:partId><ns2:ColorArray><ns2:Color><ns2:colorName>Navy</ns2:colorName></ns2:Color></ns2:ColorArray><ns2:ApparelSize><ns2:labelSize>${size}</ns2:labelSize></ns2:ApparelSize>${wt ? `<ns2:Dimension><ns2:dimensionUom>IN</ns2:dimensionUom><ns2:weightUom>LB</ns2:weightUom><ns2:weight>${wt}</ns2:weight></ns2:Dimension>` : ""}</ns2:ProductPart>`;
  const PRODUCT = env(`<GetProductResponse ${P}><Product><ns2:productId>ST100</ns2:productId><ns2:productName>Sample Tee</ns2:productName><ns2:productBrand>Sample Co</ns2:productBrand><ns2:ProductPartArray>${part("ST-N-S", "S", "0.3")}${part("ST-N-XL", "XL", "")}</ns2:ProductPartArray></Product></GetProductResponse>`);
  const C = 'xmlns:ns2="http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/"';
  const PRICES = env(`<GetConfigurationAndPricingResponse ${C}><Configuration><PartArray><Part><ns2:partId>ST-N-S</ns2:partId><PartPriceArray><PartPrice><minQuantity>1</minQuantity><price>4</price></PartPrice></PartPriceArray></Part></PartArray></Configuration></GetConfigurationAndPricingResponse>`);
  const fetchImpl = async (url, init) => new Response(/GetProductRequest/.test(init.body) ? PRODUCT : PRICES, { status: 200 });
  const pv = await ps.fetchVendorProduct({ name: "Supplier", endpoints: { product: "https://x.test/pd", ppc: "https://x.test/ppc" }, credentials: { id: "u", password: "p" }, overrides: { fobId: "1" } }, "ST100", { media: false }, fetchImpl);
  ok("a connected vendor's product carries its parts' weights in ounces (a part with none is left out)", pv.weights && pv.weights.Navy.S === 4.8 && pv.weights.Navy.XL === undefined &&
    lib.cleanVendorProduct_(pv).weights.navy.S === 4.8);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test150 crashed: false"); process.exit(1); });
