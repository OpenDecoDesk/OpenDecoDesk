const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");

// Storefront usability round (2026-10): the cart survives a refresh and the trip to Stripe, Cancel on Stripe
// shows a banner with Pay by card for the SAME order, card success doesn't claim "marked paid", the phone
// cart bar and item count, +/− on cart lines, the same card layout for every product, inline errors, the
// confirmation's summary and wording, and shopper-facing words / phone sizing.
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
const catalog = { status: "ok", orgId: "o1", catalog: { name: "Acme", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
  enabledPayments: ["Card", "Check"], salesTaxRate: 0,
  graphics: [{ id: 1, name: "Logo", kind: "embroidery", imageUrl: "", thumbUrl: "", addOnCents: 0, inkColors: ["Gold", "White"], allowedLocations: [], allowedGarmentColors: [] }],
  products: [
    { id: "tee", type: "shirt", name: "Tee", sub: "", images: [], features: [], sizePricing: { M: 20, XL: 22 }, personalizationPrice: 3 },
    { id: "cap", type: "cap", name: "Cap", sub: "", images: [], features: [], flatPrice: 16, personalizationPrice: null },
    { id: "polo", type: "shirt", name: "Polo", sub: "", images: [], features: [], configurable: true, garmentColors: ["Navy", "Red"], sizePricing: { M: 30 }, personalizationPrice: null,
      locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [1] }] }
  ] } };

async function shop(url, seed){
  const calls = [];
  const vc = new VirtualConsole();   // swallow jsdom's "navigation not implemented" when the page goes to Stripe
  const dom = new JSDOM(html, { runScripts: "dangerously", url, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win){
      for(const [k, v] of Object.entries(seed || {})) win.sessionStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      win.fetch = async (u, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        calls.push({ url: String(u), body });
        const ans = String(u).startsWith("/api/catalog") ? catalog
          : String(u).startsWith("/api/orders") ? { status: "ok", checkoutToken: "tok-" + body.orderId }
          : String(u).startsWith("/api/checkout") ? { url: "https://checkout.stripe.test/s" } : {};
        return { ok: true, status: 200, json: async () => ans, text: async () => JSON.stringify(ans) };
      };
      win.alert = (m) => { win._alerts = (win._alerts || []).concat(m); };
      win.scrollTo = () => {};
    } });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 150));
  return { w, d: w.document, calls };
}
const ok = (m, c) => console.log(m + ":", !!c);
const tick = () => new Promise(r => setTimeout(r, 30));

(async () => {
  console.log("=== Product cards ===");
  let { w, d, calls } = await shop("https://acme.example.com/");
  const teeCard = d.getElementById("price-tee").closest(".product");
  ok("sizes priced differently show 'from' the lowest", d.getElementById("price-tee").textContent === "from $20.00");
  const ev = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
  d.getElementById("size-tee").value = "XL"; ev(d.getElementById("size-tee"), "change");
  ok("…and the exact price once a size is picked", d.getElementById("price-tee").textContent === "$22.00");
  const order = [...teeCard.querySelectorAll("#size-tee, #pers-tee, #qty-tee, .add-btn")].map(e => e.id || "add");
  ok("a plain card runs size → personalization → quantity → Add to cart, like a configurable one", order.join(",") === "size-tee,pers-tee,qty-tee,add");
  ok("the buttons say 'Add to cart'", [...d.querySelectorAll(".add-btn")].every(b => b.textContent === "Add to cart"));
  ok("the quantity box is a number box, 1 to 50", d.getElementById("qty-tee").type === "number" && d.getElementById("qty-tee").min === "1" && d.getElementById("qty-tee").max === "50");
  ok("garment color swatches say which is picked (aria-pressed), and the thread select has a label",
    d.querySelector('#gcolorwrap-polo .cfg-swatch[data-color="Navy"]').getAttribute("aria-pressed") === "true" && /Thread color for Front/.test(d.getElementById("ink-polo-front").getAttribute("aria-label")));
  d.querySelector('#gcolorwrap-polo .cfg-swatch[data-color="Red"]').click();
  ok("…and follow the pick", d.querySelector('#gcolorwrap-polo .cfg-swatch[data-color="Red"]').getAttribute("aria-pressed") === "true" && d.querySelector('#gcolorwrap-polo .cfg-swatch[data-color="Navy"]').getAttribute("aria-pressed") === "false");
  ok("a configurable card says 'Designs', and its breakdown says 'Garment' and 'Included'",
    /Designs/.test(d.getElementById("price-polo").closest(".product").textContent) && /Garment/.test(d.getElementById("cbd-polo").textContent) && /Included/.test(d.getElementById("cbd-polo").textContent) && !/Base/.test(d.getElementById("cbd-polo").textContent));

  console.log("\n=== Adding, the count and the phone cart bar ===");
  ok("the cart bar is hidden while the cart is empty", d.getElementById("cartBar").hidden);
  d.getElementById("pers-tee").checked = true; ev(d.getElementById("pers-tee"), "change");
  d.querySelector('[data-action="add"][data-pid="tee"]').click();
  ok("an empty personalization name is refused next to the product, not in a pop-up",
    /name/i.test(d.getElementById("cmsg-tee").textContent) && !d.getElementById("cmsg-tee").hidden && !(w._alerts || []).length && w.eval("cart").length === 0);
  d.getElementById("pers-tee").checked = false; ev(d.getElementById("pers-tee"), "change");
  d.querySelector('[data-action="add"][data-pid="tee"]').click();
  ok("adding clears the message and flashes 'Added ✓' on the button", d.getElementById("cmsg-tee").hidden && d.querySelector('.add-btn[data-pid="tee"]').textContent === "Added ✓");
  ok("the cart bar shows the count and total", !d.getElementById("cartBar").hidden && d.getElementById("cartBar").textContent === "View cart (1) · $22.00");
  ok("the order panel's heading counts the items", /\(1 item\)/.test(d.querySelector("#ticketPanel h2").textContent));
  ok("the cart line shows the price each and has +/−; ✕ is labelled", /× \$22\.00 each/.test(d.querySelector(".cart-line").textContent) &&
    d.querySelectorAll('.cart-line [data-action="qty"]').length === 2 && d.querySelector(".remove-x").getAttribute("aria-label") === "Remove Tee");

  console.log("\n=== +/− on a cart line ===");
  d.querySelector('.cart-line [data-action="qty"][data-d="1"]').click();
  ok("+ makes it 2 and doubles the line", w.eval("cart")[0].qty === 2 && w.eval("cart")[0].lineTotal === 44 && d.getElementById("cartBar").textContent === "View cart (2) · $44.00");
  d.querySelector('.cart-line [data-action="qty"][data-d="-1"]').click();
  d.querySelector('.cart-line [data-action="qty"][data-d="-1"]').click();
  ok("− down past 1 takes the line off", w.eval("cart").length === 0 && d.getElementById("cartBar").hidden);

  console.log("\n=== The cart is kept (refresh, back-swipe) ===");
  d.querySelector('[data-action="add"][data-pid="cap"]').click();
  const saved = JSON.parse(w.sessionStorage.getItem("cart:o1"));
  ok("the cart is saved for this shop in this tab", Array.isArray(saved) && saved.length === 1 && saved[0].productId === "cap");
  ({ w, d, calls } = await shop("https://acme.example.com/", { "cart:o1": saved.concat([{ productId: "gone", name: "Old", qty: 1, unitPrice: 5, lineTotal: 5 }]) }));
  ok("a refresh brings it back", w.eval("cart").length === 1 && w.eval("cart")[0].productId === "cap" && /Cap/.test(d.getElementById("ticketPanel").textContent));
  ok("…dropping a line whose product is no longer sold", !w.eval("cart").some(c => c.productId === "gone"));

  console.log("\n=== Placing an order: errors in the form, then the confirmation ===");
  d.getElementById("placeOrderBtn").click(); await tick();
  ok("a missing name is shown in the order panel (persistent, role=alert) and the field focused",
    !d.getElementById("checkoutMsg").hidden && /add your name/.test(d.getElementById("checkoutMsg").textContent) && d.activeElement && d.activeElement.id === "custName");
  d.getElementById("custName").value = "Pat Smith";
  d.getElementById("custContact").value = "pat@example.com";
  d.getElementById("placeOrderBtn").click(); await tick();
  ok("no payment method → asked for it", /how you'll pay/.test(d.getElementById("checkoutMsg").textContent));
  d.getElementById("custPaymentMethod").value = "Check";
  d.getElementById("placeOrderBtn").click(); await new Promise(r => setTimeout(r, 80));
  const conf = d.querySelector(".confirmation");
  ok("the confirmation lists the items, the delivery and the total", !!conf && /Cap/.test(conf.querySelector(".conf-items").textContent) && /Local pickup[\s\S]*Free/.test(conf.textContent) && /Total[\s\S]*\$16\.00/.test(conf.textContent));
  ok("…tells a check payer what happens next, and where the copy was emailed",
    /Please pay using the details below/.test(conf.textContent) && /emailed to pat@example\.com/.test(conf.textContent) && !/Payment is handled separately/.test(conf.textContent));
  ok("…and the saved cart is emptied", JSON.parse(w.sessionStorage.getItem("cart:o1")).length === 0);

  console.log("\n=== Paying by card: Cancel on Stripe, then Pay by card ===");
  ({ w, d, calls } = await shop("https://acme.example.com/"));
  d.querySelector('[data-action="add"][data-pid="cap"]').click();
  d.getElementById("custName").value = "Pat Smith";
  d.getElementById("custContact").value = "pat@example.com";
  d.getElementById("custPaymentMethod").value = "Card";
  d.getElementById("placeOrderBtn").click(); await new Promise(r => setTimeout(r, 80));
  const placed = calls.find(c => c.url.startsWith("/api/orders")).body;
  const pending = JSON.parse(w.sessionStorage.getItem("pendingCard:o1") || "null");
  ok("going to Stripe remembers the order and its pay token, and empties the cart (no second order by accident)",
    pending && pending.orderId === placed.orderId && pending.token === "tok-" + placed.orderId && pending.total === 16 && JSON.parse(w.sessionStorage.getItem("cart:o1")).length === 0);
  const seed = { "pendingCard:o1": pending };
  ({ w, d, calls } = await shop("https://acme.example.com/?stripe=cancel&orderId=" + placed.orderId + "&org=o1", seed));
  const bar = d.getElementById("unpaidBar");
  ok("coming back with Cancel shows the order is saved but not paid", !!bar && /wasn't finished/.test(bar.textContent) && bar.textContent.includes(placed.orderId) && /don't need to order again/.test(bar.textContent));
  bar.querySelector('[data-action="retry-card"]').click(); await tick();
  const retry = calls.find(c => c.url.startsWith("/api/checkout"));
  ok("Pay by card opens checkout for the SAME order with its token", retry && retry.body.orderId === placed.orderId && retry.body.checkoutToken === "tok-" + placed.orderId && !calls.some(c => c.url.startsWith("/api/orders")));
  ({ w, d } = await shop("https://acme.example.com/?stripe=cancel&orderId=OTHER-1&org=o1"));
  ok("from another tab (nothing remembered) the banner still says so, without a pay button",
    /OTHER-1/.test(d.getElementById("unpaidBar").textContent) && !d.querySelector('[data-action="retry-card"]'));
  d.querySelector('[data-action="dismiss-unpaid"]').click();
  ok("Close removes it", !d.getElementById("unpaidBar"));

  console.log("\n=== Card success ===");
  ({ w, d } = await shop("https://acme.example.com/?stripe=success&orderId=" + placed.orderId + "&org=o1", { "pendingCard:o1": pending, "cart:o1": saved }));
  const okText = d.querySelector(".confirmation").textContent;
  ok("the success page says the payment went through, not that the order is 'marked paid'", /your payment went through/.test(okText) && !/marked paid/.test(okText));
  ok("…and forgets the pending order and the cart", !w.sessionStorage.getItem("pendingCard:o1") && !w.sessionStorage.getItem("cart:o1"));

  console.log("\n=== Shopper-facing words ===");
  ok("blank stock reads 'Ships faster — in stock'", /Ships faster — in stock/.test(w.readyBadgeHtml_({ blankStock: { "": { M: 3 } } }, "", "M")) && !/decorate/.test(w.readyBadgeHtml_({ blankStock: { "": { M: 3 } } }, "", "M")));
  const late = w.deadlineBannerHtml({ orderDeadline: "2020-01-01", allowOrdersAfterDeadline: true });
  ok("a passed deadline that still takes orders doesn't say 'Closed'", /Late orders are still being accepted/.test(late) && !/Closed/.test(late) && !/has closed/.test(late));
  ok("no 'blank' in picture descriptions and no 'Available now' heading", !/blank — click to view/.test(html) && !/Available now/.test(html));
  ok("the default payment hint explains the next step", /you'll see how to pay after you place the order/.test(html) && !/this just places your order/.test(html));

  console.log("\n=== Phones ===");
  ok("inputs and selects are 16px on a phone (no iOS zoom), and the small buttons are 44px",
    /@media\(max-width:760px\)\{\s*\.product-controls select, \.product-controls input, \.checkout-fields input, \.checkout-fields select[^}]*font-size:16px;\}/.test(html) && /\.remove-x, \.qty-step\{min-width:44px;min-height:44px;\}/.test(html));
  ok("the cart bar only shows on a phone", /\.cart-bar\{display:none;\}/.test(html) && /\.cart-bar\{display:block;position:fixed;/.test(html));
  process.exit(0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
