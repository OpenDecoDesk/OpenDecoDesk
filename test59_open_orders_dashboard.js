const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Admin home dashboard: every open order across all shops — not completed, not voided, not a
// test, not fully cancelled. Real SQL (sql.js) + real db.js, orders.js and admin.js (jsdom).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, voidOrder, getOpenOrders, getOrdersByOrg };")();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t'), ('rec','rec','REC','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));

  const add = (orderId, orgId, days, extra = {}, items) => lib.insertOrder(d1, Object.assign({ orderId, orgId, customerName: "Cust " + orderId,
    contact: orderId.toLowerCase() + "@x.com", paymentMethod: "Venmo", placedAt: daysAgo(days) }, extra),
    items || [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 2, unitPrice: 23 }]);
  const pay = (orderId) => { d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method) VALUES (?, 4600, ?, 'venmo')", [orderId, daysAgo(1)]); d1._raw.run("UPDATE orders SET paid=1, paidAt=? WHERE orderId=?", [daysAgo(1), orderId]); };
  await add("UNPAID1", "prime", 3);
  await add("PAID1", "rec", 30); pay("PAID1");
  await add("SHIP1", "prime", 12); pay("SHIP1"); d1._raw.run("UPDATE orders SET manufacturedAt=?, shippedAt=? WHERE orderId='SHIP1'", [daysAgo(5), daysAgo(2)]);
  await add("DONE1", "prime", 40); pay("DONE1"); d1._raw.run("UPDATE orders SET deliveredAt=?, completedAt=? WHERE orderId='DONE1'", [daysAgo(20), daysAgo(19)]);
  await add("VOID1", "rec", 8); await lib.voidOrder(d1, "VOID1", "duplicate");
  await add("TEST-1", "prime", 2, { isTest: true });
  await add("CANC1", "prime", 6); d1._raw.run("UPDATE order_items SET cancelDate=? WHERE orderId='CANC1'", [daysAgo(4)]);
  await add("PART1", "rec", 4, {}, [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 23 }, { productId: "", name: "Cap", type: "hat", size: "", qty: 1, unitPrice: 20 }]);
  d1._raw.run("UPDATE order_items SET cancelDate=? WHERE orderId='PART1' AND name='Cap'", [daysAgo(1)]);

  console.log("=== getOpenOrders (db.js) ===");
  const open = await lib.getOpenOrders(d1);
  const ids = open.map(o => o.orderId);
  console.log("open orders from every shop, oldest first:", ids.join(",") === "PAID1,SHIP1,PART1,UNPAID1");
  console.log("completed, voided, test and fully-cancelled orders are left out:", !["DONE1", "VOID1", "TEST-1", "CANC1"].some(x => ids.includes(x)));
  console.log("a partly-cancelled order stays open, its total counting only active items:", open.find(o => o.orderId === "PART1").effectiveTotal === 23);
  console.log("each order comes with items and payments:", open.find(o => o.orderId === "PAID1").items.length === 1 && open.find(o => o.orderId === "PAID1").payments.length === 1);
  console.log("getOrdersByOrg still returns every order for one shop, newest first:", (await lib.getOrdersByOrg(d1, "prime")).map(o => o.orderId).join(",") === "TEST-1,UNPAID1,CANC1,SHIP1,DONE1");
  // More orders than D1's 100-bound-parameter cap — the child tables are filtered by subquery, not IN (?, ?, …).
  for (let i = 0; i < 120; i++) await add("BULK" + i, "rec", 1);
  const many = await lib.getOpenOrders(d1);
  console.log("124 open orders all load with their items (child queries bind no per-order parameters):", many.length === 124 && many.every(o => o.items.length > 0));
  d1._raw.run("DELETE FROM order_items WHERE orderId LIKE 'BULK%'"); d1._raw.run("DELETE FROM orders WHERE orderId LIKE 'BULK%'");

  console.log("\n=== getOpenOrders admin action (orders.js) ===");
  const api = new Function(
    strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async (env, host) => host.kind === 'admin' ? null : jsonResponse({ status: 'error', message: 'Admin only' }, 403); const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  const call = async (body, host = "admin.example.com") => {
    const x = await api({ env: { DB: d1 }, waitUntil: () => {}, request: { url: `https://${host}/api/orders`, json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  let r = await call({ action: "getOpenOrders" });
  console.log("returns the open orders with each shop's name:", r.status === 200 && r.body.orders.length === 4 && r.body.orders.find(o => o.orderId === "PAID1").orgName === "REC");
  r = await call({ action: "getOpenOrders" }, "league101.example.com");
  console.log("refused away from the admin subdomain, no orders returned:", r.status >= 400 && !r.body.orders);
  // getOrdersAllShops: the whole All-shops page in one request.
  r = await call({ action: "getOrdersAllShops" });
  console.log("getOrdersAllShops returns every shop's orders + verifications in one response:",
    r.status === 200 && Array.isArray(r.body.shops) && r.body.shops.some(s => Array.isArray(s.orders) && s.orders.length > 0) && r.body.shops.every(s => "verifications" in s));
  r = await call({ action: "getOrdersAllShops" }, "league101.example.com");
  console.log("getOrdersAllShops refused away from the admin subdomain:", r.status >= 400 && !r.body.shops);

  console.log("\n=== Unified Orders page (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  // Unbounded date range for the test so fixed order dates aren't filtered out by the 30-day default.
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "prime", name: "Example League" }, { orgId: "rec", name: "REC" }]; window._ordersFilter = { from: "", to: "" };');
  const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };
  const app = w.document.getElementById("app");
  const allIds = () => [...w.document.querySelectorAll("#adminPanel tbody tr[data-order]")].map(tr => tr.dataset.order).filter((v, i, a) => a.indexOf(v) === i).sort().join(",");

  await w.renderOrdersPage(app);
  await wait(() => w.document.querySelector("#adminPanel tbody tr[data-order]") || /No orders/.test(app.textContent));
  console.log("filter bar: shop dropdown defaults to All shops, has both shops, plus date range + both include boxes:", (() => {
    const sel = w.document.getElementById("ordFilterOrg");
    return !!sel && sel.value === "" && sel.options[0].text === "All shops" && [...sel.options].some(o => o.text === "REC") && [...sel.options].some(o => o.text === "Example League")
      && !!w.document.getElementById("ordFilterFrom") && !!w.document.getElementById("ordFilterTo")
      && !!w.document.getElementById("ordIncludeCompleted") && !w.document.getElementById("ordIncludeCompleted").checked
      && !!w.document.getElementById("ordIncludeCancelled") && !w.document.getElementById("ordIncludeCancelled").checked;
  })());
  console.log("All-shops table has a leading Shop column and merges both shops (completed/void/cancelled hidden by default):",
    /^Shop/.test(w.document.querySelector("#adminPanel thead th").textContent) && allIds() === "PAID1,PART1,SHIP1,TEST-1,UNPAID1");
  console.log("a merged row carries its own shop (per-row action uses that shop):",
    w.document.querySelector('tr[data-order="PAID1"] .order-select').dataset.org === "rec" &&
    w.document.querySelector('tr[data-order="UNPAID1"] .order-select').dataset.org === "prime");
  console.log("All mode hides the bulk bar / breakdown / export (single-shop only):",
    !w.document.getElementById("bulkBar") && !w.document.getElementById("ordBreakdownSection") && /Pick a single shop/.test(app.textContent));

  console.log("\n=== Single-shop view + the two include boxes ===");
  const shopIds = () => allIds();
  const paintShop = async (org) => { w.renderAdminOrders(app, org); await new Promise(x => setTimeout(x, 30)); await wait(() => w.document.getElementById("ordSummaryBar") || /No orders match/.test(app.textContent)); };
  const rec = { orgId: "rec", name: "REC" }, prime = { orgId: "prime", name: "Example League" };
  await paintShop(rec);
  const cancBox = () => w.document.getElementById("ordIncludeCancelled");
  console.log("single-shop view has both include boxes in the filter bar, unticked, and the bulk bar + breakdown are back:",
    !!cancBox() && !cancBox().checked && /Include cancelled/.test(cancBox().parentElement.textContent) &&
    !!w.document.getElementById("ordIncludeCompleted") && !!w.document.getElementById("bulkBar") && !!w.document.getElementById("ordBreakdownSection"));
  console.log("default: the voided order is hidden; a partly-cancelled order still shows:", shopIds() === "PAID1,PART1");
  cancBox().click();
  await new Promise(x => setTimeout(x, 30)); await wait(() => w.document.getElementById("ordSummaryBar"));
  console.log("ticked: the voided order appears (with its VOID tag):", shopIds() === "PAID1,PART1,VOID1" && /VOID/.test(w.document.querySelector('tr[data-order="VOID1"]').textContent));
  console.log("…but still isn't counted in the totals:", /^2 orders/.test(w.document.getElementById("ordSummaryBar").textContent.replace(/\s+/g, " ").trim()));
  await paintShop(prime);
  console.log("the choice carries to other shops: fully-cancelled CANC1 shows, completed DONE1 still hidden:", cancBox().checked && shopIds() === "CANC1,SHIP1,TEST-1,UNPAID1");
  cancBox().click();
  await new Promise(x => setTimeout(x, 30)); await wait(() => w.document.getElementById("ordSummaryBar"));
  console.log("unticked: cancelled orders hidden again:", shopIds() === "SHIP1,TEST-1,UNPAID1");
  w.document.getElementById("ordIncludeCompleted").click();
  await new Promise(x => setTimeout(x, 30)); await wait(() => w.document.getElementById("ordSummaryBar"));
  console.log("the two boxes are independent (completed shown, cancelled still hidden):", shopIds() === "DONE1,SHIP1,TEST-1,UNPAID1");
  w._orderView.includeCompleted = false;

  console.log("\n=== Date-range filter ===");
  w.eval('window._ordersFilter = { from: "", to: "" };');
  await paintShop(prime);
  const beforeDate = shopIds();
  w.eval('window._ordersFilter = { from: "'+ new Date(Date.now() - 7 * 86400000).toISOString().slice(0,10) +'", to: "'+ new Date().toISOString().slice(0,10) +'" };');
  await paintShop(prime);
  console.log("narrowing to the last 7 days drops the older orders (SHIP1 @12d, DONE1 @40d gone):",
    beforeDate.includes("SHIP1") && !shopIds().includes("SHIP1"));

  console.log("\n=== Where the Orders page opens ===");
  const route = async (hash) => { w.history.replaceState(null, "", hash); await w.adminRoute(); await new Promise(x => setTimeout(x, 30)); await wait(() => w.document.getElementById("ordFilterOrg") && !/Loading/.test(w.document.getElementById("adminPanel").textContent)); };
  await route("#orders");
  console.log("the Orders page opens on the first shop (the top of the Shop dropdown), not All shops:", w.location.hash === "#orders/prime" && w.document.getElementById("ordFilterOrg").value === "prime" && !!w.document.getElementById("bulkBar"));
  await route("#");
  console.log("…and so does the admin's home address:", w.location.hash === "#orders/prime" && w.document.getElementById("ordFilterOrg").value === "prime");
  await route("#orders/all");
  console.log("All shops is still there, at #orders/all:", w.location.hash === "#orders/all" && w.document.getElementById("ordFilterOrg").value === "" && /^Shop/.test(w.document.querySelector("#adminPanel thead th").textContent));
  w.rerenderOrdersView(); await new Promise(x => setTimeout(x, 30)); await wait(() => w.document.getElementById("ordFilterOrg"));
  console.log("…Refresh / a filter change there stays on All shops:", w.location.hash === "#orders/all" && w.document.getElementById("ordFilterOrg").value === "");
  await route("#orders/rec");
  w.onOrdersOrgChange("");
  console.log("picking All shops in the dropdown goes to #orders/all:", w.location.hash === "#orders/all");
  const cv = new Function(strip(require("fs").readFileSync(__dirname + "/functions/_lib/hostConfig.js", "utf8")) + "\n" + strip(require("fs").readFileSync(__dirname + "/functions/_lib/catalogValidation.js", "utf8")) + "\nreturn validateOrgFields;")();
  console.log("“all” can't be a shop's ID (it's the All-shops address):", /reserved/.test(cv({ orgId: "all" }, true).error || "") && !cv({ orgId: "allston" }, true).error);
})().catch(e => { console.log("test59 crashed:", false); console.error(e); process.exit(1); });
