const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Ordering blanks from a supplier through PromoStandards (migrations/0072): Blanks to Order → Order from SanMar…
// checks the supplier's parts and stock, places the order with Purchase Order 1.0.0 sendPO, marks the order lines
// "blanks ordered" with the PO number, and the supplier's Order Shipment Notification turns into blank shipments.
// Admin only. The supplier's SOAP is recorded below in the shapes of the published WSDLs (SanMar's live ones);
// `fetch` is mocked.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const psSrc = strip(read("functions/_lib/promostandards.js")), credSrc = strip(read("functions/_lib/vendorCredentials.js")), soSrc = strip(read("functions/_lib/supplierOrders.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, insertOrder, getBlanksToOrder };`)();
const ps = new Function(psSrc + `\nreturn { psBuildPO_, psSendPO, psGetInventory, psGetParts, psPartFor_, psGetShipments, psEl_, PS_OVERRIDES };`)();
const so = new Function(psSrc + "\n" + soSrc + `\nreturn { supplierShipMethods };`)();
const built = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + psSrc + "\n" + credSrc + "\n" + soSrc + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { onRequestPost, checkSupplierShipments };")();
const api = built.onRequestPost;
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// ---- Recorded supplier answers ----
const env = (body) => `<?xml version="1.0" encoding="UTF-8"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>${body}</S:Body></S:Envelope>`;
const P = 'xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"';
const part = (id, color, size) => `<ns2:ProductPart><ns2:partId>${id}</ns2:partId><ns2:ColorArray><ns2:Color><ns2:colorName>${color}</ns2:colorName></ns2:Color></ns2:ColorArray><ns2:ApparelSize><ns2:labelSize>${size}</ns2:labelSize></ns2:ApparelSize></ns2:ProductPart>`;
const PRODUCT = env(`<GetProductResponse ${P}><Product><ns2:productId>K540</ns2:productId><ns2:productName>Silk Touch Polo</ns2:productName><ns2:productBrand>Port Authority</ns2:productBrand>
  <ns2:ProductPartArray>${part("1001", "Black", "S")}${part("1002", "Black", "2XL")}${part("1003", "Navy", "S")}</ns2:ProductPartArray></Product></GetProductResponse>`);
const I = 'xmlns:ns2="http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/Inventory/2.0.0/"';
let stock = { 1001: 100, 1002: 50, 1003: 2 };
const inventory = () => env(`<GetInventoryLevelsResponse ${I}><ns2:Inventory><ns2:productId>K540</ns2:productId><ns2:PartInventoryArray>${Object.entries(stock).map(([id, n]) =>
  `<ns2:PartInventory><ns2:partId>${id}</ns2:partId><ns2:mainPart>false</ns2:mainPart><ns2:quantityAvailable><ns2:Quantity><ns2:uom>EA</ns2:uom><ns2:value>${n}</ns2:value></ns2:Quantity></ns2:quantityAvailable><ns2:manufacturedItem>false</ns2:manufacturedItem><ns2:buyToOrder>false</ns2:buyToOrder></ns2:PartInventory>`).join("")}</ns2:PartInventoryArray></ns2:Inventory></GetInventoryLevelsResponse>`);
const PO_OK = env(`<ns2:SendPOResponse xmlns:ns2="http://www.promostandards.org/WSDL/PO/1.0.0/" xmlns="http://www.promostandards.org/WSDL/PO/1.0.0/SharedObjects/"><ns2:transactionId>TX-5877-1679510682389</ns2:transactionId></ns2:SendPOResponse>`);
const PO_HTML = env(`<ns2:SendPOResponse xmlns:ns2="http://www.promostandards.org/WSDL/PO/1.0.0/" xmlns="http://www.promostandards.org/WSDL/PO/1.0.0/SharedObjects/"><ServiceMessageArray><ServiceMessage><code>500</code><description>S&amp;S Promostandards Purchase Order Error&lt;br/&gt;&lt;br/&gt;PO Number: PO-9&lt;br/&gt;&lt;br/&gt;Error Log: &lt;br/&gt;PaymentProfile: PaymentProfile required for this account (credit card or bank).&lt;br/&gt;</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></ns2:SendPOResponse>`);
const PO_REFUSED = env(`<ns2:SendPOResponse xmlns:ns2="http://www.promostandards.org/WSDL/PO/1.0.0/" xmlns="http://www.promostandards.org/WSDL/PO/1.0.0/SharedObjects/"><ServiceMessageArray><ServiceMessage><code>999</code><description>Payment method on file declined</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></ns2:SendPOResponse>`);
const O = 'xmlns="http://www.promostandards.org/WSDL/OrderShipmentNotificationService/1.0.0/" xmlns:ns2="http://www.promostandards.org/WSDL/OrderShipmentNotificationService/1.0.0/SharedObjects/"';
const pkg = (tn) => `<Package><id>1</id><trackingNumber>${tn}</trackingNumber><shipmentDate>2026-10-22T00:00:00</shipmentDate><carrier>UPS</carrier><shipmentMethod>Ground</shipmentMethod></Package>`;
let osnPackages = [];
const osn = (po) => env(`<GetOrderShipmentNotificationResponse ${O}><OrderShipmentNotificationArray><OrderShipmentNotification><purchaseOrderNumber>${po}</purchaseOrderNumber><complete>true</complete><SalesOrderArray><SalesOrder><salesOrderNumber>S1</salesOrderNumber><complete>true</complete>
  <ShipmentLocationArray><ShipmentLocation><complete>true</complete><ShipFromAddress><address1>x</address1><city>Reno</city><region>NV</region><postalCode>89511</postalCode></ShipFromAddress><ShipToAddress><address1>1 Main</address1><city>Anytown</city><region>CO</region><postalCode>80202</postalCode></ShipToAddress>
  <PackageArray>${osnPackages.map(pkg).join("")}</PackageArray></ShipmentLocation></ShipmentLocationArray></SalesOrder></SalesOrderArray></OrderShipmentNotification></OrderShipmentNotificationArray></GetOrderShipmentNotificationResponse>`);

const calls = [];
let poMode = "ok", down = false;
const vendorFetch = async (url, init = {}) => {
  const body = String(init.body || "");
  calls.push({ url: String(url), action: (init.headers || {}).SOAPAction, body });
  if (down) throw new Error("fetch failed");
  if (/GetProductRequest/.test(body)) return new Response(PRODUCT, { status: 200 });
  if (/GetInventoryLevelsRequest/.test(body)) return new Response(inventory(), { status: 200 });
  if (/SendPORequest/.test(body)) {
    if (poMode === "timeout") throw new Error("The operation was aborted due to timeout");
    return new Response(poMode === "refused" ? PO_REFUSED : poMode === "html" ? PO_HTML : PO_OK, { status: 200 });
  }
  if (/GetOrderShipmentNotificationRequest/.test(body)) return new Response(osn((body.match(/<ns:referenceNumber>([^<]+)</) || [])[1] || ""), { status: 200 });
  return new Response("", { status: 404 });
};
const URLS = { product: "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2", ppc: "https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding",
  inv: "https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final", po: "https://ws.sanmar.com:8080/promostandards/POServiceBinding",
  osn: "https://ws.sanmar.com:8080/promostandards/OrderShipmentNotificationServiceBinding" };

(async () => {
  console.log("=== The requests ===");
  const conn = { name: "SanMar", companyCode: "SanMar", endpoints: URLS, credentials: { id: "shop_user", password: "s3&cret" }, overrides: {} };
  const xml = ps.psBuildPO_({ poNumber: "PO-20261020-1", orderDate: "2026-10-20T14:00:00.000Z", carrier: "UPS", service: "GROUND",
    shipTo: { company: "Northside Stitch Co", street1: "1 Main St", city: "Anytown", state: "co", zip: "80202", email: "o@x.com", phone: "(303) 555-0100" },
    lines: [{ partId: "1001", qty: 3, unitCents: 893, description: "K540 Black S" }, { partId: "1003", qty: 2, unitCents: 893 }] });
  const order = (s, names) => { let at = -1; for (const n of names) { const i = s.indexOf(n, at + 1); if (i <= at) return false; at = i; } return true; };
  ok("the PO's elements are in the PO 1.0.0 WSDL's order (main vs shared namespace as the WSDL has them)", order(xml, ["<ns:PO>", "<ns:orderType>Blank", "<ns:orderNumber>PO-20261020-1", "<ns:orderDate>2026-10-20T14:00:00<",
    "<ns:totalAmount>44.65<", "<ns:rush>false", "<shar:currency>USD", "<ns:OrderContactArray>", "<shar:contactType>Order", "<ns:ShipmentArray>", "<shar:shipReferences>", "<shar:allowConsolidation>",
    "<shar:blindShip>", "<shar:packingListRequired>", "<shar:FreightDetails><shar:carrier>UPS</shar:carrier><shar:service>GROUND</shar:service>", "<shar:ShipTo><shar:customerPickup>false", "<shar:shipmentId>1",
    "<ns:LineItemArray>", "<ns:LineItem><ns:lineNumber>1", "<shar:description>K540 Black S", "<ns:lineType>New", "<shar:ToleranceDetails>", "<ns:allowPartialShipments>", "<ns:lineItemTotal>26.79",
    "<ns:PartArray><shar:Part><shar:partId>1001</shar:partId><shar:customerSupplied>false</shar:customerSupplied><shar:Quantity><shar:uom>EA</shar:uom><shar:value>3</shar:value>",
    "<ns:lineNumber>2", "<shar:partId>1003", "<ns:termsAndConditions>"]));
  ok("…the ship-to block is the shop's address: company, street, city, 2-letter state, ZIP, US, phone digits only", order(xml, ["<shar:ShipTo>", "<shar:companyName>Northside Stitch Co", "<shar:address1>1 Main St", "<shar:city>Anytown",
    "<shar:region>CO", "<shar:postalCode>80202", "<shar:country>US", "<shar:email>o@x.com", "<shar:phone>3035550100"]));
  calls.length = 0;
  const sent = await ps.psSendPO(conn, { poNumber: "PO-1", shipTo: { company: "A", street1: "1", city: "T", state: "CO", zip: "80202" }, lines: [{ partId: "1001", qty: 1, unitCents: 100 }] }, vendorFetch);
  ok("sendPO goes to the Purchase Order service with its SOAPAction, the login escaped, and returns the transaction id", sent.transactionId === "TX-5877-1679510682389" && calls[0].url === URLS.po && calls[0].action === '"sendPO"' &&
    calls[0].body.includes('xmlns:ns="http://www.promostandards.org/WSDL/PO/1.0.0/"') && /<ns:SendPORequest><shar:wsVersion>1\.0\.0<\/shar:wsVersion><shar:id>shop_user<\/shar:id><shar:password>s3&amp;cret<\/shar:password><ns:PO>/.test(calls[0].body));
  poMode = "refused";
  let err = ""; try { await ps.psSendPO(conn, { poNumber: "PO-2", shipTo: {}, lines: [{ partId: "1001", qty: 1, unitCents: 1 }] }, vendorFetch); } catch (e) { err = e.message; }
  ok("…a refusal (ServiceMessage of severity Error) becomes a plain message", /Payment method on file declined/.test(err));
  poMode = "html"; err = "";
  try { await ps.psSendPO(conn, { poNumber: "PO-9", shipTo: {}, lines: [{ partId: "1001", qty: 1, unitCents: 1 }] }, vendorFetch); } catch (e) { err = e.message; }
  ok("…and one sent as HTML (S&S) reads as plain text", /Purchase Order Error · PO Number: PO-9 · Error Log: · PaymentProfile: PaymentProfile required for this account \(credit card or bank\)\.$/.test(err) && !/</.test(err));
  ok("a test order says so on the order: the shipment's comments, in the WSDL's place", /<shar:shipReferences>T<\/shar:shipReferences><shar:comments>TEST ORDER — DO NOT PROCESS OR SHIP<\/shar:comments><shar:allowConsolidation>/.test(ps.psBuildPO_({ poNumber: "T", comments: "TEST ORDER — DO NOT PROCESS OR SHIP", shipTo: {}, lines: [] })) &&
    !/<shar:comments>/.test(ps.psBuildPO_({ poNumber: "T", shipTo: {}, lines: [] })));
  poMode = "ok"; calls.length = 0;
  const levels = await ps.psGetInventory(conn, "K540", ["1001", "1003"], vendorFetch);
  ok("stock: getInventoryLevels for the product, filtered to its parts, in the Inventory 2.0.0 WSDL's order", levels["1001"] === 100 && levels["1003"] === 2 && calls[0].action === '"getInventoryLevels"' && calls[0].url === URLS.inv &&
    /<shar:productId>K540<\/shar:productId><shar:Filter><shar:partIdArray><shar:partId>1001<\/shar:partId><shar:partId>1003<\/shar:partId><\/shar:partIdArray><\/shar:Filter><\/ns:GetInventoryLevelsRequest>/.test(calls[0].body));
  const parts = await ps.psGetParts(conn, "K540", {}, vendorFetch);
  ok("our color + size finds the supplier's part, ignoring case and spacing; an unknown one finds none", ps.psPartFor_(parts, "black", "2xl") === "1002" && ps.psPartFor_(parts, "Navy", " S ") === "1003" && ps.psPartFor_(parts, "Red", "S") === "");
  osnPackages = ["1Z999", "1Z999", "1Z888"]; calls.length = 0;
  const ships = await ps.psGetShipments(conn, "PO-1", vendorFetch);
  ok("shipments: Order Shipment Notification queried by PO number (query type 1), each tracking number once", ships.map(s => s.trackingNumber).join() === "1Z999,1Z888" && ships[0].carrier === "UPS" && ships[0].shipDate === "2026-10-22" &&
    calls[0].action === '"getOrderShipmentNotification"' && /<ns:queryType>1<\/ns:queryType><ns:referenceNumber>PO-1<\/ns:referenceNumber>/.test(calls[0].body));

  console.log("\n=== Ordering from Blanks to Order ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('shipFrom', '{"name":"Northside Stitch Co","street1":"1 Main St","city":"Anytown","state":"CO","zip":"80202","phone":"3035550100","email":"o@x.com"}');`);
  const keyEnv = { VENDOR_CREDENTIALS_KEY: "a-long-random-master-key-for-tests-0123456789" };
  global.fetch = vendorFetch;
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1, ...keyEnv }, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const sz = (list) => list.map(([size, purchasePrice]) => ({ size, purchasePrice, quantity: 0 }));
  const polo = (await lib.createBlank(d1, { name: "Silk Touch Polo", productType: "shirt", vendor: "SanMar", brand: "Port Authority", sku: "K540", color: "",
    colors: [{ color: "Black", sizes: sz([["S", 8.93], ["2XL", 9.93]]) }, { color: "Navy", sizes: sz([["S", 8.93]]) }, { color: "Red", sizes: sz([["S", 8.93]]) }] })).id;
  await lib.createProduct(d1, "acme", { productId: "polo", type: "shirt", name: "Acme Polo", pricingMode: "sized", sizePricing: { S: 30, "2XL": 32 }, visible: true, configurable: true, garmentColors: ["Black", "Navy", "Red"], locations: [] });
  for (const [c, s] of [["Black", "S"], ["Black", "2XL"], ["Navy", "S"], ["Red", "S"]]) await lib.setBlankLink(d1, "acme", "polo", c, s, polo, c, s);
  let n = 0;
  const placeOrder = async (items) => {
    const orderId = "O" + (++n);
    await lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Cust " + n, contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date(Date.now() + n * 1000).toISOString() },
      items.map(([size, qty, color]) => ({ productId: "polo", name: "Acme Polo", type: "shirt", size, qty, unitPrice: 30, config: { garmentColor: color, locations: [] } })));
    await d1.prepare("UPDATE orders SET paid=1 WHERE orderId=?").bind(orderId).run();
    return orderId;
  };
  const o1 = await placeOrder([["S", 3, "Black"], ["2XL", 1, "Black"]]);
  const o2 = await placeOrder([["S", 2, "Navy"]]);
  const o3 = await placeOrder([["S", 1, "Red"]]);
  let r = await call({ action: "saveVendorConnection", companyCode: "SanMar", name: "SanMar", endpoints: URLS, credentials: { id: "shop_user", password: "s3cret" } });
  const cid = r.body.id;
  ok("the connection keeps its Inventory, Purchase Order and Order Shipment Notification services", r.status === 200 && JSON.parse(d1.q("SELECT endpointsJson FROM vendor_connections WHERE id=?", cid)[0].endpointsJson).po === URLS.po);
  await call({ action: "linkVendorConnectionBlanks", id: cid, blankIds: [polo] });
  const bto = await lib.getBlanksToOrder(d1);
  const rowFor = (c, s) => bto.suppliers[0].rows.find(x => x.color === c && x.size === s);
  ok("Blanks to Order rows say which order lines they're for and which connection their blank uses", rowFor("Black", "S").items.length === 1 && rowFor("Black", "S").vendorConnectionId === cid && rowFor("Navy", "S").vendorPrice === null);

  for (const a of ["listSupplierOrders", "previewSupplierOrder", "placeSupplierOrder", "checkSupplierOrderShipments", "cancelSupplierOrder"]) {
    const m = await call({ action: a, connectionId: cid, lines: [] }, { role: "manager" }), s = await call({ action: a, connectionId: cid, lines: [] }, { role: "staff" });
    ok(`${a}: admin only — a manager and a worker are refused`, m.status === 403 && s.status === 403);
  }
  r = await call({ action: "listSupplierOrders" });
  ok("the admin gets the connections that can take orders, their ship methods, and every connection's company", r.status === 200 && r.body.connections.length === 1 && r.body.connections[0].stock === true &&
    r.body.connections[0].shipMethods[0].service === "GROUND" && r.body.companies[cid] === "SanMar");   // free shipping is per vendor now (test142)
  const want = [{ blankId: polo, color: "Black", size: "S", qty: 3 }, { blankId: polo, color: "Black", size: "2XL", qty: 1 }, { blankId: polo, color: "Navy", size: "S", qty: 2 }, { blankId: polo, color: "Red", size: "S", qty: 1 }];
  r = await call({ action: "previewSupplierOrder", connectionId: cid, lines: want });
  const pl = (c, s) => r.body.lines.find(x => x.color === c && x.size === s);
  ok("preview: each line's part, the supplier's stock and our price", r.status === 200 && pl("Black", "S").partId === "1001" && pl("Black", "S").available === 100 && pl("Black", "S").unitCents === 893 && r.body.stockChecked);
  ok("…a color the supplier doesn't have is a problem, named (a part problem — the window unticks it)", /no Red \/ S in style K540/.test(pl("Red", "S").problem) && pl("Red", "S").problemKind === "part");
  ok("…so is ordering more than it has", pl("Navy", "S").problem === "" && r.body.problems === 1);
  ok("…with the shop's address as the ship-to and a fresh PO number", r.body.shipTo.city === "Anytown" && !r.body.shipToMissing.length && /^PO-\d{8}-1$/.test(r.body.poNumber) && r.body.environment === "production");
  // OpenDecoDesk: the PO prefix is the shop's own (Global settings → Business profile), not a fixed code.
  let bp = await call({ action: "updateBusinessProfile", business: { name: "Northside Stitch Co", poPrefix: "ns" } });
  ok("the Business profile's purchase order prefix is kept (upper case)…", bp.status === 200 && bp.body.business.poPrefix === "NS");
  ok("…and starts the next PO number", /^NS-\d{8}-1$/.test((await call({ action: "previewSupplierOrder", connectionId: cid, lines: want })).body.poNumber));
  bp = await call({ action: "updateBusinessProfile", business: { name: "Northside Stitch Co", poPrefix: "N S!" } });
  ok("…a prefix with anything but letters and numbers is refused", bp.status === 400 && /only letters and numbers/.test(bp.body.message));
  ok("…it isn't shown to customers", !/poPrefix/.test(read("functions/_lib/db.js").match(/const BUSINESS_PUBLIC_FIELDS = \[[^\]]*\]/)[0]));
  await call({ action: "updateBusinessProfile", business: { name: "Northside Stitch Co", poPrefix: "" } });
  ok("OpenDecoDesk lists no SanMar ship-method codes: the window offers UPS Ground", !ps.PS_OVERRIDES.SanMar.shipMethods &&
    JSON.stringify(so.supplierShipMethods("SanMar")) === JSON.stringify([{ carrier: "UPS", service: "GROUND", label: "UPS Ground" }]));
  down = true;
  const offline = await call({ action: "previewSupplierOrder", connectionId: cid, lines: want.slice(0, 2) });
  down = false;
  ok("the supplier not answering is a 'lookup' problem, reported for the whole order (lines aren't unticked for it)", offline.body.lines.every(x => x.problemKind === "lookup") && /couldn't be reached/.test(offline.body.lookupError));
  stock["1003"] = 1;
  r = await call({ action: "previewSupplierOrder", connectionId: cid, lines: want.slice(0, 3) });
  ok("…only 1 Navy S left: 'Only 1 in stock'", /Only 1 in stock/.test(pl("Navy", "S").problem));
  stock["1003"] = 2;
  r = await call({ action: "previewSupplierOrder", connectionId: cid, lines: [{ blankId: polo, color: "Black", size: "S", qty: 1.5 }] });
  ok("a quantity that isn't a whole number is refused", r.status === 400 && /whole number/.test(r.body.message));
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines: want, itemIds: [], carrier: "UPS", service: "GROUND", poNumber: "PO-TEST-1" });
  ok("placing refuses while any line has a problem (nothing saved, nothing sent)", r.status === 409 && r.body.code === "problems" && !d1.q("SELECT 1 FROM supplier_orders").length);
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines: want.slice(0, 3), itemIds: [], carrier: "FEDEX", service: "OVERNIGHT", poNumber: "PO-TEST-1" });
  ok("…and refuses a ship method the supplier doesn't offer", r.status === 400 && /ship method/.test(r.body.message));

  const allItems = bto.suppliers[0].rows.flatMap(x => x.items);
  calls.length = 0;
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines: want.slice(0, 3).map(l => Object.assign({}, l, { unitCents: 1, partId: "EVIL" })), itemIds: allItems.concat([999999]),
    carrier: "UPS", service: "GROUND", poNumber: "PO-TEST-1" });
  const poSent = calls.find(c => /SendPORequest/.test(c.body));
  ok("placing the order sends it with the parts and prices worked out here, not what the browser sent", r.status === 200 && r.body.order.status === "placed" && r.body.order.transactionId === "TX-5877-1679510682389" &&
    /<shar:partId>1001<\/shar:partId>/.test(poSent.body) && !/EVIL/.test(poSent.body) && /<ns:totalAmount>54\.58<\/ns:totalAmount>/.test(poSent.body));
  const items = d1.q("SELECT id, orderId, blankOrderedAt, blankVendor, blankVendorOrderId FROM order_items ORDER BY id");
  ok("…the order lines for those blanks are marked blanks ordered, with the supplier and PO number", items.filter(i => [o1, o2].includes(i.orderId)).every(i => i.blankOrderedAt && i.blankVendor === "SanMar" && i.blankVendorOrderId === "PO-TEST-1") && r.body.marked === 3);
  ok("…the Red line (not in the order) and an id that isn't one of these blanks' lines are left alone", !items.find(i => i.orderId === o3).blankOrderedAt);
  ok("…and so is each order's summary", d1.q("SELECT blankVendorOrderId FROM orders WHERE orderId=?", o1)[0].blankVendorOrderId === "PO-TEST-1");
  ok("…it's recorded, and audited", d1.q("SELECT status, totalCents FROM supplier_orders WHERE poNumber='PO-TEST-1'")[0].status === "placed" &&
    d1.q("SELECT detail FROM audit_log WHERE action='supplier_order.placed'").some(a => /PO-TEST-1/.test(a.detail) && /"linesMarked":3/.test(a.detail) && !/s3cret/.test(a.detail)));
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines: want.slice(0, 1), itemIds: [], carrier: "UPS", service: "GROUND", poNumber: "PO-TEST-1" });
  ok("the same PO number can't be placed twice (a double click)", r.status === 409 && /already been used/.test(r.body.message) && calls.filter(c => /SendPORequest/.test(c.body)).length === 1);
  ok("…and the next suggested PO number moves on", /^PO-\d{8}-1$/.test((await call({ action: "previewSupplierOrder", connectionId: cid, lines: want.slice(0, 1) })).body.poNumber));

  poMode = "refused";
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines: want.slice(0, 1), itemIds: [], carrier: "UPS", service: "GROUND", poNumber: "PO-TEST-2" });
  ok("a refused order says why, is saved as refused and marks nothing", r.status === 502 && r.body.code === "failed" && /Payment method on file declined/.test(r.body.message) && r.body.order.status === "failed");
  poMode = "timeout";
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines: want.slice(0, 1), itemIds: [], carrier: "UPS", service: "GROUND", poNumber: "PO-TEST-3" });
  ok("no answer at all is 'unknown' — check the supplier's site before sending again", r.status === 502 && r.body.code === "unknown" && /isn't known whether/.test(r.body.message));
  poMode = "ok"; calls.length = 0;
  const unknownId = r.body.order.id;
  r = await call({ action: "placeSupplierOrder", retryId: unknownId });
  ok("Send again resends the same lines with the same PO number", r.status === 200 && r.body.order.status === "placed" && /<ns:orderNumber>PO-TEST-3<\/ns:orderNumber>/.test(calls.find(c => /SendPORequest/.test(c.body)).body));
  r = await call({ action: "placeSupplierOrder", retryId: unknownId });
  ok("…but a placed order can't be sent again", r.status === 409);
  d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('shipFrom', '{"name":"x","street1":"","city":"Anytown","state":"CO","zip":""}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  r = await call({ action: "placeSupplierOrder", connectionId: cid, lines: want.slice(0, 1), itemIds: [], carrier: "UPS", service: "GROUND", poNumber: "PO-TEST-4" });
  ok("an incomplete ship-from address is refused, naming what's blank", r.status === 400 && /street, ZIP/.test(r.body.message));
  d1._raw.exec(`UPDATE global_settings SET value='{"name":"Northside Stitch Co","street1":"1 Main St","city":"Anytown","state":"CO","zip":"80202"}' WHERE key='shipFrom';`);

  r = await call({ action: "saveVendorConnection", companyCode: "SanMar", name: "SanMar test", endpoints: Object.assign({}, URLS, { environment: "test" }), credentials: { id: "edev", password: "edev" } });
  const testCid = r.body.id;
  // (OpenDecoDesk: whatever the shop's own purchase order prefix is.)
  await call({ action: "updateBusinessProfile", business: { name: "Northside Stitch Co", poPrefix: "NS" } });
  r = await call({ action: "previewSupplierOrder", connectionId: testCid, lines: want.slice(0, 1) });
  ok("on a test connection the PO number starts TEST-", r.status === 200 && /^TEST-\d{8}-1$/.test(r.body.poNumber) && r.body.environment === "test");
  await call({ action: "updateBusinessProfile", business: { name: "Northside Stitch Co", poPrefix: "" } });
  calls.length = 0;
  r = await call({ action: "placeSupplierOrder", connectionId: testCid, lines: want.slice(0, 1), itemIds: [], carrier: "UPS", service: "GROUND" });
  const testPo = calls.find(c => /SendPORequest/.test(c.body));
  ok("…and the order sent says it's a test", r.status === 200 && /<ns:orderNumber>TEST-\d{8}-1<\/ns:orderNumber>/.test(testPo.body) && /<shar:comments>TEST ORDER — DO NOT PROCESS OR SHIP<\/shar:comments>/.test(testPo.body));
  ok("a production order carries no test comment", !/<shar:comments>/.test(poSent.body));

  console.log("\n=== Shipments ===");
  osnPackages = ["1ZSANMAR1"];
  const placed = d1.q("SELECT id FROM supplier_orders WHERE poNumber='PO-TEST-1'")[0].id;
  r = await call({ action: "checkSupplierOrderShipments", id: placed });
  const ship = d1.q("SELECT * FROM blank_shipments WHERE trackingNumber='1ZSANMAR1'")[0];
  ok("Check shipments turns a tracking number the supplier reports into a blank shipment of the order's lines", r.status === 200 && r.body.added === 1 && ship && ship.supplierPoNumber === "PO-TEST-1" && ship.carrier === "UPS" &&
    d1.q("SELECT count(*) n FROM blank_shipment_items WHERE shipmentId=?", ship.id)[0].n === 3);
  ok("…which marks those lines shipped", d1.q("SELECT blankShippedAt FROM order_items WHERE orderId=?", o1).every(x => x.blankShippedAt === "2026-10-22"));
  r = await call({ action: "checkSupplierOrderShipments", id: placed });
  ok("…and is added only once", r.body.added === 0 && d1.q("SELECT count(*) n FROM blank_shipments WHERE trackingNumber='1ZSANMAR1'")[0].n === 1);
  ok("the list shows each order with its shipments", r.body.orders.find(o => o.poNumber === "PO-TEST-1").shipments[0].trackingNumber === "1ZSANMAR1");
  osnPackages = ["1ZSANMAR2"];
  for (let i = 0; i < 12; i++) d1._raw.exec(`INSERT INTO supplier_orders (connectionId, vendor, poNumber, status, createdAt, placedAt, itemIdsJson) VALUES (${cid}, 'SanMar', 'BULK-${i}', 'placed', '${new Date().toISOString()}', '${new Date().toISOString()}', '[]')`);
  calls.length = 0;
  const morning = await built.checkSupplierShipments({ DB: d1, ...keyEnv }, { limit: 10 });
  ok("the 6 AM check asks about at most its share of the budget (10 orders)", calls.filter(c => /GetOrderShipmentNotificationRequest/.test(c.body)).length === 10 && morning.checked === 10);
  ok("…and the roll-up runs it before the blank-shipment check", /checkSupplierShipments\(env[\s\S]*checkBlankShipments\(env/.test(read("functions/api/daily-digest.js")));

  console.log("\n=== The screens ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sentUi = [];
  let confirmed = 0;
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#blankorder", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => { confirmed++; return true; }); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sentUi.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "manager", name: "M", email: "m@x" };');
  const wait = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return fn(); };
  // A new paid order so there's something to buy again.
  const o4 = await placeOrder([["S", 4, "Black"], ["S", 1, "Navy"]]);
  await w.renderBlanksToOrder(d.getElementById("app"));
  await wait(() => d.querySelector(".bto-supplier"));
  ok("a manager sees Blanks to Order and Copy list, but no Order button and no supplier orders", d.querySelector(".bto-copy") && !d.querySelector(".bto-order") && !d.getElementById("btoSupplierOrders") && !d.querySelector(".bto-not-orderable") &&
    !sentUi.some(b => b.action === "listSupplierOrders"));
  // A SanMar blank that isn't linked to the connection, needed by an open order.
  const tee = (await lib.createBlank(d1, { name: "Core Tee", productType: "shirt", vendor: "SanMar", brand: "Port & Co", sku: "PC54", color: "", colors: [{ color: "Navy", sizes: sz([["M", 3.5]]) }] })).id;
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Acme Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true });
  await lib.setBlankLink(d1, "acme", "tee", "", "M", tee, "Navy", "M");
  await lib.insertOrder(d1, { orderId: "OT1", orgId: "acme", customerName: "T", contact: "t@x.com", paymentMethod: "Venmo", placedAt: new Date().toISOString() }, [{ productId: "tee", name: "Acme Tee", type: "shirt", size: "M", qty: 2, unitPrice: 20 }]);
  await d1.prepare("UPDATE orders SET paid=1 WHERE orderId='OT1'").run();
  w.eval('adminMe = { role: "admin", name: "A", email: "a@x" };');
  await w.renderBlanksToOrder(d.getElementById("app"));
  await wait(() => d.querySelector(".bto-order"));
  ok("a line whose blank isn't linked to a connection is named under the table, with how to fix it", /Core Tee \(PC54\)/.test((d.querySelector(".bto-not-orderable") || {}).textContent || "") &&
    /isn't linked to a vendor connection/.test(d.querySelector(".bto-not-orderable").textContent));
  ok("an admin gets Order from SanMar… and the orders placed with suppliers", /Order from SanMar/.test(d.querySelector(".bto-order").textContent) && /PO-TEST-1/.test(d.getElementById("btoSupplierOrders").textContent) &&
    /1ZSANMAR1/.test(d.getElementById("btoSupplierOrders").textContent));
  d.querySelector(".bto-order").click();
  await wait(() => d.getElementById("soPlace") && !d.getElementById("soPlace").disabled);
  ok("the order window checks stock and prices straight away: Place order with the total", !d.getElementById("soPlace").disabled && /\$44\.65/.test(d.getElementById("soPlace").textContent) &&
    sentUi.some(b => b.action === "previewSupplierOrder") && /Everything ticked is in stock/.test(d.getElementById("soMsg").textContent) && /^PO-\d{8}-1$/.test(d.getElementById("soPo").value));
  ok("…a line the supplier can't supply (Red) is unticked, saying so; the rest can go", d.querySelectorAll(".so-on:not(:checked)").length === 1 && /1 line the supplier can't supply was unticked/.test(d.getElementById("soMsg").textContent));
  const qty = d.querySelector(".so-qty");
  qty.value = "500"; qty.dispatchEvent(new w.Event("input"));
  ok("changing a quantity needs a fresh check before placing", d.getElementById("soPlace").disabled && /check stock/.test(d.getElementById("soMsg").textContent));
  d.getElementById("soCheck").click();
  await wait(() => /Only 100 in stock/.test(d.getElementById("soLines").textContent));
  ok("…and too many shows the supplier's stock as the problem, Place stays off", /Only 100 in stock/.test(d.getElementById("soLines").textContent) && d.getElementById("soPlace").disabled);
  qty.value = "4"; qty.dispatchEvent(new w.Event("input"));
  d.getElementById("soCheck").click();
  await wait(() => !d.getElementById("soPlace").disabled);
  d.getElementById("soPlace").click();
  await wait(() => d.getElementById("soDone"));
  const placeUi = sentUi.filter(b => b.action === "placeSupplierOrder").pop();
  ok("Place order asks to confirm, sends the lines and their order lines, and says what was marked", confirmed >= 1 && placeUi && placeUi.itemIds.length === 2 && placeUi.carrier === "UPS" &&
    /placed with SanMar/.test(d.body.textContent) && /2 order lines are now marked blanks ordered/.test(d.body.textContent));
  ok("…and the lines are marked on the order", d1.q("SELECT blankVendorOrderId FROM order_items WHERE orderId=?", o4).every(x => /^PO-\d{8}-1$/.test(x.blankVendorOrderId)));
  d.getElementById("soDone").click();
  await wait(() => d.querySelector(".so-receive"));
  const recv = w.supplierOrderReceivePrefill_((await call({ action: "listSupplierOrders" })).body.orders.find(o => o.poNumber === "PO-TEST-1"));
  ok("Receive… fills in Receive order: the supplier, the PO number, one box per blank with each line at what it cost", recv.vendor === "SanMar" && recv.vendorRef === "PO-TEST-1" && recv.groups.length === 1 &&
    recv.groups[0].blankId === polo && recv.groups[0].lines.find(l => l.color === "Black" && l.size === "S").total === 26.79);
  ok("Send again is offered on an order that was refused", d.querySelector(".so-retry") !== null);

  console.log("\n=== Cancelled with the supplier ===");
  const uiOrder = (await call({ action: "listSupplierOrders" })).body.orders.find(o => o.poNumber === placeUi.poNumber);
  ok("a placed order offers Mark cancelled…", d.querySelector(`.so-cancel[data-id="${uiOrder.id}"]`) !== null);
  d.querySelector(`.so-cancel[data-id="${uiOrder.id}"]`).click();
  // The shared confirm window (confirmModal_): type the reason, then Mark cancelled.
  await wait(() => d.getElementById("cmReason"));
  d.getElementById("cmReason").value = "Ordered by mistake";
  d.getElementById("cmOk").click();
  await wait(() => /Cancelled at the supplier/.test((d.getElementById("btoSupplierOrders") || {}).textContent || ""));
  const after = d1.q("SELECT blankOrderedAt, blankVendor, blankVendorOrderId FROM order_items WHERE orderId=?", o4);
  ok("Mark cancelled takes the PO number off its order lines (they're back to be ordered)", after.every(x => x.blankOrderedAt === null && x.blankVendorOrderId === "" && x.blankVendor === "") &&
    d1.q("SELECT blankOrderedAt FROM orders WHERE orderId=?", o4)[0].blankOrderedAt === null);
  ok("…shows it cancelled with the reason, with no more Check shipments / Receive / Mark cancelled", /Cancelled at the supplier/.test(d.getElementById("btoSupplierOrders").textContent) && /Ordered by mistake/.test(d.getElementById("btoSupplierOrders").textContent) &&
    !d.querySelector(`.so-cancel[data-id="${uiOrder.id}"]`) && !d.querySelector(`.so-receive[data-id="${uiOrder.id}"]`));
  ok("…and it's audited", d1.q("SELECT detail FROM audit_log WHERE action='supplier_order.cancelled'").some(a => new RegExp(placeUi.poNumber).test(a.detail) && /"linesUnmarked":2/.test(a.detail)));
  r = await call({ action: "cancelSupplierOrder", id: uiOrder.id });
  ok("…it can't be cancelled twice", r.status === 409);
  r = await call({ action: "cancelSupplierOrder", id: d1.q("SELECT id FROM supplier_orders WHERE poNumber='PO-TEST-2'")[0].id });
  ok("…and a refused order (never placed) can't be marked cancelled", r.status === 409);
  const shippedPo = d1.q("SELECT id FROM supplier_orders WHERE poNumber='PO-TEST-1'")[0].id;
  r = await call({ action: "cancelSupplierOrder", id: shippedPo });
  ok("cancelling an order whose lines already shipped leaves those lines alone", r.status === 200 && r.body.unmarked === 0 && d1.q("SELECT blankVendorOrderId FROM order_items WHERE orderId=?", o1).every(x => x.blankVendorOrderId === "PO-TEST-1"));
  calls.length = 0;
  await built.checkSupplierShipments({ DB: d1, ...keyEnv }, { limit: 50 });
  ok("the shipment checks skip cancelled orders", !calls.some(c => new RegExp("<ns:referenceNumber>(" + placeUi.poNumber + "|PO-TEST-1)<").test(c.body)));

  console.log("\n=== The connection screen ===");
  w.eval("ADMIN_NAV_TOOLS");
  ok("the connection form lists the ordering services and saves them", /row\("inv", false\)\}\$\{row\("po", false\)\}\$\{row\("osn", false\)\}/.test(adminJs) && /po: url\("po"\), osn: url\("osn"\)/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test139 crashed: false"); process.exit(1); });
