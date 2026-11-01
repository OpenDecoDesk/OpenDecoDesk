const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Vendor connections through PromoStandards (migrations/0065, Parts C + D of "pricing by color"). One adapter
// for every supplier in the PromoStandards directory: Product Data (getProduct), Pricing & Configuration
// (getFobPoints + getConfigurationAndPricing, Customer price) and Media Content (getMediaContent) become the
// same vendor product as a vendor's download file, for the same review window. Logins are AES-GCM encrypted
// under VENDOR_CREDENTIALS_KEY and never sent back. The vendors' SOAP is recorded below in the shapes of the
// published WSDLs (namespaces as SanMar's live ones); `fetch` is mocked.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const psSrc = strip(read("functions/_lib/promostandards.js")), credSrc = strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/vendorLog.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, getAllBlanks };`)();
const ps = new Function(psSrc + `\nreturn { readXml_, xmlAll_, psXmlText_, soapCall_, searchPsCompanies, getPsEndpoints, fetchVendorProduct, psProductId_, psGetParts, psPartFor_, psIsImageUrl_ };`)();
const vc = new Function(credSrc + `\nreturn { encryptVendorCredentials, decryptVendorCredentials, vendorCredentialsReady };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + psSrc + "\n" + credSrc + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// ---- Recorded vendor answers ----
const env = (body) => `<?xml version="1.0" encoding="UTF-8"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>${body}</S:Body></S:Envelope>`;
const P = 'xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"';
const part = (id, color, hex, size) => `<ns2:ProductPart><ns2:partId>${id}</ns2:partId><ns2:ColorArray><ns2:Color><ns2:hex>${hex}</ns2:hex><ns2:colorName>${color}</ns2:colorName></ns2:Color></ns2:ColorArray><ns2:ApparelSize><ns2:apparelStyle>Unisex</ns2:apparelStyle><ns2:labelSize>${size}</ns2:labelSize></ns2:ApparelSize></ns2:ProductPart>`;
const PRODUCT = env(`<GetProductResponse ${P}><Product><ns2:productId>K540</ns2:productId><ns2:productName>Port Authority Silk Touch Performance Polo</ns2:productName>
  <ns2:description>A legendary polo &amp; harder working.</ns2:description><ns2:ProductMarketingPointArray><ns2:ProductMarketingPoint><ns2:pointType>Feature</ns2:pointType><ns2:pointCopy>3.8-ounce, 100% polyester</ns2:pointCopy></ns2:ProductMarketingPoint>
  <ns2:ProductMarketingPoint><ns2:pointCopy>Moisture-wicking</ns2:pointCopy></ns2:ProductMarketingPoint></ns2:ProductMarketingPointArray>
  <ns2:productBrand>Port Authority</ns2:productBrand><ns2:ProductCategoryArray><ns2:ProductCategory><ns2:category>Polos/Knits</ns2:category><ns2:subCategory>Easy Care</ns2:subCategory></ns2:ProductCategory></ns2:ProductCategoryArray>
  <ns2:ProductPartArray>${part("K540-B-S", "Black", "000000", "S")}${part("K540-B-2XL", "Black", "000000", "2XL")}${part("K540-N-S", "Navy", "1F2A44", "S")}</ns2:ProductPartArray></Product></GetProductResponse>`);
const C = 'xmlns:ns2="http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/"';
const FOB = env(`<GetFobPointsResponse ${C}><FobPointArray><FobPoint><ns2:fobId>RENO</ns2:fobId><fobCity>Reno</fobCity></FobPoint></FobPointArray></GetFobPointsResponse>`);
const price = (id, tiers) => `<Part><ns2:partId>${id}</ns2:partId><PartPriceArray>${tiers.map(([q, p]) => `<PartPrice><minQuantity>${q}</minQuantity><price>${p}</price></PartPrice>`).join("")}</PartPriceArray><ns2:partGroup>1</ns2:partGroup></Part>`;
const PRICES = env(`<GetConfigurationAndPricingResponse ${C}><Configuration><PartArray>${price("K540-B-S", [[72, "8.43"], [1, "8.9300"]])}${price("K540-B-2XL", [[1, "9.93"]])}${price("K540-N-S", [[1, "8.93"]])}</PartArray></Configuration></GetConfigurationAndPricingResponse>`);
const M = 'xmlns:ns2="http://www.promostandards.org/WSDL/MediaService/1.0.0/SharedObjects/" xmlns="http://www.promostandards.org/WSDL/MediaService/1.0.0/"';
const media = (pid, url, cls) => `<MediaContent><ns2:productId>K540</ns2:productId><ns2:partId>${pid}</ns2:partId><url>${url}</url><ns2:mediaType>Image</ns2:mediaType><ClassTypeArray><ClassType><classTypeId>${cls[0]}</classTypeId><classTypeName>${cls[1]}</classTypeName></ClassType></ClassTypeArray></MediaContent>`;
const MEDIA = env(`<GetMediaContentResponse ${M}><MediaContentArray>${media("K540-B-S", "https://cdnm.sanmar.com/imglib/mresjpg/2013/f5/K540_black_model_front.jpg", [1007, "Front"])}${media("K540-B-S", "https://cdnm.sanmar.com/imglib/mresjpg/2013/f5/K540_black_model_back.jpg", [1008, "Rear"])}${media("K540-N-S", "https://cdnm.sanmar.com/imglib/mresjpg/2013/f5/K540_navy_model_front.jpg", [1007, "Front"])}</MediaContentArray></GetMediaContentResponse>`);
const FAULT = env(`<S:Fault><faultcode>S:Server</faultcode><faultstring>Authentication Credentials failed</faultstring></S:Fault>`);
const NOPRODUCT = env(`<GetProductResponse ${P}><ServiceMessageArray><ns2:ServiceMessage><ns2:code>130</ns2:code><ns2:description>Product Id not found</ns2:description><ns2:severity>Error</ns2:severity></ns2:ServiceMessage></ServiceMessageArray></GetProductResponse>`);
const DIRECTORY = JSON.stringify([{ Code: "SanMar", Name: "SanMar", Type: "Supplier" }, { Code: "SS", Name: "S&S Activewear", Type: "Supplier" }, { Code: "s&scustomdesigns", Name: "S&S Custom Designs", Type: "Distributor" }, { Code: "OTTO", Name: "OTTO Cap", Type: "Supplier" }]);
const ENDPOINTS = JSON.stringify([
  { Service: { ServiceType: { Code: "Product", Name: "Product Data" }, Status: "Production", Version: "1.0.0" }, URL: "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBinding?WSDL", TestURL: "" },
  { Service: { ServiceType: { Code: "Product", Name: "Product Data" }, Status: "Production", Version: "2.0.0" }, URL: "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2?WSDL", TestURL: "https://edev-ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2?WSDL" },
  { Service: { ServiceType: { Code: "PPC", Name: "Product Pricing and Configuration" }, Status: "Production", Version: "1.0.0" }, URL: "https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding?WSDL", TestURL: "" },
  { Service: { ServiceType: { Code: "MED", Name: "Media Content" }, Status: "Production", Version: "1.1.0" }, URL: "https://ws.sanmar.com:8080/promostandards/MediaContentServiceBinding?WSDL", TestURL: "" },
  { Service: { ServiceType: { Code: "INV", Name: "Inventory" }, Status: "Production", Version: "2.0.0" }, URL: "https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final?WSDL", TestURL: "" }]);

const calls = [];
let soapMode = "ok";
const vendorFetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith("/json/companies")) return new Response(DIRECTORY, { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/json/companies/SanMar/endpoints")) return new Response(ENDPOINTS, { status: 200 });
  if (url.includes("/json/companies/")) return new Response(JSON.stringify({ success: false, message: "Invalid company code" }), { status: 200 });
  const body = String(init.body || "");
  calls.push({ url, action: (init.headers || {}).SOAPAction, body });
  if (soapMode === "fault") return new Response(FAULT, { status: 500 });
  if (/GetProductRequest/.test(body)) return new Response(/<shar:productId>NOPE</.test(body) ? NOPRODUCT : PRODUCT, { status: 200 });
  if (/GetFobPointsRequest/.test(body)) return new Response(FOB, { status: 200 });
  if (/GetConfigurationAndPricingRequest/.test(body)) return new Response(PRICES, { status: 200 });
  if (/GetMediaContentRequest/.test(body)) return new Response(MEDIA, { status: 200 });
  return new Response("", { status: 404 });
};
const conn = { name: "SanMar", companyCode: "SanMar", endpoints: { product: "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2", ppc: "https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding", media: "https://ws.sanmar.com:8080/promostandards/MediaContentServiceBinding" },
  credentials: { id: "pcw_user", password: "s3cret&<pw>" }, overrides: {} };

(async () => {
  console.log("=== The XML reader and SOAP ===");
  const t = ps.readXml_(`<?xml version="1.0"?><a:Root xmlns:a="x"><a:item n="1">One &amp; two</a:item><b:item><![CDATA[<raw>]]></b:item><empty/></a:Root>`);
  ok("prefixes dropped, entities and CDATA read, attributes kept", ps.xmlAll_(t, "item").map(n => n.text).join("|") === "One & two|<raw>" && ps.xmlAll_(t, "item")[0].attrs.n === "1" && ps.xmlAll_(t, "empty").length === 1);
  calls.length = 0;
  const p = await ps.fetchVendorProduct(conn, "K540", {}, vendorFetch);
  const getProduct = calls.find(c => /GetProductRequest/.test(c.body)), pricing = calls.find(c => /GetConfigurationAndPricingRequest/.test(c.body));
  ok("each request is a SOAP 1.1 envelope in the service's namespaces, with its SOAPAction", getProduct.action === '"getProduct"' && getProduct.url === conn.endpoints.product &&
    getProduct.body.includes('xmlns:ns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"') && getProduct.body.includes('xmlns:shar="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/"') &&
    /<ns:GetProductRequest><shar:wsVersion>2\.0\.0<\/shar:wsVersion><shar:id>pcw_user<\/shar:id><shar:password>s3cret&amp;&lt;pw&gt;<\/shar:password><shar:localizationCountry>US<\/shar:localizationCountry><shar:localizationLanguage>en<\/shar:localizationLanguage><shar:productId>K540<\/shar:productId><\/ns:GetProductRequest>/.test(getProduct.body));
  ok("…pricing asks for the account's (Customer) blank price at the FOB the vendor named, fields in the WSDL's order", pricing.action === '"getConfigurationAndPricing"' &&
    /<shar:productId>K540<\/shar:productId><shar:currency>USD<\/shar:currency><shar:fobId>RENO<\/shar:fobId><shar:priceType>Customer<\/shar:priceType><shar:localizationCountry>US<\/shar:localizationCountry><shar:localizationLanguage>en<\/shar:localizationLanguage><shar:configurationType>Blank<\/shar:configurationType>/.test(pricing.body));
  ok("the vendor product: name, brand, description, bullet points, category", p.name === "Port Authority Silk Touch Performance Polo" && p.brand === "Port Authority" &&
    p.description === "A legendary polo & harder working." && p.features.join("|") === "3.8-ounce, 100% polyester|Moisture-wicking" && p.category === "Polos/Knits / Easy Care");
  ok("…each part's color (with hex) and size, priced at its quantity-1 price", p.colors.map(c => c.color + c.hex).join() === "Black#000000,Navy#1F2A44" && p.sizes.join() === "S,2XL" &&
    p.prices.Black.S === 8.93 && p.prices.Black["2XL"] === 9.93 && p.prices.Navy.S === 8.93);
  ok("…and each color's images with their view, file names kept for the image download", p.colors[0].images.map(i => i.type + ":" + i.fileName).join() === "front:K540_black_model_front.jpg,back:K540_black_model_back.jpg" &&
    p.colors[1].images[0].url.endsWith("K540_navy_model_front.jpg"));
  soapMode = "fault";
  let err = ""; try { await ps.fetchVendorProduct(conn, "K540", {}, vendorFetch); } catch (e) { err = e.message; }
  ok("a SOAP fault becomes a plain message", /Authentication Credentials failed/.test(err));
  soapMode = "ok"; err = "";
  try { await ps.fetchVendorProduct(conn, "NOPE", { media: false }, vendorFetch); } catch (e) { err = e.message; }
  ok("…and so does a PromoStandards error message", /Product Id not found/.test(err));

  console.log("\n=== A part's own color, not primaryColor; pictures only ===");
  // Shaped like SanMar's getProduct answer: every part opens with the product's primaryColor (the same "go to
  // market" color on each, which SanMar doesn't use), then its own ColorArray with a display name (standardColorName)
  // and a backend name (colorName). Reading the first Color in a part gave every part primaryColor's name.
  const pc = (id, std, name, size) => `<ns2:ProductPart><partId>${id}</partId><ns2:primaryColor><Color><standardColorName>Signal Red</standardColorName><colorName>SignalRed</colorName></Color></ns2:primaryColor>` +
    `<ns2:ColorArray><Color><standardColorName>${std}</standardColorName><colorName>${name}</colorName></Color></ns2:ColorArray><ApparelSize><apparelStyle>Unisex</apparelStyle><labelSize>${size}</labelSize></ApparelSize></ns2:ProductPart>`;
  const SM_PRODUCT = env(`<GetProductResponse ${P}><Product><ns2:productId>ST100</ns2:productId><ns2:productName>Sample Tee</ns2:productName><ns2:productBrand>Sample</ns2:productBrand>
    <ns2:ProductPartArray>${pc("1", "Deep Black", "DeepBlack", "S")}${pc("2", "Deep Black", "DeepBlack", "M")}${pc("3", "True Navy", "TrueNavy", "S")}${pc("4", "True Navy", "TrueNavy", "M")}</ns2:ProductPartArray></Product></GetProductResponse>`);
  const SM_PRICES = env(`<GetConfigurationAndPricingResponse ${C}><Configuration><PartArray>${price("1", [[1, "3.10"]])}${price("2", [[1, "3.20"]])}${price("3", [[1, "3.30"]])}${price("4", [[1, "3.40"]])}</PartArray></Configuration></GetConfigurationAndPricingResponse>`);
  const smMedia = (pid, url) => `<MediaContent><ns2:productId>ST100</ns2:productId><ns2:partId>${pid}</ns2:partId><url>${url}</url><ns2:mediaType>Image</ns2:mediaType></MediaContent>`;
  const SM_MEDIA = env(`<GetMediaContentResponse ${M}><MediaContentArray>${smMedia("1", "https://img.example/st100_black_front.jpg")}${smMedia("1", "https://img.example/st100_black.glb")}${smMedia("3", "https://img.example/st100_navy_front.JPG?v=2")}${smMedia("3", "https://img.example/st100_navy_spin.mp4")}</MediaContentArray></GetMediaContentResponse>`);
  const smFetch = async (url, init = {}) => {
    const body = String(init.body || "");
    if (/GetProductRequest/.test(body)) return new Response(SM_PRODUCT, { status: 200 });
    if (/GetFobPointsRequest/.test(body)) return new Response(env(`<GetFobPointsResponse ${C}><FobPointArray><FobPoint><fobId>1</fobId></FobPoint></FobPointArray></GetFobPointsResponse>`), { status: 200 });
    if (/GetConfigurationAndPricingRequest/.test(body)) return new Response(SM_PRICES, { status: 200 });
    if (/GetMediaContentRequest/.test(body)) return new Response(SM_MEDIA, { status: 200 });
    return new Response("", { status: 404 });
  };
  const smConn = { ...conn, name: "SanMar", companyCode: "SanMar", overrides: {} };
  const sm = await ps.fetchVendorProduct(smConn, "ST100", {}, smFetch);
  ok("every color comes back — each part's own ColorArray, never the shared primaryColor", sm.colors.map(c => c.color).join() === "Deep Black,True Navy" && !JSON.stringify(sm).includes("Signal"));
  ok("…SanMar shows its display name (standardColorName); prices land on the right color", sm.prices["Deep Black"].S === 3.1 && sm.prices["True Navy"].M === 3.4);
  const other = await ps.fetchVendorProduct({ ...smConn, name: "Other", companyCode: "OTHER" }, "ST100", {}, smFetch);
  ok("…another vendor shows colorName, as before", other.colors.map(c => c.color).join() === "DeepBlack,TrueNavy");
  ok("pictures only: the 3D model (.glb) and the video (.mp4) are left out, a .JPG with a query string kept", sm.colors[0].images.map(i => i.fileName).join() === "st100_black_front.jpg" &&
    sm.colors[1].images.map(i => i.fileName).join() === "st100_navy_front.JPG" && ps.psIsImageUrl_("https://x/y/noext") && !ps.psIsImageUrl_("https://x/a.usdz"));
  // SanMar repeats style-level pictures on every part, labelled with that part's color: the catalog's "Primary" photo
  // (one color's) and group shots. Kept, they put the same wrong front picture on every color.
  const smM = (pid, url, id, name, color) => `<MediaContent><productId>ST100</productId><partId>${pid}</partId><url>${url}</url><mediaType>Image</mediaType><ClassTypeArray><ClassType><classTypeId>${id}</classTypeId><classTypeName>${name}</classTypeName></ClassType></ClassTypeArray><color>${color}</color><singlePart>true</singlePart></MediaContent>`;
  const SHARED = env(`<GetMediaContentResponse ${M}><MediaContentArray>` +
    smM("1", "https://img.example/st100_black_back.jpg", 1008, "Rear", "Deep Black") + smM("1", "https://img.example/st100_black_front.jpg", 1007, "Front", "Deep Black") +
    smM("1", "https://img.example/catalog/ST100.jpg", 1006, "Primary", "Deep Black") + smM("1", "https://img.example/st100_black_sw.jpg", 1004, "Swatch", "Deep Black") +
    smM("1", "https://img.example/st100_group_model.jpg", 500, "Custom", "Deep Black") + smM("2", "https://img.example/st100_black_hi.jpg", 2001, "High", "Deep Black") +
    smM("3", "https://img.example/st100_navy_front.jpg", 1007, "Front", "True Navy") + smM("3", "https://img.example/catalog/ST100.jpg", 1006, "Primary", "True Navy") +
    smM("3", "https://img.example/st100_group_model.jpg", 500, "Custom", "True Navy") + `</MediaContentArray></GetMediaContentResponse>`);
  const sh = await ps.fetchVendorProduct(smConn, "ST100", {}, async (u, init = {}) => /GetMediaContentRequest/.test(String(init.body)) ? new Response(SHARED, { status: 200 }) : smFetch(u, init));
  const shBlack = sh.colors.find(c => c.color === "Deep Black").images, shNavy = sh.colors.find(c => c.color === "True Navy").images;
  ok("a picture the vendor puts on more than one color (SanMar's catalog Primary, group shots) isn't any color's picture", !JSON.stringify(sh.colors).includes("catalog/ST100.jpg") && !JSON.stringify(sh.colors).includes("group_model") &&
    shNavy.map(i => i.fileName).join() === "st100_navy_front.jpg");
  ok("…each color's own pictures stay, front first and the swatch last; SanMar's 2001 \"High\" isn't a swatch", shBlack[0].fileName === "st100_black_front.jpg" && shBlack[shBlack.length - 1].type === "swatch" &&
    shBlack.find(i => i.fileName === "st100_black_hi.jpg").type !== "swatch" && shBlack.length === 4);
  const one = await ps.fetchVendorProduct(smConn, "ST100", {}, async (u, init = {}) => {
    const b = String(init.body || "");
    if (/GetProductRequest/.test(b)) return new Response(env(`<GetProductResponse ${P}><Product><ns2:productId>ST100</ns2:productId><ns2:ProductPartArray>${pc("1", "Deep Black", "DeepBlack", "S")}</ns2:ProductPartArray></Product></GetProductResponse>`), { status: 200 });
    if (/GetMediaContentRequest/.test(b)) return new Response(SHARED, { status: 200 });
    return smFetch(u, init);
  });
  ok("…a style that comes in one color keeps every picture", JSON.stringify(one.colors).includes("catalog/ST100.jpg"));
  const parts = await ps.psGetParts(smConn, "ST100", {}, smFetch);
  ok("ordering: each color + size finds its own part — by the display name or SanMar's backend name", ps.psPartFor_(parts, "True Navy", "M") === "4" && ps.psPartFor_(parts, "Deep Black", "S") === "1" &&
    ps.psPartFor_(parts, "TrueNavy", "S") === "3" && ps.psPartFor_(parts, "Signal Red", "S") === "");
  const dupe = env(`<GetProductResponse ${P}><Product><ns2:productId>ST100</ns2:productId><ns2:ProductPartArray>${pc("1", "Deep Black", "DeepBlack", "S")}${pc("9", "Deep Black", "DeepBlack", "S")}${pc("3", "True Navy", "TrueNavy", "S")}</ns2:ProductPartArray></Product></GetProductResponse>`);
  const dParts = await ps.psGetParts(smConn, "ST100", {}, async (u, init = {}) => /GetProductRequest/.test(String(init.body)) ? new Response(dupe, { status: 200 }) : new Response("", { status: 404 }));
  ok("…two parts for the same color + size are never guessed between (refused), the others still match", ps.psPartFor_(dParts, "Deep Black", "S") === "" && dParts.ambiguous["deepblack|s"] && ps.psPartFor_(dParts, "True Navy", "S") === "3");
  ok("the vendor's product ID is the style # unless the connection says how to write it", ps.psProductId_(conn, "K540") === "K540" && ps.psProductId_({ overrides: { productIdFormat: "{brand} {style}" } }, "5100", "C2 Sport") === "C2 Sport 5100");

  console.log("\n=== The directory ===");
  const found = await ps.searchPsCompanies("s&s", vendorFetch);
  ok("searching the PromoStandards directory finds suppliers (not distributors)", found.length === 1 && found[0].code === "SS");
  const eps = await ps.getPsEndpoints("SanMar", vendorFetch);
  ok("…and a supplier's endpoints: the version this site speaks, with its test address", eps.product.pick.version === "2.0.0" && eps.product.pick.url === "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2" &&
    eps.product.pick.testUrl.startsWith("https://edev-ws.sanmar.com:8080/") && eps.ppc.pick.version === "1.0.0" && eps.media.pick.version === "1.1.0");

  console.log("\n=== Logins, encrypted ===");
  const keyEnv = { VENDOR_CREDENTIALS_KEY: "a-long-random-master-key-for-tests-0123456789" };
  const sealed = await vc.encryptVendorCredentials(keyEnv, { id: "pcw_user", password: "s3cret" });
  ok("a login is stored encrypted (no trace of it in the stored text)", !/pcw_user|s3cret/.test(sealed) && !/pcw_user/.test(Buffer.from(sealed, "base64").toString("latin1")));
  ok("…and reads back with the same key", JSON.stringify(await vc.decryptVendorCredentials(keyEnv, sealed)) === JSON.stringify({ id: "pcw_user", password: "s3cret" }));
  err = ""; try { await vc.decryptVendorCredentials({ VENDOR_CREDENTIALS_KEY: "a-different-key-entirely-9876543210" }, sealed); } catch (e) { err = e.message; }
  ok("…not with another key", /can't be read/.test(err));
  err = ""; try { await vc.encryptVendorCredentials({}, { id: "x", password: "y" }); } catch (e) { err = e.message; }
  ok("…and without the master key nothing is stored", /VENDOR_CREDENTIALS_KEY/.test(err) && !vc.vendorCredentialsReady({}) && vc.vendorCredentialsReady(keyEnv));

  console.log("\n=== The admin API ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  global.fetch = vendorFetch;
  const call = async (body, { role = "admin", envx = keyEnv } = {}) => { const res = await api({ env: { DB: d1, ...envx }, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const k540 = (await lib.createBlank(d1, { name: "Port Authority K540 Performance Polo", productType: "shirt", vendor: "SanMar", brand: "Port Authority", sku: "K540",
    colors: [{ color: "Black", images: [], sizes: [{ size: "S", purchasePrice: 8, quantity: 4 }] }] })).id;
  ok("a manager can't search the directory or connect a vendor", (await call({ action: "vendorDirectorySearch", q: "sanmar" }, { role: "manager" })).status === 403 &&
    (await call({ action: "saveVendorConnection", name: "x", companyCode: "x", endpoints: {} }, { role: "manager" })).status === 403);
  let r = await call({ action: "vendorDirectoryEndpoints", code: "SanMar" });
  ok("the admin gets the directory's endpoints and the vendor's login wording", r.status === 200 && r.body.endpoints.product.pick && r.body.labels.idLabel === "SanMar.com user name" && r.body.credentialsReady === true);
  const save = { action: "saveVendorConnection", companyCode: "SanMar", name: "SanMar", endpoints: { product: conn.endpoints.product, ppc: conn.endpoints.ppc, media: conn.endpoints.media }, credentials: { id: "pcw_user", password: "s3cret" } };
  r = await call(save, { envx: {} });
  ok("connecting without the master key is refused, saying what to set", r.status === 400 && /VENDOR_CREDENTIALS_KEY/.test(r.body.message));
  r = await call(Object.assign({}, save, { endpoints: { product: "http://ws.sanmar.com/x", ppc: conn.endpoints.ppc } }));
  ok("service addresses must be https", r.status === 400);
  r = await call(save);
  const cid = r.body.id;
  const row = d1.q("SELECT * FROM vendor_connections WHERE id=?", cid)[0];
  ok("the connection is saved with its login encrypted", r.status === 200 && row.credentialsEnc && !/s3cret|pcw_user/.test(row.credentialsEnc));
  r = await call({ action: "listVendorConnections" }, { role: "manager" });
  ok("listing connections never sends the login back — only that one is set", r.status === 200 && r.body.connections[0].hasCredentials === true && !JSON.stringify(r.body).includes("s3cret") && !JSON.stringify(r.body).includes(row.credentialsEnc));
  ok("…and it's audited (without the login)", d1.q("SELECT detail FROM audit_log WHERE action='vendor.connection_created'").some(a => /"credentials":"set"/.test(a.detail) && !/s3cret/.test(a.detail)));
  calls.length = 0;
  r = await call({ action: "testVendorConnection", id: cid, style: "K540" });
  ok("Test looks the style up with the stored login and marks the connection connected", r.status === 200 && r.body.product.colors.length === 2 &&
    calls.some(c => /<shar:id>pcw_user<\/shar:id><shar:password>s3cret<\/shar:password>/.test(c.body)) && d1.q("SELECT status FROM vendor_connections WHERE id=?", cid)[0].status === "ok");
  soapMode = "fault";
  r = await call({ action: "testVendorConnection", id: cid, style: "K540" });
  ok("a failing test says why and marks it as a problem", r.status === 502 && /Authentication Credentials failed/.test(r.body.message) &&
    d1.q("SELECT status, lastError FROM vendor_connections WHERE id=?", cid)[0].status === "error");
  soapMode = "ok";
  r = await call({ action: "linkVendorConnectionBlanks", id: cid, blankIds: [k540] });
  ok("blanks are linked to the connection", r.status === 200 && (await lib.getAllBlanks(d1)).find(b => b.id === k540).vendorConnectionId === cid);
  r = await call({ action: "fetchVendorProducts", connectionId: cid, styles: [{ style: "K540", brand: "Port Authority" }, { style: "NOPE" }] }, { role: "manager" });
  ok("a manager can fetch live products: one per style, a style the vendor doesn't have reported on its own", r.status === 200 && r.body.products.length === 1 && r.body.products[0].vendor === "SanMar" &&
    r.body.errors.length === 1 && /not found/.test(r.body.errors[0].message));
  const plan = (await call({ action: "previewVendorBlanks", products: r.body.products })).body.plans[0];
  ok("…which go through the same plan as a vendor file: the K540 on file, priced per color", plan.action === "update" && plan.blankId === k540 && plan.priceChanges === 1 && plan.newColors === 1);
  // A blank created or updated from a connection is linked to it (Order from <supplier> and Refresh go by the link).
  const fetched = r.body.products[0];
  ok("each fetched product says which connection it came from", fetched.connectionId === cid);
  await call({ action: "linkVendorConnectionBlanks", id: cid, blankIds: [] });
  let ap = await call({ action: "applyVendorBlanks", products: [fetched], selections: [{ key: plan.key, prices: true, colors: [], newSizes: false }], source: "Vendor (live)" });
  ok("updating an unlinked blank from a connection links it to that connection", ap.status === 200 && (await lib.getAllBlanks(d1)).find(b => b.id === k540).vendorConnectionId === cid);
  const fresh = Object.assign({}, fetched, { style: "K540NEW" });
  const newPlan = (await call({ action: "previewVendorBlanks", products: [fresh] })).body.plans[0];
  ap = await call({ action: "applyVendorBlanks", products: [fresh], selections: [{ key: newPlan.key, colors: ["Black"], create: {} }], source: "Vendor (live)" });
  const made = (await lib.getAllBlanks(d1)).find(b => b.sku === "K540NEW");
  ok("…and a blank created from a connection is linked from the start", newPlan.action === "create" && ap.status === 200 && made && made.vendorConnectionId === cid);
  const forged = Object.assign({}, fetched, { style: "K540FAKE", connectionId: 999 });
  const forgedPlan = (await call({ action: "previewVendorBlanks", products: [forged] })).body.plans[0];
  await call({ action: "applyVendorBlanks", products: [forged], selections: [{ key: forgedPlan.key, colors: ["Black"], create: {} }] });
  ok("…a connection that doesn't exist links nothing", (await lib.getAllBlanks(d1)).find(b => b.sku === "K540FAKE").vendorConnectionId === null);
  r = await call({ action: "saveVendorConnection", id: cid, name: "SanMar (main)", endpoints: { product: conn.endpoints.product, ppc: conn.endpoints.ppc, media: "" } });
  ok("editing without retyping the login keeps it", r.status === 200 && d1.q("SELECT credentialsEnc FROM vendor_connections WHERE id=?", cid)[0].credentialsEnc === row.credentialsEnc);
  r = await call({ action: "deleteVendorConnection", id: cid });
  ok("Disconnect deletes the connection and its login, and unlinks its blanks (they stay)", r.status === 200 && !d1.q("SELECT 1 FROM vendor_connections").length &&
    (await lib.getAllBlanks(d1)).find(b => b.id === k540).vendorConnectionId === null);

  console.log("\n=== The screens ===");
  r = await call(save);
  const cid2 = r.body.id;
  await call({ action: "linkVendorConnectionBlanks", id: cid2, blankIds: [k540] });
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/#vendors", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.URL.createObjectURL = () => "blob:x"; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  await w.renderVendorIntegrations(d.getElementById("app"));
  for (let i = 0; i < 100 && !d.querySelector(".vc-card"); i++) await new Promise(res => setTimeout(res, 10));
  ok("Vendor integrations lists the connection: its status and blanks linked", /SanMar/.test(d.querySelector(".vc-card").textContent) && /1 blank linked/.test(d.querySelector(".vc-card").textContent));
  ok("…and Tools has the page (admin only)", w.eval("ADMIN_NAV_TOOLS").some(x => x[0] === "vendors") && w.eval("adminPageRole_('vendors')") === "admin");
  d.getElementById("vcConnect").click();
  d.getElementById("vcQ").value = "sanmar"; d.getElementById("vcGo").click();
  for (let i = 0; i < 100 && !d.querySelector(".vcPick"); i++) await new Promise(res => setTimeout(res, 10));
  d.querySelector(".vcPick").click();
  for (let i = 0; i < 100 && !d.querySelector(".vcUrl"); i++) await new Promise(res => setTimeout(res, 10));
  ok("connecting: pick from the directory, and its service addresses come filled in", d.querySelector('.vcUrl[data-key="product"]').value === "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2" &&
    /SanMar\.com user name/.test(d.getElementById("vcStep").textContent));
  d.getElementById("vcTestEnv").checked = true; d.getElementById("vcTestEnv").dispatchEvent(new w.Event("change"));
  ok("…the TEST services box switches to the vendor's test addresses", d.querySelector('.vcUrl[data-key="product"]').value.startsWith("https://edev-ws.sanmar.com:8080/"));
  d.getElementById("vcTestEnv").checked = false; d.getElementById("vcTestEnv").dispatchEvent(new w.Event("change"));
  d.getElementById("vcId").value = "user2"; d.getElementById("vcPw").value = "pw2";
  ok("…the password box is masked", d.getElementById("vcPw").type === "password");
  d.getElementById("vcSave").click();
  for (let i = 0; i < 100 && !d.getElementById("vtStyle"); i++) await new Promise(res => setTimeout(res, 10));
  const saveSent = sent.filter(b => b.action === "saveVendorConnection").pop();
  ok("Connect saves it and goes straight to Test", saveSent && saveSent.credentials.id === "user2" && d.getElementById("vtStyle") && d1.q("SELECT count(*) n FROM vendor_connections")[0].n === 2);
  d.getElementById("vtStyle").value = "K540"; d.getElementById("vtGo").click();
  for (let i = 0; i < 100 && !/answered/.test(d.getElementById("vtOut").textContent); i++) await new Promise(res => setTimeout(res, 10));
  ok("…Test shows what the vendor sent back", /answered/.test(d.getElementById("vtOut").textContent) && /2 colors/.test(d.getElementById("vtOut").textContent) && /S \$8\.93/.test(d.getElementById("vtOut").textContent));
  w.eval("window._blanksAll = null;");
  w._blanksAll = (await call({ action: "getBlanks" })).body.blanks;
  w._vendorConnections = (await call({ action: "listVendorConnections" })).body.connections;
  w.refreshBlanksFromVendors_(null, () => {});
  for (let i = 0; i < 200 && !d.querySelector(".vb-card"); i++) await new Promise(res => setTimeout(res, 10));
  ok("Blanks → Refresh from vendor fetches the linked blanks live into the review window", d.querySelector(".vb-card") && /UPDATE/.test(d.querySelector(".vb-card").textContent) && /K540/.test(d.querySelector(".vb-card").textContent));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test129 crashed: false"); process.exit(1); });
