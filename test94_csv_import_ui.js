const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// The CSV import windows (Blanks → Import CSV, Products → Import CSV) in jsdom against the REAL
// /api/orders handler: preview first, untick/tick, import, the screens refresh; and the wider size
// list (5XL, 6XL, odd sizes) on the storefront and in the product form.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const BLANKS_CSV = `style,brand,name,supplier,category,size_range,cost_XS,cost_S,cost_M,cost_L,cost_XL,cost_2XL,cost_5XL,needle,backing,notes
ST650,Sport-Tek,"Sport-Tek Micropique, Sport-Wick Polo",SanMar,Shirts,XS-5XL,11.50,11.50,11.50,11.50,11.50,12.50,17.50,Ballpoint,Cutaway,
S700,Champion,Champion Powerblend Pullover Hoodie,SanMar,Hoodies & Layers,S-2XL,,15.00,15.00,15.00,15.00,18.00,,Ballpoint,Cutaway + WSS topping,"Fallback; recheck"
,Nobody,No style,SanMar,Shirts,,,5,5,5,5,,,,,
`;
const PRODUCTS_CSV = `sku,category,name,brand,blank_style,price,description,features,default_colors,all_colors,graphics_locations,personalization_price,sizes,size_upcharges,margin_base,active
LEAGUE-ST650,Shirts,Sport-Tek Micropique Polo,Sport-Tek,ST650,27.00,"A smooth polo, built for golf.",Snag-resistant|Tag-free,True Navy|Black,Black|True Navy|White,Front: left chest,2.00,XS|S|M|L|XL|2XL|5XL,2XL:1.00|5XL:6.00,11.00,TRUE
LEAGUE-S700,Hoodies & Layers,Champion Hoodie,Champion,S700,35.00,A classic hoodie.,Pouch pocket,Navy,Black|Navy,Front: left chest,2.00,S|M|L|XL|2XL,2XL:4.00,15.00,TRUE
LEAGUE-MUG,Mugs,A mug,,,10,,,,,,,,,,TRUE
`;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1);`);
  const count = async (sql) => Number((await d1.prepare(sql).first()).n);
  const sent = [];
  const adminJs = read("public/admin.js"), indexHtml = read("public/index.html");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.CSS = win.CSS || { escape: (v) => String(v).replace(/["\\\]]/g, "\\$&") };   // jsdom has no CSS.escape
      win.fetch = async (url, init) => {
        if (String(url).includes("/api/orders")) {
          const body = JSON.parse(init.body); sent.push(body);
          const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}), request: { url: "https://admin.example.com/api/orders", json: async () => body, headers: { get: () => null } } });
          const text = await res.text();
          return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(text) };
        }
        return { ok: true, status: 200, json: async () => ({ status: "admin" }) };
      };
    } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie";`);
  if (!w.Blob.prototype.text) w.Blob.prototype.text = function(){ return new Promise((res) => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(this); }); };
  const ok = (m, c) => console.log(m + ":", !!c);
  const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(res => setTimeout(res, 10)); return !!f(); };
  const file = (text, name) => new w.File([text], name, { type: "text/csv" });

  console.log("=== Parsing ===");
  const parsed = w.csvToObjects_("﻿" + BLANKS_CSV);
  ok("header row → keys, BOM stripped, quoted commas kept, blank trailing line ignored", parsed.headers[0] === "style" && parsed.rows.length === 3 && parsed.rows[0].name === "Sport-Tek Micropique, Sport-Wick Polo" && parsed.rows[1].notes === "Fallback; recheck");
  ok("size summary: short lists spelled out, long runs as a range", w.csvSizeSummary_(["S", "M"]) === "S, M" && w.csvSizeSummary_(["XS", "S", "M", "L", "6XL"]) === "XS–6XL (5)");

  console.log("\n=== Blanks → Import CSV ===");
  ok("the Blanks page has an Import CSV button", /id="blankImportCsvBtn"/.test(adminJs) && /showBlankCsvImportModal_\(file, refresh\)/.test(adminJs));
  let done = null;
  w.showBlankCsvImportModal_(file(BLANKS_CSV, "blanks.csv"), (r) => { done = r; });
  await until(() => d.querySelector("#csvImpGo"));
  ok("the preview asked the server for a dry run and wrote nothing", sent.some(b => b.action === "importBlanks" && b.dryRun === true) && (await count("SELECT count(*) n FROM blanks")) === 0);
  const rows = () => [...d.querySelectorAll("#csvImpBody tbody tr")];
  ok("three rows: two New (ticked), one that can't be imported (unticked, disabled)", rows().length === 3 && rows().filter(r => /New/.test(r.textContent)).length === 2 &&
    rows()[2].querySelector(".csv-on").disabled && !rows()[2].querySelector(".csv-on").checked && /No style/.test(rows()[2].textContent));
  ok("the button counts the ticked rows", d.querySelector("#csvImpGo").textContent === "Import 2 rows");
  rows()[1].querySelector(".csv-on").click();
  ok("unticking a row updates the count", d.querySelector("#csvImpGo").textContent === "Import 1 row");
  d.querySelector("#csvImpAll").click(); d.querySelector("#csvImpAll").click();
  ok("tick-all re-ticks only the rows that can be imported", d.querySelector("#csvImpGo").textContent === "Import 2 rows" && !rows()[2].querySelector(".csv-on").checked);
  rows()[1].querySelector(".csv-on").click();
  d.querySelector("#csvImpGo").click();
  await until(() => done);
  ok("only the ticked row was imported, the window closed and the page was told", done && done.created === 1 && !d.querySelector("#csvImpBody") &&
    (await count("SELECT count(*) n FROM blanks")) === 1 && (await count("SELECT count(*) n FROM blanks WHERE sku='ST650'")) === 1);
  ok("the real request carried the row as {header: value} and no dryRun", sent.some(b => b.action === "importBlanks" && !b.dryRun && b.rows.length === 1 && b.rows[0].style === "ST650" && b.rows[0].cost_5XL === "17.50"));
  // The rest of the file.
  done = null; w.showBlankCsvImportModal_(file(BLANKS_CSV, "blanks.csv"), (r) => { done = r; });
  await until(() => d.querySelector("#csvImpGo"));
  ok("opening the same file again shows Update for what's already there", /Update/.test(rows()[0].textContent) && /New/.test(rows()[1].textContent));
  d.querySelector("#csvImpGo").click(); await until(() => done);
  ok("…and importing it leaves one blank per style", (await count("SELECT count(*) n FROM blanks")) === 2);

  console.log("\n=== Blanks: colors from the products file ===");
  const m = w.blankColorsFromProducts_(w.csvToObjects_(PRODUCTS_CSV).rows);
  ok("each style's colors = all_colors, then any default color not already there", m.get("st650").join("|") === "Black|True Navy|White" && m.get("s700").join("|") === "Black|Navy" && m.size === 2);
  done = null; w.showBlankCsvImportModal_(file(BLANKS_CSV, "blanks.csv"), (r) => { done = r; });
  await until(() => d.querySelector("#csvImpGo"));
  ok("a blanks file with no colors says so and offers to read them from the products file", /This file has no colors/.test(d.querySelector("#csvImpBody").textContent) &&
    !!d.querySelector("#csvImpColorFile") && /no colors/.test(rows()[0].textContent));
  const pick = async (text, name) => { const inp = d.querySelector("#csvImpColorFile"); Object.defineProperty(inp, "files", { value: [file(text, name)], configurable: true });
    const before = sent.length; inp.dispatchEvent(new w.Event("change")); await until(() => sent.length > before && d.querySelector("#csvImpGo")); };
  await pick("a,b\n1,2\n", "nope.csv");
  ok("a file with no blank_style / all_colors is refused with a reason", /has no blank_style \+ all_colors columns/.test(d.querySelector("#csvImpBody").textContent));
  await pick(PRODUCTS_CSV, "products.csv");
  ok("after picking it the preview shows each style's colors", /read from products\.csv: 2 of 3 styles matched/.test(d.querySelector("#csvImpBody").textContent.replace(/\s+/g, " ")) &&
    /3 colors/.test(rows()[0].textContent) && /Adds 3 colors/.test(rows()[0].textContent) && /2 colors/.test(rows()[1].textContent));
  d.querySelector("#csvImpGo").click(); await until(() => done);
  ok("importing writes the colors onto the blanks (every size per color, placeholder gone)",
    (await count("SELECT count(*) n FROM blank_colors c JOIN blanks b ON b.id=c.blankId WHERE b.sku='ST650' AND c.color<>''")) === 3 &&
    (await count("SELECT count(*) n FROM blank_sizes s JOIN blanks b ON b.id=s.blankId WHERE b.sku='ST650'")) === 21 &&
    (await count("SELECT count(*) n FROM blank_sizes s JOIN blanks b ON b.id=s.blankId WHERE b.sku='ST650' AND s.color=''")) === 0 &&
    sent.some(b => b.action === "importBlanks" && !b.dryRun && b.rows[0].colors === "Black|True Navy|White"));

  console.log("\n=== A file that isn't a blanks file ===");
  w.showBlankCsvImportModal_(file("name,price\nTee,5\n", "wrong.csv"), () => {});
  await until(() => d.querySelector("#csvImpClose"));
  ok("says the style column is missing and lists what it found; nothing to import", /no <b>style<\/b> column|no style column/i.test(d.querySelector("#csvImpBody").innerHTML) && /name, price/.test(d.querySelector("#csvImpBody").textContent) && !d.querySelector("#csvImpGo"));
  d.querySelector("#csvImpClose").click();
  w.showBlankCsvImportModal_(file("style,cost_M\n", "empty.csv"), () => {});
  await until(() => d.querySelector("#csvImpClose"));
  ok("a header with no rows is explained", /no rows under its header/.test(d.querySelector("#csvImpBody").textContent));
  d.querySelector("#csvImpClose").click();

  console.log("\n=== Products → Import CSV ===");
  ok("the Products page has an Import CSV button", /id="prodImportCsvBtn"/.test(adminJs) && /showProductCsvImportModal_\(orgId, file/.test(adminJs));
  const gr = await (await w.fetch("/api/orders", { body: JSON.stringify({ action: "saveGraphic", key: "x", org: "league", graphic: { name: "Crest", kind: "transfer", tier: null } }) })).json();
  done = null; w.showProductCsvImportModal_("league", file(PRODUCTS_CSV, "products.csv"), (r) => { done = r; });
  await until(() => d.querySelector("#csvImpGo"));
  ok("preview: two New with price ranges and the blank link, one that can't be imported", rows().length === 3 && /\$27\.00–\$33\.00/.test(rows()[0].textContent) && /Linked to blank ST650/.test(rows()[0].textContent) &&
    /isn't one of this site's categories/.test(rows()[2].textContent) && (await count("SELECT count(*) n FROM products")) === 0);
  ok("the shop's graphics are offered for the new locations, unticked", d.querySelectorAll(".csvImpGraphic").length === 1 && !d.querySelector(".csvImpGraphic").checked && !!gr.id);
  d.querySelector(".csvImpGraphic").click();
  d.querySelector("#csvImpGo").click(); await until(() => done);
  ok("both products were created for that shop with the ticked graphic", done.created === 2 && (await count("SELECT count(*) n FROM products WHERE orgId='league'")) === 2 &&
    sent.some(b => b.action === "importProducts" && !b.dryRun && b.org === "league" && b.graphicIds.join() === String(gr.id)));
  ok("…and linked to their blanks", (await count("SELECT count(*) n FROM product_blank_links WHERE orgId='league' AND productId='league-st650'")) === 14);

  console.log("\n=== Sizes beyond 4XL ===");
  ok("sizes sort in garment order with 5XL/6XL and unknown ones last", w.productSizes_({ "6XL": 1, LT: 1, S: 1, "2XL": 1, XS: 1, "5XL": 1 }).join(",") === "XS,S,2XL,5XL,6XL,LT");
  ok("the storefront lists a product's own sizes (not just XS–4XL)", (indexHtml.match(/productSizes_\(p\.sizePricing\)/g) || []).length === 2 && !/SIZE_ORDER\.filter\(s => s in/.test(indexHtml));
  ok("a blank's size rows sort the same way", w.sizesInOrder_([{ size: "2XL" }, { size: "L" }, { size: "5XL" }, { size: "S" }]).map(s => s.size).join(",") === "S,L,2XL,5XL");
  // The product form shows a price box for every size the product carries, and saving keeps them.
  w.eval(`window._adminOrgRegistry = [{ orgId: "league", name: "League" }];`);
  w.location.hash = "#catalog/orgs/league/products/league-st650/edit";
  await until(() => d.querySelectorAll(".prodFormSize").length > 0);
  const boxes = [...d.querySelectorAll(".prodFormSize")];
  ok("the product form has price boxes through 6XL, filled from the import", boxes.map(b => b.dataset.size).join(",") === "XS,S,M,L,XL,2XL,3XL,4XL,5XL,6XL" &&
    boxes.find(b => b.dataset.size === "5XL").value === "33" && boxes.find(b => b.dataset.size === "3XL").value === "");
  ok("saving reads every box by its size (so 5XL isn't dropped)", /document\.querySelectorAll\("\.prodFormSize"\)\.forEach\(inp => \{[\s\S]{0,120}sizePricing\[inp\.dataset\.size\]/.test(adminJs));
})().catch(e => { console.log("test94 crashed:", false); console.error(e); process.exit(1); });
