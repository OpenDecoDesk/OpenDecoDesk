// Orders only from a shop's own address, and a card checkout only for whoever placed the order:
//   * a storefront order sent to the bare domain is refused — the shop comes from the address, never
//     the request (localhost may still name it, for development); rate quotes there aren't signed;
//   * placing an order returns `checkoutToken` (an HMAC over the order id and a 24-hour expiry, with
//     the install's signing secret under its own label), and /api/checkout asks for it — or for the
//     order's own invoice link — before it opens Stripe Checkout, whose page shows the customer's name
//     and email.
// Real SQL (sql.js) + the real db.js, http.js, orders.js, shipping.js, checkout.js.
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const H = new Function(httpSrc + "\nreturn { signOrderToken, verifyOrderToken };")();
const lib = new Function(dbSrc + "\nreturn { createProduct, getOrderById };")();
const STUBS = "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const getCatalogData = async () => ({ subdomainMap: { shop: 'shop' }, orgs: {} });\n";
const quoteSrc = strip(read("functions/_lib/quoteToken.js"));
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
const orders = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + quoteSrc + "\n" + STUBS +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const invalidateCatalogVersionCache = () => {};\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")(selectBox);
const shipping = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + quoteSrc + "\n" + STUBS + dbSrc + "\n" + strip(read("functions/api/shipping.js")) + "\nreturn onRequestPost;")(selectBox);
const checkout = new Function(hostSrc + "\n" + httpSrc + "\n" + STUBS + dbSrc + "\n" + strip(read("functions/api/checkout.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('shop','shop','Shop','t','t',1,1);`);
  await lib.createProduct(d1, "shop", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, weightOz: 6 });
  const env = { DB: d1, SIGNING_SECRET: "s".repeat(40), SHIPPO_API_KEY: "shippo_test_x", STRIPE_SECRET_KEY: "sk_test_x", ...MAIL_ENV };
  const stripe = [];
  global.fetch = async (url, init) => {
    if (captureMail(url, init, [])) return MAIL_OK;
    if (String(url).includes("api.goshippo.com")) return { json: async () => ({ rates: [{ amount: "9.00", provider: "USPS", servicelevel: { name: "Ground" } }] }) };
    if (String(url).includes("api.stripe.com")) { stripe.push(init.body); return { json: async () => ({ url: "https://checkout.stripe.test/s" }) }; }
    throw new Error("unexpected fetch " + url);
  };
  const run = async (handler, url, body) => {
    const res = await handler({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  await run(orders, "https://admin.example.com/api/orders", { key: "x", action: "updateShipFromAddress", shipFrom: { name: "Shop", street1: "1 High St", city: "Columbus", state: "OH", zip: "43004", phone: "6145550100" } });
  const order = (orderId) => ({ orderId, orgId: "shop", customerName: "Pat", contact: "pat@example.com", paymentMethod: "Card", items: [{ productId: "tee", size: "M", qty: 1 }] });

  console.log("=== The token ===");
  const t = await H.signOrderToken(env, "SHOP-1");
  ok("it's an expiry and a MAC, made with the signing secret", /^\d{10}\.[0-9a-f]{64}$/.test(t) && await H.verifyOrderToken(env, "SHOP-1", t));
  ok("it's for one order", !(await H.verifyOrderToken(env, "SHOP-2", t)));
  ok("changing it, or its expiry, breaks it", !(await H.verifyOrderToken(env, "SHOP-1", t.replace(/.$/, (c) => c === "0" ? "1" : "0"))) &&
    !(await H.verifyOrderToken(env, "SHOP-1", (Number(t.split(".")[0]) + 60) + "." + t.split(".")[1])));
  ok("another install's secret doesn't accept it", !(await H.verifyOrderToken({ SIGNING_SECRET: "t".repeat(40) }, "SHOP-1", t)));
  const past = Math.floor(Date.now() / 1000) - 10;
  ok("an expired one is refused, and junk too", !(await H.verifyOrderToken(env, "SHOP-1", past + "." + "a".repeat(64))) && !(await H.verifyOrderToken(env, "SHOP-1", "nope")) && !(await H.verifyOrderToken(env, "SHOP-1", null)));
  ok("with no secret there's no token (and nothing verifies)", (await H.signOrderToken({}, "SHOP-1")) === null && !(await H.verifyOrderToken({}, "SHOP-1", t)));

  console.log("\n=== Placing an order ===");
  let r = await run(orders, "https://example.com/api/orders", order("BARE-1"));
  ok("the bare domain refuses an order that names a shop, and saves nothing", r.status === 403 && /shop's own page/.test(r.body.message) && !(await lib.getOrderById(d1, "BARE-1")));
  r = await run(orders, "https://example.com/api/orders", Object.assign(order("BARE-2"), { orgId: "no-such-shop" }));
  ok("…with the same answer for a shop that doesn't exist", r.status === 403 && r.body.message === "Orders are placed from a shop's own page.");
  r = await run(orders, "https://shop.example.com/api/orders", order("SHOP-1"));
  const token = r.body.checkoutToken;
  ok("the shop's own address takes it, and the answer carries the order's checkout token", r.status === 200 && !!(await lib.getOrderById(d1, "SHOP-1")) && await H.verifyOrderToken(env, "SHOP-1", token));

  console.log("\n=== Paying by card ===");
  r = await run(checkout, "https://shop.example.com/api/checkout", { orderId: "SHOP-1", orgId: "shop" });
  ok("an order number alone opens no checkout", r.status === 403 && stripe.length === 0);
  r = await run(checkout, "https://shop.example.com/api/checkout", { orderId: "SHOP-1", orgId: "shop", checkoutToken: await H.signOrderToken(env, "OTHER-9") });
  ok("nor another order's token", r.status === 403 && stripe.length === 0);
  r = await run(checkout, "https://shop.example.com/api/checkout", { orderId: "SHOP-1", orgId: "shop", invoiceToken: "a".repeat(32) });
  ok("nor an invoice link that isn't this order's", r.status === 403 && stripe.length === 0);
  r = await run(checkout, "https://shop.example.com/api/checkout", { orderId: "SHOP-1", orgId: "shop", checkoutToken: token });
  ok("the token placing the order returned opens it, for the order's balance", r.status === 200 && stripe.length === 1 && new URLSearchParams(stripe[0]).get("line_items[0][price_data][unit_amount]") === "2000");

  console.log("\n=== Rate quotes ===");
  r = await run(shipping, "https://example.com/api/shipping", { zip: "43004", org: "shop", items: [{ productId: "tee", qty: 1 }] });
  ok("on the bare domain naming a shop: no signed rate comes back (nothing that can be ordered with)", r.status === 200 && (r.body.rates || []).every(x => !x.quoteToken));
  r = await run(shipping, "https://shop.example.com/api/shipping", { zip: "43004", items: [{ productId: "tee", qty: 1 }] });
  ok("on the shop's own address they're signed", r.status === 200 && r.body.rates.every(x => !!x.quoteToken));
  r = await run(shipping, "http://localhost:8790/api/shipping", { zip: "43004", org: "shop", items: [{ productId: "tee", qty: 1 }] });
  ok("a developer's own machine may name the shop", r.status === 200 && r.body.rates.every(x => !!x.quoteToken));

  console.log("\n=== The shop page ===");
  const html = read("public/index.html");
  ok("the storefront sends the token back when it starts a card payment", /checkoutToken: \(saved && saved\.checkoutToken\) \|\| null/.test(html) && !/customerName: name, contact\n/.test(html));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test123 ran to the end without crashing: false"); process.exitCode = 1; });
