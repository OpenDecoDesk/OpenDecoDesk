const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Printed transfers (migrations/0068): DTFs at fixed locations that are part of a product — configurable or
// not — and of its price. Each order line carries them as $0 transfer entries (`fixed: true`), so Run Transfer
// Sheets, transfer stock and COGS handle them; a product with embroidery too is on both run screens.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, priceItem, createProduct, updateProduct, getProductsByOrg, createTransfer, receiveTransferSheet, createGraphic,
  updateGraphic, deleteGraphic, deleteLocation, listLocations, getTransferQueue, makeTransferLine, refreshOrderLinesFromCatalog, analyzePricing,
  getCatalogIssues, copyProductsFromOrg };`)();
lib.getProduct = async (db, org, id) => (await lib.getProductsByOrg(db, org)).find(p => p.productId === id);
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1), ('other','other','Other','t','t',1);`);
  const locs = await lib.listLocations(d1);
  const BACK = locs.find(l => l.name === "Back").id, FRONT = locs.find(l => l.name === "Front").id;
  const sheet = await lib.createTransfer(d1, { name: "Crest DTF sheet" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: sheet, count: 20, pctOfSheet: 100 }], totalCents: 1000, receivedAt: "2026-10-01" });   // 50¢ each
  const crest = await lib.createGraphic(d1, "club", { name: "Club crest", kind: "transfer", transferId: sheet, inkColors: ["White", "Black"], tier: "large" });
  const loose = await lib.createGraphic(d1, "club", { name: "Loose print", kind: "transfer", transferId: null });
  const stitched = await lib.createGraphic(d1, "club", { name: "Stitched S&C", kind: "embroidery" });
  const otherShop = await lib.createGraphic(d1, "other", { name: "Club crest", kind: "transfer", transferId: sheet });

  console.log("=== Saving: what the product form may send ===");
  const create = (productId, extra) => call(Object.assign({ action: "createProduct", org: "club", productId, type: "shirt", name: productId, pricingMode: "flat",
    flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true }, extra));
  const refuse = async (what, fixedTransfers, re) => { const r = await create("bad", { fixedTransfers }); ok("refused: " + what, r.status === 400 && re.test(r.body.message)); };
  await refuse("an embroidery graphic", [{ locationId: BACK, graphicId: stitched }], /embroidery/);
  await refuse("another shop's graphic", [{ locationId: BACK, graphicId: otherShop }], /Pick a graphic/);
  await refuse("no location", [{ locationId: null, graphicId: crest }], /Pick a location/);
  await refuse("an ink the graphic doesn't have", [{ locationId: BACK, graphicId: crest, ink: "Gold" }], /isn't an ink/);
  await refuse("the same graphic twice at one location", [{ locationId: BACK, graphicId: crest }, { locationId: BACK, graphicId: crest }], /twice/);
  await refuse("more than 10", Array.from({ length: 11 }, () => ({ locationId: BACK, graphicId: crest })), /at most 10/);
  let r = await create("tee", { fixedTransfers: [{ locationId: BACK, graphicId: crest, ink: "Black", junk: 1 }] });
  ok("a plain product saves its printed transfer", r.status === 200);
  let tee = await lib.getProduct(d1, "club", "tee");
  ok("…stored cleaned: location, graphic, ink", JSON.stringify(tee.fixedTransfers) === JSON.stringify([{ locationId: BACK, graphicId: crest, ink: "Black" }]));
  r = await call({ action: "updateProduct", org: "club", ...tee, fixedTransfers: undefined, name: "Tee" });
  ok("an update that doesn't send them leaves them", r.status === 200 && (await lib.getProduct(d1, "club", "tee")).fixedTransfers.length === 1);

  console.log("\n=== Order lines carry them, at no charge ===");
  const plain = await lib.priceItem(d1, "club", "tee", "OSFA", 2, false, null);
  const entry = plain.config && plain.config.locations[0];
  ok("the price is the product's own ($20 — the large tier isn't added)", near(plain.unitPrice, 20));
  ok("a plain line gets a plain snapshot with the transfer", plain.config.plain === true && entry.kind === "transfer" && entry.fixed === true && entry.addOnCents === 0);
  ok("…at its location, with its graphic, ink and transfer", entry.label === "Back" && entry.graphicName === "Club crest" && entry.ink === "Black" && entry.transferId === sheet);

  // A configurable product: embroidery picked at the Front, the crest always printed on the back.
  await lib.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "flat", flatPrice: 30, visible: true, noDesignNeeded: true, noBlankNeeded: true,
    configurable: true, garmentColors: ["Navy"], reorderQr: "none", locations: [{ key: "front", label: "Front", locationId: FRONT, graphicIds: [crest] }],
    fixedTransfers: [{ locationId: BACK, graphicId: crest, ink: "" }] });
  const cfgLine = await lib.priceItem(d1, "club", "polo", "OSFA", 1, false, { garmentColor: "Navy", locations: {} });
  ok("a configurable product with a printed transfer can leave every option at None", near(cfgLine.unitPrice, 30) && cfgLine.config.locations.length === 1 && cfgLine.config.locations[0].fixed);
  ok("…the ink defaults to the graphic's first", cfgLine.config.locations[0].ink === "White");
  const both = await lib.priceItem(d1, "club", "polo", "OSFA", 1, false, { garmentColor: "Navy", locations: { front: { graphicId: crest, ink: "White" } } });
  ok("a picked option is charged; the printed one isn't", near(both.unitPrice, 34) && both.config.locations.length === 2 && both.config.locations.filter(l => l.fixed).length === 1);
  await lib.createProduct(d1, "club", { productId: "plainpolo", type: "shirt", name: "Plain polo", pricingMode: "flat", flatPrice: 30, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy"], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [crest] }] });
  let threw = false; try { await lib.priceItem(d1, "club", "plainpolo", "OSFA", 1, false, { garmentColor: "Navy", locations: {} }); } catch (e) { threw = /at least one graphic/.test(e.message); }
  ok("without one, all-None is still refused", threw);

  console.log("\n=== Run Transfer Sheets, stock and COGS ===");
  await lib.insertOrder(d1, { orderId: "O1", orgId: "club", customerName: "C", contact: "c@x.com", paymentMethod: "Card", placedAt: "2026-10-10T00:00:00Z" },
    [{ productId: "tee", name: "Tee", type: "shirt", size: "OSFA", qty: 2, unitPrice: 20, config: plain.config }]);
  d1._raw.run("UPDATE orders SET paid=1 WHERE orderId='O1'");
  const item = Number(d1._raw.exec("SELECT id FROM order_items WHERE orderId='O1'")[0].values[0][0]);
  let q = await lib.getTransferQueue(d1);
  let card = q.ready.concat(q.waiting).find(c => c.itemId === item);
  ok("the line is on Run Transfer Sheets with the crest on the back", !!card && card.transfers.length === 1 && card.transfers[0].location === "Back" && card.transfers[0].graphicName === "Club crest");
  ok("…ready: stock covers it and there's no blank to wait for", q.ready.some(c => c.itemId === item) && !card.hasEmbroidery);
  await lib.makeTransferLine(d1, "O1", item);
  const onHand = Number(d1._raw.exec(`SELECT quantity FROM transfers WHERE id=${sheet}`)[0].values[0][0]);
  const cogs = Number(d1._raw.exec(`SELECT cogsCents FROM order_items WHERE id=${item}`)[0].values[0][0]);
  ok("making it uses 2 transfers (20 → 18) and puts them in COGS (2 × 50¢)", onHand === 18 && cogs === 100);

  // Embroidered AND printed: the product's own design runs on Run Order, the DTF on Run Transfer Sheets.
  await lib.createProduct(d1, "club", { productId: "cap", type: "shirt", name: "Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: false, noBlankNeeded: true,
    fixedTransfers: [{ locationId: BACK, graphicId: crest }] });
  const capLine = await lib.priceItem(d1, "club", "cap", "OSFA", 1, false, null);
  await lib.insertOrder(d1, { orderId: "O2", orgId: "club", customerName: "D", contact: "d@x.com", paymentMethod: "Card", placedAt: "2026-10-11T00:00:00Z" },
    [{ productId: "cap", name: "Cap", type: "shirt", size: "OSFA", qty: 1, unitPrice: 25, config: capLine.config }]);
  d1._raw.run("UPDATE orders SET paid=1 WHERE orderId='O2'");
  q = await lib.getTransferQueue(d1);
  card = q.ready.concat(q.waiting).find(c => c.orderId === "O2");
  ok("an embroidered product with a printed transfer is on Run Transfer Sheets as 'also embroidered'", !!card && card.hasEmbroidery);

  console.log("\n=== Update from catalog ===");
  d1._raw.run("UPDATE orders SET manufacturedAt=NULL WHERE orderId='O2'");
  await lib.updateProduct(d1, "club", Object.assign(await lib.getProduct(d1, "club", "cap"), { fixedTransfers: [{ locationId: BACK, graphicId: crest, ink: "Black" }] }));
  let pv = await lib.refreshOrderLinesFromCatalog(d1, "O2", false);
  ok("a changed printed transfer is reported", pv.lines.length === 1 && pv.lines[0].changes.some(c => /Printed transfer at Back is now Club crest/.test(c)));
  await lib.updateProduct(d1, "club", Object.assign(await lib.getProduct(d1, "club", "cap"), { fixedTransfers: [] }));
  pv = await lib.refreshOrderLinesFromCatalog(d1, "O2", true);
  ok("a removed one is reported and dropped from the line", pv.lines[0].changes.some(c => /removed/.test(c)) &&
    !JSON.parse(d1._raw.exec("SELECT configJson FROM order_items WHERE orderId='O2'")[0].values[0][0] || "{}").locations);

  console.log("\n=== Pricing, catalog check, deletes, copying ===");
  const a = (await lib.analyzePricing(d1, { orgId: "club", productId: "tee" })).products[0];
  ok("the pricing analysis counts the printed transfer in the DTF cost (50¢)", near(a.rows[0].transfer, 0.5) && near(a.transferFixed, 0.5));
  const draft = (await lib.analyzePricing(d1, { orgId: "club", productId: "tee", draft: { fixedTransfers: [] } })).products[0];
  ok("…and follows the unsaved form", near(draft.rows[0].transfer, 0));
  await lib.updateProduct(d1, "club", Object.assign(await lib.getProduct(d1, "club", "tee"), { fixedTransfers: [{ locationId: BACK, graphicId: loose }] }));
  let issues = await lib.getCatalogIssues(d1, "club");
  const teeIssues = (issues.orgs.club.products || {}).tee || [];
  ok("a printed transfer with no transfer linked is flagged", teeIssues.some(i => i.code === "fixedTransferUnlinked"));
  await lib.updateProduct(d1, "club", Object.assign(await lib.getProduct(d1, "club", "tee"), { fixedTransfers: [{ locationId: BACK, graphicId: crest }] }));
  const onlyPrinted = await lib.createGraphic(d1, "club", { name: "Only printed", kind: "transfer", transferId: sheet });
  await lib.updateProduct(d1, "club", Object.assign(await lib.getProduct(d1, "club", "cap"), { fixedTransfers: [{ locationId: FRONT, graphicId: onlyPrinted }] }));
  let msg = ""; try { await lib.deleteGraphic(d1, onlyPrinted); } catch (e) { msg = e.message; }
  ok("a graphic in use as a printed transfer can't be deleted", /printed transfers/.test(msg));
  msg = ""; try { await lib.deleteLocation(d1, BACK); } catch (e) { msg = e.message; }
  ok("nor can its location", /printed transfers/.test(msg));
  const copied = await lib.copyProductsFromOrg(d1, "club", "other", [{ fromProductId: "tee", productId: "tee", name: "Tee", sub: "", type: "shirt", visible: false }], { copyImages: false });
  const copy = await lib.getProduct(d1, "other", "tee");
  ok("copying to another shop uses that shop's graphic of the same name", copy.fixedTransfers.length === 1 && copy.fixedTransfers[0].graphicId === otherShop &&
    copied[0].notes.some(n => /Printed transfer: graphic “Club crest” → this shop's/.test(n)));

  console.log("\n=== Screens ===");
  const adm = read("public/admin.js"), idx = read("public/index.html"), cat = read("functions/api/catalog.js"), mail = read("functions/_lib/email.js");
  ok("the product form has the Printed transfers box, outside the configurable-only fields", /id="cfgFixedWrap"/.test(adm) && adm.indexOf('id="cfgFixedWrap"') > adm.indexOf('<div id="cfgFields"') &&
    /function drawFixed\(\)/.test(adm) && /fixedTransfers: window\._productFixedGet\(\)/.test(adm));
  ok("the Pricing panel's draft includes them", /d\.fixedTransfers = window\._productFixedGet\(\)/.test(adm));
  ok("Edit items and the line summary leave them out (they aren't picks)", /!l\.auto && !l\.fixed && l\.location !== "reorderqr"\)\.map\(l => l\.custom/.test(adm) && /function cfgSummary_[\s\S]{0,200}!l\.fixed/.test(adm));
  ok("receipts leave them out", /!l\.auto && !l\.fixed/.test(mail));
  ok("the shop page lets every option be None when the product has them", /hasFixedTransfers = true/.test(cat) && /!p\.hasFixedTransfers/.test(idx) && /!product\.hasFixedTransfers/.test(idx));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
