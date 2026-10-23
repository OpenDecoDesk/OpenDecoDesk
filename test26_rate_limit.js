const fs = require("fs");

// ---- shared lib ----
let libSrc = fs.readFileSync(__dirname + "/functions/_lib/hostConfig.js", "utf8")
  .replace(/export const/g, "const").replace(/export function/g, "function");

let rateLimitSrc = fs.readFileSync(__dirname + "/functions/_lib/rateLimit.js", "utf8")
  .replace(/export async function/g, "async function")
  .replace(/export function/g, "function");

// adminAuth.js imports access.js (optional Cloudflare Access check) — load both.
let adminAuthSrc = (fs.readFileSync(__dirname + "/functions/_lib/access.js", "utf8") + "\n" +
    fs.readFileSync(__dirname + "/functions/_lib/adminAuth.js", "utf8"))
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export const/g, "const")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function")
  .replace(/export function/g, "function");

let httpSrc = fs.readFileSync(__dirname + "/functions/_lib/http.js", "utf8")
  .replace(/export function/g, "function");

eval(libSrc + "\n" + rateLimitSrc + "\n" + adminAuthSrc + "\n" + httpSrc);
// requireAdmin reads the stored 2FA secret from D1; these tests use stub DBs and no 2FA.
global.getSettingRaw = async () => null;
// …and asks who the admins are before taking the installer's passphrase: here, nobody yet.
global.getBootstrapState = async () => ({ userCount: 0, admins: [] });

// getCatalogData(env) mock shared by orders.js/checkout.js below.
global.getCatalogData = async () => ({
  subdomainMap: {
    "league101": "league-101",
    "rec": "rec"
  },
  orgs: {}
});

// Mocks for db.js and email.js functions — rate limit tests only care that
// the handler responds, not what the DB returns.
global.getAllOrgs = async () => [];
// Order submission requires the org to exist and be ready (server-side).
global.getOrgById = async (db, orgId) => ({ orgId, name: orgId, subdomain: "", ready: true, orderDeadline: null, allowOrdersAfterDeadline: true });
// Order submission reads the PUBLISHED shop (migrations/0076); here it is whatever getOrgById says.
global.getPublishedOrg = (db, orgId) => global.getOrgById(db, orgId);
// The REAL address check from db.js (whitelist + state-vs-ZIP), not a mock.
// Region (Global settings): the default install — US address formats, no saved time zone.
global.getLocaleSettings = async () => ({ timeZone: "", country: "US" });
global.cleanShippingAddress = new Function(require("fs").readFileSync(__dirname + "/functions/_lib/db.js", "utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1")
  + "\nreturn cleanShippingAddress;")();
// …and the REAL quantity rule, ZIP table and "quote pending" marker from db.js.
Object.assign(global, new Function(require("fs").readFileSync(__dirname + "/functions/_lib/db.js", "utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1")
  + "\nreturn { lineQty, QTY_MESSAGE, zipStates, SHIPPING_QUOTE_PENDING };")());
global.createOrg = async () => ({});
global.updateOrg = async () => {};
global.getProductsByOrg = async () => [];
global.createProduct = async () => {};
global.updateProduct = async () => {};
global.setProductVisible = async () => {};
global.getGlobalSettings = async () => ({});
global.setGlobalSettings = async () => {};
global.getOrdersByOrg = async () => [];
global.getOrderById = async () => null;
global.insertOrder = async () => {};
global.setOrderPaid = async () => {};
global.setOrderEmailTimestamp = async () => {};
global.setFulfillmentStage = async () => {};
global.setTrackingNumbers = async () => {};
global.cancelLineItemWithReason = async () => {};
global.setLineItemRefund = async () => {};
global.getOrderTotal = async () => 10;

// checkout.js calls getOrderCheckoutState(db, orderId) → {total, paid, orgId}.
// Built on the getOrderTotal mock so per-test total overrides keep working;
// __checkoutPaid / __checkoutOrg let a test simulate a paid order or its org.
global.__checkoutPaid = false;
global.__checkoutOrg = "league-101";
global.getOrderCheckoutState = async (db, orderId) => {
  const total = await global.getOrderTotal(db, orderId);
  return total === null ? null : { total, paid: global.__checkoutPaid, orgId: global.__checkoutOrg };
};
global.getOrderForShipping = async () => null;
global.priceItem = async () => ({ unitPrice: 25, personalizationFee: 0 });
global.getPublicCatalogData = async () => ({ subdomainMap: {}, orgs: {} });
global.setOrderRefunded = async () => {};
global.setOrderDisputeStatus = async () => {};

global.sendOrderReceivedEmail = async () => true;
global.sendOrderNotificationEmail = async () => {};
global.sendPaymentConfirmedEmail = async () => true;
global.sendCancellationEmail = async () => true;
global.sendStripePaymentNotification = async () => {};
global.sendRefundNotification = async () => {};
global.sendDisputeNotification = async () => {};

// quoteToken.js + turnstile.js — real implementations (pure, no bindings).
let quoteTokenSrc = fs.readFileSync(__dirname + "/functions/_lib/quoteToken.js", "utf8")
  .replace(/export (async function|function|const)/g, "$1");
let turnstileSrc = fs.readFileSync(__dirname + "/functions/_lib/turnstile.js", "utf8")
  .replace(/export (async function|function|const)/g, "$1");
eval(quoteTokenSrc + "\n" + turnstileSrc);

let ordersSrc = fs.readFileSync(__dirname + "/functions/api/orders.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function");
eval(ordersSrc);
const ordersHandler = onRequestPost;

let checkoutSrc = fs.readFileSync(__dirname + "/functions/api/checkout.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function");
eval(checkoutSrc);
const checkoutHandler = onRequestPost;

let uploadSrc = fs.readFileSync(__dirname + "/functions/_lib/fileUpload.js", "utf8").replace(/export (async function|function)/g, "$1") + "\n" +
  fs.readFileSync(__dirname + "/functions/api/upload.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function");
eval(uploadSrc);
const uploadHandler = onRequestPost;

if(!global.crypto) global.crypto = {};
if(!global.crypto.randomUUID) global.crypto.randomUUID = () => "11111111-2222-3333-4444-555555555555";

// ---- test helpers ----
// In-memory stand-in for the D1 `rate_limits` table — implements exactly the
// three statements rateLimit.js issues (upsert…RETURNING, SELECT, sweep).
function makeD1(){
  const rows = new Map();
  let writes = 0;
  return {
    _rows: rows, get _writes(){ return writes; },
    prepare(sql){ return { bind(...a){ return {
      first: async () => {
        if(sql.startsWith("INSERT INTO rate_limits")){
          writes++;
          const prev = rows.get(a[0]);
          const count = (prev ? prev.count : 0) + 1;
          rows.set(a[0], { count, expiresAt: a[1] });
          return { count };
        }
        if(sql.startsWith("SELECT count FROM rate_limits")){
          const r = rows.get(a[0]); return r ? { count: r.count } : null;
        }
        return null;
      },
      run: async () => {
        if(sql.startsWith("DELETE FROM rate_limits")){ for(const [k, v] of rows) if(v.expiresAt < a[0]) rows.delete(k); }
        return { meta: { changes: 0 } };
      },
    }; } }; },
  };
}
function reqWithIp(ip, extra){
  return Object.assign({ headers: { get: (h) => h === "CF-Connecting-IP" ? ip : null } }, extra || {});
}

(async () => {
  // ========================
  // rateLimit.js — unit
  // ========================
  console.log("=== rateLimit.js: allows requests under the limit, blocks at/over it ===");
  {
    const env = { DB: makeD1() };
    const req = reqWithIp("1.2.3.4");
    let last;
    for(let i = 0; i < 5; i++){ last = await rateLimited(env, "unit_a", req, 5); }
    console.log("5th request (at the limit) still allowed:", last.blocked === false);
    const sixth = await rateLimited(env, "unit_a", req, 5);
    console.log("6th request is blocked:", sixth.blocked === true);
    console.log("retryAfter is a sane 1-60s value:", sixth.retryAfter >= 1 && sixth.retryAfter <= 60);
  }

  console.log("\n=== rateLimit.js: different IPs are tracked independently ===");
  {
    const env = { DB: makeD1() };
    for(let i = 0; i < 5; i++){ await rateLimited(env, "unit_b", reqWithIp("10.0.0.1"), 5); }
    const blocked = await rateLimited(env, "unit_b", reqWithIp("10.0.0.1"), 5);
    console.log("Exhausted IP is blocked:", blocked.blocked === true);
    const other = await rateLimited(env, "unit_b", reqWithIp("10.0.0.2"), 5);
    console.log("A different IP on the SAME bucket is unaffected:", other.blocked === false);
  }

  console.log("\n=== rateLimit.js: different buckets are tracked independently for the same IP ===");
  {
    const env = { DB: makeD1() };
    const ip = reqWithIp("10.0.0.5");
    for(let i = 0; i < 5; i++){ await rateLimited(env, "bucket_x", ip, 5); }
    const blockedX = await rateLimited(env, "bucket_x", ip, 5);
    console.log("bucket_x is exhausted:", blockedX.blocked === true);
    const bucketY = await rateLimited(env, "bucket_y", ip, 5);
    console.log("bucket_y (same IP, different bucket) is unaffected:", bucketY.blocked === false);
  }

  console.log("\n=== rateLimit.js: no D1 binding -> never blocks (local dev without the binding) ===");
  {
    const env = {};
    let r;
    for(let i = 0; i < 50; i++){ r = await rateLimited(env, "unit_c", reqWithIp("1.1.1.1"), 5); }
    console.log("50 requests, still never blocked:", r.blocked === false);
  }

  console.log("\n=== rateLimit.js: a D1 error never blocks a first request, and limits still apply (in memory) ===");
  {
    const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1_ERROR: no such table: rate_limits"); }, run: async () => {} }) }) };
    const env = { DB: broken };
    const r = await rateLimited(env, "unit_d", reqWithIp("1.1.1.1"), 1);
    console.log("Request allowed despite D1 error (rateLimited):", r.blocked === false);
    const c = await rateLimitCheck(env, "unit_e", reqWithIp("1.1.1.1"), 1);
    console.log("Request allowed despite D1 error (rateLimitCheck):", c.blocked === false);
    // …but limiting doesn't switch OFF during a D1 outage: counts fall back to memory.
    const r2 = await rateLimited(env, "unit_d", reqWithIp("1.1.1.1"), 1);
    console.log("D1 down: the request over the limit is still blocked (counted in memory):", r2.blocked === true);
    const ip = reqWithIp("2.2.2.2");
    for(let i = 0; i < 3; i++) await rateLimitHit(env, "unit_f", ip);
    const c2 = await rateLimitCheck(env, "unit_f", ip, 3);
    console.log("D1 down: failed sign-ins still add up and block the IP at the limit:", c2.blocked === true);
    const c3 = await rateLimitCheck(env, "unit_f", reqWithIp("3.3.3.3"), 3);
    console.log("…without blocking other IPs:", c3.blocked === false);
  }

  console.log("\n=== rateLimit.js: a blocked IP is short-circuited in memory (no more D1 writes this window) ===");
  {
    const db = makeD1();
    const env = { DB: db };
    const req = reqWithIp("4.4.4.4");
    for(let i = 0; i < 3; i++){ await rateLimited(env, "unit_mem", req, 2); }
    const writesWhenBlocked = db._writes;
    for(let i = 0; i < 20; i++){ await rateLimited(env, "unit_mem", req, 2); }
    console.log("20 more blocked requests cost zero D1 writes:", db._writes === writesWhenBlocked);
  }

  console.log("\n=== rateLimit.js: window resets after 60s elapses ===");
  {
    const env = { DB: makeD1() };
    const req = reqWithIp("5.5.5.5");
    const originalNow = Date.now;
    let fakeNow = 1700000000000;
    Date.now = () => fakeNow;
    let r;
    for(let i = 0; i < 3; i++){ r = await rateLimited(env, "unit_window", req, 3); }
    console.log("3rd request in the window is allowed:", r.blocked === false);
    const blocked = await rateLimited(env, "unit_window", req, 3);
    console.log("4th request in the SAME window is blocked:", blocked.blocked === true);
    fakeNow += 61 * 1000;
    const afterWindow = await rateLimited(env, "unit_window", req, 3);
    console.log("Request in the NEXT window is allowed again:", afterWindow.blocked === false);
    Date.now = originalNow;
  }

  console.log("\n=== rateLimitResponse(): 429 with Retry-After header and a clear JSON message ===");
  {
    const res = rateLimitResponse(42);
    console.log("Status 429:", res.status === 429);
    console.log("Retry-After header echoes the value:", res.headers.get("Retry-After") === "42");
    const data = JSON.parse(await res.text());
    console.log("Body is a clear error message:", data.status === "error" && /too many requests/i.test(data.message));
  }

  // ========================
  // adminAuth.js — unit
  // ========================
  console.log("\n=== timingSafeEqual(): correct/incorrect comparisons ===");
  console.log("Equal strings:", timingSafeEqual("proxy-pass", "proxy-pass") === true);
  console.log("Different length:", timingSafeEqual("short", "much-longer-value") === false);
  console.log("Same length, different content:", timingSafeEqual("aaaaaaaa", "aaaaaaab") === false);
  console.log("Non-string inputs never throw, just return false:", timingSafeEqual(undefined, "x") === false && timingSafeEqual(null, "x") === false);

  console.log("\n=== requireAdmin(): host/passphrase/rate-limit gating ===");
  {
    const env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", DB: makeD1() };
    const req = reqWithIp("2.2.2.2");

    const notAdmin = await requireAdmin(env, {kind:"locked", orgId:"x"}, "proxy-pass", req, "Custom not-admin message");
    console.log("Non-admin host refused with 403 and the caller's custom message:", notAdmin.status === 403);
    const notAdminData = JSON.parse(await notAdmin.text());
    console.log("Custom message honored:", notAdminData.message === "Custom not-admin message");

    const wrongKey = await requireAdmin(env, {kind:"admin"}, "nope", req, "msg");
    console.log("Wrong passphrase -> 401 Unauthorized:", wrongKey.status === 401);
    console.log("Message is exactly 'Unauthorized':", JSON.parse(await wrongKey.text()).message === "Unauthorized");

    const ok = await requireAdmin(env, {kind:"admin"}, "proxy-pass", req, "msg");
    console.log("Correct passphrase -> null (proceed):", ok === null);

    const unconfigured = await requireAdmin({DB: makeD1()}, {kind:"admin"}, "anything", reqWithIp("2.2.2.3"), "msg");
    console.log("Unset PROXY_ADMIN_PASSPHRASE -> 401 Unauthorized (not a separate 500 leaking config state):", unconfigured.status === 401);
  }

  console.log("\n=== requireAdmin(): rate limit blocks brute-force attempts, even a correct guess once exhausted ===");
  {
    const env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", DB: makeD1() };
    const req = reqWithIp("3.3.3.3");
    let last;
    for(let i = 0; i < 10; i++){ last = await requireAdmin(env, {kind:"admin"}, "wrong-guess-" + i, req, "msg"); }
    console.log("10th wrong guess still just 401 (within budget):", last.status === 401);
    const overLimit = await requireAdmin(env, {kind:"admin"}, "wrong-guess-11", req, "msg");
    console.log("11th attempt from the same IP -> 429, not 401:", overLimit.status === 429);
    const withCorrectKey = await requireAdmin(env, {kind:"admin"}, "proxy-pass", req, "msg");
    console.log("Even the CORRECT passphrase is blocked once the budget is exhausted (rate limit runs before the compare):", withCorrectKey.status === 429);
  }

  console.log("\n=== requireAdmin(): SUCCESSFUL requests are never counted (no D1 writes, never throttled) ===");
  {
    const db = makeD1();
    const env = { PROXY_ADMIN_PASSPHRASE: "proxy-pass", DB: db };
    const req = reqWithIp("3.3.3.4");
    let ok = true;
    for(let i = 0; i < 200; i++){ ok = ok && (await requireAdmin(env, {kind:"admin"}, "proxy-pass", req, "msg")) === null; }
    console.log("200 authorized admin requests in one minute all pass:", ok);
    console.log("...and cost zero rate-limit writes:", db._writes === 0);
  }

  // ========================
  // Integration — orders.js + upload.js share admin_auth
  // ========================
  console.log("\n=== Integration: orders.js admin actions rate-limited (admin_auth, 10 failed attempts/min/IP) ===");
  {
    const kv = makeD1();
    const env = {
      DB: kv, PROXY_ADMIN_PASSPHRASE: "proxy-pass"
    };
    const ip = "9.9.9.9";
    const mkReq = () => reqWithIp(ip, {
      json: async () => ({action:"getOrders", org:"league-101", key:"WRONG"}),
      url: "https://admin.example.com/api/orders"
    });
    let last;
    for(let i = 0; i < 10; i++){ last = await ordersHandler({ request: mkReq(), env }); }
    console.log("10th failed request (still within budget) reaches the passphrase check (401, not 429):", last.status === 401);
    const overLimit = await ordersHandler({ request: mkReq(), env });
    console.log("11th failed request from the same IP -> 429:", overLimit.status === 429);

    console.log("\n=== Cross-endpoint: upload.js shares the SAME admin_auth budget as orders.js ===");
    const uploadEnv = Object.assign({ IMAGES: { put: async () => {} }, R2_PUBLIC_BASE: "https://img.example.com" }, env);
    const uploadReq = reqWithIp(ip, {
      url: "https://admin.example.com/api/upload",
      headers: { get: (h) => h === "X-Admin-Key" ? "proxy-pass" : (h === "CF-Connecting-IP" ? ip : null) },
      arrayBuffer: async () => new ArrayBuffer(10)
    });
    const uploadRes = await uploadHandler({ request: uploadReq, env: uploadEnv });
    console.log("upload.js is ALSO blocked from the same IP, even with the CORRECT passphrase (shared budget):", uploadRes.status === 429);

    console.log("\n=== A fresh IP is unaffected by the exhausted budget above ===");
    const freshRes = await ordersHandler({
      request: reqWithIp("6.6.6.6", { json: async () => ({action:"getOrders", org:"league-101", key:"WRONG"}), url: "https://admin.example.com/api/orders" }),
      env
    });
    console.log("Fresh IP still reaches the passphrase check (401, not 429):", freshRes.status === 401);
  }

  // ========================
  // Integration — checkout.js has its own bucket
  // ========================
  console.log("\n=== Integration: checkout.js rate-limited independently (checkout bucket, 20/min/IP) ===");
  {
    const kv = makeD1();
    const env = {
      DB: kv, STRIPE_SECRET_KEY: "sk_test_fake"
    };
    // checkout.js calls getOrderTotal(env.DB) directly — global mock returns 10.
    // It still calls fetch() for the Stripe API.
    global.fetch = async (url) => {
      if(String(url).includes("stripe.com")) return { json: async () => ({url:"https://checkout.stripe.com/pay/cs_x"}) };
      return { json: async () => ({status:"ok"}) };
    };
    const ip = "8.8.8.8";
    const mkReq = () => reqWithIp(ip, {
      json: async () => ({checkoutToken: await require("./testlib/order-token").orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-RL1"), orderId:"ORD-RL1", orgId:"league-101", customerName:"X", contact:"x@example.com"}),
      url: "https://example.com/api/checkout"
    });
    let last;
    for(let i = 0; i < 20; i++){ last = await checkoutHandler({ request: mkReq(), env }); }
    console.log("20th checkout request (at the limit) still succeeds:", last.status === 200);
    const res21 = await checkoutHandler({ request: mkReq(), env });
    console.log("21st checkout request from the same IP -> 429:", res21.status === 429);

    console.log("\n=== admin_auth budget is untouched by checkout traffic sharing the same IP ===");
    const ordersEnv = { DB: kv, PROXY_ADMIN_PASSPHRASE: "proxy-pass" };
    const adminRes = await ordersHandler({
      request: reqWithIp(ip, { json: async () => ({action:"getOrders", org:"league-101", key:"proxy-pass"}), url: "https://admin.example.com/api/orders" }),
      env: ordersEnv
    });
    console.log("Admin request from the SAME IP still works fine (separate bucket from checkout):", adminRes.status === 200);
  }

  // ========================
  // Integration — order submission has its own bucket
  // ========================
  console.log("\n=== Integration: orders.js order submission rate-limited independently (order_submit bucket, 20/min/IP) ===");
  {
    const kv = makeD1();
    const env = { DB: kv };
    const ip = "7.7.7.7";
    const mkReq = () => reqWithIp(ip, {
      json: async () => ({
        orderId: "ORD-OS1", orgId: "league-101",
        contact: "test@example.com", customerName: "Test",
        items: [{productId: "shirt-l", type: "shirt", size: "L", qty: 1}]
      }),
      url: "https://league101.example.com/api/orders"
    });
    let last;
    for(let i = 0; i < 20; i++){ last = await ordersHandler({ request: mkReq(), env }); }
    const lastData = JSON.parse(await last.text());
    console.log("20th order submission (at the limit) still succeeds:", lastData.status === "ok");
    const res21 = await ordersHandler({ request: mkReq(), env });
    console.log("21st order submission from the same IP -> 429:", res21.status === 429);
  }
})();
