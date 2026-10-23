const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
// jsdom can't navigate; "Pay by card" ends by sending the browser to Stripe. Keep that one notice quiet.
const quiet = () => { const vc = new VirtualConsole(); vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); }); return vc; };

// Invoices (migrations/0058): the admin emails a customer a link to a page where they see what's
// owed, choose how they'll get the order, and pay. Real SQL (sql.js), the real orders.js action that
// sends it, the real public endpoint (functions/api/invoice.js), the real checkout endpoint, the real
// email — and the real customer page and admin screens in jsdom.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");

const mail = [], stripe = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  if (String(url).startsWith("https://api.stripe.com/")) { const p = new URLSearchParams(init.body); stripe.push(p); return { json: async () => ({ url: "https://checkout.stripe.test/session" }) }; }
  throw new Error("unexpected fetch " + url);
};

// One scope holding the shared libraries, with each endpoint in its own inner scope (they each
// declare onRequestPost).
const M = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club', guild: 'guild' }, orgs: {}, features: globalThis.__features || {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const getCatalogData_ = getCatalogData;\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const invoiceApi = (function(){\n" + strip(read("functions/api/invoice.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "const checkoutApi = (function(){\n" + strip(read("functions/api/checkout.js")) + "\nreturn onRequestPost; })();\n" +
  "return { ordersApi, invoiceApi, checkoutApi, signQuote, canonicalItems, insertOrder, getOrderById, createProduct, updateOrg, setOrgDeliveryOptions, getOrderInvoiceByOrder, " +
  "getUnsentOwnerNotices, settleOrderBalance, setFulfillmentStage, cleanDeliveryOptions, INVOICE_LINK_TTL_DAYS, setSalesTaxSettings, setFeatures };")();
const tick = (ms) => new Promise(res => setTimeout(res, ms || 60));
const { orderTokenFor } = require("./testlib/order-token");
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rarr;/g, "→").replace(/\s+/g, " ");

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, STRIPE_SECRET_KEY: "sk_test_x", SIGNING_SECRET: "test-signing-secret", ...MAIL_ENV };
  await M.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "CO" });
  const ctx = (request) => ({ env, request, waitUntil: (p) => p.then(() => {}, () => {}) });
  const admin = async (body) => { const res = await M.ordersApi(ctx({ url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } }));
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const invGet = async (token) => { const res = await M.invoiceApi.onRequestGet(ctx({ url: "https://club.example.com/api/invoice?token=" + encodeURIComponent(token), headers: { get: () => "203.0.113.9" } }));
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const invPost = async (body) => { const res = await M.invoiceApi.onRequestPost(ctx({ url: "https://club.example.com/api/invoice", json: async () => body, headers: { get: () => "203.0.113.9" } }));
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const checkout = async (body, host = "club") => { const res = await M.checkoutApi(ctx({ url: `https://${host}.example.com/api/checkout`, json: async () => body, headers: { get: () => null } }));
    return { status: res.status, body: JSON.parse(await res.text()) }; };

  // A shop that offers pickup, its own hand-delivery option and shipping; and one that only does pickup.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','#1E7A4C','t','t',1), ('guild','guild','Guild','#333333','t','t',1);`);
  // (cleaned first, as the shop form's save does — that's what gives the custom option its lasting id)
  await M.setOrgDeliveryOptions(d1, "club", M.cleanDeliveryOptions([{ type: "pickup" }, { type: "custom", label: "Club meeting delivery", fee: 5 }, { type: "shipping" }]).options);
  await M.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { M: 25 }, weightOz: 9, visible: true });
  await M.createProduct(d1, "guild", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 18, visible: true });
  const clubOpts = d1.q("SELECT deliveryOptionsJson j FROM orgs WHERE orgId='club'")[0].j;
  const customId = JSON.parse(clubOpts).find(o => o.type === "custom").id;

  let n = 0;
  const sale = async (org = "club", item = { productId: "polo", name: "Polo", type: "shirt", size: "M", qty: 2 }, extra = {}) => {
    const r = await admin(Object.assign({ action: "createLocalSale", org, items: [item], paymentMethod: "Invoice", customerName: "Sam Carter", contact: "sam" + (++n) + "@example.com" }, extra));
    return r.body.orderId;
  };

  console.log("=== Sending an invoice (admin) ===");
  const O1 = await sale();
  mail.length = 0;
  let r = await admin({ action: "sendInvoice", org: "club", orderId: O1, message: "Thanks for the order!" });
  const inv1 = await M.getOrderInvoiceByOrder(d1, O1);
  console.log("it answers with the link, on the shop's own address:", r.status === 200 && r.body.emailSent === true && r.body.url === `https://club.example.com/?invoice=${inv1.token}` && /^[a-z0-9]{32}$/.test(inv1.token));
  console.log("one email goes to the customer, with the link, the note and the amounts:", mail.length === 1 && mail[0].to === "sam1@example.com" && /Invoice for your order/.test(mail[0].subject)
    && mail[0].htmlBody.includes(r.body.url) && /Thanks for the order!/.test(plain(mail[0].htmlBody)) && /Polo .*Subtotal \$50\.00 .*Total \$50\.00/.test(plain(mail[0].htmlBody)) && mail[0].body.includes(r.body.url));
  console.log("the order now carries when its invoice went out:", !!r.body.invoice.sentAt && (await M.getOrderById(d1, O1)).invoice.sentTo === "sam1@example.com");
  console.log("sending is audited:", d1.q("SELECT count(*) n FROM audit_log WHERE action='order.invoice_sent' AND orderId=?", O1)[0].n === 1);
  mail.length = 0;
  r = await admin({ action: "sendInvoice", org: "club", orderId: O1, email: "sam.new@example.com" });
  const inv1b = await M.getOrderInvoiceByOrder(d1, O1);
  console.log("sending again keeps the same link (the first email still works) and counts the send:", inv1b.token === inv1.token && inv1b.sendCount === 2 && r.body.url.endsWith(inv1.token));
  console.log("a different address typed in the window is used, and becomes the order's contact:", mail[0].to === "sam.new@example.com" && (await M.getOrderById(d1, O1)).contact === "sam.new@example.com");
  const noEmail = await sale("club", undefined, { contact: "" });
  r = await admin({ action: "sendInvoice", org: "club", orderId: noEmail });
  console.log("an order with no email needs one typed in:", r.status === 400 && /email address/.test(r.body.message));
  r = await admin({ action: "sendInvoice", org: "club", orderId: noEmail, email: "not-an-email" });
  console.log("a bad address is refused:", r.status === 400);
  const paidSale = await sale("club", undefined, { paid: true });
  r = await admin({ action: "sendInvoice", org: "club", orderId: paidSale });
  console.log("an order that's already paid in full can't be invoiced:", r.status === 400 && /already paid/.test(r.body.message));
  r = await admin({ action: "sendInvoice", org: "guild", orderId: O1 });
  console.log("the order must belong to the shop named:", r.status === 404);
  r = await admin({ action: "sendInvoice", org: "club", orderId: "NOPE-1" });
  console.log("an unknown order is refused:", r.status === 404);
  // The email can fail (here: not configured) — the invoice still exists and the link comes back.
  const O2 = await sale();
  const envNoMail = { DB: d1, STRIPE_SECRET_KEY: "sk_test_x", SIGNING_SECRET: "test-signing-secret" };
  const res2 = await M.ordersApi({ env: envNoMail, waitUntil: (p) => p.then(() => {}, () => {}), request: { url: "https://admin.example.com/api/orders", json: async () => ({ key: "x", action: "sendInvoice", org: "club", orderId: O2 }), headers: { get: () => null } } });
  const b2 = JSON.parse(await res2.text());
  console.log("if the email can't be sent, the invoice is still made and the link is returned to pass on:", b2.status === "ok" && b2.emailSent === false && /\?invoice=[a-z0-9]{32}$/.test(b2.url));
  const T2 = (await M.getOrderInvoiceByOrder(d1, O2)).token;

  console.log("\n=== The customer's invoice (public endpoint) ===");
  r = await invGet("nope");
  console.log("a made-up token shows nothing:", r.status === 404);
  r = await invGet("a".repeat(32));
  console.log("...nor a well-formed one that doesn't exist:", r.status === 404 && !/order/i.test(JSON.stringify(r.body).replace(/invoice link/, "")));
  r = await invGet(T2);
  let v = r.body.invoice;
  console.log("the real token shows the order: lines, totals and what's owed:", r.status === 200 && v.orderId === O2 && v.orgName === "Example Club" && v.items.length === 1 && v.items[0].name === "Polo" && v.items[0].size === "M"
    && v.items[0].qty === 2 && v.subtotal === 50 && v.total === 50 && v.balanceDue === 50 && v.paid === false && v.salesTax > 0);
  console.log("it lists this shop's delivery options and the ways to pay:", v.delivery.options.map(o => o.type).join() === "pickup,custom,shipping" && v.delivery.options[1].fee === 5
    && v.delivery.chosen === false && v.delivery.locked === "" && v.delivery.quotable === true && v.payments.join() === "Card,Venmo,Zelle,Check");
  console.log("it gives away nothing else — no email address, no other orders, no internal ids:", !/example\.com|contact|payments"\s*:\s*\[\s*\{|sheetRow/.test(JSON.stringify(v)));
  console.log("opening it is recorded once:", !!(await M.getOrderInvoiceByOrder(d1, O2)).viewedAt);

  console.log("\n=== Choosing delivery ===");
  r = await invPost({ token: T2, action: "setDelivery", deliveryOptionId: customId, shippingCost: 0.01, fee: 0 });
  v = r.body.invoice;
  let o = await M.getOrderById(d1, O2);
  console.log("the shop's own option brings ITS fee and name (nothing from the request):", r.status === 200 && o.shippingCost === 5 && o.shippingMethod === "Club meeting delivery" && !o.shippingAddress
    && v.total === 55 && v.balanceDue === 55 && v.delivery.chosen === true && v.delivery.current.label === "Club meeting delivery" && v.delivery.current.fee === 5);
  await tick(30);
  const notices = (await M.getUnsentOwnerNotices(d1)).filter(x => x.kind === "invoice" && x.orderId === O2);
  console.log("the owner hears about it in the next roll-up:", notices.length === 1 && /Sam Carter chose Club meeting delivery — \$5\.00 on their invoice/.test(notices[0].summary));
  const aud = d1.q("SELECT actor, ip, detail FROM audit_log WHERE action='order.invoice_delivery_chosen' AND orderId=?", O2)[0];
  console.log("the change is audited as the customer's, with where it came from:", !!aud && aud.actor === "customer-invoice" && aud.ip === "203.0.113.9" && /option:/.test(aud.detail));
  r = await invPost({ token: T2, action: "setDelivery", deliveryOptionId: "pickup" });
  o = await M.getOrderById(d1, O2);
  console.log("changing to local pickup takes the fee off again:", r.status === 200 && o.shippingCost === 0 && o.shippingMethod === "" && r.body.invoice.total === 50 && r.body.invoice.delivery.current.kind === "pickup");
  r = await invPost({ token: T2, action: "setDelivery", deliveryOptionId: "c-not-real" });
  console.log("an option that isn't in the shop's list is refused:", r.status === 400 && /no longer offered/.test(r.body.message));
  r = await invPost({ token: T2, action: "setDelivery" });
  console.log("...and so is no choice at all:", r.status === 400);
  r = await invPost({ token: T2, action: "somethingElse" });
  console.log("only setDelivery is accepted:", r.status === 400 && /Unknown action/.test(r.body.message));

  console.log("\n=== Shipping: only a signed carrier rate for this shop, these items and this ZIP ===");
  const items2 = [{ productId: "polo", qty: 2 }];
  const quote = (over = {}) => M.signQuote(env, Object.assign({ orgId: "club", zip: "80202", items: M.canonicalItems(items2), amountCents: 842, method: "USPS Ground Advantage" }, over));
  const homeAddr = { name: "Sam Carter", line1: "1 Main St", city: "Denver", state: "CO", zip: "80202" };
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: await quote(), shippingAddress: homeAddr });
  v = r.body.invoice; o = await M.getOrderById(d1, O2);
  console.log("a good quote sets the carrier, cost, address and weight on the order:", r.status === 200 && o.shippingCost === 8.42 && o.shippingMethod === "USPS Ground Advantage" && o.shippingAddress.zip === "80202"
    && o.shippingAddress.line1 === "1 Main St" && o.totalWeightOz === 18 && v.total === 58.42 && v.delivery.current.kind === "shipping" && v.delivery.address.city === "Denver");
  console.log("a Colorado address keeps the sales tax:", o.salesTax > 0);
  const ohAddr = { name: "Sam Carter", line1: "9 High St", city: "Toledo", state: "OH", zip: "43604" };
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: await quote({ zip: "43604" }), shippingAddress: ohAddr });
  o = await M.getOrderById(d1, O2);
  console.log("shipping out of state takes the Colorado sales tax off the order:", r.status === 200 && o.salesTax === 0 && r.body.invoice.salesTax === 0);
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: await quote(), shippingAddress: ohAddr });
  console.log("a rate quoted for another ZIP is refused:", r.status === 400 && /ZIP doesn't match/.test(r.body.message));
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: await quote({ items: M.canonicalItems([{ productId: "polo", qty: 1 }]) }), shippingAddress: homeAddr });
  console.log("a rate quoted for fewer items is refused:", r.status === 400 && /changed since shipping was quoted/.test(r.body.message));
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: await quote({ orgId: "guild" }), shippingAddress: homeAddr });
  console.log("a rate signed for another shop is refused:", r.status === 400);
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: (await quote()).replace(/.$/, (c) => c === "0" ? "1" : "0"), shippingAddress: homeAddr });
  console.log("a tampered quote is refused:", r.status === 400);
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: await quote(), shippingAddress: { name: "Sam", zip: "80202" } });
  console.log("shipping needs a full address:", r.status === 400 && /full address/.test(r.body.message));
  r = await invPost({ token: T2, action: "setDelivery", quoteToken: await quote(), shippingAddress: Object.assign({}, homeAddr, { state: "OH" }) });
  console.log("a Colorado ZIP with another state is refused (it would drop the tax):", r.status === 400 && /80202 is in CO, but the state says OH/.test(r.body.message));
  r = await invPost({ token: T2, action: "setDelivery", manualShipping: true, shippingAddress: homeAddr });
  console.log("'cost to follow' is refused for an order a box fits — it has a carrier rate (the server's call, as on the storefront):",
    r.status === 400 && /can be quoted now/.test(r.body.message) && (await M.getOrderById(d1, O2)).shippingCost === 8.42);
  // A shop that only offers local pickup has nothing to choose, and can't be shipped to.
  const G1 = await sale("guild", { productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1 });
  await admin({ action: "sendInvoice", org: "guild", orderId: G1 });
  const TG = (await M.getOrderInvoiceByOrder(d1, G1)).token;
  r = await invGet(TG);
  console.log("a pickup-only shop offers no delivery choice:", r.body.invoice.delivery.options.length === 0);
  r = await invPost({ token: TG, action: "setDelivery", manualShipping: true, shippingAddress: homeAddr });
  console.log("...and refuses shipping:", r.status === 400 && /doesn't offer shipping/.test(r.body.message));
  // An order with a line that isn't a listed product can't be quoted from catalog weights.
  const C1 = await sale("club", { productId: "__custom__", name: "Custom banner", type: "custom", size: "", qty: 1, customUnitPrice: 40 });
  await admin({ action: "sendInvoice", org: "club", orderId: C1 });
  r = await invGet((await M.getOrderInvoiceByOrder(d1, C1)).token);
  console.log("an order with a custom line offers shipping only as 'cost to follow':", r.body.invoice.delivery.quotable === false && r.body.invoice.delivery.options.some(x => x.type === "shipping"));
  r = await invPost({ token: (await M.getOrderInvoiceByOrder(d1, C1)).token, action: "setDelivery", manualShipping: true, shippingAddress: homeAddr });
  v = r.body.invoice; o = await M.getOrderById(d1, C1);
  console.log("'ship it — cost to follow' saves the address with no charge yet:", r.status === 200 && o.shippingCost === 0 && o.shippingAddress.zip === "80202" && v.delivery.current.kind === "shipping-quote" && v.delivery.current.fee === null && v.total === 40);

  console.log("\n=== When delivery can no longer be changed ===");
  const L1 = await sale();
  await admin({ action: "sendInvoice", org: "club", orderId: L1, allowDelivery: false });
  const TL1 = (await M.getOrderInvoiceByOrder(d1, L1)).token;
  r = await invGet(TL1);
  console.log("the admin can send an invoice with the delivery method fixed:", r.body.invoice.delivery.locked === "fixed");
  r = await invPost({ token: TL1, action: "setDelivery", deliveryOptionId: customId });
  console.log("...and the endpoint refuses a change (409):", r.status === 409 && (await M.getOrderById(d1, L1)).shippingCost === 0);
  const L2 = await sale();
  await admin({ action: "sendInvoice", org: "club", orderId: L2 });
  const TL2 = (await M.getOrderInvoiceByOrder(d1, L2)).token;
  d1._raw.run("UPDATE orders SET shippedAt='2026-10-10T00:00:00Z' WHERE orderId=?", [L2]);
  r = await invPost({ token: TL2, action: "setDelivery", deliveryOptionId: customId });
  console.log("not once the order has shipped:", r.status === 409 && /already shipped/.test(r.body.message));
  d1._raw.run("UPDATE orders SET shippedAt=NULL WHERE orderId=?", [L2]);
  await M.settleOrderBalance(d1, L2, "test");
  r = await invGet(TL2);
  console.log("a paid invoice shows as paid, with nothing left to pay:", r.body.invoice.paid === true && r.body.invoice.balanceDue === 0 && r.body.invoice.delivery.locked === "paid");
  r = await invPost({ token: TL2, action: "setDelivery", deliveryOptionId: customId });
  console.log("...and its delivery can't be changed online any more:", r.status === 409 && /already paid/.test(r.body.message));
  const L3 = await sale("club", undefined, { placedAt: "2026-08-15" });
  await admin({ action: "sendInvoice", org: "club", orderId: L3 });
  const TL3 = (await M.getOrderInvoiceByOrder(d1, L3)).token;
  d1._raw.run("INSERT INTO closed_periods (month, closedAt) VALUES ('2026-08', '2026-09-05T00:00:00Z')");
  r = await invPost({ token: TL3, action: "setDelivery", deliveryOptionId: customId });
  console.log("nor on an order in a closed (filed) month:", r.status === 409 && (await M.getOrderById(d1, L3)).shippingCost === 0);
  // Expiry and cancellation.
  const X1 = await sale();
  await admin({ action: "sendInvoice", org: "club", orderId: X1 });
  const TX1 = (await M.getOrderInvoiceByOrder(d1, X1)).token;
  d1._raw.run("UPDATE order_invoices SET sentAt=? WHERE token=?", [new Date(Date.now() - (M.INVOICE_LINK_TTL_DAYS + 1) * 864e5).toISOString(), TX1]);
  r = await invGet(TX1);
  console.log(`the link stops working ${M.INVOICE_LINK_TTL_DAYS} days after it was last sent:`, r.status === 410 && /expired/.test(r.body.message) && (await invPost({ token: TX1, action: "setDelivery", deliveryOptionId: "pickup" })).status === 410);
  await admin({ action: "sendInvoice", org: "club", orderId: X1 });
  console.log("sending it again renews the same link:", (await invGet(TX1)).status === 200);
  d1._raw.run("UPDATE orders SET voidedAt='2026-10-12T00:00:00Z', voidReason='test' WHERE orderId=?", [X1]);
  r = await invGet(TX1);
  console.log("a cancelled order's invoice says so and shows nothing:", r.status === 410 && /cancelled/.test(r.body.message) && !r.body.invoice);
  r = await admin({ action: "sendInvoice", org: "club", orderId: X1 });
  console.log("...and can't be sent again:", r.status === 400 && /voided/.test(r.body.message));

  console.log("\n=== Paying by card comes back to the invoice ===");
  await invPost({ token: T2, action: "setDelivery", deliveryOptionId: customId });
  stripe.length = 0;
  r = await checkout({ orderId: O2, orgId: "club", invoiceToken: T2, total: 0.01 });
  console.log("the charge is the order's balance, with its delivery fee (never an amount from the request):", r.status === 200 && stripe[0].get("line_items[0][price_data][unit_amount]") === "5500");
  console.log("paying returns to the invoice page:", stripe[0].get("success_url") === `https://club.example.com/?invoice=${T2}&paid=1` && stripe[0].get("cancel_url") === `https://club.example.com/?invoice=${T2}`);
  stripe.length = 0;
  await checkout({ orderId: O2, orgId: "club", invoiceToken: "x&next=https://evil.example", checkoutToken: await orderTokenFor(env, O2) });
  console.log("a malformed invoice token is ignored (with the order's own token, the ordinary return address is used):", /\?stripe=success&orderId=/.test(stripe[0].get("success_url")) && !/evil/.test(stripe[0].get("success_url")));
  stripe.length = 0;
  r = await checkout({ orderId: O2, orgId: "club" });
  console.log("an order number alone doesn't open a checkout:", r.status === 403 && stripe.length === 0);
  await checkout({ orderId: O2, orgId: "club", checkoutToken: await orderTokenFor(env, O2) });
  console.log("an ordinary checkout, with the token placing the order returned:", /\?stripe=success&orderId=/.test(stripe[0].get("success_url")));

  console.log("\n=== With the storefront switched off, an invoice can still be paid ===");
  globalThis.__features = { storefront: false };
  stripe.length = 0;
  r = await checkout({ orderId: O2, orgId: "club", invoiceToken: T2 });
  console.log("its token opens the card checkout for its own order:", r.status === 200 && stripe.length === 1);
  r = await checkout({ orderId: O2, orgId: "club" });
  console.log("…without it the storefront's checkout is closed:", r.status === 403 && r.body.feature === "storefront");
  const other = (await M.getOrderInvoiceByOrder(d1, C1)).token;
  r = await checkout({ orderId: O2, orgId: "club", invoiceToken: other });
  console.log("…and another order's invoice token doesn't open it:", r.status === 403);
  console.log("the invoice page itself still answers:", (await invGet(T2)).status === 200);
  globalThis.__features = {};

  console.log("\n=== Sales tax added on top of the prices ===");
  await M.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "CO", taxMode: "exclusive" });
  const E1 = await sale();
  await admin({ action: "sendInvoice", org: "club", orderId: E1 });
  const TE1 = (await M.getOrderInvoiceByOrder(d1, E1)).token;
  v = (await invGet(TE1)).body.invoice;
  console.log("the invoice says the tax is added, and its total is items + tax:", v.taxMode === "exclusive" && v.taxJurisdiction === "CO" && v.subtotal === 50 && v.salesTax === 3 && v.total === 53 && v.balanceDue === 53);
  await M.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "CO", taxMode: "inclusive" });

  // ---- The customer's page, in jsdom, against the real endpoints ---------------------------------
  const P1 = await sale();
  await admin({ action: "sendInvoice", org: "club", orderId: P1, message: "See you at the meeting." });
  const TP = (await M.getOrderInvoiceByOrder(d1, P1)).token;
  const calls = [];
  const page = async (search) => {
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: "usable", url: "https://club.example.com/" + search, pretendToBeVisual: true, virtualConsole: quiet(),
      beforeParse(win){
        win.fetch = async (url, opts) => {
          const u = String(url), body = opts && opts.body ? JSON.parse(opts.body) : null;
          calls.push({ url: u, body });
          const wrap = async (res) => { const text = await res.text(); return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(text) }; };
          if (u.startsWith("/api/invoice?")) return wrap(await M.invoiceApi.onRequestGet(ctx({ url: "https://club.example.com" + u, headers: { get: () => null } })));
          if (u === "/api/invoice") return wrap(await M.invoiceApi.onRequestPost(ctx({ url: "https://club.example.com" + u, json: async () => body, headers: { get: () => null } })));
          if (u === "/api/checkout") return wrap(await M.checkoutApi(ctx({ url: "https://club.example.com" + u, json: async () => body, headers: { get: () => null } })));
          if (u === "/api/shipping") return { ok: true, status: 200, json: async () => ({ status: "ok", manualShipping: false, rates: [
            { provider: "USPS", service: "Ground Advantage", amount: 8.42, estimatedDays: 3,
              quoteToken: await M.signQuote(env, { orgId: "club", zip: body.zip, items: M.canonicalItems(body.items), amountCents: 842, method: "USPS Ground Advantage" }) },
            { provider: "UPS", service: "Ground", amount: 11.1, estimatedDays: 2,
              quoteToken: await M.signQuote(env, { orgId: "club", zip: body.zip, items: M.canonicalItems(body.items), amountCents: 1110, method: "UPS Ground" }) }] }) };
          // /api/catalog etc.: who runs the site (Global settings → Business profile), as the real one sends it.
          return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a", country: "US",
            business: { name: "Sample Embroidery", legalName: "Sample Embroidery LLC", venmo: "sample-shop", zelle: "pay@example.com", mailingAddress: "1 Sample St, Springfield NY 12345" } }) };
        };
      } });
    await tick(250);
    return dom;
  };
  let dom = await page("?invoice=" + TP);
  let w = dom.window, doc = w.document;
  // The page as a reader sees it: every tag is a gap (table cells have no spaces between them in textContent).
  const txt = () => plain(doc.getElementById("app").innerHTML).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const settle = async (pred) => { for (let i = 0; i < 80 && !pred(); i++) await tick(25); };
  console.log("\n=== The invoice page ===");
  console.log("it shows the shop, the order, the shop's note, the lines and the balance:", /Example Club/.test(txt()) && txt().includes(P1) && /See you at the meeting\./.test(txt())
    && /Polo · M/.test(txt()) && /Subtotal \$50\.00/.test(txt()) && /Balance due \$50\.00/.test(txt()) && /Includes sales tax/.test(txt()));
  console.log("the link's token stays in the address, so a reload lands here again:", w.location.search === "?invoice=" + TP);
  console.log("it offers the three ways to get the order:", [...doc.querySelectorAll('input[name="invDelivery"]')].map(x => x.value).join() === `o:pickup,o:${customId},ship`);
  console.log("paying waits for that choice (the total depends on it):", doc.getElementById("invPayCard").disabled === true && /Choose how you'd like to get your order above/.test(txt()));
  console.log("...and no amount to send by Zelle or check is shown yet:", !/Send \$/.test(txt()) && !/payable to/.test(txt()) && !doc.getElementById("invPayVenmo"));
  doc.getElementById("invSaveDelivery").click();
  await tick(60);
  console.log("saving with nothing chosen asks for a choice:", /Choose how you'd like to get your order\./.test(doc.getElementById("invDelErr").textContent));
  const pickRadio = (val) => { const el = [...doc.querySelectorAll('input[name="invDelivery"]')].find(x => x.value === val); el.checked = true; el.dispatchEvent(new w.Event("change")); };
  pickRadio("o:" + customId);
  doc.getElementById("invSaveDelivery").click();
  await settle(() => /Balance due \$55\.00/.test(txt()));
  console.log("choosing the shop's delivery option adds its fee to the total and saves it to the order:", /Club meeting delivery \$5\.00/.test(txt()) && /Total \$55\.00/.test(txt()) && (await M.getOrderById(d1, P1)).shippingMethod === "Club meeting delivery");
  console.log("now the card button is live, for the new amount:", doc.getElementById("invPayCard").disabled === false && /Pay \$55\.00 by card/.test(doc.getElementById("invPayCard").textContent));
  console.log("Venmo, Zelle and check are offered for the same amount, with the order number:", /amount=55\.00/.test(doc.getElementById("invPayVenmo").href) && /Send \$55\.00 to/.test(txt()) && /Sample Embroidery LLC/.test(txt()) && /pay@example\.com/.test(txt()) && /1 Sample St/.test(txt()) && txt().split(P1).length > 3);
  // Shipping: address, rates, pick one.
  pickRadio("ship");
  console.log("choosing shipping opens the address form:", doc.getElementById("invShip").hidden === false);
  doc.getElementById("invRatesBtn").click();
  await tick(60);
  console.log("rates need a ZIP first:", /5-digit ZIP/.test(doc.getElementById("invDelErr").textContent));
  const fill = (id, val) => { doc.getElementById(id).value = val; };
  fill("invAName", "Sam Carter"); fill("invALine1", "1 Main St"); fill("invACity", "Denver"); fill("invAState", "co"); fill("invAZip", "80202");
  doc.getElementById("invRatesBtn").click();
  await settle(() => doc.querySelectorAll('input[name="invRate"]').length === 2);
  console.log("it lists the carrier rates for that ZIP, and keeps what was typed:", doc.querySelectorAll('input[name="invRate"]').length === 2 && /USPS Ground Advantage — \$8\.42/.test(txt()) && doc.getElementById("invALine1").value === "1 Main St");
  const shipCall = calls.filter(c => c.url === "/api/shipping").pop();
  console.log("the rates were asked for this order's own items:", shipCall.body.zip === "80202" && JSON.stringify(shipCall.body.items) === JSON.stringify([{ productId: "polo", qty: 2 }]));
  doc.getElementById("invSaveDelivery").click();
  await tick(60);
  console.log("saving without picking a rate asks for one:", /Choose one of the shipping options/.test(doc.getElementById("invDelErr").textContent));
  const rate = doc.querySelectorAll('input[name="invRate"]')[0]; rate.checked = true; rate.dispatchEvent(new w.Event("change"));
  doc.getElementById("invSaveDelivery").click();
  await settle(() => /Balance due \$58\.42/.test(txt()));
  o = await M.getOrderById(d1, P1);
  console.log("picking a rate saves the carrier, cost and address to the order:", /Shipping \(USPS Ground Advantage\) \$8\.42/.test(txt()) && o.shippingCost === 8.42 && o.shippingAddress.state === "CO" && o.shippingAddress.line1 === "1 Main St");
  // Pay by card.
  stripe.length = 0;
  let went = "";
  const realLocation = w.location;
  doc.getElementById("invPayCard").click();
  await settle(() => stripe.length === 1);
  await tick(60);
  const payCall = calls.filter(c => c.url === "/api/checkout").pop();
  console.log("Pay by card starts a checkout for this order and says to come back here:", payCall.body.orderId === P1 && payCall.body.invoiceToken === TP && stripe[0].get("line_items[0][price_data][unit_amount]") === "5842" && stripe[0].get("success_url").endsWith("?invoice=" + TP + "&paid=1"));
  void went; void realLocation;
  // Back from paying: the webhook hasn't landed yet, then it has.
  dom = await page("?invoice=" + TP + "&paid=1"); w = dom.window; doc = w.document;
  console.log("back from the card page it says the payment is being confirmed, and drops the one-time flag:", /your payment is being confirmed/.test(txt()) && w.location.search === "?invoice=" + TP);
  await M.settleOrderBalance(d1, P1, "card");
  dom = await page("?invoice=" + TP); w = dom.window; doc = w.document;
  console.log("once it's paid the page says so, with nothing left to pay or change:", /Paid in full — thank you!/.test(txt()) && !doc.getElementById("invPayCard") && !doc.getElementById("invSaveDelivery") && !/Balance due/.test(txt()));
  console.log("...and still shows how it's being delivered:", /Shipping \(USPS Ground Advantage\)/.test(txt()) && /1 Main St/.test(txt()));
  dom = await page("?invoice=" + "b".repeat(32)); w = dom.window; doc = w.document;
  console.log("a link that isn't valid says so and shows no order:", /isn't valid/.test(txt()) && !/Balance due/.test(txt()));
  dom = await page("?invoice=" + TL1); w = dom.window; doc = w.document;
  console.log("an invoice sent with delivery fixed has no delivery choice, and can be paid straight away:", !doc.querySelector('input[name="invDelivery"]') && doc.getElementById("invPayCard").disabled === false);
  dom = await page("?invoice=" + TG); w = dom.window; doc = w.document;
  console.log("a pickup-only shop's invoice goes straight to paying:", !doc.querySelector('input[name="invDelivery"]') && doc.getElementById("invPayCard").disabled === false && /Pay \$18\.00 by card/.test(txt()));
  const hostile = await sale("club", { productId: "__custom__", name: "<img src=x onerror=alert(1)>", type: "custom", size: "", qty: 1, customUnitPrice: 5 }, { customerName: "<b>Bold</b>" });
  await admin({ action: "sendInvoice", org: "club", orderId: hostile, message: "<script>alert(2)</script>" });
  dom = await page("?invoice=" + (await M.getOrderInvoiceByOrder(d1, hostile)).token); w = dom.window; doc = w.document;
  const appText = doc.getElementById("app").textContent;
  console.log("names and notes are shown as text, never run as HTML:", !doc.querySelector("#app img") && !doc.querySelector("#app script")
    && appText.includes("<img src=x onerror=alert(1)>") && appText.includes("<script>alert(2)</script>") && appText.includes("<b>Bold</b>"));

  // ---- Admin ------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o2){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o2); } }
  const sentAdmin = [];
  const adom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) { const b = JSON.parse(opts.body); sentAdmin.push(b); const res = await admin(b); return { ok: res.status < 400, status: res.status, json: async () => res.body }; }
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      autoConfirm(win, () => true);
    } });
  const aw = adom.window, adoc = aw.document;
  await tick(150);
  await aw.loadAdminScript();
  aw.eval('adminKey = "x"; adminOrgs = [{ orgId: "club", name: "Example Club" }];');
  aw.console.error = () => {};   // jsdom has no CSS.escape, so redrawing a row that isn't on screen complains; the send itself is what's tested
  console.log("\n=== Admin: Orders ===");
  const A1 = await sale();
  const org = { orgId: "club", name: "Example Club" };
  const fresh = async (id) => M.getOrderById(d1, id);
  let cell = aw.invoiceCell_(org, await fresh(A1));
  console.log("an unpaid order has a 'Send invoice…' button:", /Send invoice…/.test(cell) && !/Invoice sent/.test(cell));
  console.log("a paid order doesn't:", !/invoice/i.test(aw.invoiceCell_(org, await fresh(paidSale))));
  console.log("the button is in every order's action cell:", /Send invoice…/.test(aw.adminActionCell(org, await fresh(A1))));
  aw._ordersCache = { club: [await fresh(A1)] };
  try { aw.showSendInvoiceModal("club", A1); } catch (e) { console.error("showSendInvoiceModal threw:", e); }
  console.log("the window is pre-filled with the customer's email and offers the delivery choice:", adoc.getElementById("siEmail").value === (await fresh(A1)).contact && adoc.getElementById("siDelivery").checked === true);
  adoc.getElementById("siMessage").value = "Thank you!";
  mail.length = 0; sentAdmin.length = 0;
  adoc.getElementById("siSend").click();
  for (let i = 0; i < 80 && adoc.getElementById("siDone").hidden; i++) await tick(25);
  const sentReq = sentAdmin.find(b => b.action === "sendInvoice");
  if (adoc.getElementById("siDone").hidden) console.error("Send invoice window error:", adoc.getElementById("siErr").textContent, JSON.stringify(sentAdmin));
  console.log("Send emails the invoice and shows the link to copy:", sentReq && sentReq.message === "Thank you!" && sentReq.allowDelivery === true && mail.length === 1
    && /\?invoice=[a-z0-9]{32}/.test(adoc.getElementById("siLink").value) && /Sent to/.test(adoc.getElementById("siDone").textContent));
  cell = aw.invoiceCell_(org, await fresh(A1));
  console.log("afterwards the row says when it went out and that it hasn't been opened, and offers Resend:", /Resend invoice…/.test(cell) && /Invoice sent \d+\/\d+ · not opened yet/.test(cell.replace(/<[^>]+>/g, "")));
  await invGet((await M.getOrderInvoiceByOrder(d1, A1)).token);
  await invPost({ token: (await M.getOrderInvoiceByOrder(d1, A1)).token, action: "setDelivery", deliveryOptionId: "pickup" });
  cell = aw.invoiceCell_(org, await fresh(A1)).replace(/<[^>]+>/g, "");
  console.log("...then that the customer opened it and chose delivery:", /· opened · delivery chosen/.test(cell));
  // A tax-on-top invoice: the tax is its own line in the totals, and the lines add up to the total.
  dom = await page("?invoice=" + TE1); w = dom.window; doc = w.document;
  await settle(() => /Balance due/.test(txt()));
  console.log("with tax on top the page shows a Sales tax line in the totals, not 'Includes':", /Subtotal \$50\.00 Sales tax \(6% CO\) \$3\.00 Total \$53\.00/.test(txt()) && !/Includes sales tax/.test(txt()));
  console.log("the local sale form has an 'Email the customer an invoice' box, wired to send one after recording:", /id="lsInvoice"/.test(adminJs) && /sendInvoice: wantsInvoice/.test(adminJs) && /sendInvoice_\(orgId, data\.orderId/.test(adminJs));
})().catch(e => { console.error(e); console.log("test121 ran to the end without crashing: false"); process.exitCode = 1; });
