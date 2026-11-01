const fs = require("fs");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// The vendor web-service log (functions/_lib/vendorLog.js, migrations/0078): every call a vendor connection makes is
// logged — a vendor_api_log row (time, action, subject, status, error, duration, sizes) and the full request
// (password blanked) + response in the private RECEIPTS bucket (inline when there's no bucket). Admin-only list /
// entry actions, a 30-day clean-up, and the Logs viewer on Vendor integrations. Real db.js / orders.js on sql.js with
// every migration; the vendor's SOAP is mocked.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), logSrc = strip(read("functions/_lib/vendorLog.js"));
const psSrc = strip(read("functions/_lib/promostandards.js")), credSrc = strip(read("functions/_lib/vendorCredentials.js")), soSrc = strip(read("functions/_lib/supplierOrders.js"));
const vl = new Function(logSrc + `\nreturn { redactVendorRequest, vendorRequestSubject, vendorResponseError, vendorLogFetch, listVendorApiLog, getVendorApiLogEntry, cleanUpVendorApiLog };`)();
const ps = new Function(psSrc + `\nreturn { fetchVendorProduct };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + psSrc + "\n" + credSrc + "\n" + logSrc + "\n" + soSrc + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return fn(); };

// A vendor speaking PromoStandards (neutral names).
const env = (body) => `<?xml version="1.0" encoding="UTF-8"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>${body}</S:Body></S:Envelope>`;
const PRODUCT = env(`<GetProductResponse><Product><productId>AB100</productId><productName>Sample Tee</productName><ProductPartArray><ProductPart><partId>1</partId><ColorArray><Color><colorName>Navy</colorName></Color></ColorArray><ApparelSize><labelSize>M</labelSize></ApparelSize></ProductPart></ProductPartArray></Product></GetProductResponse>`);
const FOB = env(`<GetFobPointsResponse><FobPointArray><FobPoint><fobId>1</fobId></FobPoint></FobPointArray></GetFobPointsResponse>`);
const PRICES = env(`<GetConfigurationAndPricingResponse><Configuration><PartArray><Part><partId>1</partId><PartPriceArray><PartPrice><minQuantity>1</minQuantity><price>4.25</price></PartPrice></PartPriceArray></Part></PartArray></Configuration></GetConfigurationAndPricingResponse>`);
const FAULT = env(`<S:Fault><faultcode>S:Client</faultcode><faultstring>Authentication Credentials failed</faultstring></S:Fault>`);
let mode = "ok";
global.fetch = async (url, init = {}) => {
  const body = String(init.body || "");
  if (mode === "down") throw new Error("connect ECONNREFUSED");
  if (mode === "fault") return new Response(FAULT, { status: 500 });
  if (/GetProductRequest/.test(body)) return new Response(PRODUCT, { status: 200 });
  if (/GetFobPointsRequest/.test(body)) return new Response(FOB, { status: 200 });
  if (/GetConfigurationAndPricingRequest/.test(body)) return new Response(PRICES, { status: 200 });
  return new Response("", { status: 404 });
};
const fakeR2 = () => { const m = new Map(); return { m, put: async (k, v) => { m.set(k, String(v)); }, get: async (k) => m.has(k) ? { text: async () => m.get(k) } : null, delete: async (keys) => { for (const k of [].concat(keys)) m.delete(k); } }; };
const ENDPOINTS = { product: "https://ws.vendor.example/ProductData", ppc: "https://ws.vendor.example/Pricing" };

(async () => {
  console.log("=== The pieces ===");
  const req = `<shar:id>shop_user</shar:id><shar:password>s3cret&amp;pw</shar:password><shar:productId>AB100</shar:productId><SanMarUserPassword>x</SanMarUserPassword>`;
  const red = vl.redactVendorRequest(req);
  ok("the password is blanked in a request (PromoStandards and SanMar's own field), the user id and the rest kept", !/s3cret/.test(red) && /<shar:password>•••<\/shar:password>/.test(red) && /<SanMarUserPassword>•••</.test(red) && /shop_user/.test(red) && /AB100/.test(red));
  ok("what a call was about comes from its request", vl.vendorRequestSubject(req) === "product AB100" && vl.vendorRequestSubject("<ns:orderNumber>PO-7</ns:orderNumber>") === "PO PO-7");
  ok("the vendor's own error is read from a fault, an ErrorMessage or a ServiceMessage of severity Error", vl.vendorResponseError(FAULT) === "Authentication Credentials failed" &&
    vl.vendorResponseError("<ErrorMessage><code>130</code><description>Product Id not found</description></ErrorMessage>") === "Product Id not found" &&
    vl.vendorResponseError("<ServiceMessage><description>Declined</description><severity>Error</severity></ServiceMessage>") === "Declined" && vl.vendorResponseError(PRODUCT) === "");

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const R2 = fakeR2();
  const conn = { id: 7, name: "Vendor", companyCode: "VEN", endpoints: ENDPOINTS, overrides: {}, credentials: { id: "shop_user", password: "s3cret" } };
  conn.fetch = vl.vendorLogFetch({ DB: d1, RECEIPTS: R2 }, 7, { context: "unit", actor: "me" });
  const p = await ps.fetchVendorProduct(conn, "AB100", { media: false });
  ok("a vendor call through the connection still works as before", p.colors[0].color === "Navy" && p.prices.Navy.M === 4.25);
  const rows = d1.q("SELECT * FROM vendor_api_log WHERE connectionId=7 ORDER BY id");
  ok("each call is a row: action, subject, status, ok, duration, sizes, context, actor, and a payload key in R2", rows.length === 3 && rows.map(r => r.action).join() === "getProduct,getFobPoints,getConfigurationAndPricing" &&
    rows[0].subject === "product AB100" && rows[0].httpStatus === 200 && rows[0].ok === 1 && rows[0].responseBytes === PRODUCT.length && rows[0].requestBytes > 0 &&
    rows[0].context === "unit" && rows[0].actor === "me" && /^vendor-logs\/7\/\d{4}-\d\d-\d\d\//.test(rows[0].payloadKey) && rows[0].payload === "");
  const stored = JSON.parse(R2.m.get(rows[0].payloadKey));
  ok("…the full request (password blanked) and the full response are stored", stored.response === PRODUCT && /GetProductRequest/.test(stored.request) && !/s3cret/.test(stored.request) && /<shar:password>•••</.test(stored.request));
  mode = "fault";
  let err = ""; try { await ps.fetchVendorProduct(conn, "AB100", { media: false }); } catch (e) { err = e.message; }
  const f = d1.q("SELECT * FROM vendor_api_log ORDER BY id DESC LIMIT 1")[0];
  ok("a refused call is logged with the vendor's error (and the caller still gets its message)", /Authentication Credentials failed/.test(err) && f.ok === 0 && f.httpStatus === 500 && f.error === "Authentication Credentials failed");
  mode = "down"; err = "";
  try { await ps.fetchVendorProduct(conn, "AB100", { media: false }); } catch (e) { err = e.message; }
  const dn = d1.q("SELECT * FROM vendor_api_log ORDER BY id DESC LIMIT 1")[0];
  ok("…and so is a call that never connected (no status)", /couldn't be reached/.test(err) && dn.ok === 0 && dn.httpStatus === null && /ECONNREFUSED/.test(dn.error));
  mode = "ok";
  const inlineConn = { ...conn, id: 8, fetch: vl.vendorLogFetch({ DB: d1 }, 8, {}) };
  await ps.fetchVendorProduct(inlineConn, "AB100", { media: false });
  const inl = await vl.getVendorApiLogEntry({ DB: d1 }, d1.q("SELECT id FROM vendor_api_log WHERE connectionId=8 ORDER BY id LIMIT 1")[0].id);
  ok("with no bucket the payload is kept in the row, and read back the same way", inl.response === PRODUCT && /GetProductRequest/.test(inl.request) && !inl.missing);
  let broke = false;
  const badEnv = { DB: { prepare: () => { throw new Error("db down"); } } };
  try { await ps.fetchVendorProduct({ ...conn, fetch: vl.vendorLogFetch(badEnv, 9, {}) }, "AB100", { media: false }); } catch (e) { broke = true; }
  ok("a log that can't be written never breaks the call", !broke);

  console.log("\n=== The admin actions ===");
  const keyEnv = { VENDOR_CREDENTIALS_KEY: "a-long-random-master-key-for-tests-0123456789" };
  const waits = [];
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1, RECEIPTS: R2, ...keyEnv }, waitUntil: (pr) => { waits.push(Promise.resolve(pr).catch(() => {})); },
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  let r = await call({ action: "saveVendorConnection", companyCode: "VEN", name: "Vendor", endpoints: ENDPOINTS, credentials: { id: "shop_user", password: "s3cret" } });
  const cid = r.body.id;
  r = await call({ action: "testVendorConnection", id: cid, style: "AB100" });
  await Promise.all(waits);
  const mine = d1.q("SELECT * FROM vendor_api_log WHERE connectionId=? ORDER BY id", cid);
  ok("Test on a connection logs its calls, with what asked and who", r.status === 200 && mine.length === 3 && mine.every(x => x.context === "testVendorConnection" && x.actor === "owner@test"));
  mode = "fault"; await call({ action: "testVendorConnection", id: cid, style: "AB100" }); await Promise.all(waits); mode = "ok";
  r = await call({ action: "listVendorApiLog", connectionId: cid });
  ok("the list: newest first, no payloads, the actions with counts", r.status === 200 && r.body.entries[0].ok === false && r.body.entries.length === 5 && r.body.entries.filter(x => !x.ok).length === 2 && !("payload" in r.body.entries[0]) && !("payloadKey" in r.body.entries[0]) &&
    r.body.actions.find(a => a.action === "getProduct").count === 2);
  ok("…errors only / one action / paging", (await call({ action: "listVendorApiLog", connectionId: cid, errorsOnly: true })).body.entries.length === 2 &&
    (await call({ action: "listVendorApiLog", connectionId: cid, logAction: "getFobPoints" })).body.entries.length === 2 &&
    (await call({ action: "listVendorApiLog", connectionId: cid, limit: 2 })).body.more === true &&
    (await call({ action: "listVendorApiLog", connectionId: cid, beforeId: r.body.entries[1].id })).body.entries.length === 3);
  const e = (await call({ action: "getVendorApiLogEntry", id: mine[0].id })).body.entry;
  ok("one call: its full request and response", e.response === PRODUCT && /GetProductRequest/.test(e.request) && !/s3cret/.test(e.request) && e.action === "getProduct");
  ok("admin only — a manager can't read the log", (await call({ action: "listVendorApiLog", connectionId: cid }, { role: "manager" })).status === 403 &&
    (await call({ action: "getVendorApiLogEntry", id: mine[0].id }, { role: "manager" })).status === 403);

  console.log("\n=== 30 days ===");
  const before = d1.q("SELECT COUNT(*) AS n FROM vendor_api_log")[0].n;
  d1._raw.run("UPDATE vendor_api_log SET at='2026-01-01T00:00:00.000Z' WHERE id=?", [mine[0].id]);
  const c = await vl.cleanUpVendorApiLog({ DB: d1, RECEIPTS: R2 });
  ok("the daily clean-up removes entries older than 30 days and their stored payloads", c.deleted === 1 && d1.q("SELECT COUNT(*) AS n FROM vendor_api_log")[0].n === before - 1 && !R2.m.has(mine[0].payloadKey) && R2.m.has(mine[1].payloadKey));
  ok("…an entry that's gone says so", (await call({ action: "getVendorApiLogEntry", id: mine[0].id })).status === 404);
  ok("the Worker's daily run calls it", /cleanUpVendorApiLog\(env\)/.test(read("src/worker.js")));

  console.log("\n=== The Logs viewer ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#vendors", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" };');
  await w.renderVendorIntegrations(d.getElementById("app"));
  await wait(() => d.querySelector(".vcLog"));
  ok("each connection has a Logs… button", !!d.querySelector(`.vcLog[data-id="${cid}"]`));
  d.querySelector(`.vcLog[data-id="${cid}"]`).click();
  await wait(() => d.querySelectorAll(".vl-row").length);
  const rowsUi = [...d.querySelectorAll(".vl-row")];
  ok("the viewer lists the calls with time stamps (to the second), action, result and size", rowsUi.length === 4 && /\d{1,2}:\d{2}:\d{2}/.test(rowsUi[0].textContent) &&
    /✗ 500 — Authentication Credentials failed/.test(rowsUi[0].textContent) && /get(Product|FobPoints)/.test(rowsUi[0].textContent) && /KB|B/.test(rowsUi[0].textContent));
  rowsUi[rowsUi.length - 1].click();
  await wait(() => d.querySelectorAll("#vlDetail pre").length === 2);
  const pres = d.querySelectorAll("#vlDetail pre");
  ok("opening a call shows its full request (password blanked) and response, laid out", /<ns:Get\w+Request>/.test(pres[0].textContent) && /<shar:password>•••</.test(pres[0].textContent) && /<\/S:Envelope>/.test(pres[1].textContent) && /\n {4,}</.test(pres[1].textContent));
  d.getElementById("vlErrors").click(); d.getElementById("vlErrors").dispatchEvent(new w.Event("change"));
  await wait(() => d.querySelectorAll(".vl-row").length === 2);
  ok("Errors only narrows the list", d.querySelectorAll(".vl-row").length === 2 && [...d.querySelectorAll(".vl-row")].every(tr => /✗/.test(tr.textContent)));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test156 crashed: false"); process.exit(1); });
