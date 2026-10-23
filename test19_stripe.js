const fs = require("fs");
const crypto = require("crypto");

// ---- shared lib ----
let libSrc = fs.readFileSync(__dirname + "/functions/_lib/hostConfig.js", "utf8")
  .replace(/export const/g, "const").replace(/export function/g, "function");

// getCatalogData(env) mock — checkout.js calls this itself (for
// classifyHost's subdomainMap) rather than importing a static object.
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

// ---- checkout.js ----
let rateLimitSrc = fs.readFileSync(__dirname + "/functions/_lib/rateLimit.js", "utf8")
  .replace(/export async function/g, "async function")
  .replace(/export function/g, "function");
let httpSrc = fs.readFileSync(__dirname + "/functions/_lib/http.js", "utf8")
  .replace(/export function/g, "function");
// checkout.js reads the order total from D1. The db.js import is stripped
// and mocked globally.
global.getOrderTotal = async (db, orderId) => 45; // default mock; overridden per test

// checkout.js calls getOrderCheckoutState(db, orderId) →
// {total (the balance due), paid, orgId, voided, customerName, contact}.
// Built on the getOrderTotal mock so per-test total overrides keep working;
// __checkoutPaid / __checkoutOrg / __checkoutVoided let a test simulate a paid
// or voided order or its org. The customer's name/email come from the ORDER ROW
// (__orderRows), never from the request body.
global.__checkoutPaid = false;
global.__checkoutVoided = false;
global.__checkoutOrg = "league-101";
global.__orderRows = {
  "ORD-T1": { customerName: "Aaron", contact: "a@example.com" },
  "TEST-1": { customerName: "Admin Test Transaction", contact: "" },
  "ORD-T2": { customerName: "Bea", contact: "614-555-0100" },
};
global.getOrderCheckoutState = async (db, orderId) => {
  const total = await global.getOrderTotal(db, orderId);
  const row = global.__orderRows[orderId] || { customerName: "", contact: "" };
  return total === null ? null : { total, paid: global.__checkoutPaid, orgId: global.__checkoutOrg,
    voided: global.__checkoutVoided, ...row };
};
const { orderTokenFor } = require("./testlib/order-token");
let checkoutSrc = fs.readFileSync(__dirname + "/functions/api/checkout.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function");
eval(libSrc + "\n" + rateLimitSrc + "\n" + httpSrc + "\n" + checkoutSrc);
const checkoutHandler = onRequestPost;

// stripe-webhook.js writes to D1 and queues the owner's notices. The db.js
// and email.js imports are stripped and mocked globally.
global.setOrderPaid = async () => {};
global.setOrderRefunded = async () => {};
global.setOrderDisputeStatus = async () => {};
global.addOrderPayment = async () => 1;
global.reduceShippingPaidForRefund = async () => false;
// Stripe event idempotency (stripe_events table) — in-memory stand-in.
global.__processedEvents = new Set();
global.hasProcessedStripeEvent = async (db, id) => global.__processedEvents.has(id);
global.recordStripeEvent = async (db, id) => { global.__processedEvents.add(id); };
// Webhook failures are recorded for the 6 AM roll-up; collected here so a test can check them.
global.__systemIssues = [];
global.recordSystemIssue = async (db, kind, sample) => { global.__systemIssues.push({ kind, sample }); };
global.sendStripePaymentNotification = async () => {};
global.sendRefundNotification = async () => {};
global.sendDisputeNotification = async () => {};
let webhookSrc = fs.readFileSync(__dirname + "/functions/api/stripe-webhook.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function");
eval(webhookSrc);
const webhookHandler = onRequestPost;

// ---- Stubs for a spreadsheet-script runtime. Nothing in this file reads them. ----
global.__cacheStore = {};
global.CacheService = { getScriptCache: () => ({ get:(k)=>global.__cacheStore[k]||null, put:(k,v)=>{global.__cacheStore[k]=v;} }) };
const sentEmails = [];
global.MailApp = { sendEmail: (opts) => { sentEmails.push(opts); } };
global.ContentService = { MimeType:{JSON:"json"}, createTextOutput:(t)=>({_text:t, setMimeType:function(){return this;}}) };

global.UrlFetchApp = {
  fetch: (url, opts) => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({status:"ok", url:"https://checkout.stripe.com/pay/cs_test_ADMINTEST"})
  })
};

// A sheet stub with one paid order (2 items) and one refund-target row.
const sheetCells = {};
const appendedRows = [];
const ordersSheetMock = {
  appendRow: (r) => { appendedRows.push(r); }, setFrozenRows:()=>{},
  getDataRange: () => ({
    getValues: () => [
      ["Timestamp","OrgId","OrderId","CustomerName","Contact","ItemName","ItemType","Size","Qty","UnitPrice","Personalized","PersName","LineTotal","OrderTotal","Paid","PaidAt","RefundedAt","DisputeStatus","PaymentMethod"],
      ["2026-07-14","league-101","ORD-TEST1","Aaron","a@x.com","Option C","shirt","L",1,27,"N","",27,43,"N","","","","Zelle"],
      ["2026-07-14","league-101","ORD-TEST1","Aaron","a@x.com","Option D","cap","OSFA",1,16,"N","",16,43,"N","","","","Zelle"],
      ["2026-07-14","league-101","ORD-R1","Bob","b@x.com","Option A","shirt","M",1,23,"N","",23,23,"Y","Stripe: $23.00 @ 2026-07-10T09:30:00.000Z","","","Card"],
      ["2026-07-14","league-101","ORD-NOEMAIL","Charlie","555-1234","Option A","shirt","M",1,23,"N","",23,23,"N","","","","Venmo"]
    ]
  }),
  getRange: (row, col) => ({ setValue: (v) => { sheetCells[row+","+col] = v; } })
};
const orgsSheetMock = {
  appendRow: () => {}, setFrozenRows: () => {},
  getDataRange: () => ({
    getValues: () => [
      ["OrgId","Subdomain","Name","Eyebrow","Accent","Desc","Ready","SpreadsheetId","DesignImageShirtURL","DesignImageCapURL","DesignImageDetailURL","CreatedAt","UpdatedAt"],
      ["league-101","league101","Example League 101","","","","Y","fake-id","","","","",""]
    ]
  }),
  getRange: () => ({ setValue: () => {} })
};
const productsSheetMock = {
  appendRow: () => {}, setFrozenRows: () => {},
  getDataRange: () => ({ getValues: () => [["ProductId","Type","Name","Sub","ImagesJSON","FeaturesJSON","PersonalizationPrice","PricingMode","FlatPrice","SizePricingJSON","Visible","SortOrder","CreatedAt","UpdatedAt"]] }),
  getRange: () => ({ setValue: () => {} })
};
global.SpreadsheetApp = {
  openById: () => ({
    getSheetByName: (name) => {
      if(name === "Orgs") return orgsSheetMock;
      if(name === "Products") return productsSheetMock;
      return ordersSheetMock;
    },
    insertSheet: (name) => {
      if(name === "Orgs") return orgsSheetMock;
      if(name === "Products") return productsSheetMock;
      return ordersSheetMock;
    }
  })
};


function makeStripeSignature(secret, rawBody){
  const ts = Math.floor(Date.now() / 1000);
  const signed = ts + "." + rawBody;
  const sig = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return { header: "t=" + ts + ",v1=" + sig };
}

// Stripe API mock — returns a session for checkout calls, ok for everything else
function makeStripeMock(){ return async (url, opts) => {
  if(url && url.includes("stripe.com")){
    // checkout.js calls stripe.com with form-encoded body — return session
    return { json: async () => ({id:"cs_test_123", url:"https://checkout.stripe.com/pay/cs_test_123"}) };
  }
  // Any other call — body is JSON
  return { json: async () => ({status:"ok"}) };
};}

// Recording mock — captures what action was sent
function makeGsMock(calls){ return async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push(body);
  return { json: async () => ({status:"ok"}) };
};}

(async () => {

  // ========================
  // CHECKOUT.JS
  // ========================
  console.log("=== checkout.js: looks up the real total from D1 (getOrderTotal) and charges exactly that ===");
  let capturedStripeReq = null;
  let getOrderTotalCalled = false;
  global.getOrderTotal = async (db, orderId) => { getOrderTotalCalled = true; return 45; };
  global.fetch = async (url, opts) => {
    if(url.includes("stripe.com")){
      capturedStripeReq = {url, opts};
      return { json: async () => ({id:"cs_test_123", url:"https://checkout.stripe.com/pay/cs_test_123"}) };
    }
    return { json: async () => ({status:"ok"}) };
  };
  const co1 = await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-T1"), orderId:"ORD-T1",orgId:"league-101",customerName:"Aaron",contact:"a@example.com"}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_test_fake" }
  });
  const d1 = JSON.parse(await co1.text());
  console.log("Returns ok:", d1.status === "ok");
  console.log("Returns checkout URL:", d1.url && d1.url.includes("checkout.stripe.com"));
  console.log("getOrderTotal was called from D1:", getOrderTotalCalled);
  console.log("Stripe called with correct auth:", capturedStripeReq.opts.headers["Authorization"] === "Bearer sk_test_fake");
  const params = new URLSearchParams(capturedStripeReq.opts.body);
  console.log("Amount is 4500 cents ($45.00, from the D1 lookup):", params.get("line_items[0][price_data][unit_amount]") === "4500");
  console.log("OrderId in metadata:", params.get("metadata[orderId]") === "ORD-T1");
  console.log("Success URL contains orderId:", params.get("success_url").includes("ORD-T1"));
  console.log("Cancel URL contains orgId:", params.get("cancel_url").includes("league-101"));
  console.log("customer_email included when contact is a valid email:", params.get("customer_email") === "a@example.com");
  global.getOrderTotal = async () => 45;

  console.log("\n=== checkout.js: blank or phone-only contact must NOT send an empty customer_email (Stripe rejects that outright) ===");
  let capturedBlankContactReq = null;
  global.fetch = async (url, opts) => {
    if(url.includes("stripe.com")){
      capturedBlankContactReq = {url, opts};
      return { json: async () => ({id:"cs_test_789", url:"https://checkout.stripe.com/pay/cs_test_789"}) };
    }
    return { json: async () => ({status:"ok"}) };
  };
  // Admin test transactions always have a blank contact, and an order can
  // carry a phone number instead of an email — either would make Stripe
  // reject the session with "Invalid email address" if it were passed on.
  await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "TEST-1"), orderId:"TEST-1",orgId:"league-101",customerName:"Admin Test Transaction",contact:""}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_test_fake" }
  });
  const paramsBlank = new URLSearchParams(capturedBlankContactReq.opts.body);
  console.log("customer_email key is omitted entirely for a blank contact, not sent as an empty string:", !paramsBlank.has("customer_email"));

  await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-T2"), orderId:"ORD-T2",orgId:"league-101",customerName:"Bea",contact:"614-555-0100"}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_test_fake" }
  });
  const paramsPhone = new URLSearchParams(capturedBlankContactReq.opts.body);
  console.log("customer_email key is also omitted for a phone-number-only contact:", !paramsPhone.has("customer_email"));
  console.log("The phone number still lands in metadata for the owner's records:", paramsPhone.get("metadata[contact]") === "614-555-0100");

  console.log("\n=== checkout.js: name/email come from the order row, voided orders are refused ===");
  global.getOrderTotal = async () => 45;
  global.fetch = async (url, opts) => { capturedStripeReq = { url, opts }; return { json: async () => ({ url: "https://checkout.stripe.com/x" }) }; };
  await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-T1"), orderId:"ORD-T1",orgId:"league-101",customerName:"Mallory",contact:"mallory@evil.example"}), url:"https://example.com/api/checkout" },
    env: { STRIPE_SECRET_KEY: "sk_test_fake", DB: {} }
  });
  const spoofed = new URLSearchParams(capturedStripeReq.opts.body);
  console.log("a spoofed body email is ignored — Stripe gets the order's own email:", spoofed.get("customer_email") === "a@example.com");
  console.log("a spoofed body name is ignored in metadata:", spoofed.get("metadata[customerName]") === "Aaron");
  global.__checkoutVoided = true;
  const vRes = await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-T1"), orderId:"ORD-T1",orgId:"league-101"}), url:"https://example.com/api/checkout" },
    env: { STRIPE_SECRET_KEY: "sk_test_fake", DB: {} }
  });
  console.log("a voided order is refused (409):", vRes.status === 409);
  global.__checkoutVoided = false;

  console.log("\n=== checkout.js: a tampered client-sent total is completely ignored — price-tampering fix ===");
  let capturedStripeReq2 = null;
  // getOrderTotal is globally mocked to return 45 regardless of client total
  global.fetch = async (url, opts) => {
    if(url.includes("stripe.com")){
      capturedStripeReq2 = {url, opts};
      return { json: async () => ({id:"cs_test_456", url:"https://checkout.stripe.com/pay/cs_test_456"}) };
    }
    return { json: async () => ({status:"ok"}) };
  };
  await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-T1"), orderId:"ORD-T1",orgId:"league-101",total:0.50,customerName:"Aaron",contact:"a@example.com"}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_test_fake" }
  });
  const paramsTampered = new URLSearchParams(capturedStripeReq2.opts.body);
  console.log("Charges the REAL $45.00, not the tampered $0.50 the request body claimed:", paramsTampered.get("line_items[0][price_data][unit_amount]") === "4500");

  console.log("\n=== checkout.js: missing secret key returns error ===");
  const co2 = await checkoutHandler({ request:{json:async()=>({}),url:"https://example.com/api/checkout"}, env:{} });
  console.log("Error returned:", JSON.parse(await co2.text()).status === "error");

  console.log("\n=== checkout.js: missing DB binding returns a clean error ===");
  const co2b = await checkoutHandler({ request:{json:async()=>({}),url:"https://example.com/api/checkout"}, env:{STRIPE_SECRET_KEY:"sk_test_fake"} });
  console.log("Error returned:", JSON.parse(await co2b.text()).status === "error");

  console.log("\n=== checkout.js: order not found in D1 -> refuses to create a session, never calls Stripe ===");
  let calledStripeForMissingOrder = false;
  global.getOrderTotal = async () => null; // simulate order not found
  global.fetch = async (url, opts) => {
    if(url.includes("stripe.com")){ calledStripeForMissingOrder = true; return { json: async () => ({}) }; }
    return { json: async () => ({status:"ok"}) };
  };
  const co2c = await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-NOPE"), orderId:"ORD-NOPE",orgId:"league-101",customerName:"Aaron",contact:"a@example.com"}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_test_fake" }
  });
  console.log("Refuses cleanly:", JSON.parse(await co2c.text()).status === "error");
  console.log("Never even calls Stripe:", !calledStripeForMissingOrder);
  global.getOrderTotal = async () => 45;

  console.log("\n=== checkout.js: Stripe API error (e.g. bad/expired key) surfaces Stripe's real message, not a generic one ===");
  global.fetch = async (url, opts) => {
    if(url.includes("stripe.com")){
      return { json: async () => ({error: {message: "Invalid API Key provided: sk_live_***", type: "invalid_request_error"}}) };
    }
    return { json: async () => ({status:"ok"}) };
  };
  const co2d = await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_live_bad"}, "ORD-T1"), orderId:"ORD-T1",orgId:"league-101",customerName:"Aaron",contact:"a@example.com"}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_live_bad" }
  });
  const errData = JSON.parse(await co2d.text());
  console.log("Returns an error:", errData.status === "error");
  console.log("Message includes Stripe's real error text, not just 'Could not create payment session':", errData.message.includes("Invalid API Key provided"));

  console.log("\n=== checkout.js: a malformed Stripe response with NO .error.message never echoes the raw session object to the client ===");
  global.fetch = async (url, opts) => {
    if(url.includes("stripe.com")){
      // No .url and no .error — a genuinely malformed/unexpected response shape.
      return { json: async () => ({id:"cs_weird", internal_debug_field:"some internal detail that shouldn't reach a browser"}) };
    }
    return { json: async () => ({status:"ok"}) };
  };
  const co2e = await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_live_bad"}, "ORD-T1"), orderId:"ORD-T1",orgId:"league-101",customerName:"Aaron",contact:"a@example.com"}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_live_bad" }
  });
  const errData2 = JSON.parse(await co2e.text());
  console.log("Returns an error:", errData2.status === "error");
  console.log("Does NOT leak the raw session object/internal field to the client:", !errData2.message.includes("internal_debug_field"));
  console.log("Uses a bounded, generic fallback message instead:", errData2.message.includes("Unknown Stripe error"));

  // ========================
  // WEBHOOK — PAYMENT
  // ========================
  console.log("\n=== stripe-webhook.js: rejects bad signature ===");
  const badBody = JSON.stringify({type:"checkout.session.completed", data:{object:{metadata:{orderId:"ORD-T1",orgId:"league-101"}}}});
  const wh1 = await webhookHandler({
    request: { text:async()=>badBody, headers:{get:(h)=>h==="stripe-signature"?"t=999,v1=badsig":null} },
    env: { STRIPE_WEBHOOK_SECRET:"whsec_test" }
  });
  console.log("Bad sig → 401:", wh1.status === 401);

  console.log("\n=== stripe-webhook.js: checkout.session.completed → payment recorded in the ledger (which marks it paid) ===");
  const paidBody = JSON.stringify({type:"checkout.session.completed", data:{object:{metadata:{orderId:"ORD-T1",orgId:"league-101"},amount_total:4500,payment_status:"paid",payment_intent:"pi_T1"}}});
  const {header:pHeader} = makeStripeSignature("whsec_test", paidBody);
  let payArgs = null;
  global.addOrderPayment = async (db, orderId, amount, note, ref) => { payArgs = {orderId, amount, note, ref}; return 1; };
  global.fetch = async () => ({ json: async () => ({status:"ok"}) }); // Stripe PI lookup fallback (unused here)
  const wh2 = await webhookHandler({
    request: { text:async()=>paidBody, headers:{get:(h)=>h==="stripe-signature"?pHeader:null} },
    env: { DB: {}, STRIPE_WEBHOOK_SECRET:"whsec_test" }
  });
  console.log("Valid sig → 200:", wh2.status === 200);
  console.log("Payment recorded on D1 for the right order:", !!payArgs && payArgs.orderId === "ORD-T1");
  console.log("...for the amount Stripe collected, keyed by the PaymentIntent:", !!payArgs && payArgs.amount === 45 && payArgs.ref === "pi_T1");
  global.addOrderPayment = async () => 1;

  // ========================
  // WEBHOOK — REFUND
  // ========================
  console.log("\n=== stripe-webhook.js: charge.refunded → setOrderRefunded ===");
  const refundBody = JSON.stringify({type:"charge.refunded", data:{object:{metadata:{orderId:"ORD-R1",orgId:"league-101"},amount_refunded:2300}}});
  const {header:rHeader} = makeStripeSignature("whsec_test", refundBody);
  let setOrderRefundedCalled = false;
  let setOrderRefundedId = null;
  global.setOrderRefunded = async (db, orderId) => { setOrderRefundedCalled = true; setOrderRefundedId = orderId; };
  // The webhook lists the charge's refunds to record each as a ledger row.
  global.fetch = async (url) => String(url).includes("/v1/refunds")
    ? { json: async () => ({ data: [{ id: "re_1", amount: 2300, status: "succeeded", created: 1790000000 }] }) }
    : { json: async () => ({status:"ok"}) };
  await webhookHandler({
    request:{text:async()=>refundBody, headers:{get:(h)=>h==="stripe-signature"?rHeader:null}},
    env:{DB:{}, STRIPE_WEBHOOK_SECRET:"whsec_test"}
  });
  console.log("setOrderRefunded called on D1:", setOrderRefundedCalled);
  console.log("setOrderRefunded called with correct orderId:", setOrderRefundedId === "ORD-R1");
  global.setOrderRefunded = async () => {};

  // ========================
  // CHECKOUT — PAYMENTINTENT METADATA (refund/dispute traceability)
  // ========================
  console.log("\n=== checkout.js: order identifiers also stamped onto the PaymentIntent (charge.refunded/dispute events carry Charge/PI metadata, NOT session metadata) ===");
  let capturedPiReq = null;
  global.fetch = async (url, opts) => {
    if(url.includes("stripe.com")){
      capturedPiReq = {url, opts};
      return { json: async () => ({id:"cs_test_pi", url:"https://checkout.stripe.com/pay/cs_test_pi"}) };
    }
    return { json: async () => ({status:"ok"}) };
  };
  await checkoutHandler({
    request: { json:async()=>({checkoutToken: await orderTokenFor({STRIPE_SECRET_KEY:"sk_test_fake"}, "ORD-PI1"), orderId:"ORD-PI1",orgId:"league-101",customerName:"Aaron",contact:"a@example.com"}), url:"https://example.com/api/checkout" },
    env: { DB: {}, STRIPE_SECRET_KEY:"sk_test_fake" }
  });
  const piParams = new URLSearchParams(capturedPiReq.opts.body);
  console.log("payment_intent_data[metadata][orderId] set:", piParams.get("payment_intent_data[metadata][orderId]") === "ORD-PI1");
  console.log("payment_intent_data[metadata][orgId] set:", piParams.get("payment_intent_data[metadata][orgId]") === "league-101");

  // ========================
  // WEBHOOK — RETRY ON DOWNSTREAM FAILURE
  // ========================
  console.log("\n=== stripe-webhook.js: D1 write failure → 500 so Stripe RETRIES (was: silent 200, paid status lost forever) ===");
  global.addOrderPayment = async () => { throw new Error("D1 write failed"); };
  global.fetch = async () => ({ json: async () => ({status:"ok"}) });
  const whFail = await webhookHandler({
    request:{text:async()=>paidBody, headers:{get:(h)=>h==="stripe-signature"?pHeader:null}},
    env:{DB:{}, STRIPE_WEBHOOK_SECRET:"whsec_test"}
  });
  console.log("D1 write failure → HTTP 500:", whFail.status === 500);
  console.log("…and it's recorded for the 6 AM roll-up (webhook_failed):", global.__systemIssues.some(x => x.kind === "webhook_failed"));

  // ========================
  // WEBHOOK — IDEMPOTENCY / PAYMENT STATUS / AMOUNT CHECK
  // ========================
  {
    global.setOrderPaid = async () => {};
    const payments = new Map(); // externalRef -> row (mirrors the UNIQUE index)
    global.addOrderPayment = async (db, orderId, amount, note, ref) => {
      if(ref && payments.has(ref)) return 0;
      payments.set(ref || ("manual" + payments.size), {orderId, amount, note});
      return payments.size;
    };
    let notifications = 0;
    global.sendStripePaymentNotification = async () => { notifications++; };
    let paidCalls = 0;
    global.setOrderPaid = async () => { paidCalls++; };
    global.getOrderTotal = async () => 45;
    const send = async (obj) => {
      const b = JSON.stringify(obj);
      const {header} = makeStripeSignature("whsec_test", b);
      return webhookHandler({ request:{text:async()=>b, headers:{get:(h)=>h==="stripe-signature"?header:null}}, env:{DB:{}, STRIPE_WEBHOOK_SECRET:"whsec_test"} });
    };
    const evt = {id:"evt_1", type:"checkout.session.completed", data:{object:{id:"cs_1", payment_intent:"pi_1", payment_status:"paid", amount_total:4500, metadata:{orderId:"ORD-I1", orgId:"league-101"}}}};

    console.log("\n=== stripe-webhook.js: same event delivered twice → one payment, one email ===");
    const a = await send(evt);
    const b = await send(evt);
    console.log("Both deliveries → 200:", a.status === 200 && b.status === 200);
    console.log("Exactly one payment row recorded:", payments.size === 1);
    console.log("Exactly one owner notification:", notifications === 1);

    console.log("\n=== stripe-webhook.js: a DIFFERENT event for the same PaymentIntent (e.g. replay after the event log was lost) → still one payment ===");
    global.__processedEvents.clear();
    await send(Object.assign({}, evt, {id:"evt_2"}));
    console.log("Still one payment row (externalRef is unique):", payments.size === 1);
    console.log("No second notification:", notifications === 1);

    console.log("\n=== stripe-webhook.js: completed but NOT paid (delayed payment method) → nothing recorded ===");
    payments.clear(); paidCalls = 0;
    await send({id:"evt_3", type:"checkout.session.completed", data:{object:{id:"cs_3", payment_intent:"pi_3", payment_status:"unpaid", amount_total:4500, metadata:{orderId:"ORD-I3", orgId:"league-101"}}}});
    console.log("No payment row:", payments.size === 0);
    console.log("Webhook never force-marks paid (the ledger decides):", paidCalls === 0);

    console.log("\n=== stripe-webhook.js: async_payment_succeeded → recorded like a completed payment ===");
    await send({id:"evt_4", type:"checkout.session.async_payment_succeeded", data:{object:{id:"cs_3", payment_intent:"pi_3", payment_status:"paid", amount_total:4500, metadata:{orderId:"ORD-I3", orgId:"league-101"}}}});
    console.log("Payment recorded:", payments.size === 1);
    console.log("...by recording the payment, not by forcing a paid flag:", paidCalls === 0);

    console.log("\n=== stripe-webhook.js: Stripe collected LESS than the order total → payment recorded, order NOT marked paid ===");
    payments.clear(); paidCalls = 0;
    global.getOrderTotal = async () => 100;
    await send({id:"evt_5", type:"checkout.session.completed", data:{object:{id:"cs_5", payment_intent:"pi_5", payment_status:"paid", amount_total:4500, metadata:{orderId:"ORD-I5", orgId:"league-101"}}}});
    const row = payments.get("pi_5");
    console.log("Payment row recorded with the real amount ($45):", !!row && row.amount === 45);
    console.log("Payment note flags the mismatch:", !!row && row.note.includes("MISMATCH"));
    console.log("Not force-marked paid — a short payment leaves the ledger short:", paidCalls === 0);

    global.getOrderTotal = async () => 45;
    global.setOrderPaid = async () => {};
    global.addOrderPayment = async () => 1;
    global.sendStripePaymentNotification = async () => {};
    global.__processedEvents.clear();
  }
  global.setOrderPaid = async () => {};

  // ========================
  // WEBHOOK — PAYMENTINTENT METADATA FALLBACK
  // ========================
  console.log("\n=== stripe-webhook.js: charge.refunded with EMPTY metadata recovers ids from the PaymentIntent ===");
  const bareRefundBody = JSON.stringify({type:"charge.refunded", data:{object:{id:"ch_bare", metadata:{}, payment_intent:"pi_123", amount_refunded:2300}}});
  const {header:brHeader} = makeStripeSignature("whsec_test", bareRefundBody);
  let piFetched = false;
  let brD1Written = false;
  let brD1OrderId = null;
  global.setOrderRefunded = async (db, orderId) => { brD1Written = true; brD1OrderId = orderId; };
  global.fetch = async (url, opts) => {
    if(url.includes("api.stripe.com/v1/payment_intents/pi_123")){
      piFetched = true;
      return { json: async () => ({id:"pi_123", metadata:{orderId:"ORD-R1", orgId:"league-101"}}) };
    }
    if(String(url).includes("/v1/refunds")) return { json: async () => ({ data: [] }) };
    return { json: async () => ({status:"ok"}) };
  };
  const whBare = await webhookHandler({
    request:{text:async()=>bareRefundBody, headers:{get:(h)=>h==="stripe-signature"?brHeader:null}},
    env:{DB:{}, STRIPE_WEBHOOK_SECRET:"whsec_test", STRIPE_SECRET_KEY:"sk_test_fake"}
  });
  console.log("PaymentIntent fetched to resolve metadata:", piFetched);
  console.log("setOrderRefunded called on D1 with recovered orderId:", brD1Written && brD1OrderId === "ORD-R1");
  console.log("Returns 200 on success:", whBare.status === 200);
  global.setOrderRefunded = async () => {};

  console.log("\n=== stripe-webhook.js: permanently unmatchable event (no metadata, no payment_intent) → 200, no 3-day retry loop ===");
  const orphanBody = JSON.stringify({type:"charge.refunded", data:{object:{id:"ch_orphan", metadata:{}, amount_refunded:100}}});
  const {header:orHeader} = makeStripeSignature("whsec_test", orphanBody);
  let orphanD1Written = false;
  global.setOrderRefunded = async () => { orphanD1Written = true; };
  global.fetch = async () => ({ json: async () => ({status:"ok"}) });
  const whOrphan = await webhookHandler({
    request:{text:async()=>orphanBody, headers:{get:(h)=>h==="stripe-signature"?orHeader:null}},
    env:{DB:{}, STRIPE_WEBHOOK_SECRET:"whsec_test", STRIPE_SECRET_KEY:"sk_test_fake"}
  });
  console.log("Still 200 (retrying can't fix it):", whOrphan.status === 200);
  console.log("setOrderRefunded never called (no orderId to write):", !orphanD1Written);
  global.setOrderRefunded = async () => {};

  // ========================
  // WEBHOOK — DISPUTE CREATED
  // ========================
  console.log("\n=== stripe-webhook.js: charge.dispute.created → setOrderDisputeStatus ===");
  const dispBody = JSON.stringify({type:"charge.dispute.created", data:{object:{metadata:{orderId:"ORD-R1",orgId:"league-101"},reason:"fraudulent",amount:2300}}});
  const {header:dHeader} = makeStripeSignature("whsec_test", dispBody);
  let disputeStatus = null;
  global.setOrderDisputeStatus = async (db, orderId, status) => { disputeStatus = status; };
  global.fetch = async () => ({ json: async () => ({status:"ok"}) });
  await webhookHandler({
    request:{text:async()=>dispBody, headers:{get:(h)=>h==="stripe-signature"?dHeader:null}},
    env:{DB:{}, STRIPE_WEBHOOK_SECRET:"whsec_test"}
  });
  console.log("setOrderDisputeStatus called:", disputeStatus !== null);
  console.log("Status is warning_needs_response:", disputeStatus === "warning_needs_response");
  global.setOrderDisputeStatus = async () => {};

  // ========================
  // WEBHOOK — DISPUTE CLOSED
  // ========================
  console.log("\n=== stripe-webhook.js: charge.dispute.closed → setOrderDisputeStatus with final status ===");
  const dispClosedBody = JSON.stringify({type:"charge.dispute.closed", data:{object:{metadata:{orderId:"ORD-R1",orgId:"league-101"},status:"won",reason:"fraudulent",amount:2300}}});
  const {header:dcHeader} = makeStripeSignature("whsec_test", dispClosedBody);
  let closedStatus = null;
  global.setOrderDisputeStatus = async (db, orderId, status) => { closedStatus = status; };
  global.fetch = async () => ({ json: async () => ({status:"ok"}) });
  await webhookHandler({
    request:{text:async()=>dispClosedBody, headers:{get:(h)=>h==="stripe-signature"?dcHeader:null}},
    env:{DB:{}, STRIPE_WEBHOOK_SECRET:"whsec_test"}
  });
  console.log("setOrderDisputeStatus called for closed event:", closedStatus !== null);
  console.log("Status is won:", closedStatus === "won");
  global.setOrderDisputeStatus = async () => {};

  // ========================
  // WEBHOOK — A DISPUTE AS STRIPE SENDS IT (no order metadata of its own)
  // ========================
  console.log("\n=== stripe-webhook.js: a dispute is matched to its order through the PaymentIntent, and a failed lookup is retried ===");
  const sendDispute = async (eventId) => {
    const b = JSON.stringify({ id: eventId, type: "charge.dispute.created", data: { object: { id: "dp_1", object: "dispute", metadata: {}, payment_intent: "pi_D1", reason: "product_not_received", status: "needs_response", amount: 2300 } } });
    const { header } = makeStripeSignature("whsec_test", b);
    return webhookHandler({ request: { text: async () => b, headers: { get: (h) => h === "stripe-signature" ? header : null } },
      env: { DB: {}, STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_SECRET_KEY: "sk_test_x" } });
  };
  let flagged = null;
  global.setOrderDisputeStatus = async (db, orderId, status) => { flagged = orderId + ":" + status; };
  global.fetch = async (url) => ({ ok: true, json: async () => String(url).includes("/payment_intents/pi_D1") ? { id: "pi_D1", metadata: { orderId: "ORD-R1", orgId: "league-101" } } : {} });
  let dr = await sendDispute("evt_dp_ok");
  console.log("found through the PaymentIntent's metadata and flagged on the order:", dr.status === 200 && flagged === "ORD-R1:warning_needs_response");
  flagged = null;
  global.fetch = async (url) => { if (String(url).includes("api.stripe.com")) throw new Error("timeout"); return { json: async () => ({}) }; };
  dr = await sendDispute("evt_dp_down");
  console.log("Stripe unreachable for the lookup → 500, so Stripe sends the event again (not 200 and lost):", dr.status === 500 && flagged === null);
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { type: "rate_limit_error" } }) });
  dr = await sendDispute("evt_dp_429");
  console.log("…the same when Stripe answers the lookup with an error:", dr.status === 500 && flagged === null);
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { code: "resource_missing" } }) });
  dr = await sendDispute("evt_dp_gone");
  console.log("a payment Stripe doesn't have is an answer, not a failure → 200, nothing flagged:", dr.status === 200 && flagged === null);
  global.setOrderDisputeStatus = async () => {};

})();
