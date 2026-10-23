const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Discard unpublished changes: a shop goes back to its last publish — settings and products as published; a product
// added since is deleted with its links (or hidden when something already refers to it). The shop bar's button and its
// window in jsdom against the real admin API.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, getProductsByOrg, publishShop, updateProduct };`)();
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
  const tee = (await lib.createBlank(d1, { name: "Tee A", productType: "shirt", colors: [{ color: "Black", images: [], sizes: [{ size: "S", quantity: 0, purchasePrice: 5 }] }] })).id;
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 15, visible: true });

  let r = await call({ action: "previewDiscardShopChanges", org: "acme" });
  ok("a shop never published has nothing to go back to", r.status === 409 && /hasn't been published/.test(r.body.message));
  await call({ action: "publish", org: "acme" });
  r = await call({ action: "previewDiscardShopChanges", org: "acme" });
  ok("just published: nothing to discard", r.status === 200 && !r.body.plan.anything);

  // Draft changes: the cap's price and name, the shop's name, a new product with a blank link, and one already used.
  d1._raw.exec(`UPDATE products SET flatPriceCents=1900, name='Cap (new)', updatedAt='x' WHERE productId='cap'; UPDATE orgs SET name='Acme Renamed', updatedAt='x' WHERE orgId='acme';`);
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "New tee", pricingMode: "sized", sizePricing: { S: 20 }, visible: true });
  await lib.setBlankLink(d1, "acme", "tee", "", "S", tee, "Black", "S");
  await lib.createProduct(d1, "acme", { productId: "used", type: "shirt", name: "Used tee", pricingMode: "sized", sizePricing: { S: 20 }, visible: true });
  d1._raw.exec(`INSERT INTO finished_goods_movements (orgId, productId, qtyDelta, kind, occurredAt, createdAt) VALUES ('acme','used',2,'adjust','t','t');`);
  r = await call({ action: "previewDiscardShopChanges", org: "acme" });
  const plan = r.body.plan;
  ok("the preview lists what goes back (shop settings, the cap and which fields) and what was added since",
    plan.anything && plan.shopChanged && plan.shopFields.includes("name") && plan.restore.length === 1 && plan.restore[0].productId === "cap" &&
    plan.restore[0].fields.includes("flatPriceCents") && !plan.restore[0].fields.includes("updatedAt") &&
    plan.added.find(a => a.productId === "tee" && !a.history) && plan.added.find(a => a.productId === "used" && a.history));
  ok("…and it doesn't send the raw rows", !plan.snap && !plan.live);

  // The shop bar's Discard changes… button.
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.scrollTo = () => {}; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Acme" }];`);
  const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  const text = (el) => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  w.location.hash = "#catalog/orgs/acme/products/tee/edit";
  await until(() => d.querySelector(".shop-bar-discard"));
  ok("the shop bar offers Discard changes… beside Publish changes when a shop has unpublished changes", !!d.querySelector(".shop-bar-discard") && /Publish changes/.test(text(d.querySelector(".shop-bar-pub"))));
  d.querySelector(".shop-bar-discard").click();
  await until(() => d.getElementById("dcGo"));
  const win = text(d.querySelector(".discard-list"));
  ok("its window says what goes back, what's deleted and what's only hidden", /Shop settings/.test(win) && /Cap \(new\)|Cap goes back/.test(win) && /New tee was added since and is deleted/.test(win) && /Used tee .*hidden/.test(win));
  d.getElementById("dcGo").click();
  await until(() => !d.getElementById("dcGo") && /#catalog\/orgs\/acme\/products$/.test(w.location.hash));
  const prods = d1.q("SELECT productId, name, flatPriceCents, visible FROM products WHERE orgId='acme' ORDER BY productId");
  ok("Discard puts the cap back as published (name and price)", prods.find(p => p.productId === "cap").name === "Cap" && prods.find(p => p.productId === "cap").flatPriceCents === 1500);
  ok("…and the shop's settings", d1.q("SELECT name FROM orgs WHERE orgId='acme'")[0].name === "Acme");
  ok("…deletes the new product with its blank links", !prods.find(p => p.productId === "tee") && !d1.q("SELECT 1 FROM product_blank_links WHERE productId='tee'").length);
  ok("…hides the one something already refers to, instead of deleting it", prods.find(p => p.productId === "used").visible === 0);
  ok("…and the page left the deleted product for the Products list", /#catalog\/orgs\/acme\/products$/.test(w.location.hash));
  ok("it's audited with the deleted rows", d1.q("SELECT detail FROM audit_log WHERE action='catalog.changes_discarded'").some(a => /New tee/.test(a.detail)));
  const st = (await call({ action: "getPublishState" })).body;
  const acme = st.publishState.acme;
  ok("only the hidden product is still unpublished", acme && acme.state === "changed" && acme.changedProducts.join() === "used" && !acme.shopChanged);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
