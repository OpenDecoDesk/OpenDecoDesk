const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Delivery / pickup options per shop (migrations/0045): a managed list — Local pickup (free, once),
// Shipping (carrier rates, once) and the shop's own flat-fee options — validated on save, shown at
// checkout in the shop's order, and priced on the SERVER from the shop's list (never the request).
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { cleanDeliveryOptions, defaultDeliveryOptions, getOrgById, setOrgDeliveryOptions, createProduct, getOrderById, getPublicCatalogData, updateOrg };")();
const quote = new Function(strip(read("functions/_lib/quoteToken.js")) + "\nreturn { signQuote, verifyQuote, canonicalItems };")();
const SUBS = { league: "league", plain: "plain", shiponly: "shiponly" };
const api = new Function("signQuoteImpl", strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: " + JSON.stringify(SUBS) + ", orgs: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  console.log("=== The list's rules ===");
  const C = lib.cleanDeliveryOptions;
  ok("an empty list is refused", /at least one/.test(C([]).error) && /at least one/.test(C(null).error));
  ok("Local pickup can only be listed once", /Local pickup can only/.test(C([{ type: "pickup" }, { type: "pickup" }]).error));
  ok("Shipping can only be listed once", /Shipping can only/.test(C([{ type: "shipping" }, { type: "shipping" }]).error));
  ok("a custom option needs a name", /name/.test(C([{ type: "custom", label: "  ", fee: 1 }]).error));
  ok("two custom options can't share a name (any case)", /both named/.test(C([{ type: "custom", label: "Game night" }, { type: "custom", label: "game NIGHT" }]).error));
  ok("a fee must be a number from 0 to 1000", /fee/.test(C([{ type: "custom", label: "A", fee: -1 }]).error) && /fee/.test(C([{ type: "custom", label: "A", fee: "abc" }]).error) && /fee/.test(C([{ type: "custom", label: "A", fee: 1001 }]).error));
  ok("an unknown type is refused", !!C([{ type: "drone" }]).error);
  const good = C([{ type: "custom", label: "  Delivery   at practice ", fee: "5" }, { type: "pickup", label: "ignored", fee: 9 }, { type: "custom", label: "Hand delivery", fee: "" }, { type: "shipping", fee: 3 }]).options;
  ok("several custom options are fine, order is kept, names tidied, blank fee = free", good.map(o => o.type).join() === "custom,pickup,custom,shipping" && good[0].label === "Delivery at practice" && good[0].fee === 5 && good[2].fee === 0);
  ok("pickup is always free and shipping's fee is variable (null), whatever was sent", good[1].fee === 0 && good[1].label === "Local pickup" && good[3].fee === null);
  ok("custom options get stable ids; pickup/shipping have fixed ones", /^c[a-z0-9]{6,16}$/.test(good[0].id) && good[0].id !== good[2].id && good[1].id === "pickup" && good[3].id === "shipping");
  ok("an existing id survives a re-save", C([{ id: good[0].id, type: "custom", label: "Renamed", fee: 2 }]).options[0].id === good[0].id);
  ok("the default is Local pickup, plus Shipping where it was enabled", lib.defaultDeliveryOptions(false).map(o => o.type).join() === "pickup" && lib.defaultDeliveryOptions(true).map(o => o.type).join() === "pickup,shipping");

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('league','league','League','t','t',1,0), ('plain','plain','Plain','t','t',1,1), ('shiponly','shiponly','Ship only','t','t',1,0);`);
  for (const org of ["league", "plain", "shiponly"]) await lib.createProduct(d1, org, { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, weightOz: 6 });
  const env = { DB: d1, QUOTE_SIGNING_SECRET: "q".repeat(40), ...MAIL_ENV };
  let emails = [];
  global.fetch = async (url, init) => captureMail(url, init, emails) ? MAIL_OK : { ok: true, json: async () => ({}) };
  const post = async (host, body) => {
    const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `https://${host}.example.com/api/orders`, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => post("admin", Object.assign({ key: "x" }, body));

  console.log("\n=== Existing shops are unchanged until their list is edited ===");
  let league = await lib.getOrgById(d1, "league"), plain = await lib.getOrgById(d1, "plain");
  ok("a shop without shipping offers just Local pickup; one with shipping offers both", league.deliveryOptions.map(o => o.type).join() === "pickup" && plain.deliveryOptions.map(o => o.type).join() === "pickup,shipping" && !league.deliveryOptionsStored);

  console.log("\n=== Saving the list from the shop form ===");
  const orgBody = (extra) => Object.assign({ action: "updateOrg", orgId: "league", subdomain: "league", name: "League", ready: true }, extra);
  let r = await admin(orgBody({ deliveryOptions: [] }));
  ok("saving with nothing in the list is refused", r.status === 400 && /at least one/.test(r.body.message));
  r = await admin(orgBody({ deliveryOptions: [{ type: "pickup" }, { type: "pickup" }] }));
  ok("two Local pickups are refused", r.status === 400);
  r = await admin(orgBody({ deliveryOptions: [{ type: "pickup" }, { type: "custom", label: "Delivery at practice", fee: 0 }, { type: "custom", label: "Hand delivery", fee: 5 }] }));
  league = await lib.getOrgById(d1, "league");
  ok("a list with pickup and two custom options saves", r.status === 200 && league.deliveryOptionsStored && league.deliveryOptions.map(o => o.label).join("|") === "Local pickup|Delivery at practice|Hand delivery" && league.shippingEnabled === false);
  const meetId = league.deliveryOptions[1].id, handId = league.deliveryOptions[2].id;
  await new Promise(res => setTimeout(res, 20));
  ok("the change is in the audit log", Number((await d1.prepare("SELECT count(*) n FROM audit_log WHERE action='org.updated' AND detail LIKE '%deliveryOptions%'").first()).n) === 1);
  r = await admin(orgBody({ deliveryOptions: [{ type: "custom", label: "Delivery at practice", fee: 0, id: meetId }, { type: "shipping" }] }));
  league = await lib.getOrgById(d1, "league");
  ok("Local pickup can be removed; adding Shipping turns the shop's shipping flag on", r.status === 200 && league.deliveryOptions.map(o => o.type).join() === "custom,shipping" && league.shippingEnabled === true &&
    Number((await d1.prepare("SELECT shippingEnabled n FROM orgs WHERE orgId='league'").first()).n) === 1);
  // An older caller that only knows the on/off switch.
  r = await admin(orgBody({ shippingEnabled: false }));
  league = await lib.getOrgById(d1, "league");
  ok("the old shipping switch still works on a shop with a list (it removes just the shipping entry)", league.deliveryOptions.map(o => o.type).join() === "custom" && league.shippingEnabled === false);
  r = await admin({ action: "createOrg", orgId: "newshop", subdomain: "newshop", name: "New", deliveryOptions: [{ type: "custom", label: "Club night", fee: 2 }] });
  ok("a new shop can be created with its own list", r.status === 200 && (await lib.getOrgById(d1, "newshop")).deliveryOptions[0].label === "Club night");
  r = await admin({ action: "createOrg", orgId: "newshop2", subdomain: "newshop2", name: "New2" });
  ok("…and without one it starts with Local pickup", (await lib.getOrgById(d1, "newshop2")).deliveryOptions.map(o => o.type).join() === "pickup");
  await admin(orgBody({ deliveryOptions: [{ type: "pickup" }, { type: "custom", label: "Delivery at practice", fee: 0, id: meetId }, { type: "custom", label: "Hand delivery", fee: 5, id: handId }] }));
  await admin({ action: "updateOrg", orgId: "shiponly", subdomain: "shiponly", name: "Ship only", ready: true, deliveryOptions: [{ type: "shipping" }] });

  console.log("\n=== The storefront catalog ===");
  const catalog = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\nlet getCatalogData;\n" + strip(read("functions/api/catalog.js")) + "\nreturn { get: onRequestGet, set: (f) => { getCatalogData = f; } };")();
  catalog.set(async () => lib.getPublicCatalogData(d1));
  const cat = JSON.parse(await (await catalog.get({ request: { url: "https://league.example.com/api/catalog" }, env })).text()).catalog;
  ok("the shop's options reach the storefront with their fees", cat.deliveryOptions.map(o => o.label + ":" + o.fee).join("|") === "Local pickup:0|Delivery at practice:0|Hand delivery:5" && cat.shippingEnabled === false);

  console.log("\n=== Placing an order: the fee comes from the shop's list ===");
  const items = [{ productId: "tee", size: "M", qty: 1 }];
  const order = (id, extra) => Object.assign({ orderId: id, orgId: "league", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items }, extra);
  r = await post("league", order("D1", { deliveryOptionId: handId, shippingCost: 0.01, shippingMethod: "Free stuff" }));
  let o = await lib.getOrderById(d1, "D1");
  ok("a custom option charges ITS fee and records ITS name, whatever the browser sent", r.status === 200 && o.shippingCost === 5 && o.shippingMethod === "Hand delivery" && o.effectiveTotal === 25 && !o.shippingAddress);
  r = await post("league", order("D2", { deliveryOptionId: meetId }));
  o = await lib.getOrderById(d1, "D2");
  ok("a free custom option records its name with no charge", r.status === 200 && o.shippingCost === 0 && o.shippingMethod === "Delivery at practice" && o.effectiveTotal === 20);
  r = await post("league", order("D3", { deliveryOptionId: "pickup" }));
  o = await lib.getOrderById(d1, "D3");
  ok("Local pickup is free and leaves the method blank, as before", r.status === 200 && o.shippingCost === 0 && o.shippingMethod === "");
  r = await post("league", order("D4", {}));
  ok("a page loaded before the list existed (no choice sent) still means Local pickup", r.status === 200 && (await lib.getOrderById(d1, "D4")).shippingMethod === "");
  r = await post("league", order("D5", { deliveryOptionId: "cdeadbeef00" }));
  ok("an option that isn't in the list is refused", r.status === 400 && /no longer offered/.test(r.body.message) && !(await lib.getOrderById(d1, "D5")));
  // A shop whose list has no Local pickup.
  await admin(orgBody({ deliveryOptions: [{ type: "custom", label: "Delivery at practice", fee: 0, id: meetId }, { type: "custom", label: "Hand delivery", fee: 5, id: handId }] }));
  r = await post("league", order("D6", { deliveryOptionId: "pickup" }));
  ok("Local pickup is refused once the shop has removed it", r.status === 400);
  r = await post("league", order("D7", {}));
  ok("…and with several options and none chosen, the customer is asked to choose", r.status === 400 && /choose a delivery option/i.test(r.body.message));
  const addr = { name: "C", street1: "1 Main", city: "Springfield", state: "OH", zip: "45503" };
  const tok = await quote.signQuote(env, { orgId: "league", zip: "45503", items: quote.canonicalItems(items), amountCents: 899, method: "USPS Ground Advantage" });
  r = await post("league", order("D8", { shippingAddress: addr, shippingQuoteToken: tok }));
  ok("a carrier quote is refused by a shop that doesn't offer shipping", r.status === 400 && /doesn't offer shipping/.test(r.body.message));
  const tok2 = await quote.signQuote(env, { orgId: "plain", zip: "45503", items: quote.canonicalItems(items), amountCents: 899, method: "USPS Ground Advantage" });
  r = await post("plain", Object.assign(order("D9", { shippingAddress: addr, shippingQuoteToken: tok2 }), { orgId: "plain" }));
  o = await lib.getOrderById(d1, "D9");
  ok("a shop that ships still charges the signed quote", r.status === 200 && o.shippingCost === 8.99 && o.shippingMethod === "USPS Ground Advantage" && o.shippingAddress.zip === "45503");
  r = await post("shiponly", Object.assign(order("D10", {}), { orgId: "shiponly" }));
  ok("a shipping-only shop asks for a ZIP and a rate when none is chosen", r.status === 400 && /ZIP/.test(r.body.message));

  console.log("\n=== Receipts name the delivery option ===");
  await new Promise(res => setTimeout(res, 50));
  const mailFor = (id) => emails.find(e => e.subject && e.subject.includes(id) || (e.body || "").includes(id));
  const m1 = mailFor("D1"), m2 = mailFor("D2"), m9 = mailFor("D9");
  ok("a paid custom option is its own line: 'Hand delivery: $5.00', total $25.00", !!m1 && /Hand delivery: \$5\.00/.test(m1.body) && /Total: \$25\.00/.test(m1.body) && !/Shipping \(Hand delivery\)/.test(m1.body));
  ok("a free custom option is shown as Free", !!m2 && /Delivery at practice: Free/.test(m2.body));
  ok("carrier shipping still reads 'Shipping (USPS Ground Advantage)'", !!m9 && /Shipping \(USPS Ground Advantage\): \$8\.99/.test(m9.body));

  // ---- Storefront in jsdom ----
  console.log("\n=== Checkout shows the shop's list ===");
  const html = read("public/index.html");
  const shop = async (catalogBody) => {
    const sent = [];
    const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://league.example.com/", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = async (url, init) => { if (String(url).includes("/api/orders")) { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
        return { ok: true, status: 200, json: async () => catalogBody, text: async () => JSON.stringify(catalogBody) }; }; win.alert = () => {}; } });
    await new Promise(res => setTimeout(res, 200));
    return { w: dom.window, d: dom.window.document, sent };
  };
  const baseCat = (deliveryOptions, shippingEnabled) => ({ status: "ok", orgId: "league", catalog: { name: "League", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
    enabledPayments: ["Venmo"], salesTaxRate: 0, shippingEnabled, deliveryOptions, graphics: [],
    products: [{ id: "tee", type: "shirt", name: "Tee", sub: "", images: [], features: [], sizePricing: { M: 20 }, personalizationPrice: null, weightOz: 6 }] } });
  const add = (s) => { s.d.querySelector('[data-action="add"][data-pid="tee"]').click(); };
  const radios = (s) => [...s.d.querySelectorAll('input[name="shippingChoice"]')];
  const total = (s) => s.d.querySelector(".t-amount").textContent.replace(/\s+/g, "");

  let s = await shop(baseCat([{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }], false));
  add(s);
  ok("a shop with only free Local pickup shows no Delivery section (as before)", !s.d.querySelector(".shipping-section") && total(s) === "$20.00");

  s = await shop(baseCat([{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }, { id: "cmeet00001", type: "custom", label: "Delivery at practice", fee: 0 }, { id: "chand00001", type: "custom", label: "Hand delivery", fee: 5 }], false));
  add(s);
  const labels = () => [...s.d.querySelectorAll(".shipping-option")].map(l => l.textContent.replace(/\s+/g, " ").trim());
  ok("each option is a choice with its fee, in the shop's order", labels().join("|") === "Local pickup — Free|Delivery at practice — Free|Hand delivery — $5.00");
  ok("the first one is preselected and there's no ZIP box (the shop doesn't ship)", radios(s)[0].checked && !s.d.querySelector("#shippingZipInput"));
  radios(s)[2].checked = true; radios(s)[2].dispatchEvent(new s.w.Event("change", { bubbles: true }));
  ok("choosing a paid option adds its fee to the total, named in the breakdown", total(s) === "$25.00" && /Hand delivery/.test(s.d.querySelector(".ticket-breakdown").textContent));
  ok("the choice survives a re-render", radios(s)[2].checked);
  s.d.getElementById("custName").value = "Cust"; s.d.getElementById("custContact").value = "c@x.com";
  const pay = s.d.getElementById("custPaymentMethod"); if (pay) { pay.value = "Venmo"; }
  s.d.querySelector('[data-action="place-order"]').click();
  await new Promise(res => setTimeout(res, 300));
  const sentOrder = s.sent.find(b => b.orderId);
  ok("the order sends the chosen option's id (no address asked for)", !!sentOrder && sentOrder.deliveryOptionId === "chand00001" && sentOrder.shippingAddress === null && sentOrder.manualShipping === false && !sentOrder.shippingQuoteToken);

  s = await shop(baseCat([{ id: "cmeet00001", type: "custom", label: "Delivery at practice", fee: 0 }, { id: "shipping", type: "shipping", label: "Shipping", fee: null }], true));
  add(s);
  ok("a shop that also ships shows its option first and the ZIP box for carrier rates", /Delivery at practice — Free/.test(s.d.querySelector(".shipping-section").textContent) && !!s.d.querySelector("#shippingZipInput") && radios(s).length === 1 && radios(s)[0].checked);
  s.w.eval(`shippingZip = "45503"; shippingRates = [{provider:"USPS", service:"Ground", amount:8.99, quoteToken:"t"}]; renderTicket(currentOrg, currentOrgId);`);
  ok("carrier rates appear as further choices", radios(s).length === 2 && /USPS Ground/.test(s.d.querySelector(".shipping-section").textContent));
  radios(s)[1].checked = true; radios(s)[1].dispatchEvent(new s.w.Event("change", { bubbles: true }));
  ok("picking a rate charges it", total(s) === "$28.99");
  radios(s)[0].checked = true; radios(s)[0].dispatchEvent(new s.w.Event("change", { bubbles: true }));
  ok("switching back to the shop's option drops the carrier charge", total(s) === "$20.00" && s.w.eval("shippingQuote") === null);

  s = await shop(baseCat([{ id: "shipping", type: "shipping", label: "Shipping", fee: null }], true));
  add(s);
  ok("a shipping-only shop has no free default — nothing is chosen until a rate is picked", radios(s).length === 0 && s.w.eval("currentDelivery_(currentOrg).kind") === "none" && !!s.d.querySelector("#shippingZipInput"));

  // ---- Admin form ----
  console.log("\n=== The shop form's list ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const adom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "admin" }) }); } });
  const aw = adom.window, ad = aw.document;
  await new Promise(res => setTimeout(res, 150));
  await aw.loadAdminScript();
  aw.eval(`adminKey = "cookie"; window._adminOrgRegistry = [];`);
  aw.renderOrgForm(ad.getElementById("app"), null);
  const box = () => ad.getElementById("orgFormDelivery");
  const rowsText = () => [...box().querySelectorAll("[data-dlv-row]")].map(tr => tr.textContent.replace(/\s+/g, " ").trim());
  ok("a new shop starts with one item: Local pickup, Free", rowsText().length === 1 && /Local pickup/.test(rowsText()[0]) && /Free/.test(rowsText()[0]));
  ok("Local pickup can't be added twice (no + Local pickup button while it's listed)", !box().querySelector('[data-dlv-add="pickup"]') && !!box().querySelector('[data-dlv-add="shipping"]') && !!box().querySelector('[data-dlv-add="custom"]'));
  box().querySelector('[data-dlv-add="shipping"]').click();
  ok("Shipping is listed with a Variable fee, and can't be added twice", /Shipping/.test(rowsText()[1]) && /Variable/.test(rowsText()[1]) && !box().querySelector('[data-dlv-add="shipping"]'));
  box().querySelector('[data-dlv-add="custom"]').click(); box().querySelector('[data-dlv-add="custom"]').click();
  const cust = () => [...box().querySelectorAll(".dlv-label")], fees = () => [...box().querySelectorAll(".dlv-fee")];
  cust()[0].value = "Delivery at practice"; cust()[1].value = "Hand delivery"; fees()[1].value = "5";
  ok("several custom options, each with its own name and fee box", cust().length === 2 && fees().length === 2);
  box().querySelector('[data-dlv-del="0"]').click();
  ok("Local pickup can be removed; what was typed in the other rows is kept", rowsText().length === 3 && !rowsText().some(t => /Local pickup/.test(t)) && cust()[0].value === "Delivery at practice" && fees()[1].value === "5.00" && !!box().querySelector('[data-dlv-add="pickup"]'));
  ok("the list is read back for saving in order", JSON.stringify(aw.readOrgDeliveryList_().map(o => [o.type, o.label || "", o.fee == null ? "" : o.fee])) === JSON.stringify([["shipping", "", ""], ["custom", "Delivery at practice", 0], ["custom", "Hand delivery", 5]]));
  ok("problems are worded before anything is sent", aw.orgDeliveryProblem_([]) !== "" && /name/.test(aw.orgDeliveryProblem_([{ type: "custom", label: "", fee: 0 }])) && /fee/.test(aw.orgDeliveryProblem_([{ type: "custom", label: "A", fee: -2 }])) && aw.orgDeliveryProblem_(aw.readOrgDeliveryList_()) === "");
  while (box().querySelector("[data-dlv-del]")) box().querySelector("[data-dlv-del]").click();
  ok("every option can be removed, and the form then says one is needed", rowsText().length === 0 && /add at least one before saving/.test(box().textContent) && /at least one/.test(aw.orgDeliveryProblem_(aw.readOrgDeliveryList_())));
  ok("Save refuses an empty list", /orgDeliveryProblem_\(body\.deliveryOptions\)/.test(adminJs) && /deliveryOptions: readOrgDeliveryList_\(\)/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
