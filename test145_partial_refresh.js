const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Partial refresh (2026-10): after an action the admin screens update in place instead of rebuilding the page —
// the filters, scroll, ticked rows and open sections stay, and what changed is highlighted. Run Order: a machine
// pick redraws only that card; Start / Mark done refill the cards without a page rebuild. Orders: every action's
// refresh keeps the filter bar and the ticked orders (and the bulk bar). Products: show / hide refills the table
// in place; saving a product returns to the list with it highlighted. Communications: Refresh refills in place.
// Real db.js / orders.js on sql.js; the real admin page in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct, createBlank, setBlankLink, createHoop, saveDesign, addDesignVersion, setProductDesign, saveMachine };`)();
const fileUpload = strip(read("functions/_lib/fileUpload.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + fileUpload + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
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
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p && p.then ? p.then(() => {}, () => {}) : null,
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true });
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 18 }, visible: true, noDesignNeeded: true });
  const blankId = (await lib.createBlank(d1, { name: "Richardson 112", brand: "Richardson", color: "Navy", productType: "cap" })).id;
  await lib.setBlankLink(d1, "acme", "cap", "OSFA", blankId, "OSFA");
  const hoop = await lib.createHoop(d1, { name: "Cap Frame", isCapFrame: true });
  const designId = await lib.saveDesign(d1, "acme", { name: "Logo", stabilizer: "cutaway", hoopId: hoop });
  await lib.addDesignVersion(d1, designId, { designFileKey: "designs/1/a.emb", designFileName: "a.emb", designFileExt: "emb", machineFileKey: "designs/1/a.dst", machineFileName: "a.dst", machineFileExt: "dst", threadColors: [] });
  await lib.setProductDesign(d1, "acme", "cap", designId);
  await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [hoop] });
  await lib.saveMachine(d1, { name: "Machine 2", needleCount: 15, hoopIds: [hoop] });
  for (const id of ["R1", "R2"]) {
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Cust " + id, contact: id + "@x.com", placedAt: recent }, [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
    d1._raw.run("UPDATE orders SET paid=1, blankReceivedAt=? WHERE orderId=?", [recent, id]);
  }

  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/#orders/acme", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") }; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: false, status: 404, json: async () => ({ status: "error" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Acme" }];');
  const app = d.getElementById("app");
  const org = { orgId: "acme", name: "Acme" };

  console.log("=== Run Order: a machine pick redraws one card; actions refill in place ===");
  await w.renderRunOrder(app);
  await wait(() => d.querySelectorAll(".run-job-card").length === 2);
  const cards = [...d.querySelectorAll(".run-job-card")], roBody = d.getElementById("roBody");
  ok("two cards, each with a machine picker", cards.length === 2 && cards.every(c => c.querySelector(".run-machine-select")));
  ok("the queue box keeps its scroll by name", roBody.getAttribute("data-keep-scroll") === "runorder");
  sent.length = 0;
  const sel = cards[0].querySelector(".run-machine-select");
  const other = [...sel.options].find(o => !o.selected);
  sel.value = other.value; sel.dispatchEvent(new w.Event("change"));
  const cardsNow = [...d.querySelectorAll(".run-job-card")];
  ok("picking another machine redraws only that card — no server call, the other card untouched", !sent.length && cardsNow[1] === cards[1] && cardsNow[0] !== cards[0] &&
    cardsNow[0].querySelector(".run-machine-select").value === other.value && d.getElementById("roBody") === roBody);
  const start = cardsNow[0].querySelector(".run-start-btn");
  start.click();
  await wait(() => d.querySelector(".run-complete-btn"));
  ok("Start refills the cards in place — the same page and queue box, the card now running", d.getElementById("roBody") === roBody && !!d.querySelector(".run-complete-btn") &&
    sent.some(b => b.action === "startRun") && !/Loading/.test(roBody.textContent));

  console.log("\n=== Orders: an action's refresh keeps the filters and the ticked orders ===");
  await w.renderAdminOrders(app, org);
  await wait(() => d.querySelectorAll(".order-select").length >= 2);
  const filterBar = d.querySelector(".orders-filter-bar"), fromInput = d.getElementById("ordFilterFrom");
  const tick = [...d.querySelectorAll(".order-select")].find(cb => cb.dataset.order === "R1");
  tick.checked = true; tick.dispatchEvent(new w.Event("change"));
  ok("ticking an order shows the bulk bar", d.getElementById("bulkBar").style.display !== "none");
  ok("every order's tick is named so a refresh can put it back", tick.getAttribute("data-keep-check") === "ord:acme|R1");
  d1._raw.run("UPDATE orders SET manufacturedAt=? WHERE orderId='R2'", [recent]);
  sent.length = 0;
  await w.refreshOrdersInPlace_(org);
  const tickAfter = [...d.querySelectorAll(".order-select")].find(cb => cb.dataset.order === "R1");
  ok("the refresh re-reads the orders but keeps the filter bar (same elements)", sent.some(b => b.action === "getOrders") && d.querySelector(".orders-filter-bar") === filterBar && d.getElementById("ordFilterFrom") === fromInput);
  ok("…the ticked order is still ticked, and the bulk bar still shows", tickAfter && tickAfter.checked && d.getElementById("bulkBar").style.display !== "none");
  ok("…the order that changed is highlighted, the other isn't", !!d.querySelector('tr[data-order="R2"].row-flash') && !d.querySelector('tr[data-order="R1"].row-flash'));
  ok("no action rebuilds the Orders page any more (only opening a shop does)", (adminJs.match(/renderAdminOrders\(document\.getElementById\("app"\)/g) || []).length === 1);

  console.log("\n=== Products: show / hide refills the table in place; saving returns to the same place ===");
  await w.renderProductList(app, "acme");
  await wait(() => d.querySelector('tr[data-product-row="tee"]'));
  const hero = d.querySelector(".org-hero");
  await w.toggleProductVisible("acme", "tee", false);
  ok("hiding a product redraws the table, not the page — and highlights it", d.querySelector(".org-hero") === hero && d.querySelector('tr[data-product-row="tee"]').classList.contains("row-flash") &&
    /opacity:\s*\.6|opacity: 0.6/.test(d.querySelector('tr[data-product-row="tee"]').getAttribute("style") || ""));
  w._productListReturn = { orgId: "acme", productId: "cap" };
  await w.renderProductList(app, "acme");
  await wait(() => d.querySelector('tr[data-product-row="cap"]'));
  ok("back from saving a product, the list highlights it", d.querySelector('tr[data-product-row="cap"]').classList.contains("row-flash") && w._productListReturn === null);

  console.log("\n=== Communications: Refresh refills in place ===");
  await w.renderCommunications(app);
  await wait(() => !/Loading/.test((d.getElementById("commsBody") || {}).textContent || "Loading"));
  const commsBody = d.getElementById("commsBody");
  await w.refreshComms_();
  ok("Refresh keeps the page (same body element) instead of rebuilding it", d.getElementById("commsBody") === commsBody && !/Loading…/.test(commsBody.textContent));

  console.log("\n=== A highlight never breaks the page ===");
  let threw = false; try { w.flashRows_(['tr[data-order="x"y"]']); } catch (e) { threw = true; }
  ok("a bad selector is skipped, not thrown", !threw);
  ok("attrSel_ escapes quotes and backslashes for an attribute selector", w.attrSel_('a"b\\c') === 'a\\"b\\\\c');

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test133 crashed: false"); process.exit(1); });
