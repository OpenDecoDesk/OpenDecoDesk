const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// "Ready to decorate": the shop page and the admin show, for a product's color + size, how many of its
// linked blank are on the shelf and not set aside for orders (getBlankReadyByOrg). Finished stock ("N in
// stock") still wins when there is some. Display only — nothing is reserved by it. Real db.js / orders.js /
// catalog.js on sql.js; the shop page and the admin Products list in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, createTransfer, createGraphic, setBlankLink, insertOrder, settleOrderBalance,
  getBlankReadyByOrg, getReadyToShipByOrg, getPublicCatalogData, useBlanksFromStock: typeof useBlanksFromStock === "function" ? useBlanksFromStock : null };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const call = async (body, { role = "staff" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "club" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };

  // A tee blank in Navy (M 6, L 0) and Red (M 0); a cap blank (OSFA 9); a testing blank (5 on hand).
  const tee = (await lib.createBlank(d1, { name: "Gildan 5000", productType: "shirt", colors: [
    { color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 3, quantity: 6 }, { size: "L", purchasePrice: 3, quantity: 0 }] },
    { color: "Red", images: [], sizes: [{ size: "M", purchasePrice: 3, quantity: 0 }] }] })).id;
  const cap = (await lib.createBlank(d1, { name: "CP86 Cap", productType: "cap", colors: [{ color: "Royal", images: [], sizes: [{ size: "OSFA", purchasePrice: 4, quantity: 9 }] }] })).id;
  const tst = (await lib.createBlank(d1, { name: "Scrap tee", productType: "shirt", colors: [{ color: "White", images: [], sizes: [{ size: "M", purchasePrice: 1, quantity: 5 }] }] })).id;
  d1._raw.exec(`UPDATE blanks SET forTesting = 1 WHERE id = ${tst}`);

  // Plain sized tee (Navy blank), a configurable polo (Navy / Red), a flat cap, a product on the testing blank,
  // and a "no blank needed" patch that still has a link.
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { M: 20, L: 20 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "club", "tee", "", "M", tee, "Navy", "M");
  await lib.setBlankLink(d1, "club", "tee", "", "L", tee, "Navy", "L");
  const t = await lib.createTransfer(d1, { name: "Crest sheet" });
  const g = await lib.createGraphic(d1, "club", { name: "Crest", kind: "transfer", transferId: t, tier: null });
  await lib.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Club Polo", pricingMode: "sized", sizePricing: { M: 30 }, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Red"], locations: [{ key: "front", label: "Front", graphicIds: [g] }], images: [], features: [] });
  await lib.setBlankLink(d1, "club", "polo", "Navy", "M", tee, "Navy", "M");
  await lib.setBlankLink(d1, "club", "polo", "Red", "M", tee, "Red", "M");
  await lib.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "club", "cap", "", "OSFA", cap, "Royal", "OSFA");
  await lib.createProduct(d1, "club", { productId: "scrap", type: "shirt", name: "Scrap Tee", pricingMode: "sized", sizePricing: { M: 5 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "club", "scrap", "", "M", tst, "White", "M");
  await lib.createProduct(d1, "club", { productId: "patch", type: "shirt", name: "Patch", pricingMode: "sized", sizePricing: { M: 8 }, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  await lib.setBlankLink(d1, "club", "patch", "", "M", tee, "Navy", "M");

  console.log("=== The count ===");
  let ready = await lib.getBlankReadyByOrg(d1, "club");
  ok("a plain sized product: the linked blank's free stock per size (color '')", ready.tee && ready.tee[""].M === 6 && !("L" in ready.tee[""]));
  ok("a configurable product: per garment color — Navy M has 6, Red M none", ready.polo && ready.polo.Navy.M === 6 && !ready.polo.Red);
  ok("the same blank counts for every product that uses it", ready.tee[""].M === ready.polo.Navy.M);
  ok("a flat product's count is under size ''", ready.cap && ready.cap[""][""] === 9);
  ok("blanks kept for testing are left out", !ready.scrap);
  ok("products made with no blank are left out", !ready.patch);

  // An order for 4 Navy M tees whose blanks are in (taken from stock): those 4 are set aside.
  await lib.insertOrder(d1, { orderId: "A", orgId: "club", customerName: "C", contact: "c@x.com", paymentMethod: "Venmo", placedAt: "2026-10-01T15:00:00.000Z" },
    [{ productId: "tee", name: "Club Tee", type: "shirt", size: "M", qty: 4, unitPrice: 20 }]);
  await lib.settleOrderBalance(d1, "A", "test");
  const r0 = await call({ action: "useBlanksFromStock", orderId: "A" });
  ready = await lib.getBlankReadyByOrg(d1, "club");
  ok("blanks set aside for an order don't count — 6 on hand, 4 promised, 2 ready", r0.status === 200 && ready.tee[""].M === 2 && ready.polo.Navy.M === 2);
  d1._raw.exec(`UPDATE blank_sizes SET quantity = 4 WHERE blankId = ${tee} AND color = 'Navy' AND size = 'M'`);
  ready = await lib.getBlankReadyByOrg(d1, "club");
  ok("when everything on the shelf is promised, nothing shows", !ready.tee && !ready.polo);
  d1._raw.exec(`UPDATE blank_sizes SET quantity = 7 WHERE blankId = ${tee} AND color = 'Navy' AND size = 'M'`);

  console.log("\n=== The admin action ===");
  let r = await call({ action: "getBlankReadyCounts" }, { role: "staff" });
  ok("a worker can read the counts (they're on the Products list)", r.status === 200 && r.body.ready.tee[""].M === 3);
  r = await call({ action: "getBlankReadyCounts", org: "" });
  ok("…and the shop must be named", r.status === 400);

  console.log("\n=== The shop's catalog answer ===");
  const catalogGet = new Function("L", strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "let _data, _fail = false; const getCatalogData = async () => _data;\n" +
    "const getReadyToShipByOrg = (db, o) => L.getReadyToShipByOrg(db, o);\n" +
    "const getBlankReadyByOrg = async (db, o) => { if (_fail) throw new Error('boom'); return L.getBlankReadyByOrg(db, o); };\n" +
    strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet, set: (d) => { _data = d; }, fail: (f) => { _fail = f; } };")(lib);
  catalogGet.set(await lib.getPublicCatalogData(d1));
  const get = async () => JSON.parse(await (await catalogGet.onRequestGet({ request: { url: "https://club.example.com/api/catalog" }, env: { DB: d1 } })).text());
  let sent = await get();
  const prod = (id) => sent.catalog.products.find(p => p.productId === id || p.id === id);
  ok("each product carries blankStock (color → size → n)", prod("tee").blankStock[""].M === 3 && prod("polo").blankStock.Navy.M === 3 && prod("cap").blankStock[""][""] === 9);
  ok("a product with none says null", prod("scrap").blankStock === null);
  catalogGet.fail(true);
  const ce = console.error; console.error = () => {};
  sent = await get();
  console.error = ce;
  ok("if the count can't be read the page still loads, just without badges", sent.status === "ok" && prod("tee").blankStock === null);
  catalogGet.fail(false);

  console.log("\n=== The shop page ===");
  // Finished stock on the cap: 2 decorated pieces win over 9 blanks.
  d1._raw.exec(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt) VALUES ('club','cap','',2,'t')`);
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: "usable", url: "https://club.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url) => { const res = await catalogGet.onRequestGet({ request: { url: win.location.origin + url }, env: { DB: d1 } });
      const text = await res.text(); return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text }; }; } });
  const w = dom.window, doc = w.document;
  await tick(250);
  const badge = (id) => (doc.getElementById("stock-" + id) || { textContent: "" }).textContent.trim();
  ok("a plain tee shows 'Ships faster — in stock' for its first size (M)", badge("tee") === "Ships faster — in stock" && doc.querySelector("#stock-tee .ready-badge"));
  const sizeSel = doc.getElementById("size-tee");
  sizeSel.value = "L"; sizeSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("switching to a size with none hides it", badge("tee") === "");
  sizeSel.value = "M"; sizeSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("…and back shows it again", badge("tee") === "Ships faster — in stock");
  ok("finished stock wins: the cap says '2 in stock', not its 9 blanks", badge("cap") === "2 in stock" && doc.querySelector("#stock-cap .stock-badge"));
  ok("a configurable polo shows the badge for its first color (Navy M)", badge("polo") === "Ships faster — in stock");
  const red = [...doc.querySelectorAll("#gcolorwrap-polo .cfg-swatch")].find(b => b.dataset.color === "Red");
  red.click();
  ok("picking a color with none (Red) hides it", badge("polo") === "");
  [...doc.querySelectorAll("#gcolorwrap-polo .cfg-swatch")].find(b => b.dataset.color === "Navy").click();
  ok("…and picking Navy again shows it", badge("polo") === "Ships faster — in stock");
  ok("a product with no count has no badge", badge("scrap") === "");

  console.log("\n=== The admin Products list ===");
  const adminJs = read("public/admin.js");
  class L2 extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const adom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L2(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.localStorage.setItem("pcwAdminKey", "cookie");
      win.fetch = async (url, init) => {
        if (String(url).includes("/api/catalog")) return { ok: true, status: 200, json: async () => ({ status: "admin" }) };
        const body = init && init.body ? JSON.parse(init.body) : {};
        const r = await call(body, { role: "admin" });
        return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
      }; } });
  const aw = adom.window, adoc = aw.document;
  // Wait for admin.js itself (a fixed pause wasn't enough when the whole suite runs at once), then for the list.
  for (let i = 0; i < 500 && aw.eval("typeof renderProductList") !== "function"; i++) await tick(20);
  aw.eval("adminKey = 'cookie'");
  aw.eval('renderProductList(document.getElementById("app"), "club")');
  for (let i = 0; i < 300 && !adoc.querySelector(".prod-ready"); i++) await tick(20);
  await tick(400);
  const line = (id) => (adoc.querySelector(`.prod-ready[data-product="${id}"]`) || { textContent: "", innerHTML: "" });
  ok("each product with blanks on the shelf says 'Ready to decorate: N blanks'", /Ready to decorate: 3 blanks/.test(line("tee").textContent) && /Ready to decorate: 9 blanks/.test(line("cap").textContent));
  ok("…configurable products too, totalled over their colors", /Ready to decorate: 3 blanks/.test(line("polo").textContent));
  ok("…with the color / size breakdown on hover", /Navy M 3/.test(line("polo").innerHTML));
  ok("…and nothing for a product with none", line("scrap").textContent === "");

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test143 crashed: false"); process.exit(1); });
