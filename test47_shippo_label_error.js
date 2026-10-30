const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// shippo-label.js + the ship-from address (Global Settings, admin-editable —
// NOT a Cloudflare secret; see getShipFromAddress/setShipFromAddress in
// db.js). Real SQL (sql.js) + the real db.js + the real orders.js and
// shippo-label.js — no database mocks.
//
// Why it's a setting: USPS rejects label purchases with no sender email
// ("address_from.email must not be empty") or phone, so the admin has to
// be able to fix the address without a dashboard trip or a code deploy,
// the same way the sales tax rate and payment methods work.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\n?/gm, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { getShipFromAddress, setShipFromAddress };")();

async function migratedDb(){
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  // The real migrations too (shipping_labels, accounts… came with them) — the label purchase records into them.
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}

(async () => {
  console.log("=== db.js: getShipFromAddress / setShipFromAddress ===");
  let d1 = await migratedDb();
  const defaults = await lib.getShipFromAddress(d1);
  console.log("before anything is saved everything is blank (the label's sender name then comes from the Business profile):",
    defaults.name === "" && defaults.email === "" &&
    defaults.street1 === "" && defaults.city === "" && defaults.state === "" && defaults.zip === "" && defaults.phone === "");
  const saved = await lib.setShipFromAddress(d1, { name: "  ESC  ", street1: "12 Elm St", city: "Columbus", state: "oh", zip: "43215", phone: "614-555-0100", email: "ship@example.com" });
  console.log("save trims and uppercases state:", saved.name === "ESC" && saved.state === "OH" && saved.zip === "43215");
  const reread = await lib.getShipFromAddress(d1);
  console.log("round-trips through D1:", JSON.stringify(reread) === JSON.stringify(saved));
  const blank = await lib.setShipFromAddress(d1, { name: "", email: "" });
  console.log("a blank name/email is saved blank — nothing is made up:",
    blank.name === "" && blank.email === "" && blank.street1 === "");

  console.log("\n=== Admin API: getShipFromAddress / updateShipFromAddress (real orders.js) ===");
  d1 = await migratedDb();
  const ordersSrc = strip(read("functions/api/orders.js"));
  const audits = [];
  const api = new Function(
    strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false,\n" +
    "  sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + ordersSrc + "\nreturn onRequestPost;")();
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let r = await call({ action: "getShipFromAddress" });
  console.log("reads the defaults through the real API:", r.status === 200 && r.body.shipFrom.name === "");
  r = await call({ action: "updateShipFromAddress", shipFrom: { zip: "not-a-zip" } });
  console.log("bad ZIP rejected:", r.status === 400 && /ZIP/.test(r.body.message));
  r = await call({ action: "updateShipFromAddress", shipFrom: { state: "Ohio" } });
  console.log("bad state (not a 2-letter code) rejected:", r.status === 400 && /2-letter/.test(r.body.message));
  r = await call({ action: "updateShipFromAddress", shipFrom: { email: "not-an-email" } });
  console.log("bad email rejected:", r.status === 400 && /email/.test(r.body.message));
  r = await call({ action: "updateShipFromAddress", shipFrom: {
    name: "Example Stitch Co", street1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215", phone: "6145550100", email: "ship@example.com" } });
  console.log("valid address saved:", r.status === 200 && r.body.shipFrom.street1 === "12 Elm St" && r.body.shipFrom.phone === "6145550100");
  console.log("audited with before/after values:", (d1.q("SELECT detail FROM audit_log WHERE action='settings.ship_from_set'"))
    .some(row => JSON.parse(row.detail).to.street1 === "12 Elm St"));
  r = await call({ action: "getShipFromAddress" });
  console.log("read-back shows the saved address:", r.body.shipFrom.city === "Columbus");

  console.log("\n=== admin.js: Global Settings screen has a ship-from address form ===");
  const adminJs = read("public/admin.js");
  // (Global settings sends the address with the Shipping switch, in updateFeatures — saved together or not at all.)
  console.log("form fields present and wired to updateFeatures' shipFrom:",
    /id="gShipName"/.test(adminJs) && /id="gShipStreet1"/.test(adminJs) && /id="gShipCity"/.test(adminJs) &&
    /id="gShipState"/.test(adminJs) && /id="gShipZip"/.test(adminJs) && /id="gShipPhone"/.test(adminJs) && /id="gShipEmail"/.test(adminJs) &&
    /action: "updateFeatures", key: adminKey, features: want, \.\.\.\(shipFrom \? \{ shipFrom \} : \{\}\)/.test(adminJs) && /action:\s*"getShipFromAddress"/.test(adminJs));
  console.log("the old SHIP_FROM_* env vars are referenced ONLY by the temporary bridge in db.js (nowhere in the client or the API handlers):",
    !/SHIP_FROM_(NAME|STREET1|CITY|STATE|ZIP|PHONE|EMAIL)/.test(adminJs) &&
    !/SHIP_FROM_(NAME|STREET1|CITY|STATE|ZIP|PHONE|EMAIL)/.test(read("functions/api/shippo-label.js")) &&
    !/SHIP_FROM_(NAME|STREET1|CITY|STATE|ZIP|PHONE|EMAIL)/.test(read("functions/api/shipping.js")) &&
    !/SHIP_FROM_(NAME|STREET1|CITY|STATE|ZIP|PHONE|EMAIL)/.test(read("functions/api/orders.js")));

  console.log("\n=== Temporary migration bridge: values still in the old Cloudflare env vars keep working ===");
  // An install may have the address as SHIP_FROM_* env vars and nothing saved in D1. Without the fallback every
  // storefront shipping quote would fail ("Shipping not configured") until someone filled in the form.
  d1 = await migratedDb();
  const legacyEnv = { SHIP_FROM_NAME: "ESC Legacy", SHIP_FROM_STREET1: "9 Old Rd", SHIP_FROM_CITY: "Springfield", SHIP_FROM_STATE: "OH", SHIP_FROM_ZIP: "45503" };
  let eff = await lib.getShipFromAddress(d1, legacyEnv);
  console.log("nothing saved in D1 yet: the legacy env vars fill in (so quotes keep working through the deploy):",
    eff.street1 === "9 Old Rd" && eff.city === "Springfield" && eff.zip === "45503" && eff.name === "ESC Legacy");
  console.log("...and fields with neither (phone) stay blank, and so does email:", eff.phone === "" && eff.email === "");
  eff = await lib.getShipFromAddress(d1);
  console.log("callers that pass no env (the setter/tests) see D1 + defaults only:", eff.street1 === "" && eff.zip === "");
  await lib.setShipFromAddress(d1, { name: "ESC", street1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215", phone: "6145550100", email: "" });
  eff = await lib.getShipFromAddress(d1, legacyEnv);
  console.log("once saved in D1, D1 wins over the legacy env vars:", eff.street1 === "12 Elm St" && eff.city === "Columbus" && eff.zip === "43215" && eff.name === "ESC");
  d1 = await migratedDb();
  await lib.setShipFromAddress(d1, { street1: "", city: "Columbus" });
  eff = await lib.getShipFromAddress(d1, legacyEnv);
  console.log("a field left blank in D1 still falls back to the legacy env var (per field, not all-or-nothing):", eff.city === "Columbus" && eff.street1 === "9 Old Rd");

  // The admin form pre-fills from the effective values, so the admin just confirms + adds the phone.
  d1 = await migratedDb();
  const apiLegacy = async (body) => {
    const res = await api({ env: { DB: d1, ...legacyEnv }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let rl = await apiLegacy({ action: "getShipFromAddress" });
  console.log("Global Settings form is pre-filled with the values still in the old env vars:",
    rl.status === 200 && rl.body.shipFrom.street1 === "9 Old Rd" && rl.body.shipFrom.zip === "45503");
  rl = await apiLegacy({ action: "updateShipFromAddress", shipFrom: { ...rl.body.shipFrom, phone: "6145550100" } });
  const stored = JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='shipFrom'")[0].value);
  console.log("saving the pre-filled form (just adding the phone) persists everything to D1:",
    rl.status === 200 && stored.street1 === "9 Old Rd" && stored.zip === "45503" && stored.phone === "6145550100");

  // The customer-facing outage that fallback prevents: the REAL /api/shipping, on a database with
  // nothing saved yet, and only the env vars set. It must keep returning quotes, not "Shipping not configured".
  console.log("\n=== Customer-facing /api/shipping keeps quoting through the deploy (real shipping.js, real D1) ===");
  d1 = await migratedDb();
  let quoteFromZip = null;
  const shippingSrc = strip(read("functions/api/shipping.js"));
  const shipping = new Function(
    "fetch", "console",
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const getCatalogData = async () => ({ subdomainMap: {} }); const signQuote = async () => 'tok'; const canonicalItems = () => '';\n" +
    strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/hostConfig.js")) + "\n" + dbSrc + "\n" +
    // boxSize.js and shipping.js each declare their own module-level DEFAULT_ITEM_WEIGHT_OZ (fine as separate
    // ES modules) — wrap boxSize in its own scope here so concatenating them into one Function body doesn't collide.
    "const selectBox = (function(){\n" + strip(read("functions/_lib/boxSize.js")) + "\nreturn selectBox; })();\n" + shippingSrc + "\nreturn onRequestPost;"
  )(
    async (url, opts) => { quoteFromZip = JSON.parse(opts.body).address_from.zip;
      return { json: async () => ({ rates: [{ amount: "9.00", provider: "USPS", servicelevel: { name: "Ground" } }] }) }; },
    { error: () => {} },
  );
  const quote = (envExtra) => shipping({ env: { SHIPPO_API_KEY: "k", DB: d1, ...envExtra },
    request: { url: "https://prime.example.com/api/shipping", json: async () => ({ zip: "15213", items: [{ productId: "x", qty: 1, type: "shirt" }] }) } });
  let qRes, qBody;
  qRes = await quote({ SHIP_FROM_ZIP: "45503" });
  qBody = await qRes.json();
  console.log("only the old env var set, nothing in D1: quotes still work, from the env ZIP (no outage at deploy):",
    qRes.status === 200 && Array.isArray(qBody.rates) && qBody.rates.length === 1 && quoteFromZip === "45503");
  qRes = await quote({});
  qBody = await qRes.json();
  console.log("no ZIP anywhere (neither D1 nor env): refuses cleanly instead of quoting from a blank origin:",
    qRes.status === 500 && /not configured/i.test(qBody.message));
  await lib.setShipFromAddress(d1, { zip: "43215" });
  qRes = await quote({ SHIP_FROM_ZIP: "45503" });
  qBody = await qRes.json();
  console.log("once a ZIP is saved in D1 it wins over the old env var:", qRes.status === 200 && quoteFromZip === "43215");

  // ===================================================================
  // shippo-label.js — real db.js, real D1, an order with a real address
  // ===================================================================
  console.log("\n=== shippo-label.js: uses the D1-stored ship-from address ===");
  d1 = await migratedDb();
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotalCents, totalCents, placedAt, shippingAddress, totalWeightOz)
      VALUES ('PRIME-1','prime','Cust','c@x.com','Venmo',0,2000,2000,'2026-09-24T00:00:00Z','{"name":"Cust","line1":"1 Main St","city":"Columbus","state":"OH","zip":"43215"}',8);
  `);

  let fetchCalls = [];
  const errors = [];
  const fetchImpl = { f: async (url, opts) => {
    fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes("/transactions/")) return { json: async () => global.__shippoTxn };
    return { json: async () => ({ rates: [] }) };
  } };
  const shippoSrc = strip(read("functions/api/shippo-label.js"));
  const boxSizeSrc = strip(read("functions/_lib/boxSize.js"));
  const httpSrc = strip(read("functions/_lib/http.js"));
  const label = new Function(
    "fetch", "console",
    "const classifyHost = () => ({ kind: 'admin', orgId: null }); const getCatalogData = async () => ({ subdomainMap: {} }); const requireAdmin = async () => null;\n" +
    httpSrc + "\n" + dbSrc + "\n" + boxSizeSrc + "\n" + shippoSrc + "\nreturn onRequestPost;"
  )(
    (url, opts) => fetchImpl.f(url, opts),
    { error: (...a) => errors.push(a) },
  );
  const purchaseCall = (extra) => label({ env: { SHIPPO_API_KEY: "k", DB: d1 },
    request: { url: "https://admin.example.com/api/shippo-label", json: async () => Object.assign({ action: "purchase", org: "prime", orderId: "PRIME-1", carrierId: "cccccccccccccccccccccccccccc0001", serviceToken: "usps_ground_advantage", key: "x" }, extra) } });
  const ratesCall = () => label({ env: { SHIPPO_API_KEY: "k", DB: d1 },
    request: { url: "https://admin.example.com/api/shippo-label", json: async () => ({ action: "rates", org: "prime", orderId: "PRIME-1", key: "x" }) } });

  let res = await ratesCall();
  let body = await res.json();
  console.log("rate quotes work even before any ship-from address is set (defaults fill in):", res.status === 200);

  res = await purchaseCall({});
  body = await res.json();
  console.log("purchase before any address is configured lists every missing required field:",
    res.status === 500 && /street1, city, state, zip, phone/.test(body.message));

  await lib.setShipFromAddress(d1, { name: "Example Stitch Co", street1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215", phone: "6145550100", email: "ship@example.com" });
  fetchCalls.length = 0;
  // Shippo's REAL transaction shape: the outcome is in `status`
  // (there is no `object_status`), and `rate` comes back as the full embedded rate object.
  global.__shippoTxn = { object_state: "VALID", status: "SUCCESS", object_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001", tracking_number: "9400100000000000000001",
    label_url: "https://shippo-delivery.s3.amazonaws.com/label.pdf", test: true,
    rate: { object_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbb0001", amount: "6.25", currency: "USD", provider: "USPS", servicelevel_name: "Ground Advantage", servicelevel_token: "usps_ground_advantage" } };
  res = await purchaseCall({});
  body = await res.json();
  const sentFrom = fetchCalls.find(c => String(c.url).includes("/transactions/")).body.shipment.address_from;
  console.log("once configured, the real D1 address (incl. email + phone) is sent to Shippo, and the purchase succeeds:",
    res.status === 200 && sentFrom.street1 === "12 Elm St" && sentFrom.phone === "6145550100" && sentFrom.email === "ship@example.com");
  console.log("(regression) a transaction with status SUCCESS is a success — it was reported as a failure while the label was bought and charged:",
    res.status === 200 && body.status === "ok" && body.trackingNumber === "9400100000000000000001" && !body.warning);
  console.log("postage is recorded at the real $6.25 with carrier/service — the embedded rate object is not looked up as '/rates/[object Object]' and booked at $0:",
    body.labelCost === 6.25 && body.carrier === "USPS" && body.service === "Ground Advantage" &&
    !fetchCalls.some(c => String(c.url).includes("/rates/")));
  const lbl = d1.q("SELECT orderId, amountCents, carrier, service, trackingNumber, accountId FROM shipping_labels WHERE shippoTransactionId='aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001'")[0];
  console.log("(regression) the label lands in shipping_labels (the books) with tracking and the postage account:",
    !!lbl && lbl.orderId === "PRIME-1" && lbl.amountCents === 625 && lbl.carrier === "USPS" && lbl.service === "Ground Advantage" &&
    lbl.trackingNumber === "9400100000000000000001" && lbl.accountId === 2);
  res = await purchaseCall({});
  console.log("buying the same transaction again doesn't double-book it (unique per Shippo transaction):",
    d1.q("SELECT count(*) n FROM shipping_labels")[0].n === 1);

  // Older API versions return `rate` as an id string — look it up for the price.
  fetchCalls.length = 0;
  global.__shippoTxn = { status: "SUCCESS", object_id: "idrate1", tracking_number: "9400111", label_url: "https://x/l2.pdf", rate: "rateid123" };
  const fetchWas = fetchImpl.f; fetchImpl.f = async (url, opts) => { fetchCalls.push({ url }); if (String(url).includes("/rates/rateid123")) return { json: async () => ({ amount: "7.10", provider: "UPS", servicelevel: { name: "Ground Saver" } }) }; return fetchWas(url, opts); };
  res = await purchaseCall({});
  body = await res.json();
  console.log("rate given as an id string is still looked up for its price and service:",
    body.labelCost === 7.1 && body.carrier === "UPS" && body.service === "Ground Saver" && fetchCalls.some(c => String(c.url).includes("/rates/rateid123")));
  fetchImpl.f = fetchWas;

  // Older API field name still accepted.
  global.__shippoTxn = { object_status: "SUCCESS", object_id: "legacy1", tracking_number: "94001", label_url: "https://x/l3.pdf" };
  res = await purchaseCall({});
  console.log("the older object_status field is still accepted as a fallback:", res.status === 200);

  // ---- Reprint: get the PDF link of a label that's already bought (no purchase) ----
  console.log("\n=== Reprint a label already bought (never buys anything) ===");
  const reprint = () => label({ env: { SHIPPO_API_KEY: "k", DB: d1 },
    request: { url: "https://admin.example.com/api/shippo-label", json: async () => ({ action: "reprint", org: "prime", orderId: "PRIME-1", key: "x" }) } });
  d1._raw.exec("DELETE FROM shipping_labels");
  res = await reprint();
  console.log("no label on record -> 404, nothing fetched:", res.status === 404);
  // A label recorded by hand with NO link stored.
  d1._raw.exec("INSERT INTO shipping_labels (orderId, shippoTransactionId, carrier, service, amountCents, trackingNumber, labelUrl, purchasedAt, accountId) " +
    "VALUES ('PRIME-1','aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001','USPS','Ground Advantage',625,'9400100000000000000001','','2026-09-24T12:00:00.000Z',2)");
  fetchCalls.length = 0;
  const fetchWas2 = fetchImpl.f;
  fetchImpl.f = async (url, opts) => { fetchCalls.push({ url, method: opts && opts.method || "GET" });
    if (String(url).endsWith("/transactions/aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001")) return { json: async () => ({ status: "SUCCESS", label_url: "https://shippo-delivery.s3.amazonaws.com/label1.pdf" }) };
    return { json: async () => ({}) }; };
  res = await reprint();
  body = await res.json();
  console.log("no link stored: asks Shippo for THIS transaction (a GET — nothing bought) and returns the PDF link + tracking:",
    res.status === 200 && body.labelUrl === "https://shippo-delivery.s3.amazonaws.com/label1.pdf" && body.trackingNumber === "9400100000000000000001" &&
    fetchCalls.length === 1 && fetchCalls[0].method === "GET" && !fetchCalls.some(c => String(c.url).includes("/transactions/") && c.method === "POST"));
  console.log("the link is saved on the label record:", d1.q("SELECT labelUrl FROM shipping_labels")[0].labelUrl === "https://shippo-delivery.s3.amazonaws.com/label1.pdf");
  fetchCalls.length = 0;
  res = await reprint();
  body = await res.json();
  console.log("second time it uses the saved link — no call to Shippo at all:", res.status === 200 && body.labelUrl.endsWith("label1.pdf") && fetchCalls.length === 0);
  d1._raw.exec("UPDATE shipping_labels SET labelUrl=''");
  fetchImpl.f = async () => ({ json: async () => ({ status: "SUCCESS", label_url: "javascript:alert(1)" }) });
  res = await reprint();
  console.log("a link that isn't https is refused and not saved:", res.status === 502 && d1.q("SELECT labelUrl FROM shipping_labels")[0].labelUrl === "");
  fetchImpl.f = async () => { throw new Error("network down"); };
  res = await reprint();
  console.log("Shippo unreachable -> a clear 502, nothing changed:", res.status === 502 && d1.q("SELECT labelUrl FROM shipping_labels")[0].labelUrl === "");
  d1._raw.exec("UPDATE shipping_labels SET voidedAt='2026-09-26T00:00:00Z'");
  res = await reprint();
  console.log("a voided label isn't offered:", res.status === 404);
  fetchImpl.f = fetchWas2;

  // The orders screen: tracking + a Label button from the label record, and never a second "Ship".
  const trackingCell = new Function("escapeHtml", adminJs.slice(adminJs.indexOf("function trackingCell(org, o){"), adminJs.indexOf("// Re-opens the PDF of a label that's already bought")) + "\nreturn trackingCell;")(
    (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"));
  const orgO = { orgId: "prime" };
  const base = { orderId: "PRIME-1", paid: true, items: [{}], shippingAddress: { line1: "1 Main" }, shippingMethod: "USPS Ground Advantage" };
  const withLabel = trackingCell(orgO, { ...base, trackingNumber: "", labels: [{ trackingNumber: "9400100000000000000001", voidedAt: "" }] });
  console.log("order whose tracking was never copied over: shows the label's tracking as a link + a Label button, and NO Ship button (can't double-buy):",
    /9400100000000000000001/.test(withLabel) && /reprintLabel/.test(withLabel) && !/shipOrder/.test(withLabel));
  console.log("no label yet: still offers Ship:", /shipOrder/.test(trackingCell(orgO, { ...base, trackingNumber: "", labels: [] })));
  console.log("a voided label doesn't hide Ship:", /shipOrder/.test(trackingCell(orgO, { ...base, trackingNumber: "", labels: [{ trackingNumber: "x", voidedAt: "2026-09-26" }] })));
  console.log("tracking saved on the order + label: tracking link and Label button:",
    /TrackConfirmAction/.test(trackingCell(orgO, { ...base, trackingNumber: "9400", labels: [{ trackingNumber: "9400", voidedAt: "" }] })) &&
    /reprintLabel/.test(trackingCell(orgO, { ...base, trackingNumber: "9400", labels: [{ trackingNumber: "9400", voidedAt: "" }] })));
  console.log("reprintLabel calls the reprint action (not purchase):", /action: "reprint"/.test(adminJs));

  // If the label is bought but can't be recorded, say so — never silently.
  d1._raw.exec("ALTER TABLE shipping_labels RENAME TO shipping_labels_gone");
  global.__shippoTxn = { status: "SUCCESS", object_id: "norec1", tracking_number: "94002", label_url: "https://x/l4.pdf",
    rate: { amount: "6.25", provider: "USPS", servicelevel_name: "Ground Advantage" } };
  errors.length = 0;
  res = await purchaseCall({});
  body = await res.json();
  console.log("label bought but recording fails: still a success for the label, with a loud warning naming the cost and tracking:",
    res.status === 200 && body.status === "ok" && /couldn't be recorded/.test(body.warning) && /6\.25/.test(body.warning) && /94002/.test(body.warning) &&
    errors.some(a => String(a[0]).includes("Could not record shipping label")));
  d1._raw.exec("ALTER TABLE shipping_labels_gone RENAME TO shipping_labels");
  console.log("the admin screen shows that warning:", /if\(purchaseData\.warning\) showToast\(purchaseData\.warning, true\)/.test(adminJs));

  // Reproduce USPS's real error messages verbatim, against the real flow.
  global.__shippoTxn = { status: "ERROR", object_id: "z1", messages: [{ code: "user_input_problem", source: "USPS", text: 'Attribute "address_from.email" must not be empty.' }] };
  res = await purchaseCall({});
  body = await res.json();
  console.log("(regression) the address_from.email USPS error, reproduced then fixed by setting the address above:", res.status === 502 && /address_from\.email/.test(body.message));
  // ^ this call still errors because __shippoTxn is force-mocked to ERROR here — it demonstrates the
  // error-surfacing path (multi-message join, no log truncation) still works with a real, filled address.

  global.__shippoTxn = { status: "ERROR", object_id: "z2",
    messages: [
      { source: "Shippo", code: "address_error", text: "Address to street1 is required." },
      { source: "USPS", code: "rate_error", text: "This service is not available for the destination ZIP." },
    ] };
  errors.length = 0;
  res = await purchaseCall({});
  body = await res.json();
  console.log("several Shippo messages are joined, not just the first, and logged in full:",
    res.status === 502 && body.message === "Address to street1 is required. · This service is not available for the destination ZIP." &&
    errors.some(a => a.includes("Shippo transaction failed:") && a.includes(body.message)));

  global.__shippoTxn = { status: "ERROR", object_id: "z3", filler: "x".repeat(600), messages: [{ text: "Buried reason." }] };
  errors.length = 0;
  await purchaseCall({});
  console.log("a long transaction object doesn't truncate the reason out of the log:",
    errors.some(a => a.some(x => typeof x === "string" && x.includes("Buried reason."))));

  // Only phone missing.
  await lib.setShipFromAddress(d1, { name: "Example Stitch Co", street1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215", phone: "", email: "ship@example.com" });
  fetchCalls.length = 0;
  res = await purchaseCall({});
  body = await res.json();
  console.log("only phone missing -> fails clearly on just phone, no Shippo call made:",
    res.status === 500 && /phone/.test(body.message) && !/street1|city|state/.test(body.message) && fetchCalls.length === 0);
  res = await ratesCall();
  console.log("rate quotes still work with phone missing (only purchase needs it):", res.status === 200);
})().catch(e => { console.log("test47 crashed:", false); console.error(e); process.exit(1); });
