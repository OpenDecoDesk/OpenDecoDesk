const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// CSV import for blanks (one row per vendor style, a cost column per size) and for a shop's products
// (one row per listing, linked to its blank by style): preview = real run, re-import updates instead of
// duplicating, stock and average cost are never touched, and bad rows are reported, not written.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { importBlanksCsv, importProductsCsv, importTypeFromCategory, getAllBlanks, getProductsByOrg, getBlankLinks,
  receiveBlanks, listLocations, listNeedleTypes, createGraphic, createTransfer, priceItem, getPublicCatalogData };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// Rows as the browser sends them: {header: value}, straight from the two real files' layout.
const BLANK_HEAD = "style,brand,name,supplier,category,size_range,cost_XS,cost_S,cost_M,cost_L,cost_XL,cost_2XL,cost_3XL,cost_4XL,cost_5XL,cost_6XL,sale_cost_base,book_price,floor_price,needle,backing,notes".split(",");
const blankRow = (...v) => Object.fromEntries(BLANK_HEAD.map((h, i) => [h, v[i] == null ? "" : String(v[i])]));
const B_ST650 = blankRow("ST650", "Sport-Tek", "Sport-Tek Micropique Sport-Wick Polo", "SanMar", "Shirts", "XS-6XL", 11.50, 11.50, 11.50, 11.50, 11.50, 12.50, 14.50, 15.50, 17.50, 18.50, "", 23.00, 20.70, "Ballpoint", "Cutaway", "");
const B_64800 = blankRow("64800", "Gildan", "Gildan Softstyle Pique Polo", "SanMar", "Shirts", "S-4XL", "", 6.00, 6.00, 6.00, 6.00, 7.50, 8.00, 8.00, "", "", "", "", "", "Ballpoint (BPPD)", "Cutaway", "");
const B_S700 = blankRow("S700", "Champion", "Champion Powerblend Pullover Hoodie", "SanMar", "Hoodies & Layers", "S-3XL", "", 15.00, 15.00, 15.00, 15.00, 18.00, 18.00, "", "", "", 14.75, 30.00, 27.00, "Titanium", "Cutaway + WSS topping", "Fallback");
const P_HEAD = "sku,category,name,brand,blank_style,price,description,features,default_colors,all_colors,graphics_locations,personalization_price,sizes,size_upcharges,margin_base,active".split(",");
const prodRow = (...v) => Object.fromEntries(P_HEAD.map((h, i) => [h, v[i] == null ? "" : String(v[i])]));
const P_ST650 = prodRow("LEAGUE-ST650", "Shirts", "Sport-Tek Micropique Sport-Wick Polo", "Sport-Tek", "ST650", "27.00", "A smooth micropique polo.", "3.8 oz polyester|Snag-resistant|Tag-free",
  "True Navy|Black|White", "Black|Blue Lake|True Navy|True Royal|White", "Front: left chest", "2.00", "XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL", "2XL:1.00|3XL:3.00|4XL:4.00|5XL:6.00|6XL:7.00", "11.00", "TRUE");
const P_S700 = prodRow("LEAGUE-S700", "Hoodies & Layers", "Champion Powerblend Pullover Hoodie", "Champion", "S700", "35.00", "A classic fleece hoodie.", "9 oz fleece|Pouch pocket",
  "Navy|Black", "Black|Navy|Scarlet", "Front: left chest|Hood: centred", "2.00", "S|M|L|XL|2XL|3XL", "2XL:4.00|3XL:4.00", "15.00", "FALSE");

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1), ('other','other','Other','t','t',1);`);
  const count = async (sql) => Number((await d1.prepare(sql).first()).n);

  console.log("=== Category → type ===");
  ok("Shirts → shirt, Hoodies & Layers → sweatshirt, Sweatshirts → sweatshirt, Headwear/Caps → cap, unknown → ''",
    lib.importTypeFromCategory("Shirts") === "shirt" && lib.importTypeFromCategory("Hoodies & Layers") === "sweatshirt" &&
    lib.importTypeFromCategory("Sweatshirts") === "sweatshirt" && lib.importTypeFromCategory("Headwear") === "cap" && lib.importTypeFromCategory("Caps") === "cap" && lib.importTypeFromCategory("Mugs") === "");

  console.log("\n=== Blanks: preview writes nothing ===");
  let pv = await lib.importBlanksCsv(d1, [B_ST650, B_64800, B_S700], { dryRun: true });
  ok("preview says 3 new blanks", pv.created === 3 && pv.updated === 0 && pv.results.every(x => x.action === "create"));
  ok("…and nothing was written (no blanks, no needle types added)", (await count("SELECT count(*) n FROM blanks")) === 0 && (await lib.listNeedleTypes(d1)).length === 2);
  ok("sizes come from the filled cost columns only (64800 has no XS, 5XL, 6XL)", pv.results[1].sizes.join(",") === "S,M,L,XL,2XL,3XL,4XL" && pv.results[0].sizes.length === 10);
  ok("an unknown needle is announced as a new needle type", pv.newNeedleTypes.join() === "Titanium" && /Adds the needle type "Titanium"/.test(pv.results[2].notes.join()));

  console.log("\n=== Blanks: the real import ===");
  let r = await lib.importBlanksCsv(d1, [B_ST650, B_64800, B_S700], {});
  let blanks = await lib.getAllBlanks(d1);
  const blank = (sku) => blanks.find(b => b.sku === sku);
  ok("3 blanks created, styled by SKU, vendor from supplier", r.created === 3 && blanks.length === 3 && blank("ST650").vendor === "SanMar" && blank("ST650").brand === "Sport-Tek");
  ok("types from the category", blank("ST650").productType === "shirt" && blank("S700").productType === "sweatshirt");
  ok("per-size costs, zero stock", blank("ST650").sizes.length === 10 && blank("ST650").sizes.find(s => s.size === "6XL").purchasePrice === 18.50 &&
    blank("64800").sizes.find(s => s.size === "2XL").purchasePrice === 7.50 && blanks.every(b => b.sizes.every(s => s.quantity === 0)));
  ok("no stock movements were written (nothing moved)", (await count("SELECT count(*) n FROM inventory_movements")) === 0);
  ok("needle matched by name ('Ballpoint (BPPD)' → Ballpoint) and a new one created once", blank("64800").needleType === "Ballpoint" && blank("ST650").needleType === "Ballpoint" &&
    blank("S700").needleType === "Titanium" && (await lib.listNeedleTypes(d1)).length === 3);
  ok("backing and reference prices are kept in the notes", blank("S700").notes === "Backing: Cutaway + WSS topping · Book $30.00 · Floor $27.00 · Sale cost $14.75 · Fallback" && blank("64800").notes === "Backing: Cutaway");

  console.log("\n=== Blanks: importing again updates, never duplicates, never touches stock ===");
  // Receive stock on one size, hand-edit one blank's notes, then re-import with new costs.
  await lib.receiveBlanks(d1, { blankId: blank("ST650").id, vendor: "SanMar", lines: [{ size: "M", qty: 10, unitCost: 11 }] });
  await d1.prepare("UPDATE blanks SET notes='Customer favourite' WHERE sku='64800'").run();
  const B_ST650b = { ...B_ST650, cost_M: "13.00", cost_L: "13.00", name: "Sport-Tek Micropique Polo (renamed)" };
  const B_64800b = { ...B_64800, cost_5XL: "9.99" };
  pv = await lib.importBlanksCsv(d1, [B_ST650b, B_64800b], { dryRun: true });
  ok("preview says 2 updates and warns the in-stock size keeps its average cost", pv.updated === 2 && pv.created === 0 &&
    /has stock — the average cost is kept/.test(pv.results[0].notes.join()) && /Updates the cost on 1 size row/.test(pv.results[0].notes.join()));
  r = await lib.importBlanksCsv(d1, [B_ST650b, B_64800b], {});
  blanks = await lib.getAllBlanks(d1);
  ok("still 3 blanks", blanks.length === 3 && r.updated === 2);
  ok("renamed from the file", blank("ST650").name === "Sport-Tek Micropique Polo (renamed)");
  ok("the size with stock keeps its quantity and average cost", blank("ST650").sizes.find(s => s.size === "M").quantity === 10 && blank("ST650").sizes.find(s => s.size === "M").purchasePrice === 11);
  ok("a size with no stock takes the new cost", blank("ST650").sizes.find(s => s.size === "L").purchasePrice === 13);
  ok("a size new to the file is added", blank("64800").sizes.find(s => s.size === "5XL").purchasePrice === 9.99);
  ok("hand-typed notes are left alone (and the preview said so)", blank("64800").notes === "Customer favourite" && /typed by hand/.test(pv.results[1].notes.join()));

  console.log("\n=== Blanks: bad rows are reported and skipped ===");
  r = await lib.importBlanksCsv(d1, [{ style: "", name: "No style" }, { style: "X1", name: "No costs" }, { style: "X2", cost_m: "abc" }, { style: "X3", cost_M: "5" }, { style: "x3", cost_M: "5" }], {});
  ok("missing style / no costs / non-numeric cost / duplicate style are problems", r.skipped === 4 && r.created === 1 &&
    /No style/.test(r.results[0].problems[0]) && /No size costs/.test(r.results[1].problems[0]) && /isn't a number/.test(r.results[2].problems[0]) && /more than once/.test(r.results[4].problems[0]));
  ok("only the good row was written, and row numbers match the spreadsheet (header = row 1)", (await count("SELECT count(*) n FROM blanks")) === 4 && r.results[0].row === 2 && r.results[3].row === 5);

  console.log("\n=== Products: preview writes nothing ===");
  const gt = await lib.createTransfer(d1, { name: "Crest sheet" });
  const gCrest = await lib.createGraphic(d1, "league", { name: "Crest", kind: "transfer", transferId: gt, tier: null });
  const gOther = await lib.createGraphic(d1, "other", { name: "Theirs", kind: "transfer", transferId: gt, tier: null });
  pv = await lib.importProductsCsv(d1, "league", [P_ST650, P_S700], { dryRun: true, graphicIds: [gCrest] });
  ok("preview: 2 new products with their price ranges", pv.created === 2 && pv.results[0].price === "$27.00–$34.00" && pv.results[1].price === "$35.00–$39.00");
  ok("preview: blank found, links counted, colors to add reported", pv.results[0].blank.found && pv.results[0].blank.links === 30 && /Adds 5 colors to the blank/.test(pv.results[0].notes.join()));
  ok("preview: a location that doesn't exist yet is announced", pv.newLocations.join() === "Hood" && /Adds the location "Hood"/.test(pv.results[1].notes.join()));
  ok("…and nothing was written", (await count("SELECT count(*) n FROM products")) === 0 && (await count("SELECT count(*) n FROM product_blank_links")) === 0 &&
    blank("ST650").colors.length === 1);

  console.log("\n=== Products: the real import ===");
  const locsBefore = (await lib.listLocations(d1)).map(l => l.name);
  r = await lib.importProductsCsv(d1, "league", [P_ST650, P_S700], { graphicIds: [gCrest] });
  let prods = await lib.getProductsByOrg(d1, "league", false);
  const prod = (id) => prods.find(p => p.productId === id);
  ok("2 products created, ids are the SKUs lower-cased", r.created === 2 && !!prod("league-st650") && !!prod("league-s700"));
  const st = prod("league-st650"), ho = prod("league-s700");
  ok("type, description and features", st.type === "shirt" && ho.type === "sweatshirt" && st.sub === "A smooth micropique polo." && st.features.join("|") === "3.8 oz polyester|Snag-resistant|Tag-free");
  ok("size prices = price + upcharge", st.pricingMode === "sized" && st.sizePricing.M === 27 && st.sizePricing["2XL"] === 28 && st.sizePricing["3XL"] === 30 && st.sizePricing["6XL"] === 34 &&
    ho.sizePricing.XL === 35 && ho.sizePricing["3XL"] === 39 && Object.keys(ho.sizePricing).length === 6);
  ok("personalization price and the active flag", st.personalizationPrice === 2 && st.visible === true && ho.visible === false);
  ok("configurable with the default colors as garment colors", st.configurable && st.garmentColors.join("|") === "True Navy|Black|White" && ho.garmentColors.join("|") === "Navy|Black");
  const locs = await lib.listLocations(d1);
  const front = locs.find(l => l.name === "Front"), back = locs.find(l => l.name === "Hood");
  ok("locations resolved to the lookup (created when missing), keyed like the product form does", !!front && !!back &&
    st.locations.length === 1 && st.locations[0].key === "loc" + front.id && st.locations[0].locationId === front.id && st.locations[0].label === "Front" &&
    ho.locations.map(l => l.label).join("|") === "Front|Hood" && back.notes === "centred");
  ok("the chosen graphic is offered at each new location", st.locations[0].graphicIds.join() === String(gCrest) && ho.locations.every(l => l.graphicIds.join() === String(gCrest)));
  ok("a location isn't created twice across rows", locs.filter(l => l.name === "Front").length === 1 && locs.length === new Set(locsBefore.concat(["Front", "Hood"])).size);

  blanks = await lib.getAllBlanks(d1);
  ok("the blank got every color in all_colors (plus any default color), each with the blank's sizes and costs",
    blank("ST650").colors.map(c => c.color).filter(Boolean).sort().join("|") === "Black|Blue Lake|True Navy|True Royal|White" &&
    blank("ST650").colors.find(c => c.color === "Blue Lake").sizes.length === 10 && blank("ST650").colors.find(c => c.color === "Blue Lake").sizes.find(s => s.size === "6XL").purchasePrice === 18.50);
  ok("a blank whose unnamed placeholder holds stock keeps it (ST650 had 10 M received)", blank("ST650").sizes.some(s => s.color === "" && s.size === "M" && s.quantity === 10));
  ok("a blank whose placeholder was empty and unused loses it", blank("S700").colors.map(c => c.color).sort().join("|") === "Black|Navy|Scarlet" && !blank("S700").sizes.some(s => s.color === ""));
  let links = await lib.getBlankLinks(d1, "league");
  ok("every garment color × size is linked to the same color and size on the blank", links.filter(l => l.productId === "league-st650").length === 30 &&
    links.filter(l => l.productId === "league-s700").length === 12 &&
    links.every(l => l.productColor === l.blankColor && l.productSize === l.blankSize) &&
    links.filter(l => l.productId === "league-st650").every(l => l.blankId === blank("ST650").id));

  console.log("\n=== Products: the storefront and pricing see them ===");
  const priced = await lib.priceItem(d1, "league", "league-st650", "3XL", 1, true, { garmentColor: "Black", locations: { ["loc" + front.id]: { graphicId: gCrest } } });
  ok("an imported product prices like a hand-made one ($30 for 3XL + $2 personalization)", priced.unitPrice === 30 && priced.personalizationFee === 2);

  console.log("\n=== Products: importing again updates in place and keeps what the file doesn't carry ===");
  await d1.prepare(`UPDATE products SET imagesJson='["images/x.jpg"]', weightOz=7.5, personalizationOptions='["COACH"]', sortOrder=42 WHERE orgId='league' AND productId='league-st650'`).run();
  // The admin changed the location's graphics by hand; a re-import must not reset them.
  await d1.prepare(`UPDATE products SET locationsJson=? WHERE orgId='league' AND productId='league-st650'`).bind(JSON.stringify([{ key: "loc" + front.id, label: "Front", locationId: front.id, graphicIds: [] }, { key: "legacy", label: "Sleeve", locationId: null, graphicIds: [gCrest] }])).run();
  const P_ST650b = { ...P_ST650, price: "29.00", name: "Sport-Tek Polo (new name)", active: "FALSE" };
  pv = await lib.importProductsCsv(d1, "league", [P_ST650b], { dryRun: true, graphicIds: [gCrest] });
  ok("preview says update", pv.updated === 1 && pv.created === 0 && pv.results[0].action === "update");
  r = await lib.importProductsCsv(d1, "league", [P_ST650b], { graphicIds: [gCrest] });
  prods = await lib.getProductsByOrg(d1, "league", false);
  const st2 = prod("league-st650");
  ok("still 2 products; name, price and visibility follow the file", prods.length === 2 && st2.name === "Sport-Tek Polo (new name)" && st2.sizePricing.M === 29 && st2.sizePricing["6XL"] === 36 && st2.visible === false);
  ok("images, weight, pick list and sort order are untouched", st2.images.join() === "images/x.jpg" && st2.weightOz === 7.5 && st2.personalizationOptions.join() === "COACH" && st2.sortOrder === 42);
  ok("an existing location keeps the graphics set by hand; a location not in the file stays", st2.locations.find(l => l.label === "Front").graphicIds.length === 0 && !!st2.locations.find(l => l.label === "Sleeve"));
  ok("no duplicate links", (await lib.getBlankLinks(d1, "league")).filter(l => l.productId === "league-st650").length === 30);

  console.log("\n=== Products: problems and notes ===");
  r = await lib.importProductsCsv(d1, "league", [
    prodRow("", "Shirts", "No sku", "", "", "10", "", "", "", "", "", "", "S", "", "", "TRUE"),
    prodRow("BAD SKU!!", "Mugs", "Mug", "", "", "10", "", "", "", "", "", "", "", "", "", "TRUE"),
    prodRow("LEAGUE-A", "Shirts", "No price", "", "", "", "", "", "", "", "", "", "S|M", "", "", "TRUE"),
    prodRow("LEAGUE-B", "Shirts", "Bad upcharge", "", "", "10", "", "", "", "", "", "", "S|M", "2XL-1", "", "TRUE"),
    prodRow("LEAGUE-C", "Shirts", "No blank yet", "", "NOPE", "10", "", "", "Red", "", "", "", "S|M", "", "", ""),
    prodRow("LEAGUE-D", "Caps", "Cap", "", "", "16", "", "", "", "", "", "", "", "", "", "TRUE"),
    prodRow("LEAGUE-E", "Shirts", "Tall sizes", "", "64800", "20", "", "", "Navy", "Navy", "", "", "S|LT", "", "", "TRUE"),
  ], {});
  ok("no SKU / unknown category / no price / bad upcharge are problems", r.skipped === 4 && /No SKU/.test(r.results[0].problems.join()) && /isn't one of this site's categories/.test(r.results[1].problems.join()) &&
    /No price/.test(r.results[2].problems.join()) && /should look like 2XL:1.00/.test(r.results[3].problems.join()));
  prods = await lib.getProductsByOrg(d1, "league", false);
  ok("a product whose blank isn't imported yet is still created, with a note and no links", !!prod("league-c") && r.results[4].blank.found === false && /import the blanks file first/.test(r.results[4].notes.join()));
  ok("a blank active flag defaults to visible", prod("league-c").visible === true);
  ok("a cap is one flat price, not configurable when it has no colors or locations", prod("league-d").pricingMode === "flat" && prod("league-d").flatPrice === 16 && prod("league-d").configurable === false);
  ok("a size the blank has no cost for is left unlinked, and said so", /The blank has no cost for LT/.test(r.results[6].notes.join()) && r.results[6].blank.links === 1);
  ok("the other shop got nothing", (await lib.getProductsByOrg(d1, "other", false)).length === 0);

  console.log("\n=== Long files arrive in batches: row numbers and repeats still line up ===");
  let bt = await lib.importBlanksCsv(d1, [{ style: "ST650", cost_M: "1" }, { style: "ZZ9", cost_M: "1" }], { dryRun: true, rowOffset: 40, seen: ["zz9"] });
  ok("rowOffset keeps the spreadsheet's row numbers (41st data row = row 42)", bt.results[0].row === 42 && bt.results[1].row === 43);
  ok("a style already sent in an earlier batch is still a repeat", /more than once/.test(bt.results[1].problems.join()) && bt.results[0].action === "update");
  let pt = await lib.importProductsCsv(d1, "league", [prodRow("LEAGUE-ZZ", "Shirts", "Zed", "", "", "10", "", "", "", "", "", "", "S", "", "", "TRUE")], { dryRun: true, rowOffset: 20, seen: ["league-zz"] });
  ok("same for products", pt.results[0].row === 22 && /more than once/.test(pt.results[0].problems.join()));
  await lib.importProductsCsv(d1, "league", [{ sku: "LEAGUE-DTF", category: "Shirts", name: "Transfer tee", price: "15", sizes: "S|M", no_design_needed: "TRUE" }], {});
  prods = await lib.getProductsByOrg(d1, "league", false);
  ok("no_design_needed marks a transfer-only product", prod("league-dtf").noDesignNeeded === true && prod("league-st650").noDesignNeeded === false);
  ok("a non-numeric cost is reported once, without a second 'no size costs' line", (await lib.importBlanksCsv(d1, [{ style: "Q1", cost_S: "abc" }], { dryRun: true })).results[0].problems.length === 1);

  console.log("\n=== Blanks: a colors column brings in every color ===");
  const d2 = await createD1();
  d2._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d2.execFile(read("migrations/" + f));
  const withColors = { ...B_64800, colors: "Navy|Black| navy |White" };
  let cv = await lib.importBlanksCsv(d2, [withColors], { dryRun: true });
  ok("preview counts the colors (repeats dropped)", cv.results[0].colors.join("|") === "Navy|Black|White");
  await lib.importBlanksCsv(d2, [withColors], {});
  let cb = (await lib.getAllBlanks(d2))[0];
  ok("a new blank gets every color, each with every size at that size's cost, no unnamed color", cb.colors.map(c => c.color).join("|") === "Navy|Black|White" &&
    cb.colors.every(c => c.sizes.length === 7 && c.sizes.find(x => x.size === "2XL").purchasePrice === 7.50) && cb.sizes.length === 21);
  ok("…and still no stock movements", Number((await d2.prepare("SELECT count(*) n FROM inventory_movements").first()).n) === 0);
  // The common case: imported once WITHOUT colors (one unnamed placeholder), then again WITH them.
  await lib.importBlanksCsv(d2, [B_ST650], {});
  cv = await lib.importBlanksCsv(d2, [{ ...B_ST650, all_colors: "True Navy|Black" }], { dryRun: true });
  ok("re-importing with colors says it adds them", cv.results[0].action === "update" && /Adds 2 colors/.test(cv.results[0].notes.join()));
  await lib.importBlanksCsv(d2, [{ ...B_ST650, all_colors: "True Navy|Black" }], {});
  cb = (await lib.getAllBlanks(d2)).find(b => b.sku === "ST650");
  ok("the existing blank now has the colors (all_colors works as the column name too) and the placeholder is gone",
    cb.colors.map(c => c.color).join("|") === "True Navy|Black" && cb.sizes.length === 20 && cb.sizes.every(x => x.color !== "") &&
    cb.colors[0].sizes.find(x => x.size === "6XL").purchasePrice === 18.50);
  await lib.importBlanksCsv(d2, [{ ...B_ST650, all_colors: "True Navy|Black|White" }], {});
  cb = (await lib.getAllBlanks(d2)).find(b => b.sku === "ST650");
  ok("a later import adds only the new color and keeps the others", cb.colors.map(c => c.color).join("|") === "True Navy|Black|White" && cb.sizes.length === 30);

  console.log("\n=== The admin API ===");
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let a = await call({ action: "importBlanks", rows: [] });
  ok("importBlanks with no rows is refused", a.status === 400);
  a = await call({ action: "importBlanks", rows: Array.from({ length: 501 }, (_, i) => ({ style: "S" + i, cost_M: "1" })) });
  ok("more than 500 rows is refused, nothing written", a.status === 400 && (await count("SELECT count(*) n FROM blanks WHERE sku LIKE 'S%' AND sku <> 'ST650' AND sku <> 'S700'")) === 0);
  a = await call({ action: "importBlanks", dryRun: true, rows: [blankRow("NEW1", "Brand", "New one", "SanMar", "Shirts", "", "", 5, 5)] });
  ok("importBlanks dryRun returns the plan and writes nothing", a.status === 200 && a.body.dryRun === true && a.body.created === 1 && (await count("SELECT count(*) n FROM blanks WHERE sku='NEW1'")) === 0);
  a = await call({ action: "importBlanks", rows: [blankRow("NEW1", "Brand", "New one", "SanMar", "Shirts", "", "", 5, 5)] });
  await new Promise(res => setTimeout(res, 20));
  ok("importBlanks writes and audits", a.status === 200 && (await count("SELECT count(*) n FROM blanks WHERE sku='NEW1'")) === 1 && (await count("SELECT count(*) n FROM audit_log WHERE action='blanks.imported'")) === 1);
  a = await call({ action: "importProducts", org: "nope", rows: [P_S700] });
  ok("importProducts for an unknown shop is refused", a.status === 404);
  a = await call({ action: "importProducts", org: "league", rows: [P_S700], graphicIds: [gOther] });
  ok("another shop's graphic is refused", a.status === 400 && /doesn't belong to this shop/.test(a.body.message));
  a = await call({ action: "importProducts", org: "other", rows: [P_S700] });
  await new Promise(res => setTimeout(res, 20));
  ok("importProducts writes for that shop and audits", a.status === 200 && a.body.created === 1 && (await lib.getProductsByOrg(d1, "other", false)).length === 1 &&
    (await count("SELECT count(*) n FROM audit_log WHERE action='products.imported' AND orgId='other'")) === 1);
  ok("the same product id in two shops links each to the shared blank", (await lib.getBlankLinks(d1, "other")).length === 12);

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
