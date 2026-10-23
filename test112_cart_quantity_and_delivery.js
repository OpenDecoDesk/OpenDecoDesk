const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// What a storefront order can and can't decide for itself about its own shipping and tax:
//   * A line's quantity is read ONE way (lineQty in db.js) by the rate quote and by the order, so a
//     rate weighed for 1 item can't be signed for, or accepted on, an order for 50.
//   * "Shipping — quote to follow" is the server's call (no box fits the cart), not the request's;
//     such an order is marked "Quote pending" and can't be paid by card until the shop sets shipping.
//   * A ship-to address belongs to an order shipped by carrier. Pickup and the shop's own delivery
//     options have none, so an address sent along with them is not kept — and can't drop the tax.
//   * The Stripe events the webhook acts on are the ones the installer and the setup guide name.
// Real SQL (sql.js) + the real db.js, quoteToken.js, boxSize.js, shipping.js, orders.js, checkout.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const quoteSrc = strip(read("functions/_lib/quoteToken.js"));
const lib = new Function(dbSrc + "\nreturn { lineQty, QTY_MESSAGE, MAX_LINE_QTY, SHIPPING_QUOTE_PENDING, getOrderById, getOrgById, createProduct, setSalesTaxSettings, getOrderCheckoutState };")();
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
const SUBS = { shipper: "shipper" };
const STUBS = "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const getCatalogData = async () => ({ subdomainMap: " + JSON.stringify(SUBS) + ", orgs: {} });\n";
const orders = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + quoteSrc + "\n" + STUBS +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const invalidateCatalogVersionCache = () => {};\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost, signQuote, verifyQuote, canonicalItems };")(selectBox);
const shipping = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + quoteSrc + "\n" + STUBS + dbSrc + "\n" + strip(read("functions/api/shipping.js")) + "\nreturn onRequestPost;")(selectBox);
const checkout = new Function(hostSrc + "\n" + httpSrc + "\n" + STUBS + dbSrc + "\n" + strip(read("functions/api/checkout.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('shipper','shipper','Shipper','t','t',1,1);`);
  await lib.createProduct(d1, "shipper", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, weightOz: 6 });
  // A product no box is sized for: its shipping has to be quoted by hand.
  await lib.createProduct(d1, "shipper", { productId: "banner", type: "banner", name: "Banner", pricingMode: "flat", flatPrice: 80, visible: true, weightOz: 60 });
  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });
  const env = { DB: d1, SIGNING_SECRET: "s".repeat(40), SHIPPO_API_KEY: "shippo_test_x", STRIPE_SECRET_KEY: "sk_test_x", ...MAIL_ENV };

  let emails = [], shippo = [], stripe = [];
  global.fetch = async (url, init) => {
    if (captureMail(url, init, emails)) return MAIL_OK;
    if (String(url).includes("api.goshippo.com")) { shippo.push(JSON.parse(init.body)); return { json: async () => ({ rates: [{ amount: "9.00", provider: "USPS", servicelevel: { name: "Ground" } }] }) }; }
    if (String(url).includes("api.stripe.com")) { stripe.push(Object.fromEntries(new URLSearchParams(init.body))); return { json: async () => ({ url: "https://checkout.stripe.test/s" }) }; }
    throw new Error("unexpected fetch " + url);
  };
  const reqOf = (host, path, body) => ({ url: `https://${host}.example.com/api/${path}`, json: async () => body, headers: { get: () => null } });
  const run = async (handler, host, path, body) => {
    const res = await handler({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: reqOf(host, path, body) });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const settle = () => new Promise(res => setTimeout(res, 20));
  const admin = (body) => run(orders.post, "admin", "orders", Object.assign({ key: "x" }, body));
  const quote = (items, zip = "43004") => run(shipping, "shipper", "shipping", { zip, items });
  const place = (orderId, items, extra) => run(orders.post, "shipper", "orders", Object.assign({ orderId, orgId: "shipper", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items }, extra));
  const { orderTokenFor } = require("./testlib/order-token");
  const pay = async (orderId) => run(checkout, "shipper", "checkout", { orderId, orgId: "shipper", checkoutToken: await orderTokenFor(env, orderId) });
  const saved = (orderId) => lib.getOrderById(d1, orderId);
  const ohio = { name: "Pat", line1: "1 Main St", city: "Columbus", state: "OH", zip: "43004" };
  const indiana = { name: "Pat", line1: "1 Main St", city: "Indianapolis", state: "IN", zip: "46201" };
  let r = await admin({ action: "updateShipFromAddress", shipFrom: { name: "Shipper", street1: "1 High St", city: "Columbus", state: "OH", zip: "43004", phone: "6145550100" } });
  ok("setup: the shop has a ship-from address", r.status === 200);

  console.log("=== One reading of a quantity ===");
  const Q = lib.lineQty;
  ok("a whole number from 1 to 50 is a quantity; a line with none counts as 1", Q(1) === 1 && Q(50) === 50 && Q(undefined) === 1 && Q(null) === 1 && lib.MAX_LINE_QTY === 50);
  ok("nothing else is: a string, a fraction, zero, a negative, too many, NaN, a list",
    [ "50", "1", 1.9, 0, -1, 51, NaN, Infinity, [2], {}, true, "" ].every(v => Q(v) === null));

  console.log("\n=== The rate quote ===");
  for (const [what, qty] of [["a string", "50"], ["a fraction", 1.9], ["zero", 0], ["more than 50", 51]]) {
    shippo = [];
    r = await quote([{ productId: "tee", qty }]);
    ok(`a quantity that is ${what} is refused, and the carrier isn't asked`, r.status === 400 && r.body.message === lib.QTY_MESSAGE && shippo.length === 0);
  }
  shippo = [];
  r = await quote([{ productId: "tee", qty: 3 }]);
  const rate = r.body.rates && r.body.rates[0];
  const signed = rate && await orders.verifyQuote(env, rate.quoteToken);
  ok("3 tees: the parcel is weighed for 3 (3 × 6 oz, from the catalog)", r.status === 200 && shippo.length === 1 && shippo[0].parcels[0].weight === String(r.body.shipment.weightOz) && r.body.shipment.weightOz >= 18 && r.body.shipment.weightOz < 24);
  const K = orders.canonicalItems;
  ok("…and the quote is signed for 3", !!signed && signed.ok && signed.items === '[["tee",3]]' && signed.items === K([{ productId: "tee", qty: 3 }]));
  ok("lines of the same product add up, in any order", K([{ productId: "tee" }, { productId: "cap", qty: 4 }, { productId: "tee", qty: 2 }]) === '[["cap",4],["tee",3]]');
  ok("the signed cart never rounds: a cart with a fraction or a string for a quantity has no key at all",
    K([{ productId: "tee", qty: 1.9 }]) === null && K([{ productId: "tee", qty: "50" }]) === null && K([{ productId: "tee", qty: "x" }, { productId: "tee", qty: 2 }]) === null && K([{ productId: "tee", qty: 0 }]) === null);
  ok("…and neither does it get a box", selectBox([{ type: "shirt", qty: 1.5 }]) === null && selectBox([{ type: "shirt", qty: "50" }]) === null && !!selectBox([{ type: "shirt", qty: 2 }]) && !!selectBox([{ type: "shirt" }]));
  ok("a product named like a built-in is just a product id", K([{ productId: "constructor", qty: 2 }, { productId: "toString" }]) === '[["constructor",2],["toString",1]]');
  ok("no product id can read as two products (\"tee:50,cap\" × 1 is not 50 tees and a cap)", K([{ productId: "tee:50,cap", qty: 1 }]) !== K([{ productId: "tee", qty: 50 }, { productId: "cap", qty: 1 }]) &&
    K([{ productId: '"],["tee",50', qty: 1 }]) !== K([{ productId: "tee", qty: 50 }]));
  shippo = [];
  r = await quote([{ productId: "tee:50,cap", qty: 1, weightOz: 0.01, type: "shirt" }]);
  ok("a line the catalog doesn't have isn't quoted on the request's own weight and type — it isn't quoted at all", r.status === 400 && /no longer available/.test(r.body.message) && shippo.length === 0);
  r = await quote([{ productId: 7, qty: 1 }]);
  ok("…nor is a product id that isn't a string", r.status === 400 && shippo.length === 0);
  shippo = [];
  r = await quote([{ productId: "tee", qty: 2, weightOz: 0.01, type: "cap", productType: "cap" }]);
  ok("for a product it does have, the request's weight and type are ignored (2 tees weigh 12 oz)", r.status === 200 && shippo.length === 1 && r.body.shipment.weightOz >= 12 && r.body.shipment.weightOz < 18);
  shippo = [];
  r = await quote([{ productId: "banner", qty: 1, weightOz: 0.01, type: "shirt", productType: "shirt" }]);
  ok("…so a product no box fits can't be passed off as a shirt", r.status === 200 && r.body.manualShipping === true && shippo.length === 0);
  r = await quote(Array.from({ length: 21 }, () => ({ productId: "tee", qty: 1 })));
  ok("a cart longer than an order may be (20 lines) isn't quoted either", r.status === 400);

  console.log("\n=== The order ===");
  for (const [what, qty] of [["a string", "3"], ["a fraction", 2.5], ["zero", 0], ["more than 50", 51]]) {
    r = await place("Q-BAD", [{ productId: "tee", size: "M", qty }], { shippingAddress: ohio, shippingQuoteToken: rate.quoteToken });
    ok(`a quantity that is ${what} is refused and nothing is saved`, r.status === 400 && r.body.message === lib.QTY_MESSAGE && !(await saved("Q-BAD")));
  }
  r = await place("Q-MORE", [{ productId: "tee", size: "M", qty: 5 }], { shippingAddress: ohio, shippingQuoteToken: rate.quoteToken });
  ok("the quote for 3 isn't accepted on an order for 5", r.status === 400 && /cart changed/.test(r.body.message) && !(await saved("Q-MORE")));
  r = await place("Q-OK", [{ productId: "tee", size: "M", qty: 3 }], { shippingAddress: ohio, shippingQuoteToken: rate.quoteToken });
  let o = await saved("Q-OK");
  ok("…and is on the order for 3, at the quoted amount", r.status === 200 && !!o && o.items[0].qty === 3 && o.shippingCost === rate.amount && o.shippingAddress.state === "OH");
  r = await place("Q-NUM", [{ productId: 7, size: "M", qty: 1 }], {});
  ok("a product id that isn't a string is refused", r.status === 400 && r.body.message === "Invalid items" && !(await saved("Q-NUM")));
  const oddQuote = await orders.signQuote(env, { orgId: "shipper", zip: "00100", items: K([{ productId: "tee", qty: 1 }]), amountCents: 900, method: "USPS Ground" });
  r = await place("Q-ODDZIP", [{ productId: "tee", size: "M", qty: 1 }], { shippingAddress: { ...indiana, zip: "00100" }, shippingQuoteToken: oddQuote });
  ok("a quote for a ZIP no state owns can't carry an address that names a state of its choosing", r.status === 400 && /valid ZIP/.test(r.body.message) && !(await saved("Q-ODDZIP")));
  ok("the storefront stops at 50 a line and 20 lines too (said on the product's card)", /if\(qty > 50\)\{ cardMsg_\(/.test(read("public/index.html")) && /if\(cart\.length >= 20\)\{ cardMsg_\(/.test(read("public/index.html")));

  console.log("\n=== Shipping, quote to follow ===");
  r = await quote([{ productId: "banner", qty: 1 }]);
  ok("a cart no box fits gets no rate, only the note that a quote will follow", r.status === 200 && r.body.manualShipping === true && r.body.rates.length === 0);
  r = await place("M-FITS", [{ productId: "tee", size: "M", qty: 2 }], { shippingAddress: ohio, manualShipping: true });
  ok("a cart that fits a box can't be placed that way — it has a rate, and must take one", r.status === 400 && /can be quoted now/.test(r.body.message) && !(await saved("M-FITS")));
  r = await place("M-NOZIP", [{ productId: "banner", qty: 1 }], { shippingAddress: { name: "Pat", line1: "1 Main St", city: "Indianapolis", state: "IN" }, manualShipping: true });
  ok("it needs an address with a ZIP…", r.status === 400 && /valid ZIP/.test(r.body.message) && !(await saved("M-NOZIP")));
  r = await place("M-ODDZIP", [{ productId: "banner", qty: 1 }], { shippingAddress: { ...indiana, zip: "00100" }, manualShipping: true });
  ok("…one that is a real place", r.status === 400 && /valid ZIP/.test(r.body.message) && !(await saved("M-ODDZIP")));
  r = await place("M-ZIPONLY", [{ productId: "banner", qty: 1 }], { shippingAddress: { zip: "46201" }, manualShipping: true });
  ok("…and a street and city to ship to, not a ZIP alone", r.status === 400 && /full shipping address/.test(r.body.message) && !(await saved("M-ZIPONLY")));
  emails = [];
  r = await place("M-OK", [{ productId: "banner", qty: 1 }], { shippingAddress: ohio, manualShipping: true });
  await settle();
  o = await saved("M-OK");
  ok("a cart no box fits is placed, marked \"Quote pending\", with its address and no shipping yet",
    r.status === 200 && !!o && o.shippingMethod === lib.SHIPPING_QUOTE_PENDING && o.shippingCost === 0 && o.shippingAddress.zip === "43004");
  ok("the customer's email says the shipping quote is still to come", emails.length === 1 && /Shipping quote pending/.test(emails[0].htmlBody));
  stripe = [];
  r = await pay("M-OK");
  ok("it can't be paid by card yet (the items alone would read Paid)", r.status === 409 && /hasn't been quoted/.test(r.body.message) && stripe.length === 0 && (await lib.getOrderCheckoutState(d1, "M-OK")).shippingPending === true);
  r = await admin({ action: "setShippingInfo", org: "shipper", orderId: "M-OK", shippingAddress: ohio, shippingCost: 24, shippingMethod: "UPS Ground" });
  const c = await pay("M-OK");
  ok("once the shop sets the shipping, card checkout opens for items + shipping + tax ($80 + $24 + $4.80)",
    r.status === 200 && c.status === 200 && !!c.body.url && stripe.length === 1 && (await lib.getOrderCheckoutState(d1, "M-OK")).total === 108.8);

  // Shipping waived: saving Edit shipping at $0 is still the shop's answer, so the note goes and the order can be paid.
  await place("M-FREE", [{ productId: "banner", qty: 1 }], { shippingAddress: ohio, manualShipping: true });
  r = await admin({ action: "setShippingInfo", org: "shipper", orderId: "M-FREE", shippingAddress: ohio, shippingCost: 0, shippingMethod: lib.SHIPPING_QUOTE_PENDING });
  o = await saved("M-FREE");
  ok("the shop can settle it at no charge: the note is gone and card checkout opens", r.status === 200 && o.shippingMethod === "" && o.shippingCost === 0 && (await pay("M-FREE")).status === 200);
  ok("\"Quote pending\" is never printed as a carrier for the customer (shipped email, shipping payment link)",
    (read("functions/api/orders.js").match(/shownMethod_\(/g) || []).length >= 5 && !/carrier: \(label && label\.carrier\) \|\| o\.shippingMethod/.test(read("functions/api/orders.js")));

  console.log("\n=== Whose address decides the tax ===");
  r = await admin({ action: "updateOrg", orgId: "shipper", subdomain: "shipper", name: "Shipper", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "shipping" }, { type: "custom", label: "Hand delivery", fee: 5 }] });
  const handId = ((await lib.getOrgById(d1, "shipper")).deliveryOptions.find(x => x.type === "custom") || {}).id;
  const tees = [{ productId: "tee", size: "M", qty: 1 }];
  r = await place("T-PICKUP", tees, {});
  o = await saved("T-PICKUP");
  ok("pickup: taxed at home — $20 + $1.20", r.status === 200 && o.salesTax === 1.2 && r.body.total === 21.2);
  r = await place("T-CLAIM", tees, { shippingAddress: indiana });
  o = await saved("T-CLAIM");
  ok("pickup sent with another state's address: the address isn't kept, the tax is", r.status === 200 && !o.shippingAddress && o.salesTax === 1.2 && r.body.total === 21.2);
  r = await place("T-STATE", tees, { shippingAddress: { state: "IN" } });
  ok("…nor does a bare \"state\" do anything", r.status === 200 && !(await saved("T-STATE")).shippingAddress && r.body.salesTax === 1.2);
  r = await place("T-HAND", tees, { shippingAddress: indiana, deliveryOptionId: handId });
  o = await saved("T-HAND");
  ok("the shop's own delivery option: its fee, no address, taxed — $20 + $5 + $1.20", r.status === 200 && !!handId && !o.shippingAddress && o.shippingMethod === "Hand delivery" && o.shippingCost === 5 && r.body.total === 26.2);
  const inQuote = await orders.signQuote(env, { orgId: "shipper", zip: "46201", items: orders.canonicalItems(tees), amountCents: 900, method: "USPS Ground" });
  r = await place("T-SHIPPED", tees, { shippingAddress: indiana, shippingQuoteToken: inQuote });
  o = await saved("T-SHIPPED");
  ok("shipped by carrier to another state: the address is kept and there is no tax — $20 + $9", r.status === 200 && o.shippingAddress.state === "IN" && o.salesTax === 0 && r.body.total === 29);
  r = await place("T-MISMATCH", tees, { shippingAddress: ohio, shippingQuoteToken: inQuote });
  ok("…and that quote is for its own ZIP only", r.status === 400 && /ZIP doesn't match/.test(r.body.message));

  console.log("\n=== Stripe events ===");
  const hook = read("functions/api/stripe-webhook.js");
  const handled = [...hook.matchAll(/event\.type === "([a-z_.]+)"/g)].map(m => m[1]);
  const listed = (/STRIPE_WEBHOOK_EVENTS = \[([\s\S]*?)\]/.exec(read("scripts/setup.mjs")) || [])[1] || "";
  const guide = read("docs/setup.md");
  ok("a chargeback is handled under Stripe's own event names", handled.includes("charge.dispute.created") && handled.includes("charge.dispute.closed"));
  ok("no code, installer or guide still uses the names Stripe never sends", ![hook, listed, guide, read("functions/api/checkout.js")].some(s => /customer\.dispute/.test(s)));
  ok("every event the webhook acts on is one the installer tells you to subscribe to", handled.length >= 6 && handled.every(t => listed.includes('"' + t + '"')));
  ok("…and one the setup guide lists", handled.every(t => guide.includes("`" + t + "`")));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("test112 crashed:", false); console.error(e); process.exit(1); });
