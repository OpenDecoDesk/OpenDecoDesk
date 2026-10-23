const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Run Transfer Sheets lists each order line ONCE. A product linked to its blank per color (what the CSV
// import and the product form's Blank links do) has one link row per color for the same size; a queue
// joined on size only would list a line once for every color the product comes in.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { createTransfer, createGraphic, createProduct, priceItem, insertOrder, getTransferQueue, getGangSheet, createBlank, setBlankLink };")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1);`);
  const sheet = await lib.createTransfer(d1, { name: "Crest sheet" });
  const crest = await lib.createGraphic(d1, "league", { name: "Crest", kind: "transfer", transferId: sheet, tier: null });
  const COLORS = ["Black", "Carbon Heather", "Heather Grey", "Moss", "New Navy"];
  const hoodieBlank = (await lib.createBlank(d1, { name: "Carhartt Zip Hoodie", productType: "sweatshirt", vendor: "SanMar", brand: "Carhartt", sku: "CTK122", color: "",
    colors: COLORS.map(color => ({ color, sizes: [{ size: "XL", purchasePrice: 42, quantity: 0 }, { size: "L", purchasePrice: 42, quantity: 0 }] })) })).id;
  const teeBlank = (await lib.createBlank(d1, { name: "Plain Tee", productType: "shirt", vendor: "SanMar", brand: "", sku: "T1", color: "Navy", colors: [{ color: "Navy", sizes: [{ size: "XL", purchasePrice: 5, quantity: 0 }] }] })).id;
  const product = (productId, type, garmentColors) => lib.createProduct(d1, "league", { productId, type, name: productId, pricingMode: "flat", flatPrice: 60, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors, reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [crest] }] });
  await product("hoodie", "sweatshirt", COLORS);
  await product("tee", "shirt", []);                        // a configurable product with no colors: linked under ''
  for (const color of COLORS) for (const size of ["XL", "L"]) await lib.setBlankLink(d1, "league", "hoodie", color, size, hoodieBlank, color, size);
  await lib.setBlankLink(d1, "league", "tee", "", "XL", teeBlank, "Navy", "XL");
  await product("unlinked", "shirt", ["Red"]);

  const cfg = (color) => ({ garmentColor: color, locations: { front: { graphicId: crest } } });
  const line = async (productId, color, qty) => ({ productId, name: productId, type: "shirt", size: "XL", qty, unitPrice: 60, config: (await lib.priceItem(d1, "league", productId, "XL", qty, false, cfg(color))).config });
  await lib.insertOrder(d1, { orderId: "O1", orgId: "league", customerName: "C", contact: "c@x.com", paymentMethod: "Card", placedAt: "2026-10-12T00:00:00Z" },
    [await line("hoodie", "Black", 1), await line("tee", "", 2), await line("unlinked", "Red", 1)]);
  d1._raw.run("UPDATE orders SET paid=1 WHERE orderId='O1'");

  const q = await lib.getTransferQueue(d1);
  const cards = q.ready.concat(q.waiting);
  const of = (name) => cards.filter(c => c.itemName === name);
  ok("three order lines → three entries (not one per color the product comes in)", cards.length === 3);
  ok("a line whose product is linked for 5 colors is listed once", of("hoodie").length === 1 && of("hoodie")[0].qty === 1);
  ok("…with the blank linked for ITS garment color", of("hoodie")[0].blank.id === hoodieBlank && of("hoodie")[0].blank.color === "Black" && of("hoodie")[0].blank.size === "XL" && of("hoodie")[0].garmentColor === "Black");
  ok("a product with no garment colors still finds its link (and the blank's color)", of("tee").length === 1 && of("tee")[0].blank.id === teeBlank && of("tee")[0].blank.color === "Navy");
  ok("a line with no link is still listed, once, with no blank", of("unlinked").length === 1 && of("unlinked")[0].blank === null);
  const gang = await lib.getGangSheet(d1);
  ok("the gang sheet's counts are per piece, not per color link (1 + 2 + 1 = 4)", gang.reduce((n, r) => n + r.count, 0) === 4);
  ok("the queue's link lookup uses the line's garment color", /LEFT JOIN product_blank_links l ON l\.orgId = i\.orgId AND l\.productId = i\.productId AND l\.productSize = i\.size\s+AND l\.productColor = /.test(read("functions/_lib/db.js")));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
