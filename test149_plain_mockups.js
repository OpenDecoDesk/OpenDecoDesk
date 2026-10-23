const fs = require("fs");
const vm = require("vm");
const { createD1 } = require("./testlib/d1-shim.js");

// Mockups without a configurable product (2026-10): the product form's mockup table covers every location the
// product has — its printed transfers (migrations/0068) as well as a configurable product's options — and is shown
// whether or not the product is configurable. A product that isn't configurable has one column (garment color "",
// the blank it's linked to). The shop page shows a plain product's printed-transfer mockups first among its
// pictures, and a configurable product's in its live preview for the picked color.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, createTransfer, createGraphic, listLocations,
  setProductGraphicImage, getPublicCatalogData, priceItem, deleteGraphic, deleteLocation, getProductsByOrg };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const cat = new Function("const jsonResponse = () => null, classifyHost = () => null, getCatalogData = async () => null, getReadyToShipByOrg = async () => ({}), getBlankReadyByOrg = async () => ({});\n" +
  strip(read("functions/api/catalog.js")) + "\nreturn { toClientProduct };")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const locs = await lib.listLocations(d1);
  const BACK = locs.find(l => l.name === "Back").id, FRONT = locs.find(l => l.name === "Front").id;
  const sheet = await lib.createTransfer(d1, { name: "Crest DTF" });
  const crest = await lib.createGraphic(d1, "club", { name: "Club crest", kind: "transfer", transferId: sheet });
  const opt = await lib.createGraphic(d1, "club", { name: "Star badge", kind: "transfer", transferId: sheet });
  const R2 = "https://images.example.com/uploads/club/";

  // A plain (not configurable) product with a crest printed on the back, and a mockup of it.
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true,
    images: ["images/own.jpg"], fixedTransfers: [{ locationId: BACK, graphicId: crest, ink: "" }] });
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "tee", locationId: BACK, graphicId: crest, garmentColor: "", imageUrl: R2 + "tee-back.png" });
  // A stale mockup — a printed transfer that was removed — isn't shown.
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "tee", locationId: FRONT, graphicId: crest, garmentColor: "", imageUrl: R2 + "old.png" });
  // A configurable product: options at the front, the crest always on the back, mockups per color.
  await lib.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "flat", flatPrice: 30, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Red"], reorderQr: "none", locations: [{ key: "loc" + FRONT, label: "Front", locationId: FRONT, graphicIds: [opt] }],
    fixedTransfers: [{ locationId: BACK, graphicId: crest }] });
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "polo", locationId: BACK, graphicId: crest, garmentColor: "Navy", imageUrl: R2 + "polo-navy-back.png" });
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "polo", locationId: FRONT, graphicId: opt, garmentColor: "Navy", imageUrl: R2 + "polo-navy-front.png" });

  const pub = await lib.getPublicCatalogData(d1);
  const tee = pub.orgs.club.products.find(p => p.productId === "tee"), polo = pub.orgs.club.products.find(p => p.productId === "polo");
  ok("a plain product's mockups reach the catalog", tee.graphicImages && tee.graphicImages[`${BACK}|${crest}|`] === R2 + "tee-back.png");
  ok("…with which keys are its printed transfers, and the location's name", JSON.stringify(tee.fixedMockups) === JSON.stringify([{ locationId: BACK, graphicId: crest, label: "Back" }]));
  ok("a configurable product still gets its mockups, plus its printed transfers'", polo.graphicImages[`${FRONT}|${opt}|Navy`] && polo.fixedMockups.length === 1);
  const cTee = cat.toClientProduct(tee), cPolo = cat.toClientProduct(polo);
  ok("/api/catalog passes them to the shop page", cTee.graphicImages[`${BACK}|${crest}|`] === R2 + "tee-back.png" && cTee.fixedMockups[0].label === "Back" && cPolo.fixedMockups[0].graphicId === crest);

  // The shop page's picture list (productImages_ from index.html).
  const html = read("public/index.html");
  const fnSrc = html.slice(html.indexOf("function productImages_("), html.indexOf("function imageRowHtml_("));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
  const imgs = ctx.productImages_(cTee, "");
  ok("a plain product shows its printed-transfer mockup first, then its own pictures", imgs[0] === R2 + "tee-back.png" && imgs[1] === "images/own.jpg");
  ok("…and not a mockup of a printed transfer it no longer has", !imgs.includes(R2 + "old.png"));
  ok("a configurable product's picture list is unchanged (its mockups are in the live preview)", !ctx.productImages_(cPolo, "Navy").some(u => /polo-navy/.test(u)));
  ok("the live preview adds the printed transfers' mockup for the picked color", /\(p\.fixedMockups \|\| \[\]\)\.map\(f => \{ const m = mockups\[f\.locationId \+ "\|" \+ f\.graphicId \+ "\|" \+ color\]/.test(html));

  // The product form (admin.js).
  const adm = read("public/admin.js");
  const tpl = adm.slice(adm.indexOf('<div id="cfgFields"'), adm.indexOf('<div id="cfgQrWrap"'));
  ok("the mockup table sits outside the configurable-only fields, after Printed transfers",
    !tpl.slice(0, tpl.indexOf('id="cfgFixedWrap"')).includes('id="cfgMockups"') && tpl.indexOf('id="cfgMockups"') > tpl.indexOf('id="cfgFixedWrap"'));
  ok("its sections are every location: the options (while configurable) and the printed transfers", /const mockupSections_ = \(\) =>/.test(adm) && /if \(isOn\(\)\) for \(const loc of locations/.test(adm) && /for \(const f of fixedList\.filter\(f => f\.locationId && f\.graphicId\)\)/.test(adm));
  ok("a product that isn't configurable gets one column (color \"\", named after its blank)", /return \[\{ color: "", label: bc\.length \? bc\.join\(" \/ "\) : "Product" \}\]/.test(adm));
  ok("a printed transfer's cell has no Don't offer switch", /onBlock: fixed \|\| !color \? null :/.test(adm) && /if \(!fixed && \(isBlocked\(g, c\) \|\| notAllowed\(g, c\)\)\)/.test(adm));
  ok("the table redraws when printed transfers or Configurable change", /const touched = \(\) => \{ host\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\); drawMockups\(\); \}/.test(adm) &&
    /changed\(\); drawMockups\(\); \};/.test(adm));

  console.log("\n=== Embroidered graphics for mockups (migrations/0069) ===");
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const LEFT = locs.find(l => l.name === "Left Chest").id;
  const sc = await lib.createGraphic(d1, "club", { name: "S&C stitched", kind: "embroidery", imageUrl: R2 + "sc.png" });
  const make = (mockupGraphics) => call({ action: "createProduct", org: "club", productId: "cap", type: "shirt", name: "Cap", pricingMode: "flat", flatPrice: 25,
    visible: true, noDesignNeeded: true, mockupGraphics });
  let r = await make([{ locationId: LEFT, graphicId: crest }]);
  ok("refused: a transfer graphic (that's what Printed transfers are for)", r.status === 400 && /Printed transfers/.test(r.body.message));
  r = await make([{ locationId: null, graphicId: sc }]);
  ok("refused: no location", r.status === 400 && /Pick a location/.test(r.body.message));
  r = await make([{ locationId: LEFT, graphicId: sc }, { locationId: LEFT, graphicId: sc }]);
  ok("refused: the same graphic twice at a location", r.status === 400 && /twice/.test(r.body.message));
  r = await make([{ locationId: LEFT, graphicId: sc, junk: 1 }]);
  const capRow = (await lib.getProductsByOrg(d1, "club")).find(p => p.productId === "cap");
  ok("a plain product saves an embroidered graphic at a location, cleaned", r.status === 200 && JSON.stringify(capRow.mockupGraphics) === JSON.stringify([{ locationId: LEFT, graphicId: sc }]));
  const line = await lib.priceItem(d1, "club", "cap", "OSFA", 1, false, null);
  ok("it's pictures only: the order line carries nothing for it, and the price is the product's", !line.config && Math.abs(line.unitPrice - 25) < 0.005);
  await lib.setProductGraphicImage(d1, { orgId: "club", productId: "cap", locationId: LEFT, graphicId: sc, garmentColor: "", imageUrl: R2 + "cap-left.png" });
  const pub2 = await lib.getPublicCatalogData(d1);
  const cCap = cat.toClientProduct(pub2.orgs.club.products.find(p => p.productId === "cap"));
  ok("its mockup reaches the shop page, labelled with the location", cCap.fixedMockups && cCap.fixedMockups[0].graphicId === sc && cCap.fixedMockups[0].label === "Left Chest");
  ok("…and is shown first among the product's pictures", ctx.productImages_(cCap, "")[0] === R2 + "cap-left.png");
  let msg = ""; try { await lib.deleteGraphic(d1, sc); } catch (e) { msg = e.message; }
  ok("the graphic can't be deleted while a product uses it", /embroidered graphics \(for mockups\)/.test(msg));
  msg = ""; try { await lib.deleteLocation(d1, LEFT); } catch (e) { msg = e.message; }
  ok("nor can the location", /embroidered graphics \(for mockups\)/.test(msg));
  ok("the form has the box, saves it with the product, and puts its rows in the mockup table",
    /id="cfgEmbWrap"/.test(adm) && /function drawEmb\(\)/.test(adm) && /mockupGraphics: window\._productMockupGraphicsGet\(\)/.test(adm) &&
    /for \(const f of embList\.filter\(f => f\.locationId && f\.graphicId\)\)/.test(adm) && /tag: "embroidered"/.test(adm));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
