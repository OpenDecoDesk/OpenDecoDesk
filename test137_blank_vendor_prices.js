const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Vendor prices for blanks (migrations/0062). The blank form's one cost box was both the average cost of
// what's on hand and a list price: typing the vendor's $4.94 into Tidal Wave M rewrote its $6.13 landed
// average. Now the vendor price is its own value per color + size, entered by hand (it starts empty),
// with history; the average is shown, never typed; a product priced on a vendor price that has since
// changed is flagged for re-pricing; and every 30 days the roll-up lists the blanks on products on sale
// whose prices haven't been checked. Real db.js / orders.js / email.js / daily-digest.js on sql.js; the
// blank form in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, updateBlank, createProduct, setBlankLink, getAllBlanks, getProductPriceChanges, getCatalogIssues,
  getBlankPriceReminder, getBlanksNeedingPriceCheck, receiveBlanks, importBlanksCsv };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const checkShippedDeliveries = async () => ({ inTransit: [], delivered: [], pickedUp: [], awaitingPickup: [] });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const digest = new Function(strip(read("functions/_lib/http.js")) + "\n" +
  "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/daily-digest.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = () => new Promise(res => setTimeout(res, 5));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('team','team','TEAM','t','t',1);`);
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "team" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const size = (blankId, color, sz) => d1.q("SELECT * FROM blank_sizes WHERE blankId=? AND color=? AND size=?", blankId, color, sz)[0];
  const audits = (action) => d1.q("SELECT * FROM audit_log WHERE action=?", action);

  console.log("=== Starts empty ===");
  // The real case: Tidal Wave, M received at a $6.13 landed cost (the $4.94 tee + shipping and fees).
  const tw = (await lib.createBlank(d1, { name: "Gildan 64000 Tidal Wave", productType: "shirt", vendor: "S&S Activewear",
    colors: [{ color: "Tidal Wave", images: [], sizes: [{ size: "M", purchasePrice: 6.13, quantity: 1 }, { size: "L", purchasePrice: 0, quantity: 0 }] },
             { color: "Black", images: [], sizes: [{ size: "M", purchasePrice: 0, quantity: 0 }] }] })).id;
  ok("a blank's sizes have no vendor price until one is entered", size(tw, "Tidal Wave", "M").vendorPriceCents === null && size(tw, "Tidal Wave", "M").purchasePriceCents === 613);
  ok("…nothing is in the history, and the blank was never checked", d1.q("SELECT count(*) n FROM blank_vendor_prices")[0].n === 0 && d1.q("SELECT pricesCheckedAt FROM blanks WHERE id=?", tw)[0].pricesCheckedAt === null);
  await lib.createProduct(d1, "team", { productId: "tee", type: "shirt", name: "TEAM Tee", pricingMode: "sized", sizePricing: { M: 18, L: 18 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "team", "tee", "", "M", tw, "Tidal Wave", "M");
  await lib.setBlankLink(d1, "team", "tee", "", "L", tw, "Tidal Wave", "L");
  ok("a product on a blank with no vendor prices isn't flagged", (await lib.getProductPriceChanges(d1)).length === 0);
  await tick();

  console.log("\n=== Entering a vendor price keeps the average ===");
  // What the new form sends: quantity with what it showed, the vendor price only where it was changed.
  let r = await call({ action: "updateBlank", id: tw, name: "Gildan 64000 Tidal Wave", productType: "shirt", vendor: "S&S Activewear", colors: [
    { color: "Tidal Wave", images: [], sizes: [{ size: "M", quantity: 1, baseQuantity: 1, vendorPrice: 4.94 }, { size: "L", quantity: 0, baseQuantity: 0, vendorPrice: 4.94 }] },
    { color: "Black", images: [], sizes: [{ size: "M", quantity: 0, baseQuantity: 0 }] }] });
  ok("the vendor price is saved", r.status === 200 && size(tw, "Tidal Wave", "M").vendorPriceCents === 494 && size(tw, "Tidal Wave", "L").vendorPriceCents === 494);
  ok("…and the $6.13 average of the one on hand is untouched (the bug)", size(tw, "Tidal Wave", "M").purchasePriceCents === 613);
  ok("…a size left alone keeps no price", size(tw, "Black", "M").vendorPriceCents === null);
  ok("…no stock movement is written for a price", d1.q("SELECT count(*) n FROM inventory_movements WHERE blankId=?", tw)[0].n === 1);
  let hist = d1.q("SELECT * FROM blank_vendor_prices WHERE blankId=? ORDER BY id", tw);
  ok("each entry is in the history, from nothing, with who entered it", hist.length === 2 && hist.every(h => h.previousCents === null && h.priceCents === 494 && h.actor === "owner@test" && h.note === "Blank form"));
  ok("entering a price counts as checking the prices", !!d1.q("SELECT pricesCheckedAt FROM blanks WHERE id=?", tw)[0].pricesCheckedAt);
  ok("…and it's audited", audits("inventory.vendor_prices_changed").some(a => /"to":4\.94/.test(a.detail)));
  ok("the first price entered is the product's basis — nothing to re-price yet", (await lib.getProductPriceChanges(d1)).length === 0 && r.body.repricing.length === 0);
  const blanks = await lib.getAllBlanks(d1);
  const twM = blanks.find(b => b.id === tw).sizes.find(s => s.color === "Tidal Wave" && s.size === "M");
  ok("the blank list carries both: vendor price and average cost", twM.vendorPrice === 4.94 && twM.purchasePrice === 6.13 && !!twM.vendorPriceAt);
  await tick();

  console.log("\n=== The price changes: the product is flagged ===");
  r = await call({ action: "updateBlank", id: tw, name: "Gildan 64000 Tidal Wave", productType: "shirt", colors: [
    { color: "Tidal Wave", images: [], sizes: [{ size: "M", quantity: 1, baseQuantity: 1, vendorPrice: 5.25 }, { size: "L", quantity: 0, baseQuantity: 0 }] },
    { color: "Black", images: [], sizes: [{ size: "M", quantity: 0, baseQuantity: 0 }] }] });
  hist = d1.q("SELECT * FROM blank_vendor_prices WHERE blankId=? ORDER BY id", tw);
  ok("the change is kept with what it was before", hist.length === 3 && hist[2].previousCents === 494 && hist[2].priceCents === 525);
  ok("the save says which products were priced on the old price", r.body.repricing.length === 1 && r.body.repricing[0].productId === "tee");
  let changes = await lib.getProductPriceChanges(d1);
  ok("the product is flagged: Tidal Wave M $4.94 → $5.25", changes.length === 1 && changes[0].changes.length === 1 && changes[0].changes[0].from === 4.94 && changes[0].changes[0].to === 5.25 && changes[0].changes[0].size === "M");
  let issues = await lib.getCatalogIssues(d1, "team");
  const flag = (issues.orgs.team.products.tee || []).find(x => x.code === "blankPriceChanged");
  ok("…as a warning in the catalog health check", flag && flag.level === "warn" && /\$4\.94 → \$5\.25/.test(flag.text));
  const hr = await call({ action: "getBlankVendorPriceHistory", blankId: tw }, { role: "staff" });
  ok("the price history is newest first, in dollars", hr.status === 200 && hr.body.history[0].price === 5.25 && hr.body.history[0].previous === 4.94);
  await tick();
  // A worker may confirm them, as they may edit the product's prices.
  r = await call({ action: "confirmProductPrices", productId: "tee" }, { role: "staff" });
  ok("“Prices still OK” clears the flag (a worker may)", r.status === 200 && (await lib.getProductPriceChanges(d1)).length === 0);
  ok("…and is audited with what changed", audits("product.prices_confirmed").some(a => /5\.25/.test(a.detail)));
  await tick();

  console.log("\n=== Changing the product's prices counts as re-pricing ===");
  await call({ action: "updateBlank", id: tw, name: "Gildan 64000 Tidal Wave", productType: "shirt", colors: [
    { color: "Tidal Wave", images: [], sizes: [{ size: "M", quantity: 1, baseQuantity: 1, vendorPrice: 5.5 }, { size: "L", quantity: 0, baseQuantity: 0 }] },
    { color: "Black", images: [], sizes: [{ size: "M", quantity: 0, baseQuantity: 0 }] }] });
  ok("another change flags it again", (await lib.getProductPriceChanges(d1)).length === 1);
  await tick();
  const prod = { productId: "tee", type: "shirt", name: "TEAM Tee", pricingMode: "sized", sizePricing: { M: 18, L: 18 }, visible: true, noDesignNeeded: true, images: [], features: [] };
  await call({ action: "updateProduct", ...prod, name: "TEAM Tee (new name)" });
  ok("saving the product with the same prices doesn't clear it", (await lib.getProductPriceChanges(d1)).length === 1);
  await tick();
  await call({ action: "updateProduct", ...prod, sizePricing: { M: 19, L: 19 } });
  ok("saving it with new prices does", (await lib.getProductPriceChanges(d1)).length === 0 && !!d1.q("SELECT pricesReviewedAt FROM products WHERE productId='tee'")[0].pricesReviewedAt);
  await tick();
  await call({ action: "updateBlank", id: tw, name: "Gildan 64000 Tidal Wave", productType: "shirt", colors: [
    { color: "Tidal Wave", images: [], sizes: [{ size: "M", quantity: 1, baseQuantity: 1, vendorPrice: 5.75 }, { size: "L", quantity: 0, baseQuantity: 0 }] },
    { color: "Black", images: [], sizes: [{ size: "M", quantity: 0, baseQuantity: 0 }] }] });
  await tick();
  await call({ action: "updateBlank", id: tw, name: "Gildan 64000 Tidal Wave", productType: "shirt", colors: [
    { color: "Tidal Wave", images: [], sizes: [{ size: "M", quantity: 1, baseQuantity: 1, vendorPrice: 5.5 }, { size: "L", quantity: 0, baseQuantity: 0 }] },
    { color: "Black", images: [], sizes: [{ size: "M", quantity: 0, baseQuantity: 0 }] }] });
  ok("a price that went up and came back to what the product was priced on isn't flagged", (await lib.getProductPriceChanges(d1)).length === 0);
  await call({ action: "updateBlank", id: tw, name: "Gildan 64000 Tidal Wave", productType: "shirt", colors: [
    { color: "Tidal Wave", images: [], sizes: [{ size: "M", quantity: 1, baseQuantity: 1, vendorPrice: "" }, { size: "L", quantity: 0, baseQuantity: 0 }] },
    { color: "Black", images: [], sizes: [{ size: "M", quantity: 0, baseQuantity: 0 }] }] });
  ok("a price can be cleared — kept in the history as cleared", size(tw, "Tidal Wave", "M").vendorPriceCents === null &&
    d1.q("SELECT priceCents, previousCents FROM blank_vendor_prices WHERE blankId=? ORDER BY id DESC LIMIT 1", tw)[0].previousCents === 550 &&
    d1.q("SELECT priceCents FROM blank_vendor_prices WHERE blankId=? ORDER BY id DESC LIMIT 1", tw)[0].priceCents === null);
  ok("…and the average still hasn't moved", size(tw, "Tidal Wave", "M").purchasePriceCents === 613);

  console.log("\n=== Receiving and the average ===");
  await lib.receiveBlanks(d1, { blankId: tw, lines: [{ color: "Tidal Wave", size: "M", qty: 1, unitCost: 4.94 }], vendor: "S&S", occurredAt: "2026-10-17T12:00:00.000Z" });
  ok("receiving moves the average (6.13 and 4.94 → 5.54), not the vendor price", size(tw, "Tidal Wave", "M").purchasePriceCents === 554 && size(tw, "Tidal Wave", "M").vendorPriceCents === null);
  d1._raw.run(`UPDATE blank_sizes SET purchasePriceCents = 494 WHERE blankId=${tw} AND color='Tidal Wave' AND size='M'`);
  r = await call({ action: "recomputeBlankAverageCosts", id: tw });
  ok("an average that drifted is re-worked from the stock history", r.status === 200 && r.body.changed.length === 1 && r.body.changed[0].from === 4.94 && r.body.changed[0].to === 5.54 &&
    size(tw, "Tidal Wave", "M").purchasePriceCents === 554 && size(tw, "Tidal Wave", "M").quantity === 2);
  ok("…audited", audits("inventory.average_cost_recomputed").length === 1);
  r = await call({ action: "recomputeBlankAverageCosts", id: tw });
  ok("…and doing it again changes nothing", r.body.changed.length === 0);
  const nb = await call({ action: "createBlank", name: "New cap", productType: "cap", colors: [{ color: "Navy", images: [], sizes: [{ size: "OSFA", quantity: 0, vendorPrice: 3.95 }] }] });
  ok("a new blank's size starts with its vendor price as its cost", nb.status === 200 && size(nb.body.id, "Navy", "OSFA").vendorPriceCents === 395 && size(nb.body.id, "Navy", "OSFA").purchasePriceCents === 395);
  ok("older callers that send a cost still set it (imports, tests)", (await lib.createBlank(d1, { name: "Old", productType: "cap", colors: [{ color: "", images: [], sizes: [{ size: "OSFA", purchasePrice: 2, quantity: 3 }] }] })).id &&
    d1.q("SELECT purchasePriceCents FROM blank_sizes WHERE blankId=(SELECT max(id) FROM blanks)")[0].purchasePriceCents === 200);

  console.log("\n=== The blank price-list CSV sets vendor prices ===");
  const csv = await lib.importBlanksCsv(d1, [{ style: "64000", name: "Gildan 64000 Softstyle", vendor: "S&S Activewear", category: "shirt", colors: "Red|Blue", cost_S: "3.10", cost_M: "3.10" }], { actor: "owner@test" });
  const csvId = csv.results[0].id;
  ok("a new blank from the CSV gets the file's costs as vendor prices", size(csvId, "Red", "S").vendorPriceCents === 310 && size(csvId, "Blue", "M").vendorPriceCents === 310);
  await lib.importBlanksCsv(d1, [{ style: "64000", name: "Gildan 64000 Softstyle", vendor: "S&S Activewear", category: "shirt", colors: "Red|Blue", cost_S: "3.25", cost_M: "3.10" }], { actor: "owner@test" });
  ok("re-importing changes only the sizes whose price changed, with history", size(csvId, "Red", "S").vendorPriceCents === 325 && size(csvId, "Blue", "S").vendorPriceCents === 325 &&
    d1.q("SELECT count(*) n FROM blank_vendor_prices WHERE blankId=? AND note='CSV import' AND previousCents=310", csvId)[0].n === 2);

  console.log("\n=== The 30-day reminder ===");
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  d1._raw.run(`UPDATE blanks SET pricesCheckedAt = '${old}' WHERE id = ${tw}`);
  // A testing blank and a blank on a hidden product are both left out.
  const testing = (await lib.createBlank(d1, { name: "Test tee", productType: "shirt", forTesting: true, colors: [{ color: "Gray", images: [], sizes: [{ size: "M", purchasePrice: 3, quantity: 1 }] }] })).id;
  const hiddenB = (await lib.createBlank(d1, { name: "Hidden-product tee", productType: "shirt", colors: [{ color: "Red", images: [], sizes: [{ size: "M", purchasePrice: 3, quantity: 1 }] }] })).id;
  await lib.createProduct(d1, "team", { productId: "t2", type: "shirt", name: "Test-blank tee", pricingMode: "sized", sizePricing: { M: 18 }, visible: true });
  await lib.createProduct(d1, "team", { productId: "t3", type: "shirt", name: "Hidden tee", pricingMode: "sized", sizePricing: { M: 18 }, visible: false });
  await lib.setBlankLink(d1, "team", "t2", "", "M", testing, "Gray", "M");
  await lib.setBlankLink(d1, "team", "t3", "", "M", hiddenB, "Red", "M");
  let due = await lib.getBlanksNeedingPriceCheck(d1);
  ok("it lists blanks for sale on visible products not checked in 30 days", due.length === 1 && due[0].id === tw && due[0].products[0].productId === "tee" && due[0].sizes === 3 && due[0].sizesWithPrice === 1);
  r = await call({ action: "getBlanks" }, { role: "staff" });
  ok("the Blanks screen gets the same list to flag", r.body.needsPriceCheck.length === 1 && r.body.needsPriceCheck[0] === tw);
  // Bring back a pending re-price for the email.
  await call({ action: "updateBlank", id: tw, name: "Gildan 64000 Tidal Wave", productType: "shirt", colors: [
    { color: "Tidal Wave", images: [], sizes: [{ size: "M", quantity: 2, baseQuantity: 2 }, { size: "L", quantity: 0, baseQuantity: 0, vendorPrice: 5.1 }] },
    { color: "Black", images: [], sizes: [{ size: "M", quantity: 0, baseQuantity: 0 }] }] });
  d1._raw.run(`UPDATE blanks SET pricesCheckedAt = '${old}' WHERE id = ${tw}`);
  const rem = await lib.getBlankPriceReminder(d1);
  ok("never sent → due, with the blank and the product to re-price", rem.due && rem.blanks.length === 1 && rem.products.length === 1 && rem.products[0].changes[0].size === "L");

  let emails = [];
  global.fetch = async (url, init) => captureMail(url, init, emails) ? MAIL_OK : { ok: true, json: async () => ({}) };
  const env = { DB: d1, CRON_SECRET: "cron-key", ...MAIL_ENV };
  const run = async () => { const res = await digest({ env, request: { json: async () => ({ key: "cron-key" }), headers: { get: () => null } } }); return JSON.parse(await res.text()); };
  let out = await run();
  const e = emails[0];
  ok("the reminder alone sends the roll-up", out.sent === true && emails.length === 1 && /blank prices to check/.test(e.subject));
  ok("…listing the blank, when it was checked, and what uses it", /Blank prices to check/.test(e.htmlBody) && /Gildan 64000 Tidal Wave/.test(e.htmlBody) && /TEAM Tee/.test(e.htmlBody) && /1 of 3 sizes have a vendor price/.test(e.htmlBody));
  ok("…and the product to re-price with the change", /Products to re-price/.test(e.htmlBody) && /Tidal Wave L: \$4\.94 → \$5\.10/.test(e.htmlBody) && /PRODUCTS TO RE-PRICE/.test(e.body));
  ok("…leaving out the testing blank and the hidden product's blank", !/Test tee/.test(e.htmlBody) && !/Hidden-product tee/.test(e.htmlBody));
  emails = [];
  out = await run();
  ok("the next morning it isn't due again (30 days)", out.sent === false && emails.every(m => !/blank prices/i.test(m.subject || "")));
  const later = await lib.getBlankPriceReminder(d1, new Date(Date.now() + 31 * 86400000));
  ok("31 days later it's due again", later.due === true);
  r = await call({ action: "markBlankPricesChecked", id: tw });
  ok("“Prices are current” takes the blank off the list", r.status === 200 && (await lib.getBlanksNeedingPriceCheck(d1)).length === 0 && audits("inventory.vendor_prices_checked").length === 1);
  r = await call({ action: "getPendingCommunications" });
  ok("Communications shows the reminder as it stands", r.status === 200 && r.body.priceReminder && r.body.priceReminder.due === false && r.body.priceReminder.products.length === 1 && r.body.priceReminder.products[0].orgName === "TEAM");

  console.log("\n=== The blank form ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/#inventory", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const blank = (await lib.getAllBlanks(d1)).find(b => b.id === tw);
  w.showBlankModal(blank, () => {});
  for (let i = 0; i < 100 && !d.querySelector("#blkColors [data-sf='vendorPrice']"); i++) await new Promise(res => setTimeout(res, 10));
  const card = d.querySelector('[data-color-card="0"]');
  const heads = [...card.querySelectorAll("th")].map(th => th.textContent);
  ok("the sizes table has Vendor price and Avg cost (in stock) columns", heads.includes("Vendor price ($)") && heads.includes("Avg cost (in stock)"));
  const rowM = [...card.querySelectorAll("tbody tr")].find(tr => tr.querySelector("[data-sf='size']").value === "M");
  ok("the average is shown, not an input — $5.54 for the 2 on hand", /\$5\.54/.test(rowM.querySelector("[data-avg-cell]").textContent) && !rowM.querySelector("[data-avg-cell] input"));
  const rowL = [...card.querySelectorAll("tbody tr")].find(tr => tr.querySelector("[data-sf='size']").value === "L");
  ok("a size with nothing on hand shows no average", /—/.test(rowL.querySelector("[data-avg-cell]").textContent) && rowL.querySelector("[data-sf='vendorPrice']").value === "5.10");
  ok("the form says when the prices were checked, with Prices are current / history / re-work buttons", /Vendor prices checked/.test(d.getElementById("blkCheckedAt").textContent) &&
    d.getElementById("blkPricesOk") && d.getElementById("blkPriceHist") && d.getElementById("blkRecompute"));
  rowM.querySelector("[data-sf='vendorPrice']").value = "5.30";
  card.querySelector("[data-vp-all]").click();
  const blackM = d.querySelector('[data-color-card="1"] [data-sf="vendorPrice"]');
  ok("“Same vendor prices for all colors” copies them per size", blackM.value === "5.30");
  sent.length = 0;
  d.getElementById("blkSaveBtn").click();
  for (let i = 0; i < 100 && !sent.some(b => b.action === "updateBlank"); i++) await new Promise(res => setTimeout(res, 10));
  await new Promise(res => setTimeout(res, 30));
  const save = sent.find(b => b.action === "updateBlank");
  const sz = (c, s) => save.colors.find(x => x.color === c).sizes.find(x => x.size === s);
  ok("the save sends changed vendor prices only, and no cost", sz("Tidal Wave", "M").vendorPrice === 5.3 && sz("Black", "M").vendorPrice === 5.3 && !("vendorPrice" in sz("Tidal Wave", "L")) &&
    save.colors.every(c => c.sizes.every(s => !("purchasePrice" in s))));
  ok("…and the average is still the one from the stock history", size(tw, "Tidal Wave", "M").purchasePriceCents === 554 && size(tw, "Tidal Wave", "M").vendorPriceCents === 530 && size(tw, "Black", "M").vendorPriceCents === 530);
  const twNow = (await lib.getAllBlanks(d1)).find(b => b.id === tw);
  ok("the Blanks list shows the vendor price with the average beside it", /\$5\.30.*avg \$5\.54/.test(w.blankSizePrices_(twNow.sizes.find(s => s.color === "Tidal Wave" && s.size === "M")).replace(/<[^>]+>/g, "")));

  console.log("\n=== Which products use each blank ===");
  r = await call({ action: "getBlanks" }, { role: "staff" });
  const uses = r.body.products || {};
  ok("getBlanks says which products use each blank, with their shop and linked sizes", uses[tw] && uses[tw].length === 1 && uses[tw][0].productId === "tee" && uses[tw][0].orgName === "TEAM" &&
    uses[tw][0].visible === true && uses[tw][0].sizes.join() === "L,M");
  ok("…a blank on a hidden product says so; an unlinked blank isn't in the map", uses[hiddenB][0].visible === false && !uses[csvId] && !uses[nb.body.id]);
  const app = d.getElementById("app");
  await w.renderAdminBlanks(app);
  for (let i = 0; i < 100 && !d.querySelector(".blank-size-cell"); i++) await new Promise(res => setTimeout(res, 10));
  const rowOf = (name) => [...d.querySelectorAll("#blanksPanel tbody tr")].find(tr => tr.querySelector("td").textContent.includes(name));
  const twRow = rowOf("Gildan 64000 Tidal Wave");
  ok("a blank on a product for sale is flagged ON SALE with a link to the product", twRow.querySelector(".blank-onsale-badge") &&
    twRow.querySelector(".blank-product-link").getAttribute("href") === "#catalog/orgs/team/products/tee/edit" && /TEAM Tee.*\(TEAM\)/.test(twRow.textContent));
  ok("a blank no product uses says NOT LINKED TO ANY PRODUCT", rowOf("New cap").querySelector(".blank-unlinked-badge") && !rowOf("New cap").querySelector(".blank-onsale-badge"));
  ok("a blank only on a hidden product isn't ON SALE, and says so", !rowOf("Hidden-product tee").querySelector(".blank-onsale-badge") && /Only on hidden products/.test(rowOf("Hidden-product tee").textContent) && /hidden\)/.test(rowOf("Hidden-product tee").textContent));
  const pick = async (v) => { const sel = d.getElementById("blankGroup"); sel.value = v; sel.dispatchEvent(new w.Event("change")); return [...d.querySelectorAll("#blanksPanel tbody tr")].map(tr => tr.querySelector("td").textContent); };
  let names = await pick("onsale");
  ok("the filter shows just the blanks on a product for sale", names.length === 2 && names.some(t => /Tidal Wave/.test(t)) && names.some(t => /Test tee/.test(t)));
  names = await pick("unlinked");
  ok("…or just the ones not linked to any product", names.length >= 3 && names.every(t => !/Tidal Wave|Test tee|Hidden-product/.test(t)) && names.some(t => /New cap/.test(t)));
  await pick("");
  d.getElementById("blankSearch").value = "TEAM Tee"; d.getElementById("blankSearch").dispatchEvent(new w.Event("input"));
  ok("searching a product's name finds the blanks it uses", [...d.querySelectorAll("#blanksPanel tbody tr")].length === 1);

  console.log("\n=== An edit keeps the search, the group and the list where they were ===");
  d.getElementById("blankGroup").value = "onsale"; d.getElementById("blankGroup").dispatchEvent(new w.Event("change"));
  const panelBefore = d.getElementById("blanksPanel"), searchBefore = d.getElementById("blankSearch");
  w.blankEdit(String(tw));
  for (let i = 0; i < 100 && !d.getElementById("blkSaveBtn"); i++) await new Promise(res => setTimeout(res, 10));
  const vpM = [...d.querySelectorAll('[data-color-card="0"] tbody tr')].find(tr => tr.querySelector("[data-sf='size']").value === "M").querySelector("[data-sf='vendorPrice']");
  vpM.value = "5.45";
  d.getElementById("blkSaveBtn").click();
  for (let i = 0; i < 200 && !d.querySelector("#blanksPanel .row-flash"); i++) await new Promise(res => setTimeout(res, 10));
  ok("after saving, the page isn't rebuilt — the same search box and list", d.getElementById("blanksPanel") === panelBefore && d.getElementById("blankSearch") === searchBefore);
  ok("…the search and the group are still applied", d.getElementById("blankSearch").value === "TEAM Tee" && d.getElementById("blankGroup").value === "onsale" && d.querySelectorAll("#blanksPanel tbody tr").length === 1);
  ok("…the list shows the new price, and the edited blank is highlighted", /\$5\.45/.test(d.querySelector("#blanksPanel tbody tr").textContent) && d.querySelector(`[data-blank-row="${tw}"]`).classList.contains("row-flash"));
  ok("…and the list box is built once (it's the scroll box, so its scroll isn't reset)", panelBefore.getAttribute("data-keep-scroll") === "blanks" && /overflow:auto/.test(panelBefore.getAttribute("style")));
  await w.renderAdminBlanks(app);
  for (let i = 0; i < 100 && !d.querySelector(".blank-size-cell"); i++) await new Promise(res => setTimeout(res, 10));
  ok("coming back to Blanks later keeps the search and group too", d.getElementById("blankSearch").value === "TEAM Tee" && d.getElementById("blankGroup").value === "onsale" && d.querySelectorAll("#blanksPanel tbody tr").length === 1);

  console.log("\n=== keepView_: what a redraw puts back ===");
  const area = d.createElement("div");
  area.innerHTML = `<details data-keep-open="a" open><summary>A</summary></details><details data-keep-open="b"><summary>B</summary></details><input type="checkbox" data-keep-check="x" checked><input id="kvText" value="hello world">`;
  app.appendChild(area);
  const txt = d.getElementById("kvText"); txt.focus(); txt.setSelectionRange(2, 5);
  await w.keepView_(() => { area.innerHTML = `<details data-keep-open="a"><summary>A</summary></details><details data-keep-open="b" open><summary>B</summary></details><input type="checkbox" data-keep-check="x"><input id="kvText" value="hello world">`; });
  const [da, db] = area.querySelectorAll("details");
  ok("open / closed sections come back as they were", da.open === true && db.open === false);
  ok("selection ticks come back", area.querySelector("[data-keep-check]").checked === true);
  ok("the focused field gets focus back, with its selection", d.activeElement === d.getElementById("kvText") && d.activeElement.selectionStart === 2 && d.activeElement.selectionEnd === 5);
  ok("…and it returns what the redraw returned", (await w.keepView_(async () => 42)) === 42);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test126 crashed: false"); process.exit(1); });
