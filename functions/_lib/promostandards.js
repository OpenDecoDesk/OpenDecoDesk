// PromoStandards — the promotional-products industry's shared SOAP web services — as ONE adapter for every
// vendor that supports them (S&S Activewear, SanMar, OTTO Cap, … — 1,900 companies in its public directory).
// A vendor connection (vendor_connections, migrations/0065) says which company, which endpoint of each service
// and the account's id + password; everything else is the same for every vendor:
//   Product Data 2.0.0 getProduct            → name, brand, description, bullet points, categories, parts
//                                               (each part = one color + size, by partId)
//   Pricing & Configuration 1.0.0 getFobPoints + getConfigurationAndPricing (Customer price, Blank) → each
//                                               part's quantity-1 price
//   Media Content 1.1.0 getMediaContent (Image) → each part's / color's image URLs and their view
//   Inventory 2.0.0 getInventoryLevels         → each part's quantity available (all warehouses)
//   Purchase Order 1.0.0 sendPO                → places an order for blank parts (Blanks to Order)
//   Order Shipment Notification 1.0.0          → the tracking numbers of an order placed here
// fetchVendorProduct() returns the same vendor-product shape as a vendor's download file (db.js
// cleanVendorProduct_), so it goes through the same review window (planVendorBlanks / applyVendorBlanks).
// Namespaces and request field order are from the published WSDLs (checked against SanMar's live ones).
// Workers have no DOMParser, so a small XML reader is included (readXml_).

export const PS_DIRECTORY = "https://services.promostandards.org/WebServiceRepository/WebServiceRepository.svc/json";
export const PS_SERVICES = {
  product: { name: "Product Data", version: "2.0.0", ns: "http://www.promostandards.org/WSDL/ProductDataService/2.0.0/", shared: "http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/" },
  ppc: { name: "Product Pricing and Configuration", version: "1.0.0", ns: "http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/", shared: "http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/SharedObjects/" },
  media: { name: "Media Content", version: "1.1.0", ns: "http://www.promostandards.org/WSDL/MediaService/1.0.0/", shared: "http://www.promostandards.org/WSDL/MediaService/1.0.0/SharedObjects/" },
  inv: { name: "Inventory", version: "2.0.0", ns: "http://www.promostandards.org/WSDL/Inventory/2.0.0/", shared: "http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/" },
  po: { name: "Purchase Order", version: "1.0.0", ns: "http://www.promostandards.org/WSDL/PO/1.0.0/", shared: "http://www.promostandards.org/WSDL/PO/1.0.0/SharedObjects/" },
  osn: { name: "Order Shipment Notification", version: "1.0.0", ns: "http://www.promostandards.org/WSDL/OrderShipmentNotificationService/1.0.0/", shared: "http://www.promostandards.org/WSDL/OrderShipmentNotificationService/1.0.0/SharedObjects/" },
};
// The services a connection needs for each job; the rest are optional.
export const PS_REQUIRED = ["product", "ppc"];

// Small per-vendor differences, keyed by the directory's company code. Everything else is the standard.
export const PS_OVERRIDES = {
  SS: { idLabel: "S&S account number", passwordLabel: "S&S API key", help: "S&S Activewear → My Account → API access (the same account number and key as S&S's own API). To place orders, S&S also needs an integration payment method (credit card or bank) set in your S&S account settings.",
    orderHelp: "S&S charges orders placed here to the integration payment method in your S&S account settings. S&S's test address has placed real orders — treat any order from here as real." },
  SanMar: { idLabel: "SanMar.com user name", passwordLabel: "SanMar.com password", help: "SanMar's web services must be turned on for your account first — ask your SanMar rep or sanmarintegrations@sanmar.com.",
    // Placing orders (Purchase Order) is turned on separately by SanMar. Its ship-method codes aren't listed here: the
    // order window offers UPS Ground, which every supplier takes.
    // A part's color name to show: SanMar's standardColorName is the display name ("Deep Black", the SDL file's
    // COLOR_NAME); its colorName is the backend name ("DeepBlack"). Other vendors' colorName is the display name.
    colorName: "standard" },
  OTTO: { idLabel: "OTTO account / user ID", passwordLabel: "OTTO password or key", help: "Ask OTTO Cap's customer service for PromoStandards access." },
};

// ---- XML ------------------------------------------------------------------------------------------------
// A tree of {name (local name, prefix dropped), attrs, children, text}. Enough for SOAP responses: no DTDs.
export function readXml_(xml) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const decode = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {};
      for (const a of (m[4] || "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, "")] = decode(a[2] != null ? a[2] : a[3]);
      const node = { name: m[3].replace(/^.*:/, ""), attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] != null) top.text += decode(m[6]);
  }
  return root;
}
// Every descendant named `name` (any depth).
export function xmlAll_(node, name, out = []) {
  for (const c of (node && node.children) || []) { if (c.name === name) out.push(c); xmlAll_(c, name, out); }
  return out;
}
export const xmlFirst_ = (node, name) => xmlAll_(node, name)[0] || null;
// The trimmed text of the first descendant (or direct child path a/b/c) named so.
export function psXmlText_(node, path) {
  let cur = node;
  for (const part of String(path).split("/")) { cur = xmlFirst_(cur, part); if (!cur) return ""; }
  return String(cur.text || "").trim();
}

// ---- SOAP -------------------------------------------------------------------------------------------------
// A supplier's message as plain text: some send HTML (S&S: "Error<br/><br/>PO Number: …").
const psPlain_ = (s) => String(s || "").replace(/<br\s*\/?>/gi, " · ").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ")
  .replace(/(\s*·\s*)+/g, " · ").replace(/\s+/g, " ").replace(/^\s*·\s*|\s*·\s*$/g, "").trim();
const psXmlEsc_ = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One call. `fields` = [[name, value, inMainNs?]] in the WSDL's order (an empty value is left out). Returns the
// parsed Body. A SOAP fault, an HTTP error or a PromoStandards error message (ErrorMessage / ServiceMessage of
// severity Error) throws with a plain message.
// `fields` may instead be the request's inner XML, already built (and escaped) with psEl_ — for a nested request
// like sendPO, which a flat field list can't express.
export async function soapCall_(url, service, request, action, fields, fetchImpl = fetch) {
  const s = PS_SERVICES[service];
  if (!url) throw new Error(`This connection has no ${s.name} service set up.`);
  const body = typeof fields === "string" ? fields : fields.filter(f => f[1] !== "" && f[1] != null)
    .map(([k, v, main]) => main ? `<ns:${k}>${psXmlEsc_(v)}</ns:${k}>` : `<shar:${k}>${psXmlEsc_(v)}</shar:${k}>`).join("");
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${s.ns}" xmlns:shar="${s.shared}"><soapenv:Header/><soapenv:Body><ns:${request}>${body}</ns:${request}></soapenv:Body></soapenv:Envelope>`;
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"` }, body: envelope,
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined });
  } catch (e) { throw new Error(`The vendor's ${s.name} service couldn't be reached (${(e && e.message) || "network error"}).`); }
  const text = await res.text().catch(() => "");
  const tree = readXml_(text);
  const fault = xmlFirst_(tree, "Fault");
  if (fault) throw new Error(`The vendor's ${s.name} service said: ${psPlain_(psXmlText_(fault, "faultstring") || psXmlText_(fault, "Text")) || "a fault"}`);
  if (!res.ok) throw new Error(`The vendor's ${s.name} service answered ${res.status}.`);
  const err = xmlFirst_(tree, "ErrorMessage") || xmlFirst_(tree, "errorMessage");   // Order Shipment Notification spells it in lower case
  if (err && (psXmlText_(err, "description") || psXmlText_(err, "code"))) throw new Error(`${s.name}: ${psPlain_(psXmlText_(err, "description")) || "error " + psXmlText_(err, "code")}`);
  for (const sm of xmlAll_(tree, "ServiceMessage")) {
    if (/error/i.test(psXmlText_(sm, "severity"))) throw new Error(`${s.name}: ${psPlain_(psXmlText_(sm, "description")) || "error " + psXmlText_(sm, "code")}`);
  }
  return xmlFirst_(tree, "Body") || tree;
}

// One element: psEl_("shar", "city", "Anytown") or psEl_("ns", "PO", [child, child, …]). Values are escaped; an
// empty value (or empty child list) leaves the element out, as optional elements should be.
export function psEl_(prefix, name, value) {
  if (Array.isArray(value)) { const inner = value.filter(Boolean).join(""); return inner ? `<${prefix}:${name}>${inner}</${prefix}:${name}>` : ""; }
  if (value === "" || value == null) return "";
  return `<${prefix}:${name}>${psXmlEsc_(value)}</${prefix}:${name}>`;
}

// ---- The directory ----------------------------------------------------------------------------------------
async function psCachedJson_(url, fetchImpl) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (cache) { const hit = await cache.match(url).catch(() => null); if (hit) return hit.json(); }
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`The PromoStandards directory answered ${res.status}.`);
  const data = await res.json();
  if (cache) await cache.put(url, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" } })).catch(() => {});
  return data;
}
// Suppliers whose name or code contains the words typed.
export async function searchPsCompanies(q, fetchImpl = fetch) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const all = await psCachedJson_(PS_DIRECTORY + "/companies", fetchImpl);
  return (Array.isArray(all) ? all : []).filter(c => c && c.Type === "Supplier")
    .filter(c => words.every(w => (String(c.Name) + " " + String(c.Code)).toLowerCase().includes(w)))
    .slice(0, 30).map(c => ({ code: String(c.Code), name: String(c.Name) }));
}
// The company's live endpoints for the services this site uses, newest Production version of each first.
export async function getPsEndpoints(code, fetchImpl = fetch) {
  const list = await psCachedJson_(PS_DIRECTORY + "/companies/" + encodeURIComponent(code) + "/endpoints", fetchImpl);
  if (!Array.isArray(list)) throw new Error("That company isn't in the PromoStandards directory.");
  const out = {};
  for (const [key, s] of Object.entries(PS_SERVICES)) {
    const found = list.filter(e => e && e.Service && e.Service.ServiceType && e.Service.ServiceType.Name === s.name)
      .map(e => ({ version: String(e.Service.Version || ""), url: String(e.URL || "").replace(/\?wsdl$/i, ""), testUrl: String(e.TestURL || "").replace(/\?wsdl$/i, ""), status: String(e.Service.Status || "") }));
    const exact = found.filter(f => f.version === s.version);
    out[key] = { name: s.name, wanted: s.version, options: found, pick: exact[0] || null };
  }
  return out;
}

// ---- The services -----------------------------------------------------------------------------------------
const psLoc_ = [["localizationCountry", "US"], ["localizationLanguage", "en"]];
const psCred_ = (c) => [["id", c.id], ["password", c.password]];

// A part's own color: the first Color in its ColorArray, else a Color directly in the part — never the one inside
// primaryColor, which comes first in the part and is the product's "go to market" color, the same on every part
// (SanMar: "not used"; its sample's Deep Black part has a primaryColor of Insignia Blue). Reading the first Color
// anywhere gave every part one color. primaryColor's is used only when a part has nothing else.
function psPartColor_(part) {
  const arr = part.children.find(c => c.name === "ColorArray");
  if (arr) { const c = xmlFirst_(arr, "Color"); if (c) return c; }
  const direct = part.children.find(c => c.name === "Color");
  if (direct) return direct;
  const primary = part.children.find(c => c.name === "primaryColor");
  return primary ? xmlFirst_(primary, "Color") : null;
}
export async function psGetProduct(conn, productId, fetchImpl = fetch) {
  const body = await soapCall_(conn.endpoints.product, "product", "GetProductRequest", "getProduct",
    [["wsVersion", "2.0.0"], ...psCred_(conn.credentials), ...psLoc_, ["productId", productId]], fetchImpl);
  const product = xmlFirst_(body, "Product");
  if (!product) throw new Error(`No product ${productId} at this vendor.`);
  const descriptions = product.children.filter(c => c.name === "description").map(c => c.text.trim()).filter(Boolean);
  const points = xmlAll_(product, "ProductMarketingPoint").map(p => psXmlText_(p, "pointCopy")).filter(Boolean);
  const categories = xmlAll_(product, "ProductCategory").map(c => [psXmlText_(c, "category"), psXmlText_(c, "subCategory")].filter(Boolean).join(" / ")).filter(Boolean);
  const standardFirst = !!(conn && PS_OVERRIDES[conn.companyCode] && PS_OVERRIDES[conn.companyCode].colorName === "standard");
  const parts = xmlAll_(product, "ProductPart").map(p => {
    const color = psPartColor_(p);
    const size = xmlFirst_(p, "ApparelSize");
    const dim = xmlFirst_(p, "Dimension");
    const name = color ? psXmlText_(color, "colorName") : "", standard = color ? psXmlText_(color, "standardColorName") : "";
    const [shown, other] = standardFirst ? [standard || name, name] : [name || standard, standard];
    return { partId: psXmlText_(p, "partId"), color: shown, colorAlt: other && psNorm_(other) !== psNorm_(shown) ? other : "", hex: color ? psXmlText_(color, "hex") : "",
      size: size ? (psXmlText_(size, "customSize") || psXmlText_(size, "labelSize")) : "",
      weightOz: dim ? psWeightOz_(psXmlText_(dim, "weight"), psXmlText_(dim, "weightUom")) : null };
  }).filter(p => p.partId);
  return { productId: psXmlText_(product, "productId") || productId, name: psXmlText_(product, "productName"), brand: psXmlText_(product, "productBrand"),
    description: descriptions.length === 1 || descriptions.length > 3 ? descriptions.join(" ") : (descriptions.length ? descriptions[0] : ""),
    features: points.length ? points : (descriptions.length > 1 && descriptions.length <= 30 ? descriptions.slice(1) : []), categories, parts };
}

// A part's Dimension weight in ounces (weightUom LB / OZ / KG / GR / G; no unit = pounds, as US suppliers send).
export function psWeightOz_(weight, uom) {
  const n = Number(weight);
  if (!Number.isFinite(n) || n <= 0) return null;
  const f = { lb: 16, lbs: 16, oz: 1, kg: 35.274, gr: 0.035274, g: 0.035274 }[String(uom || "LB").trim().toLowerCase()];
  if (!f) return null;
  const oz = Math.round(n * f * 100) / 100;
  return oz > 0 && oz < 1000 ? oz : null;
}

export async function psGetPrices(conn, productId, fetchImpl = fetch) {
  let fobId = conn.overrides && conn.overrides.fobId;
  if (!fobId) {
    const fob = await soapCall_(conn.endpoints.ppc, "ppc", "GetFobPointsRequest", "getFobPoints", [["wsVersion", "1.0.0"], ...psCred_(conn.credentials), ["productId", productId], ...psLoc_], fetchImpl);
    fobId = psXmlText_(fob, "fobId");
  }
  const priced = async (priceType) => soapCall_(conn.endpoints.ppc, "ppc", "GetConfigurationAndPricingRequest", "getConfigurationAndPricing",
    [["wsVersion", "1.0.0"], ...psCred_(conn.credentials), ["productId", productId], ["currency", "USD"], ["fobId", fobId || "1"], ["priceType", priceType], ...psLoc_, ["configurationType", "Blank"]], fetchImpl);
  // The account's own price ("Customer"); a vendor that doesn't do customer prices answers "Net".
  let body;
  try { body = await priced("Customer"); } catch (e) { body = await priced("Net"); }
  const prices = {};
  for (const part of xmlAll_(body, "Part")) {
    const id = psXmlText_(part, "partId");
    const tiers = xmlAll_(part, "PartPrice").map(p => ({ min: Number(psXmlText_(p, "minQuantity")) || 1, price: Number(psXmlText_(p, "price")) })).filter(t => Number.isFinite(t.price) && t.price >= 0);
    if (!id || !tiers.length) continue;
    tiers.sort((a, b) => a.min - b.min);
    prices[id] = tiers[0].price;
  }
  return prices;
}

// Image views, from a media item's class types (names, else well-known ids) or its file name.
function psViewOf_(item) {
  const names = item.classTypes.map(c => String(c.name || "").toLowerCase()).join(" ");
  const ids = item.classTypes.map(c => Number(c.id));
  const file = String(item.url || "").toLowerCase().split(/[?#]/)[0].split("/").pop();
  if (/swatch/.test(names) || ids.includes(2001) || /swatch/.test(file)) return "swatch";
  if (/rear|back/.test(names) || ids.includes(1008) || /(^|[^a-z])(back|rear|b|bk)([^a-z]|$)/.test(file.replace(/\.[a-z]+$/, ""))) return "back";
  if (/side|left|right/.test(names) || ids.includes(1009) || ids.includes(1010)) return "side";
  return "front";
}
// Only pictures a browser can show: a file extension, when there is one, must be an image's. SanMar's "Image" media
// also carries its 3D designer's models (.glb) and videos (.mp4).
export const psIsImageUrl_ = (url) => {
  const file = String(url || "").split(/[?#]/)[0].split("/").pop();
  const ext = /\.([a-z0-9]{2,5})$/i.test(file) ? file.replace(/^.*\./, "").toLowerCase() : "";
  return !ext || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
};
export async function psGetMedia(conn, productId, fetchImpl = fetch) {
  const body = await soapCall_(conn.endpoints.media, "media", "GetMediaContentRequest", "getMediaContent",
    [["wsVersion", "1.1.0"], ...psCred_(conn.credentials), ["mediaType", "Image"], ["productId", productId]], fetchImpl);
  return xmlAll_(body, "MediaContent").map(mc => {
    const item = { partId: psXmlText_(mc, "partId"), url: psXmlText_(mc, "url"), color: psXmlText_(mc, "color"),
      classTypes: xmlAll_(mc, "ClassType").map(c => ({ id: psXmlText_(c, "classTypeId"), name: psXmlText_(c, "classTypeName") })) };
    return { ...item, type: psViewOf_(item) };
  }).filter(m => /^https?:\/\//i.test(m.url) && psIsImageUrl_(m.url));
}

// The vendor product (db.js cleanVendorProduct_ shape) for one style: Product Data + prices (+ images).
// conn = {name, companyCode, endpoints: {product, ppc, media}, credentials: {id, password}, overrides}.
export async function fetchVendorProduct(conn, style, opts = {}, fetchImpl = fetch) {
  const productId = psProductId_(conn, style, opts.brand);
  const [pd, prices, media] = await Promise.all([
    psGetProduct(conn, productId, fetchImpl),
    psGetPrices(conn, productId, fetchImpl),
    opts.media !== false && conn.endpoints.media ? psGetMedia(conn, productId, fetchImpl).catch(() => []) : Promise.resolve([]),
  ]);
  const colors = new Map(), sizes = [], out = {}, weights = {};
  const partColor = {}, nameOf = {};   // nameOf: either of a color's names (normalised) → the name shown
  for (const p of pd.parts) {
    const color = p.color || "";
    partColor[p.partId] = color;
    if (color) { nameOf[psNorm_(color)] = color; if (p.colorAlt) nameOf[psNorm_(p.colorAlt)] = color; }
    if (color && !colors.has(color.toLowerCase())) colors.set(color.toLowerCase(), { color, hex: /^#?[0-9a-f]{6}$/i.test(p.hex) ? (p.hex[0] === "#" ? p.hex : "#" + p.hex) : "", images: [] });
    const size = String(p.size || "OSFA").toUpperCase();
    if (!sizes.includes(size)) sizes.push(size);
    if (prices[p.partId] != null) (out[color || "*"] = out[color || "*"] || {})[size] = prices[p.partId];
    if (p.weightOz != null) (weights[color || "*"] = weights[color || "*"] || {})[size] = p.weightOz;
  }
  for (const m of media) {
    const color = (m.partId && partColor[m.partId]) || nameOf[psNorm_(m.color)] || m.color || "";
    const c = colors.get(color.toLowerCase());
    if (!c || c.images.some(im => im.url === m.url) || c.images.length >= 8) continue;
    c.images.push({ url: m.url, type: m.type, fileName: m.url.split(/[?#]/)[0].split("/").pop() });
  }
  return { vendor: conn.name, style, name: pd.name, brand: pd.brand || opts.brand || "", description: pd.description, features: pd.features,
    category: pd.categories[0] || "", colors: [...colors.values()], sizes, prices: out, productId,
    ...(Object.keys(weights).length ? { weights } : {}) };
}
// The vendor's productId for one of our styles: the style # itself unless the connection says otherwise
// (overrides.productIdFormat, e.g. "{brand} {style}" — what the test connection step shows a vendor wants).
export function psProductId_(conn, style, brand) {
  const f = conn && conn.overrides && conn.overrides.productIdFormat;
  return f ? String(f).replace(/\{style\}/g, style).replace(/\{brand\}/g, brand || "").trim() : String(style).trim();
}

// ---- Ordering: parts, stock, purchase orders, shipments ---------------------------------------------------
// Color / size names compared ignoring case, spaces and punctuation ("Heather Navy" = "heather-navy").
export const psNorm_ = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]+/g, "");
const PS_SIZE_SAME_ = { osfa: "os", onesize: "os", os: "os", "2x": "2xl", "3x": "3xl", "4x": "4xl", xxl: "2xl", xxxl: "3xl" };
export const psSizeKey_ = (v) => { const k = psNorm_(v); return PS_SIZE_SAME_[k] || k || "os"; };

// The vendor's part for each of our {color, size}: {key "color|size" (normalised) → partId}. One getProduct
// per style, live at order time — part ids aren't stored, so they can't go stale.
export async function psGetParts(conn, style, opts = {}, fetchImpl = fetch) {
  const productId = psProductId_(conn, style, opts.brand);
  const pd = await psGetProduct(conn, productId, fetchImpl);
  // Each part under both of its color names. A key two different parts answer to is ambiguous: never guessed
  // (psPartFor_ refuses it), so a wrong part can't be ordered.
  const parts = {}, ambiguous = {};
  for (const p of pd.parts) for (const name of [p.color, p.colorAlt].filter((v, i) => i === 0 || v)) {
    const key = psNorm_(name) + "|" + psSizeKey_(p.size);
    if (parts[key] && parts[key] !== p.partId) ambiguous[key] = true; else parts[key] = p.partId;
  }
  return { productId: pd.productId || productId, parts, ambiguous, colors: [...new Set(pd.parts.map(p => p.color).filter(Boolean))] };
}
export function psPartFor_(info, color, size) {
  if (!info) return "";
  const c = psNorm_(color), sz = psSizeKey_(size);
  if (info.ambiguous && info.ambiguous[c + "|" + sz]) return "";
  if (info.parts[c + "|" + sz]) return info.parts[c + "|" + sz];
  // A blank stored with one unnamed color matches a style that comes in one color.
  if (!c && info.colors.length === 1) return info.parts[psNorm_(info.colors[0]) + "|" + sz] || "";
  return "";
}

// Quantity available per part, summed over the vendor's warehouses: {partId: n}.
export async function psGetInventory(conn, productId, partIds, fetchImpl = fetch) {
  const ids = [...new Set((partIds || []).filter(Boolean))];
  const filter = ids.length ? psEl_("shar", "Filter", [psEl_("shar", "partIdArray", ids.map(id => psEl_("shar", "partId", id)))]) : "";
  const inner = psEl_("shar", "wsVersion", "2.0.0") + psEl_("shar", "id", conn.credentials.id) + psEl_("shar", "password", conn.credentials.password)
    + psEl_("shar", "productId", productId) + filter;
  const body = await soapCall_(conn.endpoints.inv, "inv", "GetInventoryLevelsRequest", "getInventoryLevels", inner, fetchImpl);
  const out = {};
  for (const pi of xmlAll_(body, "PartInventory")) {
    const id = psXmlText_(pi, "partId");
    if (!id) continue;
    const qa = xmlFirst_(pi, "quantityAvailable");
    let n = qa ? Number(psXmlText_(qa, "value")) : NaN;
    if (!Number.isFinite(n)) n = xmlAll_(pi, "inventoryLocationQuantity").reduce((t, q) => t + (Number(psXmlText_(q, "value")) || 0), 0);
    out[id] = (out[id] || 0) + Math.max(0, Math.floor(n));
  }
  return out;
}

const psMoney_ = (cents) => (Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2);
// The ship-to / order contact block (ContactDetails), US addresses.
function psContactDetails_(a) {
  return psEl_("shar", "ContactDetails", [
    psEl_("shar", "attentionTo", String(a.attention || "").slice(0, 35)),
    psEl_("shar", "companyName", String(a.company || "").slice(0, 28)),
    psEl_("shar", "address1", String(a.street1 || "").slice(0, 35)),
    psEl_("shar", "address2", String(a.street2 || "").slice(0, 35)),
    psEl_("shar", "city", String(a.city || "").slice(0, 30)),
    psEl_("shar", "region", String(a.state || "").toUpperCase().slice(0, 3)),
    psEl_("shar", "postalCode", String(a.zip || "").slice(0, 10)),
    psEl_("shar", "country", "US"),
    psEl_("shar", "email", String(a.email || "").slice(0, 105)),
    psEl_("shar", "phone", String(a.phone || "").replace(/[^0-9+]/g, "").slice(0, 32)),
  ]);
}
// The SendPORequest's inner XML, in the PO 1.0.0 WSDL's element order. po = {poNumber, orderDate (ISO), carrier, comments,
// service, shipTo: {company, attention, street1, street2, city, state, zip, email, phone}, lines: [{partId, qty,
// unitCents, description}]}. Elements the standard requires but most suppliers ignore get neutral values.
export function psBuildPO_(po) {
  const lines = po.lines || [];
  const total = lines.reduce((t, l) => t + (Number(l.unitCents) || 0) * (Number(l.qty) || 0), 0);
  const date = String(po.orderDate || new Date().toISOString()).slice(0, 19);
  const contact = psContactDetails_(po.shipTo || {});
  const lineXml = lines.map((l, i) => psEl_("ns", "LineItem", [
    psEl_("ns", "lineNumber", String(i + 1)),
    psEl_("shar", "description", String(l.description || l.partId).slice(0, 255)),
    psEl_("ns", "lineType", "New"),
    psEl_("shar", "ToleranceDetails", [psEl_("shar", "tolerance", "ExactOnly")]),
    psEl_("ns", "allowPartialShipments", "true"),
    psEl_("ns", "lineItemTotal", psMoney_((Number(l.unitCents) || 0) * (Number(l.qty) || 0))),
    psEl_("ns", "PartArray", [psEl_("shar", "Part", [
      psEl_("shar", "partId", l.partId),
      psEl_("shar", "customerSupplied", "false"),
      psEl_("shar", "Quantity", [psEl_("shar", "uom", "EA"), psEl_("shar", "value", String(Math.floor(Number(l.qty) || 0)))]),
    ])]),
  ])).join("");
  return psEl_("ns", "PO", [
    psEl_("ns", "orderType", "Blank"),
    psEl_("ns", "orderNumber", po.poNumber),
    psEl_("ns", "orderDate", date),
    psEl_("ns", "totalAmount", psMoney_(total)),
    psEl_("ns", "rush", "false"),
    psEl_("shar", "currency", "USD"),
    psEl_("ns", "OrderContactArray", [psEl_("shar", "Contact", [psEl_("shar", "contactType", "Order"), contact])]),
    psEl_("ns", "ShipmentArray", [psEl_("shar", "Shipment", [
      psEl_("shar", "shipReferences", po.poNumber),
      psEl_("shar", "comments", String(po.comments || "").slice(0, 999)),   // e.g. "TEST ORDER — DO NOT PROCESS OR SHIP"
      psEl_("shar", "allowConsolidation", "false"),
      psEl_("shar", "blindShip", "false"),
      psEl_("shar", "packingListRequired", "false"),
      psEl_("shar", "FreightDetails", [psEl_("shar", "carrier", po.carrier || "UPS"), psEl_("shar", "service", po.service || "GROUND")]),
      psEl_("shar", "ShipTo", [psEl_("shar", "customerPickup", "false"), contact, psEl_("shar", "shipmentId", "1")]),
    ])]),
    psEl_("ns", "LineItemArray", [lineXml]),
    psEl_("ns", "termsAndConditions", "Standard terms"),
  ]);
}
// Places the order. Returns {transactionId}. Any refusal throws with the supplier's message (soapCall_).
export async function psSendPO(conn, po, fetchImpl = fetch) {
  const inner = psEl_("shar", "wsVersion", "1.0.0") + psEl_("shar", "id", conn.credentials.id) + psEl_("shar", "password", conn.credentials.password) + psBuildPO_(po);
  const body = await soapCall_(conn.endpoints.po, "po", "SendPORequest", "sendPO", inner, fetchImpl);
  const transactionId = psXmlText_(body, "transactionId");
  if (!transactionId) throw new Error("Purchase Order: the supplier didn't confirm the order (no transaction id came back).");
  return { transactionId };
}

// Shipments of one purchase order (query type 1 = by PO number): [{trackingNumber, carrier, method, shipDate}].
export async function psGetShipments(conn, poNumber, fetchImpl = fetch) {
  const inner = psEl_("shar", "wsVersion", "1.0.0") + psEl_("shar", "id", conn.credentials.id) + psEl_("shar", "password", conn.credentials.password)
    + psEl_("ns", "queryType", "1") + psEl_("ns", "referenceNumber", poNumber);
  let body;
  try { body = await soapCall_(conn.endpoints.osn, "osn", "GetOrderShipmentNotificationRequest", "getOrderShipmentNotification", inner, fetchImpl); }
  catch (e) { if (/not\s*found|no\s*(data|result|shipment)/i.test(String(e.message))) return []; throw e; }   // nothing shipped yet
  const seen = new Set(), out = [];
  for (const pk of xmlAll_(body, "Package")) {
    const trackingNumber = psXmlText_(pk, "trackingNumber");
    if (!trackingNumber || seen.has(trackingNumber)) continue;
    seen.add(trackingNumber);
    out.push({ trackingNumber, carrier: psXmlText_(pk, "carrier"), method: psXmlText_(pk, "shipmentMethod"), shipDate: psXmlText_(pk, "shipmentDate").slice(0, 10) });
  }
  return out;
}
