const fs = require("fs");

// This test verifies the access-control, security, and routing logic in
// functions/api/orders.js (backed by Cloudflare D1).
// The test stubs out db.js and email.js functions so
// that the pure logic can be exercised without a live database.

let libSrc = fs.readFileSync(__dirname + "/functions/_lib/hostConfig.js", "utf8")
  .replace(/export const/g, "const")
  .replace(/export function/g, "function");

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

// getCatalogData(env) mock — orders.js calls this for classifyHost's subdomainMap.
global.getCatalogData = async () => ({
  subdomainMap: {
    "league101": "league-101",
    "league202": "league-202",
    "league303": "league-303",
    "club404": "club-404",
    "rec": "rec"
  },
  orgs: {}
});

// ---- db.js mocks (set/overridden per test as needed) ----
global.getAllOrgs = async () => [];
// Order submission requires the org to exist and be ready (server-side).
// shippingEnabled: a signed carrier quote is only accepted for a shop that offers shipping (migrations/0045).
global.getOrgById = async (db, orgId) => ({ orgId, name: orgId, subdomain: "", ready: true, shippingEnabled: true, orderDeadline: null, allowOrdersAfterDeadline: true });
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
global.getOrderById = async () => ({ orderId:"X1", orgId:"league-101", contact:"c@x.com", paid:0, items:[] });
global.insertOrder = async () => {};
global.setOrderPaid = async () => {};
// markPaidManual settles the balance in the payments ledger.
global.settleOrderBalance = async () => 0;
global.getOrderItemById = async () => null;
global.setOrderEmailTimestamp = async () => {};
global.setFulfillmentStage = async () => {};
global.setTrackingNumbers = async () => {};
global.cancelLineItemWithReason = async () => {};
global.setLineItemRefund = async () => {};
global.getOrderTotal = async () => 25;
global.getOrderForShipping = async () => null;
global.priceItem = async () => ({ unitPrice: 25, personalizationFee: 0 });
global.setOrderRefunded = async () => {};
global.setOrderDisputeStatus = async () => {};
global.getPublicCatalogData = async () => ({ subdomainMap: {}, orgs: {} });
global.insertAuditLog = async () => {};
global.getAuditLog = async () => [];
global.getRevenueData = async () => [];
global.monthOf = (iso) => String(iso || "").slice(0, 7);
global.isMonthClosed = async () => false;
global.orderMonth = async () => "";
global.itemOrderMonth = async () => "";
global.paymentMonth = async () => "";

// ---- email.js mocks ----
global.sendOrderReceivedEmail = async () => true;
global.sendOrderNotificationEmail = async () => {};
global.sendPaymentConfirmedEmail = async () => true;
global.sendCancellationEmail = async () => true;

// quoteToken.js + turnstile.js — real implementations (pure, no bindings).
let quoteTokenSrc = fs.readFileSync(__dirname + "/functions/_lib/quoteToken.js", "utf8")
  .replace(/export (async function|function|const)/g, "$1");
let turnstileSrc = fs.readFileSync(__dirname + "/functions/_lib/turnstile.js", "utf8")
  .replace(/export (async function|function|const)/g, "$1");
eval(quoteTokenSrc + "\n" + turnstileSrc);

let src = fs.readFileSync(__dirname + "/functions/api/orders.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function");

eval(libSrc + "\n" + rateLimitSrc + "\n" + adminAuthSrc + "\n" + httpSrc + "\n" + src);

const BASE_ENV = {
  DB: {},
  PROXY_ADMIN_PASSPHRASE: "proxy-passphrase",
  STRIPE_SECRET_KEY: "sk_test_fake"
};
// These tests authenticate with the passphrase and carry a stub DB; no 2FA secret is stored.
global.getSettingRaw = async () => null;
// …and no users yet, so the installer's passphrase is the way in.
global.getBootstrapState = async () => ({ userCount: 0, admins: [] });

let _ctxIp = 0;
function makeContext(bodyObj, env, url){
  // Use a unique IP per call so the rate limiter never accumulates across
  // test sections (test26 covers rate-limit behaviour separately).
  const ip = "10.0." + Math.floor(++_ctxIp / 256) + "." + (_ctxIp % 256 || 1);
  return {
    request: {
      json: async () => bodyObj,
      url: url || "https://example.com/api/orders",
      headers: { get: () => ip }
    },
    env: env || BASE_ENV,
    waitUntil: (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); },
  };
}

(async () => {

  console.log("=== Missing DB binding -> clean misconfigured error ===");
  {
    const res = await onRequestPost(makeContext({orgId:"x", items:[]}, { PROXY_ADMIN_PASSPHRASE:"p" }));
    const data = JSON.parse(await res.text());
    console.log("Clean config error:", data.status === "error" && data.message.includes("misconfigured"));
  }

  console.log("\n=== listOrgs with WRONG proxy passphrase (from the admin subdomain): rejected, D1 not queried ===");
  {
    let dbQueried = false;
    global.getAllOrgs = async () => { dbQueried = true; return []; };
    const res = await onRequestPost(makeContext({action:"listOrgs", key:"wrong-guess"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Rejected:", data.status === "error" && data.message === "Unauthorized");
    console.log("D1 was never queried:", !dbQueried);
    global.getAllOrgs = async () => [];
  }

  console.log("\n=== listOrgs with CORRECT proxy passphrase (from the admin subdomain): returns org list from D1 ===");
  {
    global.getAllOrgs = async () => [
      {orgId:"league-101", name:"Example League 101"},
      {orgId:"rec", name:"REC"}
    ];
    const res = await onRequestPost(makeContext({action:"listOrgs", key:"proxy-passphrase"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Returns ok with an org list:", data.status === "ok" && Array.isArray(data.orgs) && data.orgs.length > 0);
    console.log("Includes league-101 with its display name:", data.orgs.some(o => o.orgId === "league-101" && o.name === "Example League 101"));
    console.log("Response includes subdomain (for Clone From picker):", data.orgs.every(o => "subdomain" in o));
    console.log("Response does not leak fuller registry fields:", data.orgs.every(o => !("accent" in o) && !("desc" in o)));
    global.getAllOrgs = async () => [];
  }

  console.log("\n=== listOrgs from a locked org subdomain or the root domain is refused ===");
  {
    const res1 = await onRequestPost(makeContext({action:"listOrgs", key:"proxy-passphrase"}, BASE_ENV, "https://league101.example.com/api/orders"));
    console.log("Refused from a locked subdomain:", JSON.parse(await res1.text()).status === "error" && res1.status === 403);
    const res2 = await onRequestPost(makeContext({action:"listOrgs", key:"proxy-passphrase"}, BASE_ENV, "https://example.com/api/orders"));
    console.log("Refused from the root domain:", JSON.parse(await res2.text()).status === "error" && res2.status === 403);
  }

  console.log("\n=== getOrders with WRONG proxy passphrase (from the admin subdomain): rejected, D1 not queried ===");
  {
    let dbQueried = false;
    global.getOrdersByOrg = async () => { dbQueried = true; return []; };
    const res = await onRequestPost(makeContext({action:"getOrders", org:"league-101", key:"wrong-guess"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Rejected:", data.status === "error" && data.message === "Unauthorized");
    console.log("D1 was never queried:", !dbQueried);
    global.getOrdersByOrg = async () => [];
  }

  console.log("\n=== getOrders with CORRECT proxy passphrase (from the admin subdomain): returns orders from D1 ===");
  {
    global.getOrdersByOrg = async (db, org) => {
      if(org === "league-101") return [{orderId:"X1", orgId:org, items:[]}];
      return [];
    };
    const res = await onRequestPost(makeContext({action:"getOrders", org:"league-101", key:"proxy-passphrase"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Returns ok with orders:", data.status === "ok" && Array.isArray(data.orders) && data.orders.length === 1);
    console.log("Order belongs to correct org:", data.orders[0].orgId === "league-101");
    global.getOrdersByOrg = async () => [];
  }

  console.log("\n=== getOrders from a locked org subdomain or the root domain is refused ===");
  {
    const res1 = await onRequestPost(makeContext({action:"getOrders", org:"league-101", key:"proxy-passphrase"}, BASE_ENV, "https://league101.example.com/api/orders"));
    console.log("Refused from a locked subdomain:", JSON.parse(await res1.text()).status === "error" && res1.status === 403);
    const res2 = await onRequestPost(makeContext({action:"getOrders", org:"league-101", key:"proxy-passphrase"}, BASE_ENV, "https://example.com/api/orders"));
    console.log("Refused from the root domain:", JSON.parse(await res2.text()).status === "error" && res2.status === 403);
  }

  console.log("\n=== markPaidManual with WRONG proxy passphrase: rejected, D1 not written ===");
  {
    let dbWritten = false;
    global.settleOrderBalance = async () => { dbWritten = true; return 0; };
    const res = await onRequestPost(makeContext({action:"markPaidManual", org:"league-101", orderId:"ORD-T1", key:"wrong-guess"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Rejected:", data.status === "error" && data.message === "Unauthorized");
    console.log("D1 was never written:", !dbWritten);
    global.settleOrderBalance = async () => 0;
// markPaidManual settles the balance in the payments ledger.
global.settleOrderBalance = async () => 0;
global.getOrderItemById = async () => null;
  }

  console.log("\n=== markPaidManual with CORRECT proxy passphrase: settles the balance in the ledger and returns ok ===");
  {
    let paidOrderId = null, paidNote = null;
    global.settleOrderBalance = async (db, orderId, note) => { paidOrderId = orderId; paidNote = note; return 25; };
    global.getOrderById = async () => ({ orderId:"ORD-T1", orgId:"league-101", contact:"c@x.com", paid:0, items:[] });
    const res = await onRequestPost(makeContext({action:"markPaidManual", org:"league-101", orderId:"ORD-T1", key:"proxy-passphrase"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Returns ok:", data.status === "ok");
    console.log("settleOrderBalance called with the correct orderId:", paidOrderId === "ORD-T1");
    console.log("Ledger note says it was marked paid manually:", /Marked paid manually/.test(paidNote || ""));
    global.settleOrderBalance = async () => 0;
// markPaidManual settles the balance in the payments ledger.
global.settleOrderBalance = async () => 0;
global.getOrderItemById = async () => null;
    global.getOrderById = async () => ({ orderId:"X1", orgId:"league-101", contact:"c@x.com", paid:0, items:[] });
  }

  console.log("\n=== markPaidManual from a locked subdomain or root domain is refused ===");
  {
    const res1 = await onRequestPost(makeContext({action:"markPaidManual", org:"league-101", orderId:"X1", key:"proxy-passphrase"}, BASE_ENV, "https://league101.example.com/api/orders"));
    console.log("Refused from a locked subdomain:", JSON.parse(await res1.text()).status === "error" && res1.status === 403);
    const res2 = await onRequestPost(makeContext({action:"markPaidManual", org:"league-101", orderId:"X1", key:"proxy-passphrase"}, BASE_ENV, "https://example.com/api/orders"));
    console.log("Refused from the root domain:", JSON.parse(await res2.text()).status === "error" && res2.status === 403);
  }

  console.log("\n=== createTestTransaction with WRONG proxy passphrase: rejected ===");
  {
    let dbWritten = false;
    global.insertOrder = async () => { dbWritten = true; };
    const res = await onRequestPost(makeContext({action:"createTestTransaction", org:"league-101", amount:5, key:"wrong-guess"}, BASE_ENV, "https://admin.example.com/api/orders"));
    console.log("Rejected:", JSON.parse(await res.text()).status === "error");
    console.log("D1 was never written:", !dbWritten);
    global.insertOrder = async () => {};
  }

  console.log("\n=== createTestTransaction with an invalid amount is rejected before inserting ===");
  {
    let dbWritten = false;
    global.insertOrder = async () => { dbWritten = true; };
    const res = await onRequestPost(makeContext({action:"createTestTransaction", org:"league-101", amount:-5, key:"proxy-passphrase"}, BASE_ENV, "https://admin.example.com/api/orders"));
    console.log("Rejected:", JSON.parse(await res.text()).status === "error");
    console.log("D1 was never written:", !dbWritten);
    global.insertOrder = async () => {};
  }

  console.log("\n=== createTestTransaction with correct passphrase: inserts test order and returns Stripe URL ===");
  {
    let insertedOrder = null;
    global.insertOrder = async (db, order) => { insertedOrder = order; };
    global.fetch = async (url) => {
      if(String(url).includes("stripe.com")) return { json: async () => ({id:"cs_test_123", url:"https://checkout.stripe.com/pay/cs_test_abc"}) };
      return { json: async () => ({status:"ok"}) };
    };
    const res = await onRequestPost(makeContext({action:"createTestTransaction", org:"league-101", amount:7.50, key:"proxy-passphrase"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Returns ok with checkout URL:", data.status === "ok" && data.checkoutUrl && data.checkoutUrl.includes("checkout.stripe.com"));
    console.log("Test order inserted with TEST- prefix orderId:", insertedOrder && insertedOrder.orderId.startsWith("TEST-"));
    console.log("Amount was inserted correctly:", insertedOrder && insertedOrder.total === 7.50);
    global.insertOrder = async () => {};
  }

  console.log("\n=== createTestTransaction from a locked subdomain is refused ===");
  {
    const res = await onRequestPost(makeContext({action:"createTestTransaction", org:"league-101", amount:5, key:"proxy-passphrase"}, BASE_ENV, "https://league101.example.com/api/orders"));
    console.log("Refused from a locked subdomain:", JSON.parse(await res.text()).status === "error" && res.status === 403);
  }

  console.log("\n=== resendEmail with WRONG proxy passphrase: rejected ===");
  {
    let dbQueried = false;
    global.getOrderById = async () => { dbQueried = true; return null; };
    const res = await onRequestPost(makeContext({action:"resendEmail", org:"league-101", orderId:"ORD-T1", key:"wrong-guess"}, BASE_ENV, "https://admin.example.com/api/orders"));
    console.log("Rejected:", JSON.parse(await res.text()).status === "error");
    console.log("D1 was never queried:", !dbQueried);
    global.getOrderById = async () => ({ orderId:"X1", orgId:"league-101", contact:"c@x.com", paid:0, items:[] });
  }

  console.log("\n=== resendEmail with correct passphrase on unpaid order: returns 'received' ===");
  {
    global.getOrderById = async () => ({ orderId:"ORD-T1", orgId:"league-101", contact:"c@x.com", paid:0, items:[] });
    const res = await onRequestPost(makeContext({action:"resendEmail", org:"league-101", orderId:"ORD-T1", key:"proxy-passphrase"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Returns ok with resent=received:", data.status === "ok" && data.resent === "received");
    global.getOrderById = async () => ({ orderId:"X1", orgId:"league-101", contact:"c@x.com", paid:0, items:[] });
  }

  console.log("\n=== resendEmail with correct passphrase on PAID order: returns 'confirmed' ===");
  {
    global.getOrderById = async () => ({ orderId:"ORD-T1", orgId:"league-101", contact:"c@x.com", paid:1, paidAt:"2026-01-01T00:00:00.000Z", items:[] });
    const res = await onRequestPost(makeContext({action:"resendEmail", org:"league-101", orderId:"ORD-T1", key:"proxy-passphrase"}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Returns ok with resent=confirmed:", data.status === "ok" && data.resent === "confirmed");
    global.getOrderById = async () => ({ orderId:"X1", orgId:"league-101", contact:"c@x.com", paid:0, items:[] });
  }

  console.log("\n=== Order submission on the admin subdomain is refused ===");
  {
    const res = await onRequestPost(makeContext({orderId:"T9", customerName:"Test Customer", orgId:"league-101", contact:"a@b.com", items:[{productId:"s",type:"shirt",size:"L",qty:1}]}, BASE_ENV, "https://admin.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Refused:", data.status === "error" && res.status === 403);
  }

  console.log("\n=== Order from an unrecognized hostname is refused entirely ===");
  {
    const res = await onRequestPost(makeContext({orderId:"T7", customerName:"Test Customer", orgId:"league-101", contact:"a@b.com", items:[]}, BASE_ENV, "https://randomguess.example.com/api/orders"));
    const data = JSON.parse(await res.text());
    console.log("Refused with 'Unrecognized host':", data.status === "error" && data.message === "Unrecognized host");
  }

  console.log("\n=== An unrecognized action on the order-submission fallthrough is refused (400 Unknown action) ===");
  {
    const res = await onRequestPost(makeContext({action:"someArbitraryAppsScriptAction", orgId:"league-101"}, BASE_ENV));
    const data = JSON.parse(await res.text());
    console.log("Refused with 400 'Unknown action':", res.status === 400 && data.status === "error" && data.message === "Unknown action");
  }

  console.log("\n=== Order submission: orgId spoofed on a locked subdomain is corrected to the real subdomain's org ===");
  {
    let insertedOrgId = null;
    global.insertOrder = async (db, order) => { insertedOrgId = order.orgId; };
    const spoofedOrder = {orderId:"T2", customerName:"Test Customer", orgId:"league-101", contact:"a@b.com", items:[{productId:"s",type:"shirt",size:"M",qty:1}]};
    await onRequestPost(makeContext(spoofedOrder, BASE_ENV, "https://club404.example.com/api/orders"));
    console.log("Order recorded under club-404 (the real subdomain), not the spoofed league-101:", insertedOrgId === "club-404");
    global.insertOrder = async () => {};
  }

  console.log("\n=== The bare domain takes no orders — the shop comes from the address, never the request ===");
  {
    let insertedOrgId = null;
    global.insertOrder = async (db, order) => { insertedOrgId = order.orgId; };
    const hubOrder = {orderId:"T3", customerName:"Test Customer", orgId:"league-202", contact:"a@b.com", items:[{productId:"s",type:"shirt",size:"M",qty:1}]};
    const hubRes = await onRequestPost(makeContext(hubOrder, BASE_ENV, "https://example.com/api/orders"));
    console.log("An order sent to the bare domain naming a shop is refused, nothing saved:", hubRes.status === 403 && insertedOrgId === null && /shop's own page/.test(JSON.parse(await hubRes.text()).message));
    const unknownRes = await onRequestPost(makeContext(Object.assign({}, hubOrder, { orgId: "no-such-shop" }), BASE_ENV, "https://example.com/api/orders"));
    console.log("…with the same answer whether or not that shop exists (no guessing shop ids):", unknownRes.status === 403 && JSON.parse(await unknownRes.text()).message === "Orders are placed from a shop's own page.");
    await onRequestPost(makeContext(hubOrder, BASE_ENV, "http://localhost:8788/api/orders"));
    console.log("A developer's own machine (localhost) may still name the shop:", insertedOrgId === "league-202");
    global.insertOrder = async () => {};
  }

  console.log("\n=== Order submission: server-side priceItem is called, not client-supplied price ===");
  {
    let pricedProductId = null;
    global.priceItem = async (db, orgId, productId) => { pricedProductId = productId; return { unitPrice: 99, personalizationFee: 0 }; };
    let insertedTotal = null;
    global.insertOrder = async (db, order) => { insertedTotal = order.total; };
    const order = {orderId:"T4", customerName:"Test Customer", orgId:"league-101", contact:"a@b.com", items:[{productId:"shirt-l", type:"shirt", size:"L", qty:1}]};
    await onRequestPost(makeContext(order, BASE_ENV, "https://league101.example.com/api/orders"));
    console.log("priceItem was called for the item:", pricedProductId === "shirt-l");
    console.log("Total reflects server-side price ($99), not any client value:", insertedTotal === 99);
    global.priceItem = async () => ({ unitPrice: 25, personalizationFee: 0 });
    global.insertOrder = async () => {};
  }

  console.log("\n=== Order submission: valid email required ===");
  {
    const res = await onRequestPost(makeContext({orderId:"T5", customerName:"Test Customer", orgId:"league-101", contact:"555-1234", items:[{productId:"s",type:"shirt",size:"L",qty:1}]}, BASE_ENV, "https://league101.example.com/api/orders"));
    console.log("Rejected with phone-only contact:", JSON.parse(await res.text()).status === "error");
  }

  console.log("\n=== Order submission: empty items array rejected ===");
  {
    const res = await onRequestPost(makeContext({orderId:"T6", customerName:"Test Customer", orgId:"league-101", contact:"a@b.com", items:[]}, BASE_ENV, "https://league101.example.com/api/orders"));
    console.log("Rejected with empty items:", JSON.parse(await res.text()).status === "error");
  }
  // ======================================================================
  // The client can't set shipping cost / placedAt,
  // and closed shops / past hard deadlines are enforced server-side.
  // ======================================================================
  const PP_URL = "https://league101.example.com/api/orders";
  const QUOTE_ENV = Object.assign({}, BASE_ENV, { QUOTE_SIGNING_SECRET: "quote-secret" });
  const baseItems = [{productId:"shirt-l", type:"shirt", size:"L", qty:2}];
  const addr = { name:"A", line1:"1 Main", city:"X", state:"PA", zip:"15001" };

  console.log("\n=== Fix #1: client-supplied negative shippingCost is ignored ===");
  {
    let ins = null;
    global.insertOrder = async (db, order) => { ins = order; };
    await onRequestPost(makeContext({orderId:"S1", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: baseItems, shippingCost: -40, total: 10, subtotal: 10}, QUOTE_ENV, PP_URL));
    console.log("Stored shippingCost is 0, not -40:", ins && ins.shippingCost === 0);
    console.log("Stored total is server subtotal ($50), not client total:", ins && ins.total === 50);
    global.insertOrder = async () => {};
  }

  console.log("\n=== Fix #1: client-supplied placedAt is ignored (no backdating) ===");
  {
    let ins = null;
    global.insertOrder = async (db, order) => { ins = order; };
    await onRequestPost(makeContext({orderId:"S2", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: baseItems, placedAt: "2020-01-01T00:00:00.000Z"}, QUOTE_ENV, PP_URL));
    console.log("placedAt is server time:", ins && ins.placedAt.slice(0,4) !== "2020" && Math.abs(Date.parse(ins.placedAt) - Date.now()) < 60000);
    global.insertOrder = async () => {};
  }

  console.log("\n=== Fix #1: valid signed shipping quote is charged ===");
  {
    let ins = null;
    global.insertOrder = async (db, order) => { ins = order; };
    const tok = await signQuote(QUOTE_ENV, { orgId:"league-101", zip:"15001", items: canonicalItems(baseItems), amountCents: 1234, method:"USPS Ground" });
    const res = await onRequestPost(makeContext({orderId:"S3", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: baseItems, shippingAddress: addr, shippingQuoteToken: tok, shippingCost: 0.01}, QUOTE_ENV, PP_URL));
    console.log("Accepted:", res.status === 200);
    console.log("Shipping comes from the quote ($12.34), not the client ($0.01):", ins && ins.shippingCost === 12.34);
    console.log("Total = $50 + $12.34:", ins && Math.abs(ins.total - 62.34) < 1e-9);
    console.log("Method comes from the quote:", ins && ins.shippingMethod === "USPS Ground");
    global.insertOrder = async () => {};
  }

  console.log("\n=== Fix #1: tampered / mismatched quotes are rejected ===");
  {
    let inserted = false;
    global.insertOrder = async () => { inserted = true; };
    const tok = await signQuote(QUOTE_ENV, { orgId:"league-101", zip:"15001", items: canonicalItems(baseItems), amountCents: 1234, method:"USPS Ground" });
    const [body, sig] = tok.split(".");
    const forgedBody = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(body.replace(/-/g,"+").replace(/_/g,"/"), "base64").toString()), {a: 1}))).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    const r1 = await onRequestPost(makeContext({orderId:"S4", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: baseItems, shippingAddress: addr, shippingQuoteToken: forgedBody + "." + sig}, QUOTE_ENV, PP_URL));
    console.log("Forged amount → 400:", r1.status === 400);
    const r2 = await onRequestPost(makeContext({orderId:"S5", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: [{productId:"shirt-l", type:"shirt", size:"L", qty:20}], shippingAddress: addr, shippingQuoteToken: tok}, QUOTE_ENV, PP_URL));
    console.log("Cart grew after quoting → 400:", r2.status === 400);
    const r3 = await onRequestPost(makeContext({orderId:"S6", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: baseItems, shippingAddress: Object.assign({}, addr, {zip:"99501"}), shippingQuoteToken: tok}, QUOTE_ENV, PP_URL));
    console.log("Different ship-to ZIP → 400:", r3.status === 400);
    const otherOrgTok = await signQuote(QUOTE_ENV, { orgId:"rec", zip:"15001", items: canonicalItems(baseItems), amountCents: 100, method:"x" });
    const r4 = await onRequestPost(makeContext({orderId:"S7", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: baseItems, shippingAddress: addr, shippingQuoteToken: otherOrgTok}, QUOTE_ENV, PP_URL));
    console.log("Quote from another org → 400:", r4.status === 400);
    const realNow = Date.now;
    Date.now = () => realNow() - 3 * 60 * 60 * 1000;  // sign 3h in the past → expired
    const oldTok = await signQuote(QUOTE_ENV, { orgId:"league-101", zip:"15001", items: canonicalItems(baseItems), amountCents: 1234, method:"x" });
    Date.now = realNow;
    const r5 = await onRequestPost(makeContext({orderId:"S8", customerName:"C", orgId:"league-101", contact:"a@b.com",
      items: baseItems, shippingAddress: addr, shippingQuoteToken: oldTok}, QUOTE_ENV, PP_URL));
    console.log("Expired quote → 400:", r5.status === 400);
    console.log("None of the rejected orders were written:", inserted === false);
    global.insertOrder = async () => {};
  }

  console.log("\n=== Fix #1: shop not ready / past a hard deadline → refused server-side ===");
  {
    let inserted = false;
    global.insertOrder = async () => { inserted = true; };
    const realGetOrg = global.getOrgById;
    global.getOrgById = async (db, orgId) => ({ orgId, ready: false });
    const r1 = await onRequestPost(makeContext({orderId:"S9", customerName:"C", orgId:"league-101", contact:"a@b.com", items: baseItems}, BASE_ENV, PP_URL));
    console.log("Not-ready shop → 403:", r1.status === 403);
    global.getOrgById = async (db, orgId) => ({ orgId, ready: true, orderDeadline: "2020-01-01", allowOrdersAfterDeadline: false, closedMessage: "Closed!" });
    const r2 = await onRequestPost(makeContext({orderId:"S10", customerName:"C", orgId:"league-101", contact:"a@b.com", items: baseItems}, BASE_ENV, PP_URL));
    console.log("Past hard deadline → 403 with the shop's closed message:", r2.status === 403 && JSON.parse(await r2.text()).message === "Closed!");
    global.getOrgById = async (db, orgId) => ({ orgId, ready: true, orderDeadline: "2020-01-01", allowOrdersAfterDeadline: true });
    let softOk = false;
    global.insertOrder = async () => { softOk = true; };
    await onRequestPost(makeContext({orderId:"S11", customerName:"C", orgId:"league-101", contact:"a@b.com", items: baseItems}, BASE_ENV, PP_URL));
    console.log("Past a SOFT deadline (late orders allowed) → still accepted:", softOk);
    console.log("Refused orders were never written:", inserted === false);
    global.getOrgById = realGetOrg;
    global.insertOrder = async () => {};
  }

  console.log("\n=== Fix #8: Turnstile enforced when TURNSTILE_SECRET_KEY is set ===");
  {
    const TS_ENV = Object.assign({}, BASE_ENV, { TURNSTILE_SECRET_KEY: "ts-secret" });
    let inserted = false;
    global.insertOrder = async () => { inserted = true; };
    const realFetch = global.fetch;
    const r1 = await onRequestPost(makeContext({orderId:"S12", customerName:"C", orgId:"league-101", contact:"a@b.com", items: baseItems}, TS_ENV, PP_URL));
    console.log("Missing token → 403:", r1.status === 403 && inserted === false);
    global.fetch = async () => ({ json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }) });
    const r2 = await onRequestPost(makeContext({orderId:"S13", customerName:"C", orgId:"league-101", contact:"a@b.com", items: baseItems, turnstileToken:"bad"}, TS_ENV, PP_URL));
    console.log("Rejected token → 403:", r2.status === 403 && inserted === false);
    global.fetch = async () => { throw new Error("network"); };
    const r3 = await onRequestPost(makeContext({orderId:"S14", customerName:"C", orgId:"league-101", contact:"a@b.com", items: baseItems, turnstileToken:"x"}, TS_ENV, PP_URL));
    console.log("siteverify unreachable → fails closed (403):", r3.status === 403 && inserted === false);
    global.fetch = async () => ({ json: async () => ({ success: true }) });
    const r4 = await onRequestPost(makeContext({orderId:"S15", customerName:"C", orgId:"league-101", contact:"a@b.com", items: baseItems, turnstileToken:"good"}, TS_ENV, PP_URL));
    console.log("Valid token → accepted:", r4.status === 200 && inserted === true);
    global.fetch = realFetch;
    global.insertOrder = async () => {};
  }
})();
