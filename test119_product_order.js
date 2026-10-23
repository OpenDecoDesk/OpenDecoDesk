const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// The admin's Products list mirrors the shop's page: a section per category (in the managed order),
// the products in each in the order customers see them — and ↑ ↓ to rearrange. Real SQL (sql.js), real
// db.js + orders.js admin API, the real catalog answer, and the real screen in jsdom.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getProductsByOrg, setProductOrder, saveProductCategory, getPublicCatalogData };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendInvoiceEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const tick = (ms) => new Promise(res => setTimeout(res, ms || 60));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1), ('guild','guild','Guild','t','t',1);`);
  // Several products all left at sort order 0 (how most were created), across three categories.
  const mk = (org, productId, type, name, extra = {}) => lib.createProduct(d1, org, Object.assign({ productId, type, name, pricingMode: "flat", flatPrice: 10, visible: true, sortOrder: 0 }, extra));
  await mk("club", "cap-a", "cap", "Cap A");
  await mk("club", "polo-a", "shirt", "Polo A");
  await mk("club", "polo-b", "shirt", "Polo B");
  await mk("club", "polo-c", "shirt", "Polo C", { visible: false });
  await mk("club", "patch-a", "patch", "Patch A");
  await mk("club", "cap-b", "cap", "Cap B");
  await mk("guild", "tee", "shirt", "Guild Tee");
  const ids = async (org = "club") => (await lib.getProductsByOrg(d1, org, false)).map(p => p.productId);
  const orders = () => Object.fromEntries(d1.q("SELECT productId, sortOrder FROM products WHERE orgId='club'").map(r => [r.productId, r.sortOrder]));

  console.log("=== db.js: setProductOrder ===");
  console.log("before: all at 0, listed by id:", (await ids()).join() === "cap-a,cap-b,patch-a,polo-a,polo-b,polo-c");
  let changed = await lib.setProductOrder(d1, "club", ["polo-b", "polo-a", "polo-c", "cap-a", "cap-b", "patch-a"]);
  console.log("the list is saved in the order given:", (await ids()).join() === "polo-b,polo-a,polo-c,cap-a,cap-b,patch-a" && changed === 6);
  console.log("numbers go up in tens (room to slot one in from its form):", Object.entries(orders()).sort().join(";") === "cap-a,40;cap-b,50;patch-a,60;polo-a,20;polo-b,10;polo-c,30");
  changed = await lib.setProductOrder(d1, "club", ["polo-a", "polo-b", "polo-c", "cap-a", "cap-b", "patch-a"]);
  console.log("only the rows that moved are written:", changed === 2 && (await ids()).join() === "polo-a,polo-b,polo-c,cap-a,cap-b,patch-a");
  const refuse = async (list) => { try { await lib.setProductOrder(d1, "club", list); return ""; } catch (e) { return e.message; } };
  console.log("a list missing a product is refused, nothing half-applied:", /list changed/.test(await refuse(["polo-b", "polo-a", "polo-c", "cap-a", "cap-b"])) && (await ids())[0] === "polo-a");
  console.log("...so is one with a product that isn't the shop's:", /list changed/.test(await refuse(["polo-a", "polo-b", "polo-c", "cap-a", "cap-b", "tee"])));
  console.log("...and one that names a product twice:", /list changed/.test(await refuse(["polo-a", "polo-a", "polo-c", "cap-a", "cap-b", "patch-a"])));
  console.log("another shop's products are untouched:", d1.q("SELECT sortOrder FROM products WHERE orgId='guild'")[0].sortOrder === 0);

  console.log("\n=== Real admin API ===");
  let r = await call({ action: "setProductOrder", org: "club", productIds: ["polo-b", "polo-a", "polo-c", "cap-a", "cap-b", "patch-a"], moved: "polo-b" });
  console.log("setProductOrder saves it and answers with the products in their new order:", r.status === 200 && r.body.products.map(p => p.productId).join() === "polo-b,polo-a,polo-c,cap-a,cap-b,patch-a");
  console.log("the change is audited:", d1.q("SELECT count(*) n FROM audit_log WHERE action='products.reordered' AND orgId='club'")[0].n === 1);
  r = await call({ action: "setProductOrder", org: "club", productIds: ["polo-b"] });
  console.log("a stale list is refused (409) with a reason:", r.status === 409 && /reload/.test(r.body.message));
  r = await call({ action: "setProductOrder", org: "club" });
  console.log("the list is required:", r.status === 400);
  // What the shop's page will show follows the same order.
  const pub = await lib.getPublicCatalogData(d1);
  console.log("the storefront's catalog lists the visible products in that order:", pub.orgs.club.products.map(p => p.productId).join() === "polo-b,polo-a,cap-a,cap-b,patch-a");

  // ---- The Products screen ----------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o2){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o2); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) { const b = JSON.parse(opts.body); sent.push(b); const res = await call(b); return { ok: res.status < 400, status: res.status, json: async () => res.body }; }
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
    } });
  const w = dom.window, doc = w.document;
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "x";');
  w._adminOrgRegistry = [{ orgId: "club", name: "Club" }];
  const app = doc.getElementById("app");
  const settle = async (pred) => { for (let i = 0; i < 80 && !pred(); i++) await tick(25); };
  await w.renderProductList(app, "club");
  await settle(() => app.querySelector(".prod-cat-table"));
  const heads = () => [...app.querySelectorAll(".prod-cat-heading")].map(h => h.textContent.replace(/\s+/g, " ").trim());
  const rowsOf = (key) => [...app.querySelectorAll(`.prod-cat-table[data-category="${key}"] tbody tr`)].map(tr => tr.querySelector(".stack-title").firstChild.textContent.trim());
  const arrowsOf = (id) => [...app.querySelectorAll(`.prod-move[data-product="${id}"]`)];

  console.log("\n=== Admin: Products, as the shop's page shows them ===");
  console.log("a section per category, under the storefront's heading, in the managed order:", heads().join("|") === "Shirts (3)|Caps (2)|Patches (1)");
  console.log("each section lists its products in the saved order:", rowsOf("shirt").join() === "Polo B,Polo A,Polo C" && rowsOf("cap").join() === "Cap A,Cap B" && rowsOf("patch").join() === "Patch A");
  console.log("a hidden product is still listed, after the section's visible ones (marked Hidden, dimmed):", /Hidden/.test(app.querySelector(`.prod-cat-table[data-category="shirt"] tbody tr:nth-child(3)`).textContent)
    && /opacity/.test(app.querySelector(`.prod-cat-table[data-category="shirt"] tbody tr:nth-child(3)`).getAttribute("style") || ""));
  console.log("the page explains the order and where the sections come from:", /Listed the way the shop's page shows them/.test(app.textContent) && /Product categories/.test(app.textContent));
  console.log("every row has an up and a down arrow, named for screen readers:", arrowsOf("polo-a").length === 2 && arrowsOf("polo-a")[0].getAttribute("aria-label") === "Move Polo A up" && arrowsOf("polo-a")[1].getAttribute("aria-label") === "Move Polo A down");
  console.log("the first in a section can't go up; the last VISIBLE one can't go down:", arrowsOf("polo-b")[0].disabled && !arrowsOf("polo-b")[1].disabled && !arrowsOf("polo-a")[0].disabled && arrowsOf("polo-a")[1].disabled);
  console.log("a lone hidden product has nowhere to go (it never trades places with a visible one):", arrowsOf("polo-c").every(b => b.disabled));
  console.log("a section with one product has both arrows off:", arrowsOf("patch-a").every(b => b.disabled));

  sent.length = 0;
  arrowsOf("polo-a")[0].click();
  await settle(() => rowsOf("shirt")[0] === "Polo A");
  const req = sent.find(b => b.action === "setProductOrder");
  console.log("↑ moves the product up one place in its section and saves it:", rowsOf("shirt").join() === "Polo A,Polo B,Polo C" && (await ids()).join() === "polo-a,polo-b,polo-c,cap-a,cap-b,patch-a");
  console.log("the whole shop's order is sent, sections in the shop's order:", req && req.productIds.join() === "polo-a,polo-b,polo-c,cap-a,cap-b,patch-a" && req.moved === "polo-a");
  console.log("it says the shop's page needs a Publish:", /Order saved\. Click Publish/.test(doc.getElementById("publishStatus").textContent));
  console.log("the keyboard stays on the product that was moved:", doc.activeElement && doc.activeElement.dataset.product === "polo-a");
  arrowsOf("cap-a")[1].click();
  await settle(() => rowsOf("cap")[0] === "Cap B");
  console.log("↓ moves one down; other sections don't change:", rowsOf("cap").join() === "Cap B,Cap A" && rowsOf("shirt").join() === "Polo A,Polo B,Polo C" && (await ids()).join() === "polo-a,polo-b,polo-c,cap-b,cap-a,patch-a");
  arrowsOf("polo-a")[1].click();
  await settle(() => rowsOf("shirt")[0] === "Polo B");
  console.log("one press always changes what customers see (it never just hops over a hidden product):", rowsOf("shirt").join() === "Polo B,Polo A,Polo C");
  console.log("at the end of the visible ones the down arrow turns off:", arrowsOf("polo-a")[1].disabled === true);
  const before = (await ids()).join();
  await w.moveProduct_("club", "polo-a", 1);
  console.log("asking to move past the end does nothing:", (await ids()).join() === before);
  // A hidden product whose number puts it FIRST is still listed last, and the next move files it there.
  d1._raw.run("UPDATE products SET sortOrder=1 WHERE orgId='club' AND productId='polo-c'");
  await w.renderProductList(app, "club");
  await settle(() => rowsOf("shirt").length === 3);
  console.log("a hidden product is listed last whatever its number:", rowsOf("shirt").join() === "Polo B,Polo A,Polo C" && (await ids())[0] === "polo-c");
  arrowsOf("polo-a")[0].click();
  await settle(() => rowsOf("shirt")[0] === "Polo A");
  console.log("...and the next move saves the list as it's shown (visible first):", (await ids()).slice(0, 3).join() === "polo-a,polo-b,polo-c");
  await call({ action: "setProductVisible", org: "club", productId: "polo-b", visible: false });
  await w.renderProductList(app, "club");
  await settle(() => rowsOf("shirt")[1] === "Polo B");
  console.log("two hidden products can be re-ordered between themselves:", rowsOf("shirt").join() === "Polo A,Polo B,Polo C" && !arrowsOf("polo-b")[1].disabled && arrowsOf("polo-b")[0].disabled && arrowsOf("polo-a").every(b => b.disabled));
  await call({ action: "setProductVisible", org: "club", productId: "polo-b", visible: true });
  await w.renderProductList(app, "club");
  await settle(() => !arrowsOf("polo-a")[1].disabled);

  // The list changed in another tab (a product was added): the move is refused and the page reloads the truth.
  await mk("club", "polo-d", "shirt", "Polo D", { sortOrder: 5 });
  arrowsOf("polo-a")[1].click();
  await settle(() => rowsOf("shirt").includes("Polo D"));
  console.log("if the list changed elsewhere, the move is refused and the real list is shown:", rowsOf("shirt")[0] === "Polo D" && rowsOf("shirt").length === 4);

  // Category order drives the section order — as on the shop's page.
  await lib.saveProductCategory(d1, { key: "patch", name: "Patch", plural: "Patches", packAs: "other", sortOrder: 0 });
  await w.loadProductCategories_(true);
  await w.renderProductList(app, "club");
  await settle(() => heads()[0] && /^Patches/.test(heads()[0]));
  console.log("re-ordering the categories re-orders the sections:", heads().map(h => h.replace(/ \(\d+\)/, "")).join("|") === "Patches|Shirts|Caps");
  d1._raw.run("UPDATE products SET type='mystery' WHERE orgId='club' AND productId='cap-a'");
  await w.renderProductList(app, "club");
  await settle(() => heads().length === 4);
  console.log("a product whose category was deleted still shows, in its own section at the end:", /^Mysterys? \(1\)/.test(heads()[3]) && rowsOf("mystery").join() === "Cap A");
  console.log("the Products screen and the shop's page group the same way (one helper each, same rule):",
    /function groupProductsByCategory_/.test(adminJs) && /Mirrors renderOrgPage/.test(adminJs));
})().catch(e => { console.error(e); console.log("test119 ran to the end without crashing: false"); process.exitCode = 1; });
