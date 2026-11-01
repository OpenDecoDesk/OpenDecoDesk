const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Features (Global settings → Features): optional parts of the site, each behind a switch. This file
// covers the four that own admin pages and actions — production, bookkeeping, shipping,
// designVerification; the fifth, storefront (the public side), is in test107_storefront_switch.js. All ON unless saved off. Off: the pages
// leave the admin menu, their routes show a "turned off" page, and the SERVER refuses their actions
// (403) — while every table and row stays, so turning one back on restores everything. Inventory
// (blank / transfer stock, cost of goods) is not a switch.
// Real SQL (sql.js), real db.js / orders.js / catalog.js and the standalone handlers, and the real
// admin and storefront pages in jsdom talking to that API.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), httpSrc = strip(read("functions/_lib/http.js")), hostSrc = strip(read("functions/_lib/hostConfig.js"));
const emailSrc = strip(read("functions/_lib/email.js")), ordersJs = read("functions/api/orders.js");
const lib = new Function(dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/deliveryCheck.js")) +
  "\nreturn { FEATURES, getFeatures, setFeatures, normalizeFeatures, getPublicCatalogData, createProduct, createBlank, setBlankLink, getOrderById, getOrgById, getCatalogIssues, " +
  "getAllBlanks, getClosedPeriods, checkShippedDeliveries, checkBlankShipments, getProductionQueue };")();
const SUBS = { acme: "acme" };
// The API reads the switches the way the deployed site does: from the catalog data (here always fresh).
const api = new Function("catalogData", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async (env, host, key) => key === 'x' ? null : jsonResponse({ status: 'error', message: 'Unauthorized' }, 401); const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => { global.__inval106 = (global.__inval106 || 0) + 1; }; const getCatalogData = (env) => catalogData(env);\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const checkShippedDeliveries = async () => { global.__checks106 = (global.__checks106 || 0) + 1; return { checked: 0, delivered: [], inTransit: [], pickedUp: [], awaitingPickup: [], errors: 0 }; }, checkBlankShipments = async () => ({ checked: 0, delivered: [], inTransit: [], errors: 0 });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(ordersJs) + "\nreturn { post: onRequestPost, signQuote, canonicalItems };");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(res => setTimeout(res, ms || 40));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Acme','t','t',1,1);`);
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, personalizationPrice: 2 });
  const blankId = (await lib.createBlank(d1, { name: "Blank tee", productType: "shirt" }, [{ size: "M", purchasePrice: 4, quantity: 10 }])).id;
  await lib.setBlankLink(d1, "acme", "tee", "M", blankId, "M");
  const env = { DB: d1, QUOTE_SIGNING_SECRET: "q".repeat(40), SIGNING_SECRET: "s".repeat(40), SHIPPO_API_KEY: "shippo_test_106", ...MAIL_ENV };
  const A = api(async () => ({ subdomainMap: SUBS, ...(await lib.getPublicCatalogData(d1)), subdomainMap2: null }));
  let emails = [], shippoCalls = 0;
  global.fetch = async (url, init) => {
    if (captureMail(url, init, emails)) return MAIL_OK;
    if (/goshippo/.test(String(url))) { shippoCalls++; return { ok: true, status: 200, json: async () => ({ tracking_status: { status: "TRANSIT", status_date: new Date().toISOString() }, tracking_history: [] }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const post = async (host, body) => {
    const res = await A.post({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `https://${host}.example.com/api/orders`, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => post("admin", Object.assign({ key: "x" }, body));
  const setF = async (features) => { const r = await admin({ action: "updateFeatures", features }); await tick(20); return r; };
  // Shipping on straight in the database, where a check is about what Shipping does rather than the
  // rule for switching it on (a Shippo key and a complete ship-from address — see "Shipping setup").
  const shipOn = async () => { await lib.setFeatures(d1, { shipping: true }); await tick(20); };
  const items = [{ productId: "tee", size: "M", qty: 2 }];
  const place = (id, extra) => post("acme", Object.assign({ orderId: id, orgId: "acme", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items }, extra));
  const stock = () => Number(d1.q("SELECT quantity FROM blank_sizes WHERE blankId = ? AND size = 'M'", blankId)[0].quantity);
  const stage = (orderId, s, extra) => admin(Object.assign({ action: "setFulfillmentStage", org: "acme", orderId, stage: s }, extra));
  const off403 = (r, label) => r.status === 403 && r.body.status === "error" && new RegExp("^" + label + " is turned off").test(r.body.message) && /Global settings → Features/.test(r.body.message);
  let r;

  console.log("=== The setting: everything on unless saved off ===");
  const KEYS = ["production", "bookkeeping", "shipping", "designVerification"];   // the four with admin pages / actions
  const ALL = ["storefront", ...KEYS];
  ok("five features, each with a name and a plain sentence", lib.FEATURES.map(f => f.key).join() === ALL.join() && lib.FEATURES.every(f => f.label && f.description.length > 40));
  ok("there is no inventory switch", !lib.FEATURES.some(f => /inventor|blank|stock/i.test(f.key)));
  ok("a new install has all five on", JSON.stringify(await lib.getFeatures(d1)) === JSON.stringify({ storefront: true, production: true, bookkeeping: true, shipping: true, designVerification: true }));
  ok("no database, or one without the settings table, is all on too", (await lib.getFeatures(null)).shipping === true && (await lib.getFeatures({ prepare(){ throw new Error("no such table: global_settings"); } })).production === true);
  ok("only an explicit false is off (junk and missing keys are on)", JSON.stringify(lib.normalizeFeatures({ production: 0, shipping: "no", bookkeeping: false, other: false })) === JSON.stringify({ storefront: true, production: true, bookkeeping: false, shipping: true, designVerification: true }));
  r = await admin({ action: "getFeatures" });
  ok("the admin gets the switches and the list to draw them from", r.status === 200 && r.body.features.production === true && r.body.list.length === 5 && r.body.list[0].label === "Storefront" && r.body.list[4].label === "Design approval");
  r = await admin({ action: "updateFeatures", features: { inventory: false } });
  ok("a feature that doesn't exist is refused (no inventory switch can be invented)", r.status === 400 && /isn't a feature/.test(r.body.message));
  r = await admin({ action: "updateFeatures", features: { shipping: "off" } });
  ok("a switch is true or false, nothing else", r.status === 400 && (await lib.getFeatures(d1)).shipping === true);
  r = await post("admin", { action: "updateFeatures", key: "wrong", features: { shipping: false } });
  ok("it takes an admin to change them", r.status === 401 && (await lib.getFeatures(d1)).shipping === true);
  const inval0 = global.__inval106 || 0, ver0 = d1.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0];
  r = await setF({ shipping: false });
  ok("one switch saves and leaves the others alone", r.status === 200 && r.body.features.shipping === false && r.body.features.production === true && (await lib.getFeatures(d1)).bookkeeping === true);
  let aud = d1.q("SELECT detail, actor FROM audit_log WHERE action='settings.features_set'");
  ok("the change is audited: what changed, from → to, by whom", aud.length === 1 && /"shipping":\{"from":true,"to":false\}/.test(aud[0].detail) && !/production/.test(aud[0].detail) && aud[0].actor === "test");
  ok("saving bumps the catalog version, so every cached reader sees it", (global.__inval106 || 0) > inval0 &&
    Number(d1.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0].value) > Number((ver0 || { value: 0 }).value));
  await setF({ shipping: false });
  ok("saving the same thing again writes no audit row", d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.features_set'")[0].n === 1);
  await shipOn();
  ok("nothing in the schema changed for this: it is one global_settings row", d1.q("SELECT count(*) n FROM global_settings WHERE key='features'")[0].n === 1);

  console.log("\n=== /api/catalog tells every page ===");
  const catalog = new Function(hostSrc + "\n" + httpSrc + "\nconst getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\nlet getCatalogData;\n" + strip(read("functions/api/catalog.js")) + "\nreturn { get: onRequestGet, set: (f) => { getCatalogData = f; } };")();
  catalog.set(async () => lib.getPublicCatalogData(d1));
  const cat = async (host) => { const res = await catalog.get({ request: { url: `https://${host}.example.com/api/catalog` }, env }); return JSON.parse(await res.text()); };
  await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "shipping" }, { type: "custom", label: "Hand delivery", fee: 5 }] });
  const handId = (await lib.getOrgById(d1, "acme")).deliveryOptions[2].id;
  let c = await cat("acme");
  ok("a shop's answer carries the switches", KEYS.every(k => c.features[k] === true));
  ok("…and so do the admin host's and an unknown host's", (await cat("admin")).features.production === true && (await cat("nobody")).features.shipping === true);
  catalog.set(async () => { const d = await lib.getPublicCatalogData(d1); delete d.features; return d; });
  c = await cat("acme");
  ok("a catalog cached before the setting existed changes nothing (everything on)", JSON.stringify(c.features) === "{}" && c.catalog.shippingEnabled === true && c.catalog.deliveryOptions.length === 3);
  catalog.set(async () => lib.getPublicCatalogData(d1));

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== Production ===");
  r = await admin({ action: "getCatalogIssues" });
  const issuesOn = r.body.issues || r.body;
  ok("on: a product with no design is flagged", JSON.stringify(issuesOn).includes("noDesign"));
  await place("P-ON");
  await admin({ action: "markPaidManual", org: "acme", orderId: "P-ON" });
  ok("on: an order whose product has no design needs digitizing before it can be made", (await lib.getOrderById(d1, "P-ON")).needsDigitizing === true);
  await stage("P-ON", "blankOrdered"); await stage("P-ON", "blankReceived");
  r = await stage("P-ON", "manufactured");
  ok("…so Mark manufactured waits for it", r.status === 409 && /digitizing/.test(r.body.message));
  r = await admin({ action: "saveHoop", hoop: { name: "Round 15cm", widthMm: 150, heightMm: 150 } });
  ok("on: a production action works (a hoop is saved)", r.status === 200 && (await admin({ action: "listHoops" })).body.hoops.length === 1);

  await setF({ production: false });
  const prodActions = ["listThreads", "listHoops", "listDesigns", "listMachines", "getProductionQueue", "listActiveRuns", "getRunReportByDesign", "listAbortReasons", "getNeedleSettings", "getMachineSettings", "startRun", "markManufacturedOnMachine", "saveDesignVersion", "setProductDesigns", "saveOrderItemDesign"];
  const refused = []; for (const a of prodActions) refused.push(off403(await admin({ action: a, org: "acme" }), "Production"));
  ok("off: threads, hoops, designs, machines, Run Order, runs, the run report, abort reasons and needle settings all answer 403 naming the feature", refused.every(Boolean));
  r = await post("admin", { action: "listThreads", key: "wrong" });
  ok("…but only to an admin: someone not signed in learns nothing about the switches", r.status === 401);
  r = await admin({ action: "saveHoop", hoop: { name: "Sneaky", widthMm: 1, heightMm: 1 } });
  ok("off: nothing is written (the hoop table is as it was)", off403(r, "Production") && d1.q("SELECT count(*) n FROM hoops")[0].n === 1);
  ok("off: unrelated admin work carries on (orders, blanks, shops, transfers, revenue)", (await admin({ action: "getOrders", org: "acme" })).status === 200 && (await admin({ action: "getBlanks" })).status === 200 &&
    (await admin({ action: "listOrgs" })).status === 200 && (await admin({ action: "listTransfers", org: "acme" })).status === 200 && (await admin({ action: "getBlanksToOrder" })).status === 200);
  r = await admin({ action: "getCatalogIssues" });
  const issuesOff = JSON.stringify(r.body);
  ok("off: the health check stops nagging about designs, hoops and stitch files", r.status === 200 && !/noDesign|noStitchFile|noHoops|pickUnmapped|persHoop|designIssue/.test(issuesOff));
  r = await admin({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, personalizationPrice: 2 });
  ok("off: a product can still be edited", r.status === 200);

  console.log("--- the order workflow, start to finish, with Production off ---");
  const before = stock();
  r = await place("FLOW-1");
  ok("a customer places an order", r.status === 200 && !!(await lib.getOrderById(d1, "FLOW-1")));
  r = await admin({ action: "markPaidManual", org: "acme", orderId: "FLOW-1" });
  let o = await lib.getOrderById(d1, "FLOW-1");
  ok("it's marked paid", r.status === 200 && o.paid === true);
  ok("no digitizing step and no design upload is asked for", o.needsDigitizing === false && o.orderDesignsMissing === 0);
  ok("blanks ordered, then received", (await stage("FLOW-1", "blankOrdered", { vendor: "V" })).status === 200 && (await stage("FLOW-1", "blankReceived")).status === 200);
  r = await stage("FLOW-1", "manufactured");
  ok("Mark manufactured works straight from the Orders page", r.status === 200 && !!(await lib.getOrderById(d1, "FLOW-1")).manufacturedAt);
  ok("…and uses up the blanks (stock down by the 2 pieces, cost of goods on the line)", stock() === before - 2 &&
    d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='consume' AND orderId='FLOW-1'")[0].n === 1 && Number(d1.q("SELECT cogsCents FROM order_items WHERE orderId='FLOW-1'")[0].cogsCents) === 800);
  ok("packed, delivered (a pickup), completed", (await stage("FLOW-1", "qaPacked")).status === 200 && (await stage("FLOW-1", "delivered")).status === 200 &&
    (await admin({ action: "setOrderCompleted", orderIds: ["FLOW-1"] })).body.updated === 1 && !!(await lib.getOrderById(d1, "FLOW-1")).completedAt);
  ok("the order that was stuck on digitizing while Production was on can now be made too", (await stage("P-ON", "manufactured")).status === 200);
  // Typed-in personalization: with Production on it needs an order design uploaded first.
  await place("PERS-1", { items: [{ productId: "tee", size: "M", qty: 1, personalized: true, persName: "Pat" }] });
  await admin({ action: "markPaidManual", org: "acme", orderId: "PERS-1" });
  o = await lib.getOrderById(d1, "PERS-1");
  ok("typed-in text still needs the customer's approval (that's the other switch), but no order-design upload", o.needsDesignApproval === true && o.orderDesignsMissing === 0 && o.needsDigitizing === false);
  ok("…so the proof can be approved without a digitizing step", (await stage("PERS-1", "designApproved")).status === 200);

  await setF({ production: true });
  r = await admin({ action: "listHoops" });
  ok("back on: everything is where it was (the hoop saved earlier)", r.status === 200 && r.body.hoops.length === 1 && r.body.hoops[0].name === "Round 15cm");
  ok("back on: the health check flags the missing design again", JSON.stringify((await admin({ action: "getCatalogIssues" })).body).includes("noDesign"));
  await place("P-BACK"); await admin({ action: "markPaidManual", org: "acme", orderId: "P-BACK" });
  await place("PERS-2", { items: [{ productId: "tee", size: "M", qty: 1, personalized: true, persName: "Sam" }] });
  ok("back on: digitizing and the order-design upload are asked for again", (await lib.getOrderById(d1, "P-BACK")).needsDigitizing === true && (await lib.getOrderById(d1, "PERS-2")).orderDesignsMissing === 1);
  ok("back on: the Run Order queue loads", (await admin({ action: "getProductionQueue" })).status === 200);

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== Bookkeeping ===");
  r = await admin({ action: "listExpenseCategories" });
  const catId = r.body.categories[0].id;
  r = await admin({ action: "listAccounts" });
  const acctId = r.body.accounts[0].id;
  r = await admin({ action: "saveExpense", expense: { date: "2020-02-10", description: "Thread", categoryId: catId, amount: 12.5, accountId: acctId } });
  ok("on: an expense is recorded", r.status === 200 && (await admin({ action: "listExpenses", dateFrom: "2020-01-01", dateTo: "2020-12-31" })).status === 200);
  r = await admin({ action: "closePeriod", month: "2020-02" });
  ok("on: a month that has ended can be closed", r.status === 200 && r.body.periods.some(p => p.month === "2020-02"));
  r = await admin({ action: "addPayment", orderId: "P-BACK", amount: 1, method: "cash", date: "2020-02-11" });
  ok("on: a payment dated in the closed month is refused", r.status === 409 && /closed/.test(r.body.message));

  await setF({ bookkeeping: false });
  const bookActions = ["listExpenses", "saveExpense", "deleteExpense", "listExpenseCategories", "getExpenseReport", "importExpenses", "listAccounts", "saveAccount", "listMoney", "saveMoneyEntry", "setPaymentAccount",
    "getReconciliation", "importStatement", "createFromStatementLine", "reconcileMonth", "listClosedPeriods", "closePeriod", "reopenPeriod", "getAccountantExport"];
  refused.length = 0; for (const a of bookActions) refused.push(off403(await admin({ action: a, month: "2020-03", expense: { date: "2024-01-01" } }), "Bookkeeping"));
  ok("off: expenses, accounts & money, reconcile, periods and the accountant export all answer 403 naming the feature", refused.every(Boolean));
  ok("off: no month can be closed", (await lib.getClosedPeriods(d1)).length === 1 && d1.q("SELECT count(*) n FROM expenses")[0].n === 1);
  r = await admin({ action: "addPayment", orderId: "P-BACK", amount: 1, method: "cash", date: "2020-02-11" });
  ok("off: a month closed earlier is STILL locked — history isn't silently unlocked", r.status === 409 && /February 2020 is closed/.test(r.body.message));
  r = await admin({ action: "reopenPeriod", month: "2020-02" });
  ok("…and it can't be reopened from here either", off403(r, "Bookkeeping") && (await lib.getClosedPeriods(d1)).length === 1);
  r = await admin({ action: "addPayment", orderId: "P-BACK", amount: 1, method: "cash" });
  ok("off: the payments ledger on orders keeps working", r.status === 200 && (await lib.getOrderById(d1, "P-BACK")).payments.length === 2);
  ok("off: the Revenue and Sales Tax reports stay", (await admin({ action: "getRevenueReport", dateFrom: "2020-01-01", dateTo: "2030-01-01" })).status === 200 &&
    (await admin({ action: "getSalesTaxReport", dateFrom: "2020-01-01", dateTo: "2030-01-01" })).status === 200);
  const today = new Date().toISOString().slice(0, 10), stockB = stock();
  r = await admin({ action: "receiveBlankOrder", receivedAt: today, groups: [{ blankId, lines: [{ size: "M", qty: 5, total: 20 }] }] });
  ok("off: a blank order is received into stock without choosing an account", r.status === 200 && stock() === stockB + 5);
  r = await admin({ action: "receiveBlankOrder", receivedAt: today, groups: [{ blankId, lines: [{ size: "M", qty: 1, total: 4 }] }], rdAmount: 10, rdCategoryId: catId });
  ok("off: its R&D part (an expense) is refused, saying why, and nothing is received", r.status === 403 && /need Bookkeeping/.test(r.body.message) && stock() === stockB + 5);
  r = await admin({ action: "receiveBlankOrder", receivedAt: "2020-02-12", groups: [{ blankId, lines: [{ size: "M", qty: 1, total: 4 }] }] });
  ok("off: receiving into the closed month is still refused", r.status === 409);

  await setF({ bookkeeping: true });
  r = await admin({ action: "listExpenses", dateFrom: "2020-01-01", dateTo: "2020-12-31" });
  ok("back on: the expense is there and the month is still closed", r.status === 200 && JSON.stringify(r.body).includes("Thread") && (await admin({ action: "listClosedPeriods" })).body.periods.some(p => p.month === "2020-02"));
  r = await admin({ action: "receiveBlankOrder", receivedAt: today, groups: [{ blankId, lines: [{ size: "M", qty: 1, total: 4 }] }] });
  ok("back on: a blank order needs its paid-from account again", r.status === 400 && /paid from/.test(r.body.message));
  ok("back on: the month can be reopened", (await admin({ action: "reopenPeriod", month: "2020-02" })).status === 200 && (await lib.getClosedPeriods(d1)).length === 0);

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== Shipping ===");
  const usAddr = { name: "Pat", line1: "1 Main St", city: "Columbus", state: "OH", zip: "43004" };
  const quote = () => A.signQuote(env, { orgId: "acme", zip: "43004", items: A.canonicalItems(items), amountCents: 900, method: "USPS Ground" });
  c = await cat("acme");
  ok("on: the shop offers pickup, carrier shipping and its own option", c.catalog.shippingEnabled === true && c.catalog.deliveryOptions.map(o => o.type).join() === "pickup,shipping,custom");
  r = await place("SHIP-ON", { shippingAddress: usAddr, shippingQuoteToken: await quote() });
  ok("on: an order with a carrier quote is taken", r.status === 200 && (await lib.getOrderById(d1, "SHIP-ON")).shippingCost === 9);
  ok("on: a shop that ships and a product with no weight is flagged", JSON.stringify((await admin({ action: "getCatalogIssues" })).body).includes("noWeight"));
  r = await admin({ action: "updateShipFromAddress", shipFrom: { name: "Acme", street1: "2 Elm St", city: "Columbus", state: "OH", zip: "43004", phone: "614-555-0100", email: "a@x.com" } });
  ok("on: the ship-from address saves", r.status === 200);

  await setF({ shipping: false });
  c = await cat("acme");
  ok("off: the storefront is offered pickup and the shop's own option only", c.features.shipping === false && c.catalog.shippingEnabled === false && c.catalog.deliveryOptions.map(o => o.label).join("|") === "Local pickup|Hand delivery");
  r = await place("SHIP-OFF", { shippingAddress: usAddr, shippingQuoteToken: await quote() });
  ok("off: an order with a carrier quote is refused, and not saved", r.status === 400 && /doesn't offer shipping/.test(r.body.message) && !(await lib.getOrderById(d1, "SHIP-OFF")));
  r = await place("SHIP-MANUAL", { shippingAddress: usAddr, manualShipping: true });
  ok("off: so is a \"quote to follow\" shipment", r.status === 400);
  ok("off: pickup and the custom option keep working", (await place("PICK-OFF")).status === 200 && (await place("HAND-OFF", { deliveryOptionId: handId })).status === 200 &&
    (await lib.getOrderById(d1, "HAND-OFF")).shippingCost === 5 && (await lib.getOrderById(d1, "HAND-OFF")).shippingMethod === "Hand delivery");
  const shipActions = ["updateShipFromAddress", "getBoxPresets", "setBoxPresets", "getOrderForShipping", "checkDeliveries", "checkBlankShipments"];
  refused.length = 0; for (const a of shipActions) refused.push(off403(await admin({ action: a, orderId: "SHIP-ON" }), "Shipping"));
  ok("off: ship-from address, package sizes and the tracking checks answer 403 naming the feature", refused.every(Boolean));
  ok("off: the missing weight isn't flagged any more", !JSON.stringify((await admin({ action: "getCatalogIssues" })).body).includes("noWeight"));
  r = await admin({ action: "createOrg", orgId: "newshop", subdomain: "newshop", name: "New", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "shipping" }] });
  ok("off: a new shop can't start with carrier shipping", r.status === 400 && /Carrier shipping is turned off/.test(r.body.message) && !(await lib.getOrgById(d1, "newshop")));
  r = await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme renamed", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "shipping" }, { type: "custom", label: "Hand delivery", fee: 5, id: handId }] });
  ok("off: a shop that already had it can still be edited, and keeps its list for later", r.status === 200 && (await lib.getOrgById(d1, "acme")).deliveryOptions.some(x => x.type === "shipping"));
  {
    const g = { rateLimited: async () => ({ blocked: false }), getBoxPresets: async () => null, selectBox: () => ({ box: {}, packing: 0, boxWeightOz: 0 }), getProductsByOrg: async () => [{ productId: "tee", type: "shirt", weightOz: 6 }], getShipFromAddress: async () => ({ zip: "43004" }), ...new Function(dbSrc + "\nreturn { lineQty, QTY_MESSAGE };")() };
    const ship = (features) => new Function("g", "getCatalogData", "const { rateLimited, getBoxPresets, selectBox, getProductsByOrg, getShipFromAddress, lineQty, QTY_MESSAGE } = g; const rateLimitResponse = () => null;\n" +
      hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/api/shipping.js")) + "\nreturn onRequestPost;")(g, async () => ({ subdomainMap: SUBS, features }));
    const realFetch = global.fetch; let called = 0;
    global.fetch = async () => { called++; return { json: async () => ({ rates: [{ amount: "9.00", provider: "USPS", servicelevel: { name: "Ground" } }] }) }; };
    const req = () => ({ env: { SHIPPO_API_KEY: "k", DB: {}, QUOTE_SIGNING_SECRET: "s".repeat(40) }, request: { url: "https://acme.example.com/api/shipping", json: async () => ({ zip: "43004", items: [{ productId: "tee", qty: 1 }] }), headers: { get: () => null } } });
    let res = await ship({ shipping: false })(req());
    ok("off: /api/shipping refuses to quote, without calling the carrier", res.status === 403 && /isn't available/.test(JSON.parse(await res.text()).message) && called === 0);
    res = await ship({ shipping: true })(req());
    ok("on (or no features in the catalog at all): it quotes", res.status === 200 && called === 1 && (await ship(undefined)(req())).status === 200);
    global.fetch = realFetch;
    const label = (features) => new Function("getCatalogData", "const requireAdmin = async () => null; const selectBox = () => ({}); const getOrderForShipping = async () => { global.__labelRead106 = true; return null; }, recordShippingLabel = async () => {}, getShipFromAddress = async () => ({}), getOrderLabel = async () => { global.__labelRead106 = true; return null; }, setShippingLabelUrl = async () => {};\n" +
      hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/api/shippo-label.js")) + "\nreturn onRequestPost;")(async () => ({ subdomainMap: SUBS, features }));
    const lreq = (action) => ({ env: { SHIPPO_API_KEY: "k", DB: {} }, request: { url: "https://admin.example.com/api/shippo-label", json: async () => ({ key: "x", action, org: "acme", orderId: "SHIP-ON" }), headers: { get: () => null } } });
    global.__labelRead106 = false;
    const answers = []; for (const a of ["rates", "purchase", "reprint"]) { const x = await label({ shipping: false })(lreq(a)); answers.push(x.status === 403 && /^Shipping is turned off/.test(JSON.parse(await x.text()).message)); }
    ok("off: /api/shippo-label refuses rates, purchases and reprints before anything is looked up", answers.every(Boolean) && global.__labelRead106 === false);
    ok("on: it carries on to the order", (await label({})(lreq("reprint"))).status === 404 && global.__labelRead106 === true);
  }
  // The morning roll-up's tracking checks (the real deliveryCheck.js): nothing is looked up.
  await admin({ action: "markPaidManual", org: "acme", orderId: "SHIP-ON" });
  d1._raw.exec(`UPDATE orders SET shippedAt='2026-01-02T00:00:00.000Z', qaPackedAt='2026-01-01T00:00:00.000Z', trackingNumber='9400100000000000000000' WHERE orderId='SHIP-ON'`);
  shippoCalls = 0;
  const shipEnv = { ...env, SHIPPO_API_KEY: "shippo_test_x" };
  let chk = await lib.checkShippedDeliveries(shipEnv), chkB = await lib.checkBlankShipments(shipEnv);
  ok("off: the roll-up's delivery and blank-shipment checks skip their tracking lookups", shippoCalls === 0 && chk.checked === 0 && /turned off/.test(chk.skipped) && /turned off/.test(chkB.skipped) && chk.inTransit.length === 0);
  ok("the roll-up and Communications both go through those two checks", /checkShippedDeliveries\(env, \{ limit: TRACKING_LOOKUP_BUDGET \}\)/.test(read("functions/api/daily-digest.js")) && /checkBlankShipments\(env, \{ limit: blankBudget \}\)/.test(read("functions/api/daily-digest.js")));
  // The "shipped" email.
  await place("MAIL-OFF", { deliveryOptionId: handId }); await admin({ action: "markPaidManual", org: "acme", orderId: "MAIL-OFF" });
  d1._raw.exec(`UPDATE orders SET qaPackedAt='2026-01-01T00:00:00.000Z', manufacturedAt='2026-01-01T00:00:00.000Z' WHERE orderId IN ('MAIL-OFF','PICK-OFF')`);
  emails = [];
  r = await stage("MAIL-OFF", "shipped", { trackingNumber: "1Z999" }); await tick(40);
  ok("off: an order can still be marked shipped by hand, but no \"shipped\" email goes out", r.status === 200 && !!(await lib.getOrderById(d1, "MAIL-OFF")).shippedAt && !emails.some(e => /shipped/i.test(e.subject)));

  await shipOn();
  c = await cat("acme");
  ok("back on: the shop's carrier option is offered again, exactly as it was saved", c.catalog.shippingEnabled === true && c.catalog.deliveryOptions.map(o => o.type).join() === "pickup,shipping,custom");
  ok("back on: carrier-quote orders are taken and the ship-from address is still there", (await place("SHIP-BACK", { shippingAddress: usAddr, shippingQuoteToken: await quote() })).status === 200 &&
    (await admin({ action: "getShipFromAddress" })).body.shipFrom.street1 === "2 Elm St");
  shippoCalls = 0; chk = await lib.checkShippedDeliveries(shipEnv);
  ok("back on: the tracking check looks the shipment up", shippoCalls >= 1 && chk.checked >= 1);
  await admin({ action: "markPaidManual", org: "acme", orderId: "PICK-OFF" });
  await admin({ action: "recordTracking", org: "acme", orderId: "PICK-OFF", trackingNumber: "1Z777" });
  emails = []; r = await stage("PICK-OFF", "shipped"); await tick(40);
  ok("back on: marking shipped sends the customer's email", r.status === 200 && emails.some(e => /shipped/i.test(e.subject)));
  await admin({ action: "updateLocaleSettings", locale: { country: "OTHER" } });
  c = await cat("acme");
  ok("either rule alone turns carrier shipping off: a non-US region still hides it with the feature on", c.features.shipping === true && c.catalog.shippingEnabled === false && c.catalog.deliveryOptions.map(o => o.type).join() === "pickup,custom");
  await admin({ action: "updateLocaleSettings", locale: { country: "US" } });

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== Design approval ===");
  const verify = new Function(httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/verifyLinks.js")) + "\n" +
    strip(read("functions/api/verify.js")).replace(/onRequestGet/g, "verifyGet").replace(/onRequestPost/g, "verifyPost") + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" +
    strip(read("functions/api/upload-verify.js")).replace(/onRequestPost/g, "uploadPost").replace(/onRequestGet/g, "uploadGet") + "\nreturn { verifyGet, verifyPost, uploadPost };")();
  const vEnv = { ...env, IMAGES: { put: async () => {} }, R2_PUBLIC_BASE: "https://img.example.com" };
  const vGet = async (token) => { const res = await verify.verifyGet({ env: vEnv, request: { url: "https://acme.example.com/api/verify?token=" + token } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  const vPost = async (token, action) => { const res = await verify.verifyPost({ env: vEnv, waitUntil: () => {}, request: { url: "https://acme.example.com/api/verify", json: async () => ({ token, action }), headers: { get: () => null } } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  const vUpload = async (token) => { const res = await verify.uploadPost({ env: vEnv, request: { url: "https://acme.example.com/api/upload-verify?token=" + token, headers: { get: (k) => /content-type/i.test(k) ? "text/plain" : null } } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  // PERS-2: typed-in text, placed while Production is on → needs its order design, then approval.
  await admin({ action: "markPaidManual", org: "acme", orderId: "PERS-2" });
  const itemId = d1.q("SELECT id FROM order_items WHERE orderId='PERS-2'")[0].id;
  d1._raw.exec(`INSERT INTO order_item_designs (itemId, machineFileKey, machineFileName, machineFileExt, threadColorsJson, uploadedAt, createdAt) VALUES (${itemId}, 'order-files/${itemId}/${"a".repeat(32)}.dst', 'pat.dst', 'dst', '[]', 't', 't')`);
  await stage("PERS-2", "blankOrdered"); await stage("PERS-2", "blankReceived"); await stage("PERS-2", "digitizingComplete");
  o = await lib.getOrderById(d1, "PERS-2");
  ok("on: an order with typed-in text needs the customer's approval", o.needsDesignApproval === true && !!o.digitizingCompleteAt);
  r = await stage("PERS-2", "manufactured");
  ok("on: …so it can't be made before the design is approved", r.status === 409 && /design isn't approved/.test(r.body.message));
  emails = [];
  r = await admin({ action: "sendDesignVerification", orderIds: ["PERS-2"], message: "Please check the name." });
  const token = d1.q("SELECT token FROM design_verifications WHERE orderId='PERS-2'")[0].token;
  ok("on: the proof is emailed, and the customer's link opens it", r.status === 200 && r.body.sent === 1 && (await vGet(token)).body.status === "ok");

  await setF({ designVerification: false });
  ok("off: sending proofs and listing them answer 403 naming the feature", off403(await admin({ action: "sendDesignVerification", orderIds: ["PERS-2"], message: "x" }), "Design approval") &&
    off403(await admin({ action: "listDesignVerifications", org: "acme" }), "Design approval"));
  o = await lib.getOrderById(d1, "PERS-2");
  ok("off: no order needs design approval", o.needsDesignApproval === false && (await lib.getOrderById(d1, "FLOW-1")).needsDesignApproval === false);
  ok("off: the Design approved stage isn't offered — one order or many", off403(await stage("PERS-2", "designApproved"), "Design approval") &&
    off403(await admin({ action: "bulkSetFulfillmentStage", orderIds: ["PERS-2"], stage: "designApproved" }), "Design approval") && !(await lib.getOrderById(d1, "PERS-2")).designApprovedAt);
  r = await vGet(token);
  ok("off: a link already sent answers \"not available\" plainly, not as an error", r.status === 200 && r.body.status === "unavailable" && /isn't available right now/.test(r.body.message) && !("orderId" in r.body));
  r = await vPost(token, "approved");
  ok("off: nothing can be approved through it", r.status === 403 && /isn't available/.test(r.body.message) && d1.q("SELECT status FROM design_verifications WHERE token=?", token)[0].status === "pending");
  ok("off: nor can a picture be uploaded through it", (await vUpload(token)).status === 403);
  r = await stage("PERS-2", "manufactured");
  ok("off: the order is made without an approval", r.status === 200 && !!(await lib.getOrderById(d1, "PERS-2")).manufacturedAt);
  ok("off: the Run Order queue's rule follows (no approval wanted for typed-in text)", (await lib.getProductionQueue(d1)).every(j => j.orderId !== "PERS-2"));

  await setF({ designVerification: true });
  await place("PERS-3", { items: [{ productId: "tee", size: "M", qty: 1, personalized: true, persName: "Lee" }] });
  ok("back on: approval is needed again", (await lib.getOrderById(d1, "PERS-3")).needsDesignApproval === true && (await admin({ action: "listDesignVerifications", org: "acme" })).status === 200);
  ok("back on: the old link opens again, and an upload is judged on its own merits", (await vGet(token)).body.status === "ok" && (await vUpload(token)).status === 400);
  r = await vPost(token, "approved");
  ok("back on: …and the customer can approve through it", r.status === 200 && d1.q("SELECT status FROM design_verifications WHERE token=?", token)[0].status === "approved");

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== The standalone handlers ===");
  const KEY32 = "b".repeat(32);
  const hdr = (h) => ({ get: (k) => { const key = Object.keys(h).find(x => x.toLowerCase() === String(k).toLowerCase()); return key ? h[key] : null; } });
  const stubs = "const requireAdmin = async () => null, timingSafeEqual = (a, b) => a === b;\n";
  const design = new Function(stubs + hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/api/design.js")) + "\nreturn onRequestPost;")();
  const receipt = new Function(stubs + hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/api/receipt.js")) + "\nreturn onRequestPost;")();
  const fEnv = { ...env, DESIGNS: { put: async () => {} }, RECEIPTS: { put: async () => {} } };
  const dView = async (key) => { const res = await design({ env: fEnv, request: { url: "https://admin.example.com/api/design", headers: hdr({ "Content-Type": "application/json" }), json: async () => ({ key }) } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  const dUpload = async (qs) => { const res = await design({ env: fEnv, request: { url: "https://admin.example.com/api/design?" + qs, headers: hdr({ "Content-Type": "application/octet-stream" }) } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  const rView = async () => { const res = await receipt({ env: fEnv, request: { url: "https://admin.example.com/api/receipt", headers: hdr({ "Content-Type": "application/json" }), json: async () => ({ key: `receipts/2026/${KEY32}.pdf` }) } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
  ok("on: a design file link is signed, and a design upload gets as far as its own checks", (await dView(`designs/1/${KEY32}.dst`)).status === 200 && (await dUpload("designId=1&role=machine&ext=txt")).status === 400);
  ok("on: a receipt link is signed", (await rView()).status === 200);
  await setF({ production: false, bookkeeping: false });
  r = await dView(`designs/1/${KEY32}.dst`);
  ok("production off: /api/design refuses a design file's link", r.status === 403 && /^Production is turned off/.test(r.body.message));
  ok("production off: …and a design version's or an order design's upload", (await dUpload("designId=1&role=machine&ext=dst")).status === 403 && (await dUpload("itemId=5&role=machine&ext=dst")).status === 403);
  ok("production off: a line item's plain attachments (part of the order) still work", (await dView(`order-files/5/${KEY32}.png`)).status === 200 && (await dUpload("itemId=5&ext=zzz")).status === 400);
  r = await rView();
  ok("bookkeeping off: /api/receipt refuses", r.status === 403 && /^Bookkeeping is turned off/.test(r.body.message));
  {
    const store = new Map();
    global.caches = { default: { async match(k){ const h = store.get(k); return h ? new Response(h) : undefined; }, async put(k, res){ store.set(k, await res.text()); }, async delete(k){ return store.delete(k); } } };
    const agent = new Function("deps", "const { classifyHost, requireAdmin, timingSafeEqual, rateLimited, rateLimitResponse, signedDesignPath, DESIGN_KEY_RE } = deps;\n" + httpSrc + "\n" +
      strip(read("functions/_lib/agentRelay.js")) + "\n" + strip(read("functions/api/agent.js")) + "\nreturn onRequestPost;")({
      classifyHost: () => ({ kind: "admin" }), requireAdmin: async () => null, timingSafeEqual: (a, b) => a === b, rateLimited: async () => ({ blocked: false }), rateLimitResponse: () => null,
      signedDesignPath: async () => "/x", DESIGN_KEY_RE: /^designs\// });
    const aEnv = { ...env, AGENT_TOKEN: "t".repeat(40) };
    const call = async (op, body, token) => { const res = await agent({ env: aEnv, request: { url: "https://admin.example.com/api/agent?op=" + op, headers: hdr(token ? { "X-Agent-Token": token } : {}), json: async () => body || {} } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
    r = await call("status", {});
    ok("production off: the admin can't ask about the send-agent or queue a machine job", r.status === 403 && /^Production is turned off/.test(r.body.message) && (await call("submit", { type: "discover" })).status === 403);
    ok("production off: the agent's own polls are left alone (they just find nothing)", (r = await call("poll", {}, aEnv.AGENT_TOKEN)).status === 200 && r.body.job === null);
    await setF({ production: true, bookkeeping: true });
    ok("on: the relay answers the admin again", (await call("status", {})).status === 200);
    delete global.caches;
  }
  ok("on again: design and receipt links are signed as before", (await dView(`designs/1/${KEY32}.dst`)).status === 200 && (await rView()).status === 200);
  ok("every switch was audited each time it moved", d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.features_set'")[0].n >= 10);

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== No action can be forgotten ===");
  // EXPECTED is written out by hand, by page — deliberately not derived from orders.js — so adding
  // an action to one of these areas without deciding which side of a switch it's on fails here.
  const EXPECTED = {
    production: [
      "listThreads", "saveThread", "deleteThread", "importThreadChart",                                      // Threads
      "listSpoolSizes", "saveSpoolSize", "deleteSpoolSize", "saveThreadInventory", "deleteThreadInventory",   // Threads → spools, thread stock
      "getNeedleSettings", "saveNeedleSize", "deleteNeedleSize", "saveNeedleType", "deleteNeedleType",        // Threads → Needle settings
      "listHoops", "saveHoop", "deleteHoop",                                                                  // Hoops
      "listDesigns", "getDesign", "saveDesign", "deleteDesign", "saveDesignVersion", "updateDesignVersionColors", // Designs
      "setProductDesign", "listProductDesigns", "setProductDesigns",                                          // a product's designs
      "getOrderItemDesigns", "saveOrderItemDesign",                                                           // order-specific designs
      "listMachines", "getMachine", "saveMachine", "deleteMachine", "setMachineHoop", "setMachineNeedle", "recordMachineDiscovery", // Machines
      "getMachineSettings", "updateMachineSettings",                                                          // Machine Files
      "getProductionQueue", "markManufacturedOnMachine",                                                      // Run Order
      "listActiveRuns", "startRun", "completeRun", "getRunStats", "abortRun", "markHoopingDone",              // runs
      "listAbortReasons", "saveAbortReason", "deleteAbortReason",                                             // Abort reasons
      "getRunReportByDesign",                                                                                 // Run Times report
      "setMachineStitchCount", "listMaintenanceTasks", "saveMaintenanceTask", "deleteMaintenanceTask", "recordMaintenance", "getMaintenanceLog", // Machine maintenance
      "setDesignVersionStitches", "fillDesignStitchCounts",                                                   // design stitch counts
    ],
    bookkeeping: [
      "listExpenseCategories", "saveExpenseCategory", "deleteExpenseCategory", "listExpenses", "saveExpense", "deleteExpense", "getExpenseReport", "previewExpenseImport", "importExpenses", // Expenses
      "listAccounts", "saveAccount", "saveMoneyDefaults", "listMoney", "saveMoneyEntry", "deleteMoneyEntry", "setPaymentAccount", // Accounts & money
      "getAccountRegister", "setRecordReceipt", "previewReceiptAccountChange", "setReceiptAccount",                       // Account viewer, Change account…
      "getReconciliation", "importStatement", "autoMatchStatement", "matchStatementLine", "unmatchStatementLine", "ignoreStatementLine", "createFromStatementLine", "reconcileMonth", "unreconcileMonth", "listCashoutPayments", // Reconcile
      "listClosedPeriods", "closePeriod", "reopenPeriod", "getAccountantExport",                              // Periods & Export
    ],
    shipping: [
      "updateShipFromAddress",                         // Global settings → Ship-from address
      "getBoxPresets", "setBoxPresets",                // Package sizes
      "getOrderForShipping",                           // label purchase
      "checkDeliveries", "checkBlankShipments",        // tracking checks (Communications → Check now)
    ],
    designVerification: ["sendDesignVerification", "listDesignVerifications"],
  };
  // Everything else the dispatcher answers: always available, whatever the switches say.
  const ALWAYS_ON = [
    // Orders, payments, fulfilment stages (incl. Mark manufactured, which uses blanks)
    "listOrgs", "getOrders", "getOrdersAllShops", "getOpenOrders", "getPendingCommunications", "sendTestEmail", "setOrderCompleted", "useBlanksFromStock", "markPaidManual", "resendEmail",
    "addPayment", "recordRefund", "setRefundShipping", "backfillStripeFees", "setPaymentDate", "deletePayment", "voidPayment", "setDiscount", "deleteOrder", "voidOrder",
    "updateCustomerInfo", "createLocalSale", "createTestTransaction", "setFulfillmentStage", "bulkSetFulfillmentStage", "cancelLineItem", "bulkCancelLineItems", "setLineItemRefund", "editOrder",
    "recordTracking", "bulkRecordTracking", "setShippingInfo", "setShippingPaidAmount", "createShippingPaymentLink", "sendInvoice", "getInvoiceDocument", "updateOrderDate", "setOrderDueDate", "bulkSetDueDate",
    "addBlankShipment", "updateBlankShipment", "deleteBlankShipment", "getBlankShipments", "getOrderItemFiles", "saveOrderItemFile", "deleteOrderItemFile",
    // Reports that aren't bookkeeping
    "getAuditLog", "getRevenueReport", "getSalesTaxReport", "getInventoryReport",
    // Shops, products, catalog, settings
    "listOrgsAdmin", "createOrg", "setupOrgDomain", "getOrgDomainStatus", "updateOrg", "listProducts", "createProduct", "updateProduct", "importProducts", "setProductVisible", "setProductOrder", "createProductVersion", "copyProductVersionSettings", "separateProductVersion", "copyProductsFromOrg", "getCatalogIssues", "publish",
    "getGlobalSettings", "updateGlobalSettings", "getSetupStatus", "getCloudflareSetup", "connectCloudflare", "getBusinessProfile", "updateBusinessProfile", "getLocaleSettings", "updateLocaleSettings", "getFeatures", "updateFeatures", "getShipFromAddress", "getSalesTaxSettings", "updateSalesTaxSettings",
    "listLocations", "saveLocation", "deleteLocation", "listProductCategories", "saveProductCategory", "deleteProductCategory", "listProductGraphicImages", "setProductGraphicImage", "deleteProductGraphicImage",
    "listGraphics", "saveGraphic", "setProductGraphicColorBlocked", "deleteGraphic", "getTierPrices", "setTierPrices",
    // Inventory — always on in this release: blanks, transfers, stock movements, cost of goods
    "getInventory", "createInventoryItem", "updateInventoryItem", "deleteInventoryItem", "getBlankReadyCounts", "getBlanks", "createBlank", "updateBlank", "deleteBlank", "mergeBlanks", "importBlanks", "previewVendorBlanks", "applyVendorBlanks", "copyVendorImage", "suggestColorGroups", "analyzePricing", "getPricingSettings", "updatePricingSettings", "removeBlankImages", "findOrphanImages", "deleteOrphanImages", "listVendorConnections", "fetchVendorProducts", "vendorDirectorySearch", "vendorDirectoryEndpoints", "saveVendorConnection", "deleteVendorConnection", "testVendorConnection", "linkVendorConnectionBlanks", "previewSupplierOrder", "placeSupplierOrder", "listSupplierOrders", "checkSupplierOrderShipments", "cancelSupplierOrder", "listVendorApiLog", "getVendorApiLogEntry", "getBlanksToOrder", "freeShippingSuggestions", "getVendorShipping", "setVendorShipping", "recordRestockOrder", "cancelRestockOrder", "getPublishState", "getPreviewLink", "previewDiscardShopChanges", "discardShopChanges", "applyRulePrices", "setOrgReady", "getShopWizard", "saveShopWizard", "listShopWizards", "deleteShopWizard", "buildProductFromBlank", "getBrandRules", "updateBrandRules", "listBrandApprovals", "addBrandApproval", "revokeBrandApproval",
    "receiveBlanks", "receiveBlankOrder", "addBlankSizes", "readInvoiceWithAi", "markBlankPricesChecked", "confirmProductPrices", "recomputeBlankAverageCosts", "getBlankVendorPriceHistory", "writeOffBlanks", "getBlankMovements", "voidInventoryMovement", "restoreInventoryMovement", "previewBlankCatchUp", "applyBlankCatchUp",
    "getBlankLinks", "setBlankLink", "deleteBlankLink", "getReadyToShip", "setReadyToShipQty", "makeForStock", "getFinishedGoodsMovements", "voidFinishedGoodsMovement",
    "listTransfers", "saveTransfer", "deleteTransfer", "receiveTransferSheet", "writeOffTransfers", "getTransferMovements", "voidTransferMovement", "restoreTransferMovement",
    "getTransferQueue", "getGangSheet", "setTransferReceived", "setTransfersApplied", "refreshOrderFromCatalog", "makeTransferLine",
  ];
  const names = (text) => [...text.matchAll(/"(\w+)"/g)].map(m => m[1]);
  const mapSrc = ordersJs.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1];
  const map = {}; for (const m of mapSrc.matchAll(/(\w+): \[([\s\S]*?)\],/g)) map[m[1]] = names(m[2]);
  const catalogActions = names(ordersJs.match(/const CATALOG_ADMIN_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1]);
  const dispatched = new Set(catalogActions);
  for (const m of ordersJs.matchAll(/body\.action === "(\w+)"/g)) dispatched.add(m[1]);
  for (const m of ordersJs.matchAll(/\[([^\[\]]*)\]\.includes\(body\.action\)/g)) names(m[1]).forEach(a => dispatched.add(a));
  for (const m of ordersJs.matchAll(/const (?:RECON|MONEY|EXPENSE)_ACTIONS = \[([\s\S]*?)\];/g)) names(m[1]).forEach(a => dispatched.add(a));
  const mapped = Object.values(map).flat(), expected = Object.values(EXPECTED).flat();
  ok("the map has the four features that own admin actions and nothing else (storefront has none: it closes the public side)", Object.keys(map).join() === KEYS.join());
  ok("every action in the map is a real action in the file", mapped.length > 80 && mapped.every(a => dispatched.has(a)));
  ok("no action is listed under two features, or twice", new Set(mapped).size === mapped.length);
  const diff = KEYS.flatMap(k => [...map[k].filter(a => !EXPECTED[k].includes(a)).map(a => "+" + k + ":" + a), ...EXPECTED[k].filter(a => !map[k].includes(a)).map(a => "-" + k + ":" + a)]);
  if (diff.length) console.log("   map vs. expected:", diff.join(" "));
  ok("each feature's actions are exactly the ones listed here by page", diff.length === 0);
  const undecided = [...dispatched].filter(a => !expected.includes(a) && !ALWAYS_ON.includes(a));
  if (undecided.length) console.log("   neither switched nor always-on:", undecided.join(", "));
  ok("every action the API answers is either behind a switch or on the always-on list — none undecided", undecided.length === 0);
  ok("…in particular every catalog-admin action", catalogActions.every(a => mapped.includes(a) || ALWAYS_ON.includes(a)));
  ok("nothing is on both lists, and the always-on list names only real actions", ALWAYS_ON.every(a => !mapped.includes(a) && dispatched.has(a)) && new Set(ALWAYS_ON).size === ALWAYS_ON.length);
  ok("the gate is one check before any action runs, not one per action", (ordersJs.match(/if \(ACTION_FEATURE\[body\.action\]/g) || []).length === 1 &&
    ordersJs.indexOf("if (ACTION_FEATURE[body.action] && !featureOn(") < ordersJs.indexOf('if (body.action === "listOrgs")'));
  ok("the switches reach it from the cached catalog — no extra database read per request", /const featureOn = \(key\) => \(catalogData\.features \|\| \{\}\)\[key\] !== false;/.test(ordersJs));

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== The admin: menu, routes, Global settings ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [], sentBodies = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) {
          const body = JSON.parse(opts.body); sent.push(body.action); sentBodies.push(body);
          const res = await post("admin", body);
          return { ok: res.status < 400, status: res.status, json: async () => res.body };
        }
        if (String(url).includes("/api/catalog")) { const body = await cat("admin"); return { ok: true, status: 200, json: async () => body }; }
        if (String(url).includes("127.0.0.1")) throw new Error("no agent in tests");
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      win.confirm = () => true;
      win.CSS = win.CSS || { escape: (x) => String(x) };
    } });
  const w = dom.window, doc = w.document, app = doc.getElementById("app");
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "x"; adminOrgs = [{orgId:"acme", name:"Acme"}]; window._ordersFilter = {from:"", to:""};');
  const settle = async (pred) => { for (let i = 0; i < 80 && !pred(); i++) await tick(25); };
  const labels = (sel) => [...doc.querySelectorAll(sel)].map(b => b.textContent.trim());
  const desktop = () => labels("#adminNav .admin-nav-row .admin-nav-btn"), mobile = () => labels("#adminNav .admin-nav-sheet .admin-nav-btn");
  const go = async (hash) => { w.location.hash = "#" + hash; await w.adminRoute(); await tick(60); };
  const NAV = {
    production: ["Run Order", "Machines", "Machine maintenance", "Machine files", "Hoops", "Abort reasons", "Threads", "Run times", "Designs"],
    bookkeeping: ["Expenses", "Accounts & money", "Reconcile", "Account viewer", "Periods & export"],
    shipping: ["Package sizes"],
  };
  const ROUTES = { production: ["runorder", "machines", "machinefiles", "hoops", "abortreasons", "threads", "runreport", "designs/acme", "designs/acme/3"], bookkeeping: ["expenses", "money", "reconcile", "accountviewer", "books"], shipping: ["packages"] };
  ok("the page learned the switches from /api/catalog (all on)", KEYS.every(k => w.eval(`featureOn_("${k}")`) === true));
  w.renderAdminNav();
  const allOn = desktop();
  ok("all on: every page is in the menu, on a desktop and on a phone", Object.values(NAV).flat().every(l => allOn.includes(l) && mobile().includes(l)) && allOn.includes("Blanks") && allOn.includes("Global settings"));
  ok("every page of a switched feature in the menu is one the route guard knows", Object.entries(ROUTES).every(([f, hs]) => hs.every(h => w.adminPageFeature_(h) === f)) && w.adminPageFeature_("inventory") === "" &&
    w.adminPageFeature_("transfers") === "" && w.adminPageFeature_("settings") === "" && w.adminPageFeature_("catalog/orgs/acme/edit") === "" && w.adminPageFeature_("orders/acme") === "");
  ok("the names on the turned-off page are the server's", lib.FEATURES.every(f => w.eval("FEATURE_LABELS_")[f.key] === f.label));
  for (const f of ["production", "bookkeeping", "shipping"]) {
    w.eval(`applyFeatures_({ ${f}: false })`); w.renderAdminNav();
    const d = desktop(), m = mobile(), others = Object.entries(NAV).filter(([k]) => k !== f).flatMap(([, v]) => v);
    ok(`${f} off: its pages leave the desktop menu and the phone menu, and nothing else does`, NAV[f].every(l => !d.includes(l) && !m.includes(l)) && others.every(l => d.includes(l) && m.includes(l)) &&
      ["Orders", "Manage catalog", "Blanks", "Transfers", "Audit log", "Revenue report", "Sales tax report", "Inventory & COGS", "Communications", "Global settings", "Sign out"].every(l => d.includes(l) && m.includes(l)));
    sent.length = 0; let allOff = true;
    for (const h of ROUTES[f]) { await go(h); const p = doc.getElementById("featureOffPanel"); allOff = allOff && !!p && p.dataset.feature === f && /This feature is turned off — turn it on under Global settings/.test(p.textContent); }
    ok(`${f} off: each of its routes shows the turned-off page instead of the screen, and asks the server for nothing`, allOff && sent.length === 0 && /is turned off/.test(doc.querySelector("#app h1").textContent));
  }
  w.eval("applyFeatures_({ bookkeeping: false })"); w.renderAdminNav();
  ok("a menu group with nothing left in it disappears (Finance)", !desktop().includes("Finance") && !labels("#adminNav .admin-nav-label").includes("Finance") && desktop().includes("Reports"));
  w.eval("applyFeatures_({})"); w.renderAdminNav();
  await go("hoops"); await settle(() => /Round 15cm/.test(app.textContent));
  ok("back on: the route shows the real screen again, with its data", !doc.getElementById("featureOffPanel") && /Round 15cm/.test(app.textContent) && desktop().includes("Hoops"));

  console.log("--- buttons that would only get a 403 ---");
  const order = { orderId: "X1", paid: true, items: [{}], shippingAddress: { line1: "1 Main" }, labels: [] };
  const trk = () => w.trackingCell({ orgId: "acme" }, order);
  ok("shipping on: a paid order with an address offers Ship (buy a label)", /shipOrder/.test(trk()));
  w.eval("applyFeatures_({ shipping: false })");
  ok("shipping off: no Ship / Label button, but a hand-typed tracking number still shows", !/shipOrder|reprintLabel/.test(trk()) && /1Z5/.test(w.trackingCell({ orgId: "acme" }, { ...order, trackingNumber: "1Z5", labels: [{ trackingNumber: "1Z5" }] })) &&
    !/reprintLabel/.test(w.trackingCell({ orgId: "acme" }, { ...order, trackingNumber: "1Z5", labels: [{ trackingNumber: "1Z5" }] })));
  w.eval("applyFeatures_({ production: false, designVerification: false, bookkeeping: false })");
  await go("catalog"); await settle(() => /Acme/.test(app.textContent) && doc.querySelector("[data-issues='products']"));
  ok("production off: the shop list has no Designs button (Products and Graphics stay)", !doc.querySelector("[data-issues='designs']") && !!doc.querySelector("[data-issues='products']") && /Graphics/.test(app.textContent));
  sent.length = 0;
  await go("orders/acme"); await settle(() => !!doc.getElementById("bulkBar"));
  const bulk = labels("#bulkBar .admin-btn");
  ok("design approval off: the Orders page has no Send verification or → Design approved, and doesn't ask for verifications", !!doc.getElementById("bulkBar") && !bulk.some(l => /Send verification|Design approved/.test(l)) &&
    bulk.some(l => /Manufactured/.test(l)) && !sent.includes("listDesignVerifications") && sent.includes("getOrders"));
  ok("production off: no → Digitizing complete either", !bulk.some(l => /Digitizing/.test(l)));
  ok("…and a stage the server marks \"not needed\" says why", /Design approval is turned off/.test(w.fulfillmentBadge("", { needsDesignApproval: false }, "designApproved")) && /Production is turned off/.test(w.fulfillmentBadge("", { needsDigitizing: false }, "digitizingComplete")));
  ok("bookkeeping off: the forms ask the server for no accounts", (await w.loadAccounts_()).accounts.length === 0 && !sent.includes("listAccounts"));
  // Blanks → Receive order with Bookkeeping off: the stock side of the form, nothing about money.
  await setF({ bookkeeping: false, production: false });   // on the server too, as it would be
  {
    const hidden = (id) => { const e = doc.querySelector(id); const box = e && (e.matches("details, div") ? e : e.closest("label")); return !!box && box.style.display === "none"; };
    const before = stock(); sent.length = 0;
    w.showReceiveOrderModal(() => {}); await settle(() => !!doc.querySelector("#roSave") && !!doc.querySelector(".rcc-blank"));
    ok("bookkeeping off: Receive order shows no paid-from, receipt or R&D / personal part", hidden("#roPaidFrom") && hidden("#roReceipt") && hidden("#rccMixed") && !sent.includes("listExpenseCategories") && !sent.includes("listAccounts"));
    const sel = doc.querySelector(".rcc-blank"); sel.value = String(blankId); sel.onchange();
    const q = doc.querySelector(".rcc-qty"), cost = doc.querySelector(".rcc-cost");
    q.value = "3"; q.dispatchEvent(new w.Event("input")); cost.value = "12.00"; cost.dispatchEvent(new w.Event("input"));
    doc.querySelector("#roSave").onclick(); await settle(() => stock() === before + 3);
    ok("…and saving it receives the blanks into stock", stock() === before + 3 && sent.includes("receiveBlankOrder") && !doc.querySelector("#roSave"));
  }
  // A product's page with Production off: no Designs section, and Save doesn't touch designs.
  sent.length = 0;
  await go("catalog/orgs/acme/products/tee/edit"); await settle(() => !!doc.getElementById("prodFormNoDesign") && !!doc.getElementById("productDesignsBlock"));
  await tick(150);
  ok("production off: the product page has no Designs section, no \"no design needed\" box and no personalization-design setup", doc.getElementById("productDesignsBlock").style.display === "none" &&
    doc.getElementById("prodFormNoDesign").closest("label").style.display === "none" && doc.getElementById("prodFormPersSetup").textContent.trim() === "" &&
    !sent.some(a => /Design|listHoops/.test(a)));
  sent.length = 0;
  await w.submitProductForm("acme", true); await settle(() => sent.includes("updateProduct")); await tick(120);
  ok("…and Save changes saves the product without a refused request", sent.includes("updateProduct") && !sent.some(a => /Design/.test(a)) && !/turned off/.test((doc.getElementById("prodFormError") || {}).textContent || "") &&
    d1.q("SELECT count(*) n FROM products WHERE orgId='acme' AND productId='tee' AND visible=1")[0].n === 1);
  await setF({ bookkeeping: true, production: true });
  w.eval("applyFeatures_({})");
  await go("orders/acme"); await settle(() => labels("#bulkBar .admin-btn").some(l => /Send verification/.test(l)));
  ok("all on: those buttons are back", labels("#bulkBar .admin-btn").some(l => /Send verification/.test(l)) && labels("#bulkBar .admin-btn").some(l => /Design approved/.test(l)) && sent.includes("listDesignVerifications"));

  console.log("--- Global settings → Features ---");
  await go("settings"); await settle(() => doc.querySelectorAll("#gFeatures .gFeature").length === 5);
  const boxes = () => [...doc.querySelectorAll("#gFeatures .gFeature")];
  ok("one checkbox per feature, all ticked, each with its name and sentence", boxes().length === 5 && boxes().every(b => b.checked) && boxes().map(b => b.dataset.feature).join() === ALL.join() &&
    lib.FEATURES.every(f => doc.getElementById("gFeatures").textContent.includes(f.label) && doc.getElementById("gFeatures").textContent.includes(f.description)));
  ok("it says inventory is always on", /Stock of blanks and transfers, and cost of goods, are always on/.test(doc.getElementById("adminPanel").textContent));
  ok("all on: Shipping's and Production's panels are open (ship-from address, Machine Files)", !doc.getElementById("gPanel-shipping").hidden && !!doc.getElementById("gShipFromSection") &&
    !doc.getElementById("gPanel-production").hidden && !!doc.getElementById("gMachineSection"));
  const auditBefore = d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.features_set'")[0].n;
  boxes().find(b => b.dataset.feature === "bookkeeping").checked = false;
  boxes().find(b => b.dataset.feature === "shipping").checked = false;
  sent.length = 0;
  await w.submitGlobalSettings(); await tick(80);
  const saved = await lib.getFeatures(d1);
  ok("unticking two and saving turns exactly those off, in the database", saved.bookkeeping === false && saved.shipping === false && saved.production === true && saved.designVerification === true);
  aud = d1.q("SELECT detail FROM audit_log WHERE action='settings.features_set' ORDER BY id DESC LIMIT 1")[0];
  ok("…with one audit entry naming both", d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.features_set'")[0].n === auditBefore + 1 && /"bookkeeping":\{"from":true,"to":false\}/.test(aud.detail) && /"shipping":\{"from":true,"to":false\}/.test(aud.detail));
  ok("…the menu follows at once, without reloading", !desktop().includes("Expenses") && !desktop().includes("Package sizes") && !mobile().includes("Reconcile") && desktop().includes("Machines"));
  ok("…and the ship-from address of the feature just switched off isn't sent", sent.includes("updateFeatures") && !sent.includes("updateShipFromAddress") && sent.includes("updateMachineSettings") && sent.indexOf("updateFeatures") < sent.indexOf("updateMachineSettings"));
  sent.length = 0;
  await go("settings"); await settle(() => doc.querySelectorAll("#gFeatures .gFeature").length === 5);
  ok("the form comes back showing what's saved, without the switched-off feature's section", boxes().filter(b => !b.checked).map(b => b.dataset.feature).join() === "bookkeeping,shipping" &&
    doc.getElementById("gPanel-shipping").hidden && !doc.getElementById("gPanel-production").hidden);
  boxes().forEach(b => { b.checked = true; });
  await w.submitGlobalSettings(); await tick(80);
  ok("ticking them again turns everything back on", ALL.every(k => w.eval(`featureOn_("${k}")`)) && Object.values(await lib.getFeatures(d1)).every(Boolean) && desktop().includes("Expenses") && mobile().includes("Package sizes"));
  const toast = () => { const t = [...doc.querySelectorAll("#toastRegion > *")].map(e => e.textContent); return t[t.length - 1] || ""; };
  ok("the \"saved\" message doesn't send you to Publish for changes that are already live", /already live/.test(toast()) && !/Click Publish|when you click Publish/.test(toast()));
  await go("settings"); await settle(() => doc.querySelectorAll("#gFeatures .gFeature").length === 5);
  ok("nothing changed on the form: no Publish needed", w.globalSettingsNeedPublish_() === false);
  doc.getElementById("gPayVenmo").checked = !doc.getElementById("gPayVenmo").checked;
  ok("a payment-method box changed: that one does wait for Publish", w.globalSettingsNeedPublish_() === true);
  await w.submitGlobalSettings(); await tick(80);
  ok("…and the message says so, and that everything else is live", /payment-method change reaches the storefront when you click Publish/.test(toast()) && /everything else is already live/.test(toast()));
  await go("settings"); await settle(() => doc.querySelectorAll("#gFeatures .gFeature").length === 5);
  doc.getElementById("gPayVenmo").checked = !doc.getElementById("gPayVenmo").checked;
  await w.submitGlobalSettings(); await tick(80);
  ok("the ship-from address saved before the switch is untouched", (await admin({ action: "getShipFromAddress" })).body.shipFrom.street1 === "2 Elm St");

  console.log("--- Shipping setup: on only with a Shippo key and a complete ship-from address ---");
  {
    const full = { name: "Acme", street1: "2 Elm St", city: "Columbus", state: "OH", zip: "43004", phone: "614-555-0100", email: "a@x.com" };
    await setF({ shipping: false });
    r = await admin({ action: "updateFeatures", features: { shipping: true }, shipFrom: { ...full, street1: "9 New Rd", phone: "", email: "" } });
    ok("Shipping with an incomplete ship-from address is refused, naming what's missing — and nothing is saved", r.status === 400 && r.body.code === "shipping_setup" &&
      /in the Ship-from address: Phone, Email/.test(r.body.message) && /or untick Shipping/.test(r.body.message) && (await lib.getFeatures(d1)).shipping === false &&
      (await admin({ action: "getShipFromAddress" })).body.shipFrom.street1 === "2 Elm St");
    r = await admin({ action: "updateFeatures", features: { shipping: true }, shipFrom: { ...full, zip: "4300" } });
    ok("…so is one in the wrong format (by Region)", r.status === 400 && /ZIP must be 5 digits/.test(r.body.message) && (await lib.getFeatures(d1)).shipping === false);
    const key = env.SHIPPO_API_KEY; delete env.SHIPPO_API_KEY;
    r = await admin({ action: "updateFeatures", features: { shipping: true }, shipFrom: full });
    ok("…and so is Shipping without a Shippo key, saying where it goes", r.status === 400 && /a Shippo key \(the SHIPPO_API_KEY secret/.test(r.body.message) && r.body.shippoKey === false && (await lib.getFeatures(d1)).shipping === false);
    await shipOn();
    r = await admin({ action: "updateFeatures", features: { storefront: true } });
    ok("a change that doesn't mention Shipping isn't held up by it", r.status === 200);
    await lib.setFeatures(d1, { shipping: false });
    env.SHIPPO_API_KEY = key;
    r = await admin({ action: "getFeatures" });
    ok("the page is told whether there is a key — never the key", r.body.shippoKey === true && !JSON.stringify(r.body).includes(key));
    r = await admin({ action: "updateFeatures", features: { shipping: true }, shipFrom: { ...full, street1: "5 Oak Ave" } });
    ok("with a key and a complete address, both are saved together", r.status === 200 && r.body.features.shipping === true && (await admin({ action: "getShipFromAddress" })).body.shipFrom.street1 === "5 Oak Ave");
    r = await admin({ action: "updateFeatures", features: { shipping: true } });
    ok("…and later saves check the saved address", r.status === 200);

    // The page: ticking Shipping shows the address; Save checks it before sending anything.
    await setF({ shipping: false });
    await go("settings"); await settle(() => doc.querySelectorAll("#gFeatures .gFeature").length === 5);
    const shipBox = boxes().find(b => b.dataset.feature === "shipping"), section = doc.getElementById("gPanel-shipping");
    ok("Shipping off: its panel is closed", !shipBox.checked && section.hidden);
    shipBox.checked = true; shipBox.dispatchEvent(new w.Event("change"));
    ok("ticking Shipping opens it at once, with what's saved, saying every field is required", !section.hidden && doc.getElementById("gShipStreet1").value === "5 Oak Ave" &&
      /All fields below are required while Shipping is on/.test(section.textContent) && section.querySelectorAll(".g-req").length >= 8);
    ok("on a cloud install the key is the server's secret, shown as set or not — never a box to type it in", /✓ set \(the SHIPPO_API_KEY secret\)/.test(section.textContent) && !doc.getElementById("gShippoKey"));
    doc.getElementById("gShipPhone").value = ""; doc.getElementById("gShipZip").value = "abc";
    sent.length = 0;
    await w.submitGlobalSettings(); await tick(60);
    const err = doc.getElementById("globalSettingsError").textContent;
    ok("Save with a field missing sends nothing at all, and says what to fill in", sent.length === 0 && /Nothing was saved/.test(err) && /the ship-from phone/.test(err) && /a 5-digit ZIP/.test(err) &&
      doc.getElementById("gShipPhone").style.outline.includes("solid") && doc.getElementById("gShipZip").style.outline.includes("solid") && !doc.getElementById("gShipCity").style.outline);
    doc.getElementById("gShipPhone").value = "614-555-0199"; doc.getElementById("gShipZip").value = "43004";
    w.eval("window._gShippoKey = false");
    sent.length = 0;
    await w.submitGlobalSettings(); await tick(60);
    ok("…and so does one without a Shippo key", sent.length === 0 && /a Shippo key/.test(doc.getElementById("globalSettingsError").textContent));
    w.eval("window._gShippoKey = true");
    sent.length = 0; sentBodies.length = 0;
    await w.submitGlobalSettings(); await tick(80);
    const featReq = sentBodies.find(b => b.action === "updateFeatures") || {};
    ok("complete: the address goes with the features in one request, after the Region", featReq.features && featReq.features.shipping === true && featReq.shipFrom && featReq.shipFrom.phone === "614-555-0199" &&
      !sent.includes("updateShipFromAddress") && sent.indexOf("updateLocaleSettings") < sent.indexOf("updateFeatures") && sent.indexOf("updateFeatures") < sent.indexOf("updateGlobalSettings"));
    ok("…and both are saved", (await lib.getFeatures(d1)).shipping === true && (await admin({ action: "getShipFromAddress" })).body.shipFrom.phone === "614-555-0199");
  }
  ok("admin.js still parses as a classic script", (() => { try { new Function(adminJs); return true; } catch (e) { return false; } })());

  // ------------------------------------------------------------------------------------------------
  console.log("\n=== The storefront ===");
  const shopPage = async () => { const answer = await cat("acme");
    const d = new JSDOM(read("public/index.html"), { runScripts: "dangerously", url: "https://acme.example.com/", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => answer }); } });
    await tick(150); return d.window; };
  let sw = await shopPage(), section = sw.eval("renderShippingSection(currentOrg)");
  ok("shipping on: the customer can type a ZIP for carrier rates, next to pickup and the shop's own option", sw.eval("offersShipping_(currentOrg)") === true && /shippingZipInput/.test(section) && /Local pickup/.test(section) && /Hand delivery/.test(section));
  await setF({ shipping: false });
  sw = await shopPage(); section = sw.eval("renderShippingSection(currentOrg)");
  ok("shipping off: only pickup and the shop's own option are offered — no ZIP box, no carrier rates", sw.eval("offersShipping_(currentOrg)") === false && sw.eval('featureOn_("shipping")') === false &&
    !/shippingZipInput|carrier/i.test(section) && /Local pickup/.test(section) && /Hand delivery/.test(section));
  await shipOn();
  sw = await shopPage();
  ok("shipping back on: the ZIP box is back", /shippingZipInput/.test(sw.eval("renderShippingSection(currentOrg)")));
  const vAnswer = { status: "unavailable", feature: "designVerification", message: "Design approval isn't available right now. Please contact us about your order." };
  const vd = new JSDOM(read("public/index.html"), { runScripts: "dangerously", url: "https://acme.example.com/?verify=abc", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url) => ({ ok: true, status: 200, json: async () => String(url).includes("/api/verify") ? vAnswer : { status: "error" } }); } });
  await tick(200);
  ok("a customer opening an approval link while it's off reads \"not available\", not \"invalid or expired\"", /isn't available right now/.test(vd.window.document.getElementById("app").textContent) && !/invalid or has expired/.test(vd.window.document.getElementById("app").textContent));

  console.log("\n=== README ===");
  const readme = read("README.md");
  ok("the README has a Features section naming the switches and what each hides", /\n## Feature switches\n/.test(readme) && ["Storefront", "Production", "Bookkeeping", "Shipping", "Design approval"].every(l => readme.includes("**" + l + "**")));
  ok("…says inventory is always on, and no longer lists feature switches as to-do", /always on/.test(readme.split("\n## Feature switches\n")[1].split("\n## ")[0]) && !/Feature switches;/.test(readme));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  process.exit(0);
})().catch(e => { console.error("test106 crashed:", e); console.log("test106 crashed: false"); process.exit(1); });
