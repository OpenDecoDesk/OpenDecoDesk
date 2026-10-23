const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Three places where text chosen by someone else was used as if it were safe:
//   * A size is one the product LISTS. "toString" or "constructor" is something every JavaScript
//     object answers to, so a size by that name used to pass the check and price the line at $0.
//   * An order id comes from the browser. One called "constructor" used to break every order list
//     (and the daily roll-up) until the row was fixed by hand.
//   * The admin's screens take a shop (and product) id from the address bar. A screen is drawn only
//     for something that looks like an id, and never builds script out of that text.
// Real SQL (sql.js) + the real db.js / orders.js, and jsdom with the real index.html + admin.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + "\nreturn { priceItem, insertOrder, getOrderById, getOrdersByOrg, getOpenOrders, getOrdersForDigest, createProduct, byId_ };")();
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
const orders = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const getCatalogData = async () => ({ subdomainMap: { shipper: 'shipper' }, orgs: {} });\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const invalidateCatalogVersionCache = () => {};\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")(selectBox);

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const NAMES = ["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "toLocaleString"];

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('shipper','shipper','Shipper','t','t',1,0);`);
  await lib.createProduct(d1, "shipper", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20, L: 20 }, visible: true, weightOz: 6 });
  await lib.createProduct(d1, "shipper", { productId: "mug", type: "mug", name: "Mug", pricingMode: "flat", flatPrice: 12, visible: true });
  const env = { DB: d1, ...MAIL_ENV };
  global.fetch = async (url, init) => { if (captureMail(url, init, [])) return MAIL_OK; throw new Error("unexpected fetch " + url); };
  const place = async (orderId, items, extra) => {
    const res = await orders({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://shipper.example.com/api/orders", json: async () => Object.assign({ orderId, orgId: "shipper", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items }, extra), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const saved = (orderId) => lib.getOrderById(d1, orderId);
  const priced = async (...a) => { try { return await lib.priceItem(d1, "shipper", ...a); } catch (e) { return { error: e.message, userFacing: !!e.userFacing }; } };

  console.log("=== A size is one the product lists ===");
  ok("a listed size is priced from the product's own table", (await priced("tee", "M", 1)).unitPrice === 20);
  for (const size of [...NAMES, "__proto__"]) {
    const p = await priced("tee", size, 1);
    ok(`"${size}" is not a size (it used to be free)`, !!p.error && /not available/.test(p.error) && p.unitPrice === undefined);
  }
  ok("nor is a size that isn't text, or isn't there at all", !!(await priced("tee", ["M"], 1)).error && !!(await priced("tee", { toString: null }, 1)).error && !!(await priced("tee", 7, 1)).error && !!(await priced("tee", undefined, 1)).error);
  ok("a size is no longer than a size is, even where nothing lists the sizes (a flat-priced product)", (await priced("mug", "OSFA", 1)).unitPrice === 12 && (await priced("mug", "", 1)).unitPrice === 12 && !!(await priced("mug", "x".repeat(41), 1)).error);
  d1._raw.exec(`UPDATE products SET sizePricingCents = '{"M":2000,"L":"","XL":null,"S":0}' WHERE productId = 'tee'`);
  ok("a size listed with a blank price isn't sold for nothing; one priced $0 on purpose is", !!(await priced("tee", "L", 1)).error && !!(await priced("tee", "XL", 1)).error && (await priced("tee", "S", 1)).unitPrice === 0 && (await priced("tee", "M", 1)).unitPrice === 20);
  let r = await place("FREE-1", [{ productId: "tee", size: "toString", qty: 50 }]);
  ok("an order of 50 \"toString\" tees is refused, and nothing is saved", r.status === 400 && /not available/.test(r.body.message) && !(await saved("FREE-1")));
  r = await place("FREE-2", [{ productId: "tee", size: "M", qty: 1 }, { productId: "tee", size: "constructor", qty: 50 }]);
  ok("…also when it rides along with an honest line (which used to turn the order Paid)", r.status === 400 && !(await saved("FREE-2")));
  await lib.createProduct(d1, "shipper", { productId: "cfg", type: "shirt", name: "Build your own", pricingMode: "flat", flatPrice: 18, visible: true });
  d1._raw.exec(`UPDATE products SET configurable = 1 WHERE productId = 'cfg'`);
  const long = await priced("cfg", "", 1, false, { garmentColor: "x".repeat(61), locations: [] }), fits = await priced("cfg", "", 1, false, { garmentColor: "x".repeat(60), locations: [] });
  ok("a garment colour typed in is held to a colour's length", long.error === "Pick a garment color." && fits.error !== "Pick a garment color.");

  console.log("\n=== An order id is just an id ===");
  for (const id of NAMES) {
    r = await place(id, [{ productId: "tee", size: "M", qty: 1 }]);
    ok(`an order called "${id}" is refused`, r.status === 400 && r.body.message === "Invalid order ID");
  }
  r = await place(["ORD-1"], [{ productId: "tee", size: "M", qty: 1 }]);
  ok("so is an id that isn't text", r.status === 400 && r.body.message === "Invalid order ID");
  ok("a lookup by id holds only what was put in it", !("constructor" in lib.byId_()) && lib.byId_().toString === undefined && Object.getPrototypeOf(lib.byId_()) === null);
  // Belt and braces: even with such a row in the database (put there directly), the lists still load.
  for (const id of ["constructor", "toString"]) {
    await lib.insertOrder(d1, { orderId: id, orgId: "shipper", customerName: "Odd", contact: "o@x.com", placedAt: new Date().toISOString() },
      [{ productId: "tee", name: "Tee", type: "shirt", size: "M", qty: 2, unitPrice: 20 }]);
    await d1.prepare("INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method) VALUES (?, 500, 'x', ?, 'cash')").bind(id, new Date().toISOString()).run();
  }
  await place("ORD-OK", [{ productId: "tee", size: "M", qty: 1 }]);
  let listed = null, open = null, digest = null, err = "";
  try { listed = await lib.getOrdersByOrg(d1, "shipper"); open = await lib.getOpenOrders(d1); digest = await lib.getOrdersForDigest(d1, {}, new Date()); } catch (e) { err = String(e && e.message); }
  const odd = (listed || []).find(o => o.orderId === "constructor");
  ok("the shop's order list loads with an order called \"constructor\" in it", !err && !!listed && listed.length === 3 && !!odd && odd.items.length === 1 && odd.items[0].qty === 2 && odd.payments.length === 1);
  ok("…and so do the open-orders list and the roll-up's", !err && Array.isArray(open) && open.some(o => o.orderId === "toString") && !!digest);
  ok("an ordinary order next to them has its own lines and nothing borrowed", (listed || []).find(o => o.orderId === "ORD-OK").items.length === 1 && (listed || []).find(o => o.orderId === "ORD-OK").payments.length === 0);
  r = await place("ORD-OK", [{ productId: "tee", size: "M", qty: 3 }]);
  ok("the same order id twice is answered plainly (409), and the first order stands", r.status === 409 && /already been received/.test(r.body.message) && (await saved("ORD-OK")).items[0].qty === 1);

  console.log("\n=== The admin's Designs screen ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
      win.fetch = async (url, opts) => {
        const b = opts && opts.body ? JSON.parse(opts.body) : {};
        const good = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
        if (String(url).includes("/api/catalog")) return good({ status: "admin" });
        const design = { id: 1, orgId: "acme", name: "Front logo", hoopIds: [], personalizationHoopIds: [], stabilizer: "", notes: "" };
        switch (b.action) {
          case "listDesigns": return good({ designs: [design, { ...design, id: 9, name: "Shared mark", isGlobal: true }] });
          case "getDesign": return good({ design, versions: [] });
          case "listHoops": return good({ hoops: [] });
          case "listThreads": return good({ threads: [] });
          case "getCatalogIssues": return good({ orgs: {}, globalDesigns: {} });
          default: return good({});
        }
      };
    } });
  const w = dom.window, doc = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{orgId:"acme", name:"Acme"}]; window._adminOrgRegistry = adminOrgs;');
  const tick = (ms = 80) => new Promise(res => setTimeout(res, ms));
  const HOSTILE = '"><img src=x onerror="window.__xss=1">';
  w.location.hash = "#designs/" + encodeURIComponent(HOSTILE) + "/1";
  await w.adminRoute(); await tick();
  ok("a link to Designs whose shop isn't an id doesn't draw the screen, or anything from the link",
    !doc.getElementById("dsgList") && doc.querySelectorAll('img[src="x"]').length === 0 && w.__xss === undefined && !doc.body.innerHTML.includes("window.__xss"));
  for (const route of ["catalog/orgs/X/edit", "catalog/orgs/X/products", "catalog/orgs/X/products/new", "catalog/orgs/X/products/cap/edit", "catalog/orgs/acme/products/X/edit", "graphics/X"]) {
    w.location.hash = "#" + route.replace("X", encodeURIComponent(HOSTILE));
    await w.adminRoute(); await tick();
  }
  ok("the same goes for every catalog and graphics link that carries a shop or product id", doc.querySelectorAll('img[src="x"]').length === 0 && w.__xss === undefined && !doc.body.innerHTML.includes("window.__xss"));
  ok("an id is letters, digits, - and _ only", w.routeId_("league-101") === "league-101" && w.routeId_("A_b-9") === "A_b-9" && w.routeId_("a%20b") === null && w.routeId_("a'b") === null && w.routeId_("%E0%A4%A") === null && w.routeId_("") === null);
  w.location.hash = "#designs/newshop";
  await w.adminRoute(); await tick(150);
  ok("a shop made this session (not yet in the cached list) still opens", !!doc.getElementById("dsgList"));
  w.location.hash = "#designs/acme/1";
  await w.adminRoute(); await tick(150);
  const handlers = [...doc.querySelectorAll("#app [onclick]")].filter(b => b.dataset.org !== undefined);
  ok("for a shop it has, the screen opens with the list and the design", !!doc.getElementById("dsgList") && doc.querySelectorAll("#dsgList button[data-did]").length === 2 && /Front logo/.test(doc.getElementById("dsgDetail").textContent));
  ok("its buttons carry the shop as data and read it back; none has the shop written into its script", handlers.length >= 4 && handlers.every(b => b.dataset.org === "acme" && /this\.dataset\.org/.test(b.getAttribute("onclick")) && !/acme/.test(b.getAttribute("onclick"))));
  // Even handed such a shop id directly (past the router), the screen writes it as data, never as markup or script.
  await w.renderDesigns(doc.getElementById("app"), HOSTILE, 1); await tick(150);
  const after = [...doc.querySelectorAll("#app [data-org]")];
  ok("drawn with a hostile shop id, it stays text: no element made from it, no script run",
    after.length >= 4 && after.every(b => b.dataset.org === HOSTILE) && doc.querySelectorAll('#app img[src="x"]').length === 0 && w.__xss === undefined &&
    [...doc.querySelectorAll("#app [onclick]")].every(b => !/onerror|__xss/.test(b.getAttribute("onclick"))));
  ok("no handler in admin.js is built by quoting a shop id into script any more", !/onclick="[^"]*'\$\{orgId\.replace\(/.test(adminJs) && !/onclick="[^"]*'\$\{escapeHtml\(orgId\)\}'/.test(adminJs));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("test113 crashed:", false); console.error(e); process.exit(1); });
