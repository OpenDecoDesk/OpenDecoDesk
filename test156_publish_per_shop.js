const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Publish per shop (migrations/0076) and the admin fixes from the usability audit. A shop's published catalog (its
// orgs + products rows as of its last Publish) is what shoppers see and what orders are priced from; edits are a draft
// until that shop is published; a shop never published since then is served live; the admin can open a signed preview
// of the draft. Plus: no product saved without a price, new products start hidden, the New shop form, the catalog
// check of hidden products and of the shop as a whole, escaped modal titles, the Setup status panel.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getPublicCatalogData, priceItem, getPublishState, getPublishedOrg, publishShop, getCatalogIssues, signPreviewToken, verifyPreviewToken };`)();
const common = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/setupStatus.js")) + "\n";
const api = new Function(common +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const catalogGet = new Function(common + dbSrc +
  "\nconst getCatalogData = async (env) => getPublicCatalogData(env.DB);\n" + strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1), ('northside','northside','Northside','t','t',1);`);
  const ENV = { DB: d1, SIGNING_SECRET: "a-signing-secret-for-tests-0123456789abcdef" };
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: ENV, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const shopPage = async (org, query = "") => JSON.parse(await (await catalogGet({ request: new Request(shopOrigin(org) + "/api/catalog" + query), env: ENV })).text());
  const prod = (pid, price, extra) => Object.assign({ action: "updateProduct", org: "acme", productId: pid, type: "shirt", name: "Acme Tee", pricingMode: "flat", flatPrice: price, visible: true, images: [] }, extra || {});
  const shownPrice = async (org = "acme", pid = "tee") => { const c = await lib.getPublicCatalogData(d1); return (c.orgs[org].products.find(p => p.productId === pid) || {}).flatPrice; };
  const chargedPrice = async (pid = "tee") => (await lib.priceItem(d1, "acme", pid, "OSFA", 1, false)).unitPrice;

  console.log("=== A shop never published is served live (as before) ===");
  let r = await call({ action: "createProduct", org: "acme", productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "flat", flatPrice: 20, visible: true, images: [] });
  await call({ action: "createProduct", org: "northside", productId: "cap", type: "cap", name: "Northside Cap", pricingMode: "flat", flatPrice: 15, visible: true, images: [] });
  ok("before any Publish, the shop shows and charges what's in the catalog", r.status === 200 && await shownPrice() === 20 && await chargedPrice() === 20);
  await call(prod("tee", 22));
  ok("…and an edit shows at once", await shownPrice() === 22 && await chargedPrice() === 22);
  ok("…the admin sees it as never published", (await call({ action: "getPublishState" })).body.publishState.acme.state === "never");

  console.log("\n=== Publishing one shop ===");
  r = await call({ action: "publish", org: "acme" });
  ok("Publish for one shop publishes that shop only, and is audited", r.status === 200 && r.body.published.join() === "acme" && r.body.publishState.acme.state === "current" &&
    r.body.publishState.northside.state === "never" && d1.q("SELECT 1 FROM audit_log WHERE action='catalog.published'").length === 1);
  await call(prod("tee", 30));
  ok("after Publish, an edit is a draft: shoppers still see and pay the published price", await shownPrice() === 22 && await chargedPrice() === 22);
  ok("…even when the catalog is rebuilt from the database (no cache)", (await shopPage("acme")).catalog.products.find(p => p.id === "tee").flatPrice === 22);
  let st = (await call({ action: "getPublishState" })).body.publishState.acme;
  ok("…and the admin sees 'unpublished changes' naming the product", st.state === "changed" && st.changedProducts.join() === "tee" && !st.shopChanged);
  await call({ action: "createProduct", org: "acme", productId: "polo", type: "shirt", name: "Polo", pricingMode: "flat", flatPrice: 35, visible: true, images: [] });
  ok("a new product isn't on the shop page until Publish", !(await lib.getPublicCatalogData(d1)).orgs.acme.products.some(p => p.productId === "polo"));
  let refused = ""; try { await lib.priceItem(d1, "acme", "polo", "OSFA", 1, false); } catch (e) { refused = e.message; }
  ok("…nor can it be ordered", /not available/.test(refused));
  await call({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme 101", ready: true });
  st = (await call({ action: "getPublishState" })).body.publishState.acme;
  ok("a change to the shop's own settings is a draft too", st.shopChanged && (await lib.getPublicCatalogData(d1)).orgs.acme.name === "Acme" && (await lib.getPublishedOrg(d1, "acme")).name === "Acme");
  await call({ action: "updateProduct", org: "northside", productId: "cap", type: "cap", name: "Northside Cap", pricingMode: "flat", flatPrice: 18, visible: true, images: [] });
  ok("the other shop, never published, still changes at once (publishing Acme didn't touch it)", await shownPrice("northside", "cap") === 18);

  console.log("\n=== Preview of the draft ===");
  r = await call({ action: "getPreviewLink", org: "acme" }, { role: "manager" });
  const token = decodeURIComponent((r.body.url || "").split("preview=")[1] || "");
  ok("a manager gets a signed preview link to the shop's own address", r.status === 200 && r.body.url.startsWith(shopOrigin("acme") + "/?preview=") && token);
  ok("…a worker doesn't", (await call({ action: "getPreviewLink", org: "acme" }, { role: "staff" })).status === 403);
  // OpenDecoDesk: the shop's address is <subdomain>.<ROOT_DOMAIN>, whatever the admin's own hostname looks like.
  ENV.ROOT_DOMAIN = "myshop.example"; ENV.ADMIN_SUBDOMAIN = "office";
  const odd = await api({ env: ENV, waitUntil: () => {}, request: { url: "https://office.myshop.example/api/orders", json: async () => ({ key: "x", action: "getPreviewLink", org: "acme" }), headers: { get: () => null } } });
  ok("…on the install's root domain (ROOT_DOMAIN), not the admin hostname minus its first label", JSON.parse(await odd.text()).url.startsWith("https://acme.myshop.example/?preview="));
  delete ENV.ROOT_DOMAIN; delete ENV.ADMIN_SUBDOMAIN;
  let page = await shopPage("acme", "?preview=" + encodeURIComponent(token));
  ok("the preview shows the draft — new price, new product, new name — and says it's a preview", page.preview === true && page.catalog.products.find(p => p.id === "tee").flatPrice === 30 &&
    page.catalog.products.some(p => p.id === "polo") && page.catalog.name === "Acme 101");
  page = await shopPage("acme", "?preview=" + encodeURIComponent(token.replace(/.$/, c => c === "0" ? "1" : "0")));
  ok("a tampered token just gets the published shop", !page.preview && page.catalog.products.find(p => p.id === "tee").flatPrice === 22);
  page = await shopPage("northside", "?preview=" + encodeURIComponent(token));
  ok("…and a token for one shop doesn't preview another", !page.preview);
  ok("an expired token is refused", !(await lib.verifyPreviewToken(ENV, "acme", "1000000000." + "a".repeat(64))));

  console.log("\n=== Publishing again; Publish all ===");
  await call({ action: "publish", org: "acme" });
  ok("publishing again puts the draft live", await shownPrice() === 30 && await chargedPrice() === 30 && (await lib.getPublicCatalogData(d1)).orgs.acme.name === "Acme 101" &&
    (await call({ action: "getPublishState" })).body.publishState.acme.state === "current");
  r = await call({ action: "publish" });
  ok("Publish all shops publishes every shop", r.body.published.sort().join() === "acme,northside" && r.body.publishState.northside.state === "current");
  ok("a worker can't publish", (await call({ action: "publish", org: "acme" }, { role: "staff" })).status === 403);

  console.log("\n=== A product needs a price ===");
  r = await call({ action: "createProduct", org: "acme", productId: "noprice", type: "cap", name: "No price", pricingMode: "flat", flatPrice: "", visible: false, images: [] });
  ok("a flat price left blank is refused (it used to save as $0)", r.status === 400 && /price/.test(r.body.message));
  r = await call({ action: "createProduct", org: "acme", productId: "nosizes", type: "shirt", name: "No sizes", pricingMode: "sized", sizePricing: {}, visible: false, images: [] });
  ok("…and a sized product with no size priced", r.status === 400 && /at least one size/.test(r.body.message));
  r = await call(prod("tee", null));
  ok("…and clearing the price on an update", r.status === 400);
  r = await call(prod("tee", 0));
  ok("…but $0 typed on purpose is allowed", r.status === 200);

  console.log("\n=== Catalog check: hidden products and the shop as a whole ===");
  await call({ action: "createProduct", org: "northside", productId: "hidden1", type: "shirt", name: "Hidden", pricingMode: "flat", flatPrice: 10, visible: false, images: [] });
  const issues = await lib.getCatalogIssues(d1);
  ok("a hidden product is checked, as warnings, saying to fix it before showing it", (issues.orgs.northside.products.hidden1 || []).length && issues.orgs.northside.products.hidden1.every(x => x.level === "warn" && /fix before showing it/.test(x.text)));
  ok("the shop as a whole: a product with no picture of its own isn't flagged (the blank's photos are normal)", !issues.orgs.acme.shop.some(x => x.code === "noPictures"));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('empty','empty','Empty','t','t',0)");
  ok("…and a shop with nothing visible is flagged", (await lib.getCatalogIssues(d1)).orgs.empty.shop.some(x => x.code === "noVisibleProducts"));

  console.log("\n=== Escaped window titles ===");
  const adminJs = read("public/admin.js");
  const unsafe = [];
  // A value in a title must go through escapeHtml — counts and "s"-plurals are fine.
  const harmless = (x) => /^\s*escapeHtml\(/.test(x) || /^[\s\w.]*\.length\s*$/.test(x) || /^\s*[\w.]+\s*===\s*1\s*\?\s*"[^"]*"\s*:\s*"[^"]*"\s*$/.test(x);
  for (const m of adminJs.matchAll(/inventoryModal_\(([^\n]*)/g)) {
    const arg = m[1];
    if (/^title, bodyHtml/.test(arg)) continue;
    const t = arg.match(/^`([^`]*)`/);
    if (t && [...t[1].matchAll(/\$\{([^}]*)\}/g)].some(x => !harmless(x[1]))) unsafe.push(arg.slice(0, 60));
    if (!t && /\+\s*\(?[a-zA-Z_]+\.[a-zA-Z_]+/.test(arg.split(", `")[0].replace(/escapeHtml\([^()]*\)/g, ""))) unsafe.push(arg.slice(0, 60));
  }
  ok("every window title built from data escapes it", !unsafe.length || (console.log(unsafe), false));

  console.log("\n=== The screens ===");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.open = () => null; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" };');
  const wait = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return fn(); };
  await call(prod("tee", 31));
  await w.renderAdminOrgList(d.getElementById("app"));
  await wait(() => d.querySelector('[data-publish-state="acme"] .pub-state'));
  ok("Manage catalog: each shop has Publish and Preview, and says it has unpublished changes", d.querySelector('button[data-org="acme"][onclick*="publishCatalog"]') && d.querySelector('button[data-org="acme"][onclick*="previewShop_"]') &&
    /Unpublished changes \(1 product\)/.test(d.querySelector('[data-publish-state="acme"]').textContent));
  d.querySelector('button[data-org="acme"][onclick*="publishCatalog"]').click();
  await wait(() => /✓ Published/.test(d.querySelector('[data-publish-state="acme"]').textContent));
  ok("…Publish on the row publishes that shop and the badge turns to ✓ Published", /✓ Published/.test(d.querySelector('[data-publish-state="acme"]').textContent) && await shownPrice() === 31);
  await wait(() => d.querySelector('[data-shop-issues="empty"]') && /No product/.test(d.querySelector('[data-shop-issues="empty"]').textContent));
  ok("…and shop-level problems show on the row", /No product/.test(d.querySelector('[data-shop-issues="empty"]').textContent));
  w.eval("window._adminOrgRegistry = [{ orgId: 'acme', name: 'Acme 101' }]");
  w.renderOrgForm(d.getElementById("app"), null);
  const name = d.getElementById("orgFormName");
  name.value = "Northside 404 Club"; name.dispatchEvent(new w.Event("input"));
  ok("New shop: the ID and web address follow the name", d.getElementById("orgFormId").value === "northside-404-club" && d.getElementById("orgFormSubdomain").value === "northside404club");
  ok("…required fields are marked, Accent has a colour picker, and copying products is its own tick box (off)", d.querySelectorAll(".req").length === 3 && d.getElementById("orgFormAccentPick").type === "color" && d.getElementById("orgFormCopyProducts").checked === false);
  w.renderProductForm(d.getElementById("app"), "acme", null);
  ok("a new product starts hidden", d.getElementById("prodFormVisible") && d.getElementById("prodFormVisible").checked === false);
  d.getElementById("prodFormName") && (d.getElementById("prodFormName").value = "x");
  d.getElementById("prodFormName") && d.getElementById("prodFormName").dispatchEvent(new w.Event("input", { bubbles: true }));
  let asked = 0; autoConfirm(w, () => { asked++; return false; });
  const before = w.location.hash;
  w.location.hash = "#inventory";
  await new Promise(res => setTimeout(res, 30));
  ok("leaving a form with unsaved changes asks first (and stays on No)", asked === 1 && w.location.hash === before);
  autoConfirm(w, () => true);
  w.eval("window._prodFormDirty = false");
  await w.renderGlobalSettings(d.getElementById("app"));
  await wait(() => d.querySelector(".setup-item"));
  ok("Global settings has the Setup status list", d.querySelectorAll(".setup-item").length > 3 && /Setup status/.test(d.getElementById("setupStatusBox").textContent));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test144 crashed: false"); process.exit(1); });
