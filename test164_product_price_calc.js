const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// The price calculator on the product form: the wizard's methods ($ / % over cost, $ / % over MAP) worked out from the
// product's linked blanks, filling the size / flat price boxes and a configurable product's color price groups. Nothing
// is saved until Save changes, and the boxes stay editable. The real form in jsdom against the real admin API.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, getProductsByOrg };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const sz = (prices, map) => Object.entries(prices).map(([size, v]) => ({ size, vendorPrice: v, purchasePrice: v, quantity: 0, ...(map && map[size] != null ? { mapPrice: map[size] } : {}) }));
  const tee = (await lib.createBlank(d1, { name: "Tee A", brand: "Acme Apparel", productType: "shirt", colors: [
    { color: "Black", images: [], sizes: sz({ S: 5, M: 5, L: 7 }, { S: 18, M: 18, L: 20 }) },
    { color: "Heather", images: [], sizes: sz({ S: 6, M: 6, L: 8 }, { S: 18, M: 18, L: 20 }) } ] })).id;
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Plain tee", pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 20 }, visible: true });
  for (const s of ["S", "M", "L"]) await lib.setBlankLink(d1, "acme", "tee", "", s, tee, "Black", s);
  await lib.createProduct(d1, "acme", { productId: "ctee", type: "shirt", name: "Color tee", pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 20 }, visible: true, configurable: true, garmentColors: ["Black", "Heather"], reorderQr: "none", locations: [] });
  for (const c of ["Black", "Heather"]) for (const s of ["S", "M", "L"]) await lib.setBlankLink(d1, "acme", "ctee", c, s, tee, c, s);
  await lib.createProduct(d1, "acme", { productId: "loose", type: "shirt", name: "No blank", pricingMode: "sized", sizePricing: { S: 20 }, visible: true });

  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.scrollTo = () => {}; win.fetch = async (url, init) => {
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
  const open = async (id) => { app.innerHTML = ""; await w.renderEditProductForm(app, "acme", id); await until(() => w._blankLinksCtl && w._blankLinksCtl.productId === id || /No blanks/.test(text(d.getElementById("blankLinksSection")))); await tick();
    const det = d.getElementById("priceCalc"); det.open = true; det.dispatchEvent(new w.Event("toggle")); await tick(); };
  const box = (s) => d.querySelector(`.prodFormSize[data-size="${s}"]`).value;
  const choose = async (v) => { const r = d.querySelector(`input[name="pfcMethod"][value="${v}"]`); r.checked = true; r.dispatchEvent(new w.Event("change", { bubbles: true })); await tick(); };
  const setVal = async (id, v) => { const el = d.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); await tick(); };
  const apply = async () => { d.getElementById("pfcApply").click(); await tick(); };

  console.log("=== A plain product ===");
  await open("tee");
  ok("the calculator offers $ / % over cost and over MAP — no typed-prices method (the boxes are that)", [...d.querySelectorAll('input[name="pfcMethod"]')].map(r => r.value).join() === "over,pct,map");
  await setVal("pfcRound", "none"); await setVal("pfcAmt", 10); const km = d.getElementById("pfcKeepMap"); km.checked = false; km.dispatchEvent(new w.Event("change")); await tick();
  ok("$ over cost previews before anything changes", /S \$15\.00 · M \$15\.00 · L \$17\.00/.test(text(d.getElementById("priceCalcBody"))) && box("S") === "20");
  ok("…and says when a price lands below MAP", /S is below MAP \(\$18\.00\)/.test(text(d.getElementById("priceCalcBody"))));
  { const k = d.getElementById("pfcKeepMap"); k.checked = true; k.dispatchEvent(new w.Event("change")); await tick(); }
  await apply();
  ok("Fill in the prices writes the boxes, raised to MAP where needed (S/M $18, L $20)", box("S") === "18.00" && box("M") === "18.00" && box("L") === "20.00");
  await choose("map");
  ok("MAP method: an amount over MAP, in dollars or percent", d.getElementById("pfcMapAdd") && d.getElementById("pfcMapUnit"));
  await setVal("pfcMapAdd", 4); await apply();
  ok("MAP + $4: $22 / $22 / $24", box("S") === "22.00" && box("L") === "24.00");
  await setVal("pfcMapUnit", "pct"); await setVal("pfcMapAdd", 10); await setVal("pfcRound", "99"); await apply();
  ok("MAP + 10%, up to .99: $18 → $19.80 → $19.99, $20 → $22.99", box("S") === "19.99" && box("L") === "22.99");
  await choose("pct"); await setVal("pfcPct", 300); await setVal("pfcRound", "whole"); await apply();
  ok("% over cost, whole dollars: $5 × 4 = $20, $7 × 4 = $28", box("S") === "20.00" && box("L") === "28.00");
  const s = d.querySelector('.prodFormSize[data-size="S"]'); s.value = "21.50";
  ok("a price can still be typed by hand", box("S") === "21.50");
  ok("nothing is saved until Save changes", (await lib.getProductsByOrg(d1, "acme")).find(p => p.productId === "tee").sizePricing.S === 20);
  w.submitProductForm("acme", true);   // a price change opens the Price check window, so don't wait on it
  const saved = async () => (await lib.getProductsByOrg(d1, "acme")).find(p => p.productId === "tee").sizePricing.L === 28;
  for (let i = 0; i < 200 && !(await saved()); i++) await tick();
  d.querySelectorAll(".admin-modal").forEach(m => m.remove());
  ok("Save changes saves the filled-in prices", (await lib.getProductsByOrg(d1, "acme")).find(p => p.productId === "tee").sizePricing.L === 28);

  console.log("\n=== A configurable product whose colors cost differently ===");
  await open("ctee");
  await setVal("pfcAmt", 15); await setVal("pfcRound", "none"); await apply();
  ok("Standard (Black) is cost + $15", box("S") === "20.00" && box("L") === "22.00");
  const g = w._colorGroupsGet();
  ok("…and Heather, $1 dearer, gets its own color price group", g.length === 1 && g[0].colors.join() === "Heather" && g[0].sizePricing.S === 21 && g[0].sizePricing.L === 23);

  console.log("\n=== The price rule (Brand rules) ===");
  const rules0 = (await call({ action: "getBrandRules" })).body.rules;
  ok("there's no price rule until one is set", rules0.priceRule === null && Array.isArray(rules0.brandPrices) && !rules0.brandPrices.length);
  let r = await call({ action: "updateBrandRules", rules: Object.assign({}, rules0, { priceRule: { add: -1, unit: "amount" } }) });
  ok("a negative amount over MAP is refused", r.status === 400 && /from 0/.test(r.body.message));
  r = await call({ action: "updateBrandRules", rules: Object.assign({}, rules0, { brandPrices: [{ brand: "Acme Apparel", add: 3 }, { brand: "ACME apparel", add: 4 }] }) });
  ok("a brand with two price rules is refused", r.status === 400 && /two price rules/.test(r.body.message));
  // The page: a general rule and a brand's own.
  app.innerHTML = ""; await w.renderBrandRules(app); await until(() => d.getElementById("brPriceAdd"));
  d.getElementById("brPriceAdd").value = "10"; d.getElementById("brPriceUnit").value = "pct";
  d.getElementById("brPAdd").click(); await tick();
  const prow = d.querySelector(".br-prow"); prow.querySelector(".br-pbrand").value = "Acme Apparel"; prow.querySelector(".br-padd").value = "3";
  ok("the Brand rules page has the price rule above the restricted brands", /Price rule/.test(text(d.getElementById("brBody"))) && text(d.getElementById("brBody")).indexOf("Price rule") < text(d.getElementById("brBody")).indexOf("Restricted brands"));
  d.getElementById("brSave").click();
  await until(() => d1.q("SELECT value FROM global_settings WHERE key='brandRules'").length);
  const savedRules = JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='brandRules'")[0].value);
  ok("…saving it stores the general rule (MAP + 10%) and the brand's own (MAP + $3)", savedRules.priceRule.add === 10 && savedRules.priceRule.unit === "pct" && savedRules.brandPrices[0].brand === "Acme Apparel" && savedRules.brandPrices[0].add === 3 && savedRules.brandPrices[0].unit === "amount");
  const gen = w.priceRuleFor_(savedRules, "Other Brand"), own = w.priceRuleFor_(savedRules, "ACME-Apparel®");
  ok("a brand with no rule of its own takes the general one; a brand's own wins (matched ignoring case, punctuation and ®)", gen.add === 10 && gen.unit === "pct" && gen.brand === "" && own.add === 3 && own.brand === "Acme Apparel");
  // tee is now S $21.50 / M $20 / L $28 with MAP $18 / $18 / $20: the brand rule wants $21 / $21 / $23.
  const an = (await call({ action: "analyzePricing", org: "acme", productId: "tee" })).body.products[0];
  ok("a price under the rule but not under MAP is flagged as the price rule, naming the brand's rule", !an.belowMap && an.belowPriceRule && an.ruleProblems.length === 1 &&
    /M \$20\.00 is under the price rule of \$21\.00 \(MAP \+ \$3\.00 for Acme Apparel\)/.test(an.ruleProblems[0]) && an.rows.find(x => x.size === "M").flags.includes("mapRule"));
  const iss = (await call({ action: "getCatalogIssues", org: "acme" })).body;
  const teeIss = JSON.stringify(iss).match(/"code":"belowPriceRule","level":"(\w+)"/);
  ok("…the catalog check lists it as a warning (below MAP is an error)", teeIss && teeIss[1] === "warn");
  await open("tee"); await until(() => d.getElementById("pfcMapAdd"));
  ok("the product form's calculator starts at the brand's rule: MAP + $3", d.querySelector('input[name="pfcMethod"][value="map"]').checked && d.getElementById("pfcMapAdd").value === "3" && d.getElementById("pfcMapUnit").value === "amount" &&
    /Your price rule for Acme Apparel: MAP \+ \$3\.00/.test(text(d.getElementById("priceCalcBody"))));
  await until(() => d.querySelector(".pricing-rule-warnings"));
  ok("…and the Pricing panel shows the rule warning apart from (softer than) the MAP problems", /under the price rule/.test(text(d.querySelector(".pricing-rule-warnings"))) && !d.querySelector(".pricing-problems"));
  await setVal("pfcMapAdd", 1);
  ok("…a calculated price under the rule is a warning in the calculator, not a problem", /under your price rule/.test(text(d.querySelector(".price-calc-warnings"))) && !d.querySelector(".price-calc-problems"));

  console.log("\n=== Price impact (Brand rules) ===");
  w.eval(`adminOrgs = [{ orgId: "acme", name: "Acme" }];`);
  app.innerHTML = ""; await w.renderBrandRules(app); await until(() => d.getElementById("brImpact"));
  d.getElementById("brImpact").click();
  await until(() => d.querySelector(".pi-row"));
  const piRows = () => [...d.querySelectorAll(".pi-row")].map(tr => [...tr.children].slice(1).map(td => text(td)));   // after the tick box
  const teeM = () => piRows().find(c => c[1] === "Plain tee" && /^M /.test(c[2]));
  ok("it lists every price on a blank with a MAP, under its blank, with the shop, Before (now) and After (MAP + the rule)",
    /Tee A/.test(text(d.querySelector(".pi-blank"))) && teeM() && teeM()[0] === "Acme" && teeM()[3] === "$20.00" && teeM()[4] === "$21.00");
  ok("…Before, After and the Change between them (and a tick box to apply the row)", d.querySelector(".pi-row").children.length === 7 && teeM()[5] === "+$1.00");
  const acmeBox = d.querySelector('.pi-brand[data-brand="Acme Apparel"] .br-padd');
  acmeBox.value = "5"; acmeBox.dispatchEvent(new w.Event("input", { bubbles: true })); await tick();
  ok("tweaking the brand's rule in the window updates After at once (MAP $18 + $5 = $23)", teeM()[4] === "$23.00");
  acmeBox.value = ""; acmeBox.dispatchEvent(new w.Event("input", { bubbles: true })); await tick();
  ok("…a brand left blank falls back to the general rule (MAP + 10% = $19.80)", teeM()[4] === "$19.80");
  const only = d.getElementById("piOnly"); only.checked = true; only.dispatchEvent(new w.Event("change")); await tick();
  ok("“Only prices that would change” and a summary of how many go up / down", /would go up/.test(text(d.getElementById("piSummary"))) && piRows().every(c => c[3] !== c[4]));
  // Apply these prices: MAP + 10% rounded up to .99, one row unticked.
  const round = d.getElementById("piRound"); round.value = "99"; round.dispatchEvent(new w.Event("change")); await new Promise(r => setTimeout(r, 30));
  ok("rounding the After prices up to .99 ($19.80 → $19.99, a change of −$0.01)", teeM()[4] === "$19.99" && teeM()[5] === "−$0.01");
  const pickOf = (prod, size) => [...d.querySelectorAll(".pi-row")].find(tr => text(tr.children[2]) === prod && new RegExp("^" + size + " ").test(text(tr.children[3]))).querySelector(".pi-pick");
  const ctS = pickOf("Color tee", "S"); ctS.checked = false; ctS.dispatchEvent(new w.Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 30));
  const nPick = d.querySelectorAll(".pi-pick:checked").length;
  ok("the Apply button counts the ticked prices", new RegExp(`Apply ${nPick} prices`).test(text(d.getElementById("piApply"))) && nPick > 1);
  d.getElementById("piApply").click();
  await until(() => /Applied/.test(text(d.getElementById("piDone"))));
  const after = (id) => (lib.getProductsByOrg(d1, "acme")).then(ps => ps.find(p => p.productId === id));
  const t1 = await after("tee"), c1 = await after("ctee");
  ok("Apply sets each ticked price to its After price (tee M $18 + 10% → $19.99, L $20 + 10% → $22.99)", t1.sizePricing.M === 19.99 && t1.sizePricing.L === 22.99 && t1.pricesReviewedAt);
  ok("…an unticked row is left alone (Color tee S)", c1.sizePricing.S === 20 && c1.sizePricing.M === 19.99);
  ok("…audited per product", d1.q("SELECT detail FROM audit_log WHERE action='product.prices_applied'").length === 2);
  only.checked = false; only.dispatchEvent(new w.Event("change")); await new Promise(r => setTimeout(r, 30));
  ok("…and the table now shows the new prices as Before", teeM()[3] === "$19.99" && teeM()[4] === "$19.99");
  const pubBtn = d.querySelector(".pi-publish");
  ok("the result offers to publish each shop that changed", pubBtn && /Publish Acme/.test(text(pubBtn)));
  pubBtn.click(); await until(() => /published/.test(text(d.querySelector(".pi-publish"))));
  ok("…which publishes it", d1.q("SELECT 1 FROM catalog_snapshots WHERE orgId='acme'").length === 1);
  let ap = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "XL", price: 30 }] });
  ok("the server won't add a size the product doesn't sell", ap.status === 200 && !ap.body.prices && /doesn't sell that size/.test(ap.body.skipped[0]));
  d1._raw.exec(`UPDATE products SET colorGroupsJson='[{"key":"g1","label":"Heathers","colors":["Heather"],"sizePricingCents":{"S":2100,"M":2100,"L":2300}}]' WHERE productId='ctee'`);
  ap = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "ctee", group: "Heathers", size: "L", price: 24.99 }, { org: "acme", productId: "ctee", group: "Nope", size: "L", price: 1 }] });
  ok("a color price group's price is set by its label; an unknown group stops that product's changes", ap.body.skipped.some(t => /no such color price group/.test(t)) &&
    (await after("ctee")).colorGroups[0].sizePricing.L === 23);
  ap = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "ctee", group: "Heathers", size: "L", price: 24.99 }] });
  ok("…and a group price on its own is applied", ap.body.prices === 1 && (await after("ctee")).colorGroups[0].sizePricing.L === 24.99);
  ap = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "S", price: -2 }] });
  ok("…or take a price that isn't one", ap.status === 400);
  d.getElementById("piSave").click();
  await until(() => JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='brandRules'")[0].value).brandPrices.length === 0);
  ok("Save this rule saves it (the brand's own rule removed)", !JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='brandRules'")[0].value).brandPrices.length &&
    !d.querySelector("#piBody"));

  console.log("\n=== No blank linked ===");
  await open("loose");
  ok("a product with no blank links is told to link one first", /Link the product's sizes to a blank/.test(text(d.getElementById("priceCalcBody"))));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
