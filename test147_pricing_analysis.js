const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Pricing awareness (2026-10, migrations/0067): under each price, what an item costs the shop — blank (vendor price,
// else average cost; the dearest color of a color group), card processing at the Global settings rate, the sales
// tax backed out, DTF / transfers (the reorder QR's transfer + the product's own transfer cost) and shop supplies
// (the product's, else the global default) — and what's left (income), plus the effective hourly rate when a run
// time is typed; the average of its timed runs alongside. Targets (hourly, per item) flag items on the product,
// the Products list, Price analysis, the catalog health check and — once, when one slips — the 6 AM email. Saving a
// changed price returns the analysis; a blank's cost or a setting changing says what's now below target.
// Real db.js / orders.js on sql.js; the product form, Products list, Price analysis and Global settings in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct, createBlank, setBlankLink, analyzePricing, getPricingSettings, setPricingSettings, getCatalogIssues, getNewPricingAlerts, pricingBelowTargetForBlanks };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" +
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
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  // Sales tax 6%, included in the prices (OpenDecoDesk's default rate is 0%, set in Global settings → Sales tax).
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":"CO","taxMode":"inclusive"}');`);
  d1._raw.exec(`INSERT INTO transfers (name, purchasePriceCents, quantity, visible, createdAt, updatedAt) VALUES ('Acme QR', 110, 50, 1, 't', 't');`);
  const qrId = d1.q("SELECT id FROM transfers")[0].id;
  d1._raw.run("UPDATE orgs SET reorderQrTransferId=? WHERE orgId='acme'", [qrId]);
  const tee = (await lib.createBlank(d1, { name: "Gildan Tee", productType: "shirt", vendor: "SanMar",
    colors: [{ color: "Black", images: [], sizes: [{ size: "M", purchasePrice: 4.8, quantity: 3 }, { size: "L", purchasePrice: 6, quantity: 2 }] },
             { color: "Ash", images: [], sizes: [{ size: "M", purchasePrice: 0, quantity: 0 }] }] })).id;
  d1._raw.run("UPDATE blank_sizes SET vendorPriceCents=500 WHERE blankId=? AND color='Black' AND size='M'", [tee]);
  d1._raw.run("UPDATE blank_sizes SET vendorPriceCents=650 WHERE blankId=? AND color='Ash' AND size='M'", [tee]);
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { M: 20, L: 22 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "acme", "tee", "", "M", tee, "Black", "M");
  await lib.setBlankLink(d1, "acme", "tee", "", "L", tee, "Black", "L");
  await lib.createProduct(d1, "acme", { productId: "sticker", type: "other", name: "Sticker", pricingMode: "flat", flatPrice: 5, visible: true, noBlankNeeded: true, taxable: false });
  await lib.createProduct(d1, "acme", { productId: "bare", type: "shirt", name: "Unlinked Tee", pricingMode: "sized", sizePricing: { M: 18 }, visible: true });
  await lib.createProduct(d1, "acme", { productId: "cfg", type: "shirt", name: "Color Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true,
    configurable: true, garmentColors: ["Black", "Ash"], colorGroupsCents: [{ key: "heathers", label: "Heathers", colors: ["Ash"], sizePricingCents: { M: 2400 } }] });
  await lib.setBlankLink(d1, "acme", "cfg", "Black", "M", tee, "Black", "M");
  await lib.setBlankLink(d1, "acme", "cfg", "Ash", "M", tee, "Ash", "M");

  console.log("=== Settings ===");
  const def = await lib.getPricingSettings(d1);
  ok("defaults: card 2.9% + 30¢, no supplies, no targets", def.cardPctBps === 290 && def.cardFixedCents === 30 && def.suppliesCents === 0 && def.targetHourlyCents === null && def.targetIncomeCents === null);
  let err = ""; try { await lib.setPricingSettings(d1, { cardPctBps: -5, cardFixedCents: 30, suppliesCents: 0 }); } catch (e) { err = e.message; }
  ok("an out-of-range fee is refused", /out of range/.test(err));
  let r = await call({ action: "updatePricingSettings", pricing: { cardPct: "2.9", cardFixed: "0.30", supplies: "0.50", targetHourly: "30", targetIncome: "9.50" } });
  ok("the admin action saves fees and targets (in dollars / percent)", r.status === 200 && r.body.pricing.supplies === 0.5 && r.body.pricing.targetIncome === 9.5 && r.body.pricing.targetHourly === 30 && r.body.pricing.cardPct === 2.9);
  ok("…and says straight away which products are now below a target ($5 sticker leaves $3.70)", r.body.belowTarget.some(p => p.productId === "sticker") && !r.body.belowTarget.some(p => p.productId === "tee"));
  ok("…audited", d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.pricing_set'")[0].n === 1);
  r = await call({ action: "getPricingSettings" });
  ok("getPricingSettings reads them back with the tax rate in use", r.body.pricing.targetIncome === 9.5 && r.body.pricing.taxRateBps === 600);

  console.log("\n=== The analysis of one product ===");
  let a = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  const M = a.rows.find(x => x.size === "M"), L = a.rows.find(x => x.size === "L");
  ok("M at $20: blank $5.00 (vendor price), card $0.88 (2.9% + 30¢), tax $1.13 backed out at 6%", M.price === 20 && M.blank === 5 && M.blankSource === "vendor" && M.card === 0.88 && M.tax === 1.13);
  ok("…DTF $1.10 (the shop's reorder QR transfer), supplies $0.50 (the global default)", M.transfer === 1.1 && M.supplies === 0.5);
  ok("…costs $8.61 and income $11.39", M.costs === 8.61 && M.income === 11.39);
  ok("L uses the blank's average cost when no vendor price is entered ($6.00)", L.blank === 6 && L.blankSource === "average");
  ok("no run time → no hourly rate, just the income", M.hourly === null && a.runMinutes === null && a.minHourly === null);
  r = await call({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { M: 20, L: 22 }, visible: true, runMinutes: 5000 });
  ok("a run time over a day is refused", r.status === 400 && /Run time/.test(r.body.message));
  r = await call({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { M: 20, L: 22 }, visible: true, noDesignNeeded: true, runMinutes: 20, transferCost: 2, suppliesCost: null });
  ok("saving a run time / DTF cost comes back with the analysis (a cost changed)", r.status === 200 && r.body.pricing && r.body.pricing.productId === "tee");
  a = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  const M2 = a.rows.find(x => x.size === "M"), L2 = a.rows.find(x => x.size === "L");
  ok("the product's own DTF cost adds to the linked QR transfer ($1.10 + $2.00)", M2.transfer === 3.1 && a.transferOwn === 2);
  ok("with a 20-minute run time: M income $9.39 → $28.17/hr", M2.income === 9.39 && M2.hourly === 28.17);
  ok("L: $22 − $6.00 − $0.94 − $1.25 − $3.10 − $0.50 = $10.21 → $30.63/hr", L2.card === 0.94 && L2.tax === 1.25 && L2.income === 10.21 && L2.hourly === 30.63);
  ok("M is below both targets ($9.50/item, $30/hr), L isn't", M2.flags.includes("income") && M2.flags.includes("hourly") && !L2.flags.length && a.belowTarget);
  ok("…and the problems name the size and both targets", a.problems.some(t => /Below both targets \(income under \$9\.50, hourly rate under \$30\.00\/hr\) on M$/.test(t)));
  // The targets are an OR: meeting either one is fine.
  await call({ action: "updatePricingSettings", pricing: { cardPct: "2.9", cardFixed: "0.30", supplies: "0.50", targetHourly: "25", targetIncome: "10" } });
  let or = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  ok("targets are an OR: M misses the $10 income target but makes $28.17/hr against $25 → not flagged", !or.rows.find(x => x.size === "M").flags.length && !or.belowTarget && !or.problems.length);
  await call({ action: "updatePricingSettings", pricing: { cardPct: "2.9", cardFixed: "0.30", supplies: "0.50", targetHourly: "40", targetIncome: "9" } });
  or = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  ok("…and the other way: under $40/hr but over the $9 income target → not flagged", !or.belowTarget);
  await call({ action: "updatePricingSettings", pricing: { cardPct: "2.9", cardFixed: "0.30", supplies: "0.50", targetHourly: "", targetIncome: "9.50" } });
  or = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  ok("…with only one target set, that one decides", or.rows.find(x => x.size === "M").flags.join() === "income" && or.problems.some(t => /^Income below the \$9\.50 target on M$/.test(t)));
  await call({ action: "updatePricingSettings", pricing: { cardPct: "2.9", cardFixed: "0.30", supplies: "0.50", targetHourly: "30", targetIncome: "9.50" } });
  ok("the analysis audits the new fields on the product", d1.q("SELECT detail FROM audit_log WHERE action='product.updated' ORDER BY id DESC")[0].detail.includes("runMinutes"));
  const draft = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee", draft: { sizePricing: { M: 24, L: 22 } } })).products[0];
  ok("a draft (the form's unsaved prices) is analysed instead of the saved ones", draft.rows.find(x => x.size === "M").price === 24 && !draft.rows.find(x => x.size === "M").flags.includes("income"));
  r = await call({ action: "analyzePricing", org: "acme", productId: "tee", draft: { sizePricing: { M: 24 }, suppliesCost: -1 } });
  ok("…a bad draft number is refused", r.status === 400);
  r = await call({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { M: 20, L: 22 }, visible: true, noDesignNeeded: true, runMinutes: 20, transferCost: 2, suppliesCost: null });
  ok("saving with nothing price-related changed doesn't re-run it", r.status === 200 && r.body.pricing === null);
  r = await call({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { M: 19, L: 22 }, visible: true, noDesignNeeded: true, runMinutes: 20, transferCost: 2, suppliesCost: null });
  ok("saving a changed price returns its analysis", r.body.pricing && r.body.pricing.rows.find(x => x.size === "M").price === 19);

  console.log("\n=== Other kinds of product ===");
  const all = await lib.analyzePricing(d1, { orgId: "acme" });
  const st = all.products.find(p => p.productId === "sticker"), bare = all.products.find(p => p.productId === "bare"), cfg = all.products.find(p => p.productId === "cfg");
  ok("made with no blank: blank $0; not taxable: no tax", st.rows[0].blank === 0 && st.rows[0].tax === 0 && st.rows[0].size === "");
  ok("its own supplies cost overrides the global one", (await (async () => { d1._raw.run("UPDATE products SET suppliesCostCents=25 WHERE productId='sticker'"); return (await lib.analyzePricing(d1, { orgId: "acme", productId: "sticker" })).products[0].rows[0].supplies === 0.25; })()));
  ok("no blank linked → the blank cost is unknown and flagged", bare.rows[0].blank === null && bare.rows[0].flags.includes("noBlankCost"));
  const std = cfg.rows.find(x => x.group === "Standard"), hea = cfg.rows.find(x => x.group === "Heathers");
  ok("color price groups: a row per group, each with its own price and its colors' blank cost", std && hea && std.price === 20 && std.blank === 5 && hea.price === 24 && hea.blank === 6.5);

  console.log("\n=== Average run time ===");
  await lib.insertOrder(d1, { orderId: "R1", orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-10-01T00:00:00Z" }, [{ productId: "tee", name: "Acme Tee", type: "shirt", size: "M", qty: 3, unitPrice: 20 }]);
  const itemId = d1.q("SELECT id FROM order_items WHERE orderId='R1'")[0].id;
  const run = (piece, step, start, mins, timed = 1) => d1._raw.run(`INSERT INTO production_runs (orgId, orderId, itemId, startedAt, finishedAt, status, createdAt, pieceNo, stepNo, timed) VALUES ('acme','R1',?,?,?,'done','t',?,?,?)`,
    [itemId, start, new Date(new Date(start).getTime() + mins * 60000).toISOString(), piece, step, timed]);
  run(1, 1, "2026-10-02T10:00:00Z", 10); run(1, 2, "2026-10-02T10:20:00Z", 5);   // piece 1: two hoopings, 15 min
  run(2, 1, "2026-10-02T11:00:00Z", 21);                                          // piece 2: 21 min
  run(3, 1, "2026-10-02T12:00:00Z", 2, 0);                                        // piece 3: untimed — left out
  a = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0];
  ok("the average adds up every hooping of a piece and leaves untimed pieces out: (15 + 21) / 2 = 18 min", a.avgRunMinutes === 18 && a.avgRunPieces === 2);

  console.log("\n=== Alerts: catalog health, blank costs, the roll-up ===");
  const issues = await lib.getCatalogIssues(d1, "acme");
  ok("a product below target is a catalog warning", (issues.orgs.acme.products.tee || []).some(x => x.code === "belowTarget" && x.level === "warn"));
  const byBlank = await lib.pricingBelowTargetForBlanks(d1, [tee]);
  ok("after a blank's cost changes: the products using it that are below target", byBlank.some(p => p.productId === "tee") && !byBlank.some(p => p.productId === "sticker"));
  let alerts = await lib.getNewPricingAlerts(d1);
  ok("the roll-up's first run reports what's below target", alerts.products.some(p => p.productId === "tee"));
  await alerts.commit();
  alerts = await lib.getNewPricingAlerts(d1);
  ok("…once: the next morning it isn't repeated", !alerts.products.length);
  d1._raw.run("UPDATE blank_sizes SET vendorPriceCents=1500 WHERE blankId=? AND color='Black' AND size='M'", [tee]);
  alerts = await lib.getNewPricingAlerts(d1);
  ok("a product that slips because its blank got dearer is reported; one already reported isn't repeated", alerts.products.some(p => p.productId === "cfg") && !alerts.products.some(p => p.productId === "tee"));
  d1._raw.run("UPDATE blank_sizes SET vendorPriceCents=500 WHERE blankId=? AND color='Black' AND size='M'", [tee]);
  const email = read("functions/_lib/email.js"), digest = read("functions/api/daily-digest.js");
  ok("the email has a 'below your price targets' section and it's a reason to send", /Products now below your price targets/.test(email) && /!belowTarget\.length\) \{/.test(digest) && /alerts\.commit\(\)/.test(digest));

  console.log("\n=== The admin screens ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class Ld extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new Ld(), url: "https://admin.example.com/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.CSS = win.CSS || { escape: (x) => String(x) }; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: false, status: 404, json: async () => ({ status: "error" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Acme" }]; window._adminOrgRegistry = [{ orgId: "acme", name: "Acme" }];');
  const app = d.getElementById("app");
  const product = (await call({ action: "listProducts", org: "acme" })).body.products.find(p => p.productId === "tee");
  w.renderProductForm(app, "acme", product);
  await wait(() => d.querySelectorAll("#pricingTable .pricing-row").length === 2);
  ok("the product form shows the costs under the prices: a row per size with income and $/hr", d.querySelectorAll("#pricingTable .pricing-row").length === 2 && /\$26\.\d\d\/hr|\/hr/.test(d.getElementById("pricingTable").textContent));
  ok("…its run time, DTF cost and supplies fields, with the average run time beside it", d.getElementById("prodFormRunMinutes").value === "20" && d.getElementById("prodFormTransferCost").value === "2" &&
    /Average of its timed runs: 18 min \(2 pieces\)/.test(d.getElementById("prodFormAvgRun").textContent) && /default \$0\.50/.test(d.getElementById("prodFormSuppliesCost").placeholder));
  ok("…a row below target is flagged, with why", d.querySelector("#pricingTable .pricing-flagged") && /Below both targets/.test(d.getElementById("pricingTable").textContent));
  const mInput = [...d.querySelectorAll(".prodFormSize")].find(x => x.dataset.size === "M");
  mInput.value = "30"; mInput.dispatchEvent(new w.Event("input", { bubbles: true }));
  const mPrice = () => { const tr = [...d.querySelectorAll("#pricingTable .pricing-row")].find(x => x.cells[0].textContent.trim() === "M"); return tr ? tr.cells[1].textContent.trim() : ""; };
  await wait(() => mPrice() === "$30.00", 200);
  ok("typing a new price redraws the costs with it (the unsaved draft)", mPrice() === "$30.00" && sent.some(b => b.action === "analyzePricing" && b.draft && b.draft.sizePricing && b.draft.sizePricing.M === 30));
  sent.length = 0;
  d.getElementById("prodPriceAnalysisBtn").click();
  await wait(() => d.querySelector("#paBody .pa-product"));
  ok("the product's Price analysis button opens the analysis for it", d.querySelectorAll("#paBody .pa-product").length === 1 && sent.some(b => b.action === "analyzePricing" && b.productId === "tee"));
  d.getElementById("paDone").click();
  await w.renderProductList(app, "acme");
  await wait(() => d.querySelector('.prod-pricing[data-product="tee"]') && d.querySelector('.prod-pricing[data-product="tee"]').textContent);
  ok("the Products list shows each product's income per item and $/hr, ⚠ when below a target", /⚠ Income/.test(d.querySelector('.prod-pricing[data-product="tee"]').textContent) && /Income \$/.test(d.querySelector('.prod-pricing[data-product="sticker"]').textContent));
  ok("…and a Price analysis button for the shop", !!d.getElementById("prodListPriceBtn"));
  d.getElementById("prodListPriceBtn").click();
  await wait(() => d.querySelectorAll("#paBody .pa-product").length >= 3);
  const firstOpen = d.querySelector("#paBody .pa-product");
  ok("the shop's analysis lists products below target first, opened", firstOpen.open && /Acme Tee|Unlinked Tee|Color Tee/.test(firstOpen.textContent) && /below target/.test(d.getElementById("paBody").textContent));
  d.getElementById("paDone").click();
  ok("Manage catalog has a Price analysis button for every shop", /id="catalogPriceBtn"/.test(adminJs) && /showPriceAnalysis_\(\{\}, \{ title: 'Price analysis — every shop' \}\)/.test(adminJs));
  await w.renderGlobalSettings(app);
  await wait(() => d.getElementById("gPriceTargetIncome"));
  ok("Global settings → Pricing has the fee, supplies and target fields, filled in", d.getElementById("gPriceCardPct").value === "2.9" && d.getElementById("gPriceSupplies").value === "0.5" && d.getElementById("gPriceTargetIncome").value === "9.5" && d.getElementById("gPriceTargetHourly").value === "30");
  ok("…saving it sends updatePricingSettings and names what's now below target", /action: "updatePricingSettings"/.test(adminJs) && /belowTargetToast_\(priceData\.belowTarget/.test(adminJs));

  console.log("\n=== Who sees costs and margins ===");
  // Staff save products in OpenDecoDesk, but what an item costs and leaves is a manager's to see.
  const save = (price) => call({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { M: price, L: 22 }, visible: true, noDesignNeeded: true, runMinutes: 20, transferCost: 2, suppliesCost: 0.5 });
  globalThis.__role = "staff"; r = await save(18);
  ok("a worker can save a changed price, but the reply carries no cost analysis", r.status === 200 && r.body.pricing === null);
  globalThis.__role = "manager"; r = await save(19);
  ok("…a manager's save of a changed price does", r.status === 200 && r.body.pricing && r.body.pricing.productId === "tee");
  globalThis.__role = null;
  ok("the product form shows the panel only to a manager (a worker sees a note)", /isEdit && adminCan_\("manager"\) \? `<div id="pricingTable"/.test(read("public/admin.js")) && /A manager sees what each item costs and leaves here/.test(read("public/admin.js")));

  console.log("\n=== Sales tax added on top of the prices ===");
  // OpenDecoDesk can add the tax on top instead (Global settings → Sales tax): the customer pays it over the
  // price, so it isn't a cost — but the card is charged on the price plus the tax.
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":"CO","taxMode":"exclusive"}');`);
  const onTop = await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" });
  const T = onTop.products[0].rows.find(x => x.size === "M");
  ok("M at $19 with 6% added on top: no tax cost, card $0.88 (2.9% of $20.14 + 30¢)", T.price === 19 && T.tax === 0 && T.card === 0.88);
  ok("…so it leaves $9.52 → $28.56/hr (more than the $8.47 with the tax inside the price)", T.income === 9.52 && T.hourly === 28.56);
  ok("…and the settings say so (the table explains its $0 tax column)", onTop.settings.taxMode === "exclusive" &&
    /Sales tax is added on top of your prices/.test(read("public/admin.js")) && /no sales tax \(it's added on top of your prices/.test(read("public/admin.js")));
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":"CO","taxMode":"inclusive"}');`);
  const inside = (await lib.analyzePricing(d1, { orgId: "acme", productId: "tee" })).products[0].rows.find(x => x.size === "M");
  ok("(with the tax inside the price: tax $1.08 backed out, card $0.85, income $8.47)", inside.tax === 1.08 && inside.card === 0.85 && inside.income === 8.47);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test147 crashed: false"); process.exit(1); });
