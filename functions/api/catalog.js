/**
 * Serves each org's catalog AND identity server-side, so a customer on one
 * org's subdomain can never see any other org's name, products, pricing, or
 * even that it exists — not even by viewing page source. index.html carries
 * no org data at all; it asks this endpoint "who am I, and what do I sell."
 * ========================================================================
 * ---- HOW THIS HIDES OTHER ORGS ----
 * The real data — name, accent color, description, design preview images,
 * products, prices — lives in D1, read and edge-cached via
 * getCatalogData(env) in functions/_lib/catalogCache.js. It's never embedded
 * in index.html. The client asks this endpoint for "my org's info," and this
 * function decides which org that is by reading the request's Host header
 * itself — NOT by trusting an org id the client sends. A locked subdomain
 * always gets its own data only, no matter what ?org= it's asked with. On
 * boot, the client calls this with no ?org= at all; a response of anything
 * other than status:"ok" (root domain, or an unrecognized host) is the
 * signal index.html uses to render the generic company page instead of
 * guessing at an org.
 *
 * The root domain (functions/_lib/hostConfig.js) serves no shop and ignores
 * ?org=; the admin host gets only a marker. Any OTHER hostname — a typo, a
 * probe, or (with wildcard DNS) a subdomain that was never set up — is
 * refused outright.
 *
 * ---- ADDING/EDITING ORGS ----
 * Not a code change — use the admin panel's Manage catalog screens, then
 * click "Publish." See docs/shops-and-domains.md.
 */

import { classifyHost } from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { jsonResponse } from "../_lib/http.js";
import { getReadyToShipByOrg, getBlankReadyByOrg, getDraftCatalogShop, verifyPreviewToken } from "../_lib/db.js";

// Computes which payment methods are enabled for an org.
// Result is the intersection of:
//   - globalSettings.enabledPayments (admin-set global toggles)
//   - org.enabledPayments (per-org toggles — cannot re-enable a globally disabled method)
//   - Stripe being configured (for "Card" only)
// When either settings object is absent, every method defaults to enabled.
function computeEnabledPayments(org, globalSettings, stripeConfigured){
  const g = (globalSettings && globalSettings.enabledPayments) || {};
  const o = (org && org.enabledPayments) || {};
  const globalCard  = g.card  !== false;
  const globalVenmo = g.venmo !== false;
  const globalZelle = g.zelle !== false;
  const globalCheck = g.check !== false;
  const orgCard  = o.card  !== false;
  const orgVenmo = o.venmo !== false;
  const orgZelle = o.zelle !== false;
  const orgCheck = o.check !== false;
  const methods = [];
  if(globalCard  && orgCard  && stripeConfigured) methods.push("Card");
  if(globalVenmo && orgVenmo) methods.push("Venmo");
  if(globalZelle && orgZelle) methods.push("Zelle");
  if(globalCheck && orgCheck) methods.push("Check");
  return methods;
}

// Normalizes a stored image URL that is missing its scheme. If R2_PUBLIC_BASE
// is set without "https://", uploads are stored as
// "images.example.com/uploads/..." instead of
// "https://images.example.com/uploads/...", which browsers treat as relative
// (prepending the current page URL) rather than as absolute.
// Safe to call on any URL: absolute https:// and site-relative paths pass
// through unchanged; only bare-domain strings get the scheme prepended.
function normImageUrl(url){
  if(!url) return url;
  // Allowlist, not a blocklist: only http(s):// or a plain site path survives
  // (the same rule as cleanImageUrl in _lib/catalogValidation.js, which
  // orders.js applies on every save). Defense in depth for anything already
  // stored — e.g. " javascript:…" or "java\tscript:…", which a ^javascript:
  // blocklist would let through.
  url = String(url).trim();
  if(/[\u0000-\u001f\u007f\\<>"'`]/.test(url)) return "";
  if(!/^https?:\/\//i.test(url) && (url.startsWith("//") || url.includes(":"))) return "";
  if(/^https?:\/\//i.test(url)) return url; // already absolute
  if(url.startsWith('/')) return url;        // site-relative — intentional
  const firstSlash = url.indexOf('/');
  const hostPart = firstSlash === -1 ? url : url.slice(0, firstSlash);
  // If the segment before the first slash looks like a hostname (has a dot,
  // doesn't start with one), it's a bare-domain URL — prepend https://.
  if(hostPart.includes('.') && !hostPart.startsWith('.')) return 'https://' + url;
  return url;
}

// Maps a stored product (productId/pricingMode/flatPrice/sizePricing) to the
// shape index.html's rendering expects (id, and sizePricing OR flatPrice —
// no pricingMode field).
function toClientProduct(p){
  const out = {
    id: p.productId, type: p.type, name: p.name, sub: p.sub,
    images: p.images.map(normImageUrl), features: p.features,
    personalizationPrice: p.personalizationPrice,
    personalizationOptions: p.personalizationOptions || [],
    weightOz: p.shipWeightOz ?? p.weightOz ?? null
  };
  if(p.pricingMode === "flat"){
    out.flatPrice = p.flatPrice;
  } else {
    out.sizePricing = p.sizePricing;
  }
  // Only said when it isn't (the cart's tax estimate skips the line); taxable is the default.
  if(p.taxable === false) out.taxable = false;
  // The customer may upload their own design (migrations/0054): how it's made, its add-on per piece
  // (null = free), and whether the product can only be ordered with one.
  if(p.customDesign){
    out.customDesign = { kind: p.customDesign, price: p.customDesignPrice ?? null, required: !!p.customDesignRequired };
  }
  // Versions of a product (migrations/0059): the shop page shows products sharing a versionGroup as one
  // card with a toggle labelled by versionLabel ("Short sleeve | Long sleeve").
  // What decorates it, in words (name + decoration location), so the shop page can say so with or without a picture.
  if(Array.isArray(p.decorations) && p.decorations.length) out.decorations = p.decorations.slice(0, 12).map(d => ({
    kind: String(d.kind || ""), name: String(d.name || ""), location: String(d.location || "") }));
  if(p.versionGroup){ out.versionGroup = String(p.versionGroup); out.versionLabel = String(p.versionLabel || ""); }
  // Configurable products (migrations/0036): per-location option menus + garment colors.
  if(p.configurable){
    out.configurable = true;
    out.garmentColors = p.garmentColors || [];
    out.locations = p.locations || [];
    // Printed transfers that are part of the product (migrations/0068): it's decorated without any pick, so every
    // location may be left at None. Only the fact is sent — which graphics they are is the shop's business.
    if((p.fixedTransfers || []).length) out.hasFixedTransfers = true;
    // Color price groups (migrations/0064): a color in a group is priced by its group, else by sizePricing/flatPrice.
    if((p.colorGroups || []).length) out.colorGroups = p.colorGroups.map(g => ({ label: g.label, colors: g.colors || [],
      ...(g.flatPrice != null ? { flatPrice: g.flatPrice } : { sizePricing: g.sizePricing || {} }) }));
  }
  // Per-color images from the product's linked blank colors (migrations/0037); the storefront
  // prefers these over the product's own images. Image URLs re-normalised on the way out.
  if(p.colorImages && typeof p.colorImages === "object"){
    const ci = {};
    for(const k of Object.keys(p.colorImages)){
      const imgs = (p.colorImages[k] || []).map(normImageUrl).filter(Boolean);
      if(imgs.length) ci[k] = imgs;
    }
    if(Object.keys(ci).length) out.colorImages = ci;
  }
  // Per-location graphic mockups (migrations/0042): { "<locationId>|<graphicId>|<color>": imageUrl }.
  // The storefront shows the matching mockup for the picked color + each location's graphic.
  if(p.graphicImages && typeof p.graphicImages === "object"){
    const gi = {};
    for(const k of Object.keys(p.graphicImages)){
      const u = normImageUrl(p.graphicImages[k]);
      if(u) gi[k] = u;
    }
    if(Object.keys(gi).length) out.graphicImages = gi;
    // Which keys are its printed transfers' (migrations/0068): shown with the configurable preview, or as a plain
    // product's first pictures. Only location / graphic ids and the location's name.
    if(Array.isArray(p.fixedMockups) && p.fixedMockups.length) out.fixedMockups = p.fixedMockups.map(f => ({
      locationId: Number(f.locationId), graphicId: Number(f.graphicId), label: String(f.label || "") }));
  }
  return out;
}

export async function onRequestGet(context){
  const { request, env } = context;
  const url = new URL(request.url);

  let catalogData;
  try{
    catalogData = await getCatalogData(env);
  }catch(err){
    return jsonResponse({status:"error", message:"Catalog temporarily unavailable"}, 503);
  }

  // Global settings → Region: which address format the forms use. Anything but "OTHER" is "US".
  const country = ((catalogData.locale || {}).country === "OTHER") ? "OTHER" : "US";
  // Global settings → Features: which optional parts of the site are on. Sent with every answer so
  // the storefront and the admin know without another request; a missing key means on.
  const features = catalogData.features || {};
  // Carrier shipping needs both a US install and the Shipping feature.
  const carrierShipping = country === "US" && features.shipping !== false;

  const host = classifyHost(url.hostname, catalogData.subdomainMap, env);

  let orgId;
  if(host.kind === "locked"){
    orgId = host.orgId; // ignore any ?org= param entirely — always serve the locked org
  } else if(host.kind === "root"){
    // The root domain serves no shop at all, and ignores ?org=: answering ?org=<guess> with that
    // shop's catalog would let anyone confirm which org IDs exist. A shop is reached only through
    // its own subdomain; nothing in the site calls this with ?org=.
    orgId = null;
  } else if(host.kind === "admin"){
    // The admin subdomain isn't a storefront for any single org — it
    // has no catalog to serve. Return a marker so the client renders
    // the admin panel instead of guessing at an org. Deliberately no
    // org names/list here — that stays gated behind the passphrase in
    // orders.js (action: "listOrgs"), so hitting this subdomain alone
    // can't be used to scrape the client list.
    // edition: "desktop" tells the admin it runs inside the desktop program (hostConfig.js), so it
    // leaves out what needs the internet; desktopSuppliers / desktopEmail: the owner turned supplier
    // connections on there, or set up email (hostConfig.js desktopSuppliersOn / desktopEmailOn,
    // repeated here to keep this file's one import).
    return jsonResponse({status:"admin", business: catalogData.business || {}, country, features,
      ...(host.desktop ? {edition:"desktop", ...(String(env.DESKTOP_SUPPLIERS || "") === "on" ? {desktopSuppliers:true} : {}),
        ...(String(env.DESKTOP_EMAIL || "") === "on" ? {desktopEmail:true} : {})} : {})});
  } else {
    // Unknown hostname — refuse rather than treating it like a known host.
    return jsonResponse({status:"error", message:"Unrecognized host", business: catalogData.business || {}, country, features}, 404);
  }

  // Storefront switched off (Global settings → Features): a shop host and the root domain get the
  // same short answer — who runs the site and that ordering isn't available — and nothing about any
  // shop: no name, no products, no prices. Not an error (200), so the page can tell it from a
  // mistyped address. The admin host was answered above and is unaffected.
  if(features.storefront === false){
    return jsonResponse({status:"closed", message:"Online ordering isn't available here.", business: catalogData.business || {}, country, features});
  }

  let org = orgId && catalogData.orgs[orgId];
  // The admin's draft preview (migrations/0076): ?preview=<token signed for THIS shop> serves the shop's live,
  // unpublished rows (never cached). Anything else — a bad or expired token — is just the published shop.
  let preview = false;
  const previewToken = url.searchParams.get("preview");
  if(org && previewToken && host.kind === "locked" && env.DB && await verifyPreviewToken(env, orgId, previewToken)){
    try{ const draft = await getDraftCatalogShop(env.DB, orgId); if(draft){ org = draft; preview = true; } }
    catch(e){ console.error("draft preview failed:", e); }
  }
  if(!org){
    // The root domain always lands here (it serves no shop): one answer, 200,
    // whatever ?org= says, so probing ?org=<guess> can't enumerate org IDs.
    // Locked subdomains keep the 404 — their hostname is already the org
    // identity signal.
    if(host.kind === "root"){
      return jsonResponse({status:"error", message:"Unknown org", business: catalogData.business || {}, country, features});
    }
    return jsonResponse({status:"error", message:"Unknown org", business: catalogData.business || {}, country, features}, 404);
  }

  const enabledPayments = computeEnabledPayments(org, catalogData.globalSettings, !!env.STRIPE_SECRET_KEY);

  // Fetch ready-to-ship stock fresh from D1 (not cached — stock changes with every fulfillment).
  let stockByProduct = {};
  if(env.DB){
    try{
      const stockRows = await getReadyToShipByOrg(env.DB, orgId);
      for(const row of stockRows){
        if(!stockByProduct[row.productId]) stockByProduct[row.productId] = {};
        stockByProduct[row.productId][row.size] = row.quantity;
      }
    }catch(e){
      // Non-fatal — stock display degrades gracefully to "no stock info"
      console.error("ready_to_ship fetch failed:", e);
    }
  }
  // "Ready to decorate": the linked blank's free stock per color + size (display only; non-fatal).
  let blankReady = {};
  if(env.DB){
    try{ blankReady = await getBlankReadyByOrg(env.DB, orgId); }
    catch(e){ console.error("blank-ready fetch failed:", e); }
  }

  return jsonResponse({
    status:"ok", orgId, ...(preview ? { preview: true } : {}),
    business: catalogData.business || {},   // who runs the site: name, contact, how to pay by Venmo/Zelle/check
    country,   // "US" or "OTHER" (Global settings → Region): which address format the forms use
    features,  // Global settings → Features ({} or a missing key = on)
    catalog: {
      name: org.name, eyebrow: org.eyebrow, accent: org.accent, ready: org.ready,
      desc: org.desc, designImages: {
        shirt: normImageUrl(org.designImages.shirt),
        cap:   normImageUrl(org.designImages.cap),
        detail: normImageUrl(org.designImages.detail)
      }, shippingEnabled: org.shippingEnabled === true && carrierShipping,
      // What the customer picks from at checkout (migrations/0045): pickup / shipping / the shop's own.
      // Carrier rates need a US ZIP, so outside the US the shipping entry isn't offered — nor when
      // the Shipping feature is switched off.
      deliveryOptions: (org.deliveryOptions || []).filter(o => carrierShipping || o.type !== "shipping").map(o => ({ id: o.id, type: o.type, label: o.label, fee: o.fee })),
      // The storefront's sections, in the managed order (migrations/0056) — only the ones this shop uses.
      categories: (catalogData.categories || []).filter(c => org.products.some(p => p.type === c.key)).map(c => ({ key: c.key, label: c.label })),
      products: org.products.map(p => ({ ...toClientProduct(p), stock: stockByProduct[p.productId] || null, blankStock: blankReady[p.productId] || null })),
      // Configurable-product option catalog + tier prices (migrations/0036); only present when the
      // org has configurable products. Image URLs re-normalised on the way out.
      graphics: (org.graphics || []).map(g => ({ ...g, imageUrl: normImageUrl(g.imageUrl), thumbUrl: normImageUrl(g.thumbUrl) })),
      tierPricesCents: org.tierPricesCents || null,
      // enabledPayments is the intersection of global payment toggles,
      // per-org payment toggles, and (for Card) Stripe being configured.
      // An empty array means no payment method is shown at checkout —
      // the order still goes through, just without a payment selection.
      enabledPayments,
      orderDeadline: org.orderDeadline || null,
      closedMessage: org.closedMessage || null,
      allowOrdersAfterDeadline: org.allowOrdersAfterDeadline !== false,
      // For the storefront's "Prices include x% <state> sales tax" disclosure.
      // 0 for a tax-exempt org (nothing to disclose). Certificate details are
      // never sent to the browser.
      salesTaxRate: org.taxExempt ? 0 : (((catalogData.globalSettings || {}).salesTax || {}).rateBps || 0) / 100,
      salesTaxJurisdiction: ((catalogData.globalSettings || {}).salesTax || {}).jurisdiction || "",
      // "inclusive": the listed prices include the tax; "exclusive": the cart adds it (the server
      // works out the real figure when the order is placed).
      salesTaxMode: ((catalogData.globalSettings || {}).salesTax || {}).taxMode === "exclusive" ? "exclusive" : "inclusive",
      // Public Turnstile site key (not secret) — only when server-side
      // verification is actually on, so the widget never renders for nothing.
      turnstileSiteKey: (env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY) ? env.TURNSTILE_SITE_KEY : null
    }
  });
}
