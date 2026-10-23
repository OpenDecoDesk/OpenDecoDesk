const fs = require("fs");

// Regression tests for security behaviour:
//   1. Admin sessions are HttpOnly __Host- cookies (not localStorage bearer
//      tokens), 24h, CSRF-guarded by Origin; optional Cloudflare Access JWT.
//   2. Audit rows record actor + IP; destructive actions write the audit row
//      FIRST (with full before-values) and refuse to run if it can't be written.
//   3. classifyHost matches full hostnames only.
//   4. /api/checkout refuses already-paid orders and uses the order's own org.
//   5. Order line-item name/type come from the catalog, not the client.

const { makePlatformDb, platformGlobals, seedSession, sha256Hex } = require("./testlib/platform-db");
Object.assign(global, platformGlobals());

const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const|let)/g, "$1");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const LIB_PATHS = ["functions/_lib/hostConfig.js", "functions/_lib/http.js", "functions/_lib/access.js",
  "functions/_lib/adminAuth.js", "functions/_lib/quoteToken.js", "functions/_lib/turnstile.js"];
const LIBS = LIB_PATHS.map(p => strip(read(p))).join("\n");
// Evaluate a module with fresh copies of the real libs in scope; returns the
// named bindings. (A lib path is already part of LIBS, so it isn't re-added.)
function load(path, names){
  const extra = LIB_PATHS.includes(path) ? "" : strip(read(path));
  return new Function(LIBS + "\n" + extra + "\nreturn {" + names.join(",") + "};")();
}

function makeReq(url, { body, headers = {}, method = "POST" } = {}){
  return {
    url, method,
    json: async () => body,
    headers: { get: (h) => {
      const k = Object.keys(headers).find(x => x.toLowerCase() === h.toLowerCase());
      return k ? headers[k] : null;
    } },
  };
}

global.rateLimited = async () => ({ blocked: false, retryAfter: 0 });
global.rateLimitCheck = async () => ({ blocked: false, retryAfter: 0 });
global.rateLimitHit = async () => {};
global.rateLimitCheckGlobal = async () => ({ blocked: false, retryAfter: 0 }); global.rateLimitHitGlobal = async () => {};
global.rateLimitResponse = () => new Response("", { status: 429 });
global.getCatalogData = async () => ({ subdomainMap: { league101: "league-101", rec: "rec" }, orgs: {} });

const ADMIN = "https://admin.example.com";
const SAME = { Origin: ADMIN, "CF-Connecting-IP": "203.0.113.7" };

(async () => {
  // =====================================================================
  // 1a. Login sets an HttpOnly cookie; the token never reaches page JS
  // =====================================================================
  {
    console.log("\n=== admin-session: login sets a hardened cookie, body carries no token ===");
    const DB = await makePlatformDb();
    const env = { DB, PROXY_ADMIN_PASSPHRASE: "pw" };
    const m = load("functions/api/admin-session.js", ["onRequestPost", "onRequestDelete"]);
    const res = await m.onRequestPost({ env, request: makeReq(ADMIN + "/api/admin-session", { body: { key: "pw" }, headers: SAME }) });
    const text = await res.text();
    const cookie = res.headers.get("Set-Cookie") || "";
    const token = (cookie.match(/__Host-odd_admin=(sess_[0-9a-f]{48})/) || [])[1];
    console.log("200 ok:", res.status === 200 && JSON.parse(text).status === "ok");
    console.log("Cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/:",
      !!token && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\//.test(cookie) && !/Domain=/i.test(cookie));
    console.log("Lifetime is 24h (Max-Age=86400):", /Max-Age=86400/.test(cookie));
    console.log("Response body does NOT contain the token:", !!token && !text.includes(token) && !text.includes("sess_"));
    const stored = DB.q("SELECT tokenHash FROM admin_sessions");
    console.log("Session stored server-side, as a hash (never the token):", stored.length === 1 && stored[0].tokenHash === await sha256Hex(token) && stored[0].tokenHash !== token);

    const cross = await m.onRequestPost({ env, request: makeReq(ADMIN + "/api/admin-session",
      { body: { key: "pw" }, headers: { Origin: "https://league101.example.com" } }) });
    console.log("Login from another origin (even a sibling storefront) → 403:", cross.status === 403);

    console.log("\n=== admin-session: sign-out revokes server-side and clears the cookie ===");
    const del = await m.onRequestDelete({ env, request: makeReq(ADMIN + "/api/admin-session",
      { method: "DELETE", headers: Object.assign({ Cookie: "__Host-odd_admin=" + token }, SAME) }) });
    console.log("200:", del.status === 200);
    console.log("Session removed from storage:", DB.q("SELECT count(*) AS c FROM admin_sessions")[0].c === 0);
    console.log("Cookie cleared (Max-Age=0):", /Max-Age=0/.test(del.headers.get("Set-Cookie") || ""));
  }

  // =====================================================================
  // 1b. requireAdmin: cookie + Origin; legacy bearer tokens refused; actor
  // =====================================================================
  const auth = load("functions/_lib/adminAuth.js", ["requireAdmin", "adminActor"]);
  const token = "sess_" + "c".repeat(48);
  const future = new Date(Date.now() + 3600e3).toISOString();
  const sessDb = await makePlatformDb();
  await seedSession(sessDb, token, future);
  const envA = { DB: sessDb, PROXY_ADMIN_PASSPHRASE: "pw" };
  {
    console.log("\n=== requireAdmin: cookie sessions + CSRF guard ===");
    const withCookie = (headers) => makeReq(ADMIN + "/api/orders", { headers: Object.assign({ Cookie: "__Host-odd_admin=" + token }, headers) });
    let r0 = withCookie(SAME);
    let r = await auth.requireAdmin(envA, { kind: "admin" }, "cookie", r0);
    console.log("Valid cookie + same Origin → admitted:", r === null);
    console.log("Actor is the signed-in user's email, never the token:", auth.adminActor(r0) === "owner@myshop.com" && !auth.adminActor(r0).includes(token));
    r = await auth.requireAdmin(envA, { kind: "admin" }, "cookie", withCookie({ Origin: "https://league101.example.com" }));
    console.log("Valid cookie from a sibling subdomain → 403 (CSRF):", r !== null && r.status === 403);
    r = await auth.requireAdmin(envA, { kind: "admin" }, "cookie", withCookie({}));
    console.log("Valid cookie with no Origin header → 403:", r !== null && r.status === 403);
    r = await auth.requireAdmin(envA, { kind: "admin" }, token, makeReq(ADMIN + "/api/orders", { headers: SAME }));
    console.log("Old-style bearer token in the body → 401 (no longer accepted):", r !== null && r.status === 401);
    const pr = makeReq(ADMIN + "/api/orders", { headers: SAME });
    r = await auth.requireAdmin(envA, { kind: "admin" }, "pw", pr);
    console.log("Passphrase path (TOTP off) still works, actor = passphrase:", r === null && auth.adminActor(pr) === "passphrase");
  }

  // =====================================================================
  // 1c. Optional Cloudflare Access — real RS256 JWTs
  // =====================================================================
  {
    console.log("\n=== Cloudflare Access: verified when configured, fails closed ===");
    const subtle = globalThis.crypto.subtle;
    const kp = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = Object.assign(await subtle.exportKey("jwk", kp.publicKey), { kid: "k1", alg: "RS256" });
    const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const TEAM = "example.cloudflareaccess.com", AUD = "aud-123";
    async function jwt(claims, { kid = "k1", key = kp.privateKey } = {}){
      const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
      const now = Math.floor(Date.now() / 1000);
      const p = b64u(JSON.stringify(Object.assign({ aud: [AUD], iss: "https://" + TEAM, email: "pat@example.com", exp: now + 600, iat: now }, claims)));
      const sig = await subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
      return h + "." + p + "." + b64u(sig);
    }
    let certsUp = true;
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if(String(url) === "https://" + TEAM + "/cdn-cgi/access/certs"){
        if(!certsUp) throw new Error("down");
        return { ok: true, json: async () => ({ keys: [jwk] }) };
      }
      throw new Error("unexpected fetch " + url);
    };
    const A = load("functions/_lib/adminAuth.js", ["requireAdmin", "adminActor", "_resetAccessKeyCache"]);
    const envX = Object.assign({}, envA, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
    const reqWith = (assertion) => makeReq(ADMIN + "/api/orders", { headers: Object.assign({ "Cf-Access-Jwt-Assertion": assertion, Cookie: "__Host-odd_admin=" + token }, SAME) });

    let rq = reqWith(await jwt({}));
    let r = await A.requireAdmin(envX, { kind: "admin" }, "cookie", rq);
    console.log("Valid Access JWT + session → admitted:", r === null);
    console.log("Audit actor is the user, with the Access email beside it when that differs:", A.adminActor(rq) === "owner@myshop.com (Access: pat@example.com)");
    r = await A.requireAdmin(envX, { kind: "admin" }, "cookie", makeReq(ADMIN + "/api/orders", { headers: Object.assign({ Cookie: "__Host-odd_admin=" + token }, SAME) }));
    console.log("No Access JWT → 403 even with a valid session:", r !== null && r.status === 403);
    r = await A.requireAdmin(envX, { kind: "admin" }, "cookie", reqWith(await jwt({ exp: Math.floor(Date.now() / 1000) - 5 })));
    console.log("Expired JWT → 403:", r !== null && r.status === 403);
    r = await A.requireAdmin(envX, { kind: "admin" }, "cookie", reqWith(await jwt({ aud: ["some-other-app"] })));
    console.log("JWT for another Access app (wrong aud) → 403:", r !== null && r.status === 403);
    r = await A.requireAdmin(envX, { kind: "admin" }, "cookie", reqWith(await jwt({ iss: "https://evil.cloudflareaccess.com" })));
    console.log("Wrong issuer → 403:", r !== null && r.status === 403);
    const other = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    r = await A.requireAdmin(envX, { kind: "admin" }, "cookie", reqWith(await jwt({}, { key: other.privateKey })));
    console.log("JWT signed by a different key (forged) → 403:", r !== null && r.status === 403);
    A._resetAccessKeyCache(); certsUp = false;
    r = await A.requireAdmin(envX, { kind: "admin" }, "cookie", reqWith(await jwt({})));
    console.log("Access signing keys unreachable → refused (fail closed):", r !== null && r.status === 403);
    certsUp = true;
    r = await A.requireAdmin(envA, { kind: "admin" }, "cookie", makeReq(ADMIN + "/api/orders", { headers: Object.assign({ Cookie: "__Host-odd_admin=" + token }, SAME) }));
    console.log("Access NOT configured → not required:", r === null);
    global.fetch = realFetch;
  }

  // =====================================================================
  // 2. Audit trail: actor + IP, full before-values, audit-before-delete
  // =====================================================================
  {
    const audits = [];
    let auditFails = false, deleted = { order: 0, payment: 0 };
    Object.assign(global, {
      insertAuditLog: async (db, row) => { if(auditFails) throw new Error("D1 down"); audits.push(row); },
      getAuditLog: async () => [], getAllOrgs: async () => [], getRevenueData: async () => [],
      getOrderPaymentById: async (db, id) => ({ id, orderId: "ORD-1", amount: 42.5, note: "Venmo", receivedAt: "2026-09-01T00:00:00Z", externalRef: "" }),
      voidPayment: async () => { deleted.payment++; },
      monthOf: (iso) => String(iso || "").slice(0, 7), isMonthClosed: async () => false,
      orderMonth: async () => "2026-09", itemOrderMonth: async () => "2026-09", paymentMonth: async () => "2026-09",
      getOrderById: async (db, id) => ({ orderId: id, orgId: "league-101", customerName: "C", contact: "c@x.com",
        total: 60, subtotal: 60, shippingCost: 0, discountAmount: 0, discountNote: "", paymentMethod: "Venmo",
        placedAt: "2026-09-01T00:00:00Z", paid: false, paidAt: "", netReceived: 0, voidedAt: "",
        items: [{ id: 1, name: "Polo", lineTotal: 60 }], payments: [] }),
      voidOrder: async () => { deleted.order++; },
      setOrderDiscount: async () => {}, updateOrderPlacedAt: async () => {},
      getSettingRaw: async () => null, // these envs carry a stub DB; no 2FA secret stored
      getBootstrapState: async () => ({ userCount: 0, admins: [] }),   // …and no users yet: the passphrase is the way in
    });
    const O = load("functions/api/orders.js", ["onRequestPost"]);
    const ctx = (body) => ({ env: { DB: {}, PROXY_ADMIN_PASSPHRASE: "pw" }, waitUntil: () => {},
      request: makeReq(ADMIN + "/api/orders", { body: Object.assign({ key: "pw" }, body), headers: SAME }) });

    console.log("\n=== Audit: payment.voided records the amount, actor and IP ===");
    let res = await O.onRequestPost(ctx({ action: "voidPayment", paymentId: 7, org: "league-101", reason: "typo" }));
    const a = audits.find(x => x.action === "payment.voided");
    console.log("Voided:", res.status === 200 && deleted.payment === 1);
    console.log("Audit has amount/note/date of the deleted payment:", !!a && a.detail.amount === 42.5 && a.detail.note === "Venmo" && !!a.detail.receivedAt);
    console.log("Audit records actor + IP:", !!a && a.actor === "passphrase" && a.ip === "203.0.113.7");

    console.log("\n=== Audit: order.voided keeps a full snapshot (items + payments) ===");
    res = await O.onRequestPost(ctx({ action: "voidOrder", orderId: "ORD-1", reason: "duplicate" }));
    const d = audits.find(x => x.action === "order.voided");
    console.log("Snapshot includes line items and payments:", !!d && Array.isArray(d.detail.items) && d.detail.items.length === 1 && Array.isArray(d.detail.payments));

    console.log("\n=== Audit: discount change records before AND after ===");
    await O.onRequestPost(ctx({ action: "setDiscount", orderId: "ORD-1", amount: 5, note: "loyalty" }));
    const ds = audits.find(x => x.action === "order.discount_set");
    console.log("from/to recorded:", !!ds && ds.detail.from.amount === 0 && ds.detail.to.amount === 5);

    console.log("\n=== Audit write fails → destructive action is REFUSED, nothing deleted ===");
    auditFails = true; deleted = { order: 0, payment: 0 };
    const r1 = await O.onRequestPost(ctx({ action: "deleteOrder", orderId: "ORD-1" }));
    const r2 = await O.onRequestPost(ctx({ action: "deletePayment", paymentId: 7 }));
    console.log("voidOrder (legacy deleteOrder name) → 503, order NOT voided:", r1.status === 503 && deleted.order === 0);
    console.log("voidPayment (legacy deletePayment name) → 503, payment NOT voided:", r2.status === 503 && deleted.payment === 0);
    auditFails = false;

    // =====================================================================
    // 5. Line-item name/type from the catalog
    // =====================================================================
    console.log("\n=== Order submission: item name/type come from the catalog, not the client ===");
    let inserted = null;
    Object.assign(global, {
      getOrgById: async (db, orgId) => ({ orgId, ready: true, allowOrdersAfterDeadline: true }),
      getPublishedOrg: async (db, orgId) => ({ orgId, ready: true, allowOrdersAfterDeadline: true }),   // migrations/0076
      getLocaleSettings: async () => ({ timeZone: "", country: "US" }),   // the default Region
      priceItem: async () => ({ unitPrice: 25, personalizationFee: 0, name: "Club Polo", type: "shirt" }),
      getProductsByOrg: async () => [], insertOrder: async (db, order, items) => { inserted = items; },
      sendOrderReceivedEmail: async () => false, sendOrderNotificationEmail: async () => false, setOrderEmailTimestamp: async () => {},
      // The REAL address check from db.js (whitelist + state-vs-ZIP), not a mock.
      cleanShippingAddress: new Function(strip(read("functions/_lib/db.js")) + "\nreturn cleanShippingAddress;")(),
      // …and the REAL quantity rule.
      ...new Function(strip(read("functions/_lib/db.js")) + "\nreturn { lineQty, QTY_MESSAGE };")(),
    });
    const sub = await O.onRequestPost({ env: { DB: {} }, waitUntil: () => {},
      request: makeReq("https://league101.example.com/api/orders", { body: { orderId: "ORD-9", orgId: "league-101",
        customerName: "C", contact: "c@x.com", items: [{ productId: "polo", size: "L", qty: 1, name: "FREE — call 555-0100", type: "anything" }] } }) });
    console.log("Accepted:", sub.status === 200);
    console.log("Stored name is the catalog's, not the client's:", !!inserted && inserted[0].name === "Club Polo");
    console.log("Stored type is the catalog's:", !!inserted && inserted[0].type === "shirt");
  }

  // =====================================================================
  // 3. classifyHost — full hostnames only
  // =====================================================================
  {
    console.log("\n=== classifyHost: full-hostname matching ===");
    const H = load("functions/_lib/hostConfig.js", ["classifyHost"]);
    const map = { league101: "league-101" };
    const k = (h) => H.classifyHost(h, map).kind;
    console.log("admin.example.com → admin:", k("admin.example.com") === "admin");
    console.log("admin.opendecodesk.pages.dev (branch preview) → unknown:", k("admin.opendecodesk.pages.dev") === "unknown");
    console.log("admin.evil.example → unknown:", k("admin.evil.example") === "unknown");
    console.log("league101.evil.example → unknown:", k("league101.evil.example") === "unknown");
    console.log("x.admin.example.com → unknown:", k("x.admin.example.com") === "unknown");
    console.log("constructor.example.com (prototype key) → unknown:", k("constructor.example.com") === "unknown");
    console.log("Org subdomain still locked:", H.classifyHost("league101.example.com", map).orgId === "league-101");
    console.log("Root and www still root:", k("example.com") === "root" && k("www.example.com") === "root");
  }

  // =====================================================================
  // 4. Checkout — no double payment, order's own org
  // =====================================================================
  {
    console.log("\n=== checkout: refuses already-paid orders; uses the order's real org ===");
    let state = { total: 45, paid: false, orgId: "league-101" };
    global.getOrderCheckoutState = async () => state;
    let stripeParams = null;
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { stripeParams = new URLSearchParams(opts.body); return { json: async () => ({ url: "https://checkout.stripe.com/x" }) }; };
    const C = load("functions/api/checkout.js", ["onRequestPost"]);
    const { orderTokenFor } = require("./testlib/order-token");
    const call = async (host, body) => C.onRequestPost({ env: { DB: {}, STRIPE_SECRET_KEY: "sk_test" },
      request: makeReq("https://" + host + "/api/checkout", { body: Object.assign({ checkoutToken: await orderTokenFor({ STRIPE_SECRET_KEY: "sk_test" }, body.orderId) }, body) }) });

    state.paid = true; stripeParams = null;
    let r = await call("league101.example.com", { orderId: "ORD-1", orgId: "league-101" });
    console.log("Paid order → 409, no Stripe session created:", r.status === 409 && stripeParams === null);

    state.paid = false; state.orgId = "rec";
    r = await call("league101.example.com", { orderId: "REC-1", orgId: "league-101" });
    console.log("Order belongs to a different org than the storefront → 403:", r.status === 403);

    r = await call("example.com", { orderId: "REC-1", orgId: "league-101" });
    console.log("Root domain: Stripe metadata uses the order's real org (rec), not the body's:",
      r.status === 200 && stripeParams.get("metadata[orgId]") === "rec" && stripeParams.get("payment_intent_data[metadata][orgId]") === "rec");
    global.fetch = realFetch;
  }
})();
