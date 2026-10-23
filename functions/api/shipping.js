/**
 * Shippo shipping rate quotes.
 * =========================================================
 * Route: POST /api/shipping
 *
 * Accepts { zip, items:[{productId, qty, weightOz}] } and returns up to
 * 3 carrier rates from Shippo sorted cheapest-first. The client uses these
 * to let the customer choose a delivery option before placing their order.
 *
 * The origin ZIP (part of the admin-editable ship-from address, Global
 * Settings screen — see getShipFromAddress in db.js) is read from D1 —
 * it's ordinary business info, not a secret.
 *
 * ---- SECRET (see docs/configuration.md) ----
 * SHIPPO_API_KEY  — Shippo Dashboard → API → "Shippo API Token"
 *                   Use shippo_test_... while testing, shippo_live_... for real charges.
 *
 * ---- PARCEL DIMENSIONS ----
 * Edit the constants below to match your typical shipment box.
 * Weight is dynamic (sum of item weights from the cart); dimensions are fixed.
 *
 * ---- RATE LIMITING ----
 * 20 requests/min/IP, counted in D1 (see rateLimit.js).
 * Fails open if D1 is unavailable — same pattern as every other rate-limited
 * endpoint in this project (see rateLimit.js).
 */

import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { jsonResponse } from "../_lib/http.js";
import { selectBox } from "../_lib/boxSize.js";
import { getBoxPresets, getProductsByOrg, getShipFromAddress, lineQty, QTY_MESSAGE, getCategoryPackMap, getOrderInvoice, invoiceExpired } from "../_lib/db.js";
import { classifyHost } from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { signQuote, canonicalItems } from "../_lib/quoteToken.js";

// Per-item fallback weight (oz) when a product has no weightOz set.
const DEFAULT_ITEM_WEIGHT_OZ = 8;

export async function onRequestPost(context){
  const { request, env } = context;

  if(!env.SHIPPO_API_KEY || !env.DB){
    console.error("SHIPPO_API_KEY or DB binding not configured");
    return jsonResponse({status:"error", message:"Shipping not configured."}, 500);
  }

  // Rate-limit before any D1 work.
  const rl = await rateLimited(env, "shipping_quote", request, 20);
  if(rl.blocked) return rateLimitResponse(rl.retryAfter);

  // Carrier rates are quoted by US ZIP only. Outside the US (Global settings → Region → country)
  // the shop's pickup and flat-fee delivery options are what's offered. The country rides on the
  // catalog data, which is edge-cached — no extra database read.
  let storefrontOff = false;
  try{
    const cd = await getCatalogData(env);
    // Global settings → Features → Shipping switched off: no carrier rates at all.
    if(((cd && cd.features) || {}).shipping === false){
      return jsonResponse({status:"error", feature:"shipping", message:"Carrier shipping isn't available for this shop — please choose another delivery option."}, 403);
    }
    // Storefront switched off: no rate quotes for customers. The admin's own quotes (a parcel typed
    // in by hand on the admin host) still work, and so does a customer's invoice the shop sent
    // (checked below, once the request's invoice token has been read).
    if(((cd && cd.features) || {}).storefront === false &&
       classifyHost(new URL(request.url).hostname, cd.subdomainMap, env).kind !== "admin"){
      storefrontOff = true;
    }
    if(((cd && cd.locale) || {}).country === "OTHER"){
      return jsonResponse({status:"error", message:"Carrier shipping rates aren't available for this shop's region — please choose another delivery option."}, 400);
    }
  }catch(e){ /* catalog unavailable — carry on as US; the order itself re-checks */ }

  const shipFromZip = String((await getShipFromAddress(env.DB, env)).zip || "");
  if(!shipFromZip){
    console.error("Ship-from ZIP not set — see Global Settings");
    return jsonResponse({status:"error", message:"Shipping not configured."}, 500);
  }

  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({status:"error", message:"Invalid JSON."}, 400); }

  // With the storefront off, only rates for an invoice the shop sent: a valid, unexpired invoice token
  // for an order of the shop the rates are for (functions/api/invoice.js).
  if(storefrontOff){
    const tok = /^[a-z0-9]{16,64}$/.test(String((body && body.invoiceToken) || "")) ? String(body.invoiceToken) : "";
    const inv = tok ? await getOrderInvoice(env.DB, tok).catch(() => null) : null;
    if(!inv || invoiceExpired(inv) || (typeof body.org === "string" && body.org && body.org !== inv.orgId)){
      return jsonResponse({status:"error", feature:"storefront", message:"Online ordering isn't available here."}, 403);
    }
  }

  const { zip } = body;
  let items = body.items;

  if(!zip || !/^\d{5}$/.test(String(zip))){
    return jsonResponse({status:"error", message:"ZIP must be 5 digits."}, 400);
  }
  if(!Array.isArray(items) || items.length === 0 || items.length > 20){
    return jsonResponse({status:"error", message:"No items provided."}, 400);
  }
  // Each line's quantity is read once, by the rule the order itself uses (lineQty in db.js), and
  // everything below — the weight, the box, the signed cart — works from that one number.
  if(items.some(it => !it || typeof it !== "object" || Array.isArray(it) || lineQty(it.qty) === null)){
    return jsonResponse({status:"error", message: QTY_MESSAGE}, 400);
  }
  items = items.map(it => ({ ...it, qty: lineQty(it.qty) }));

  // Resolve the storefront's org so weights/types come from the catalog, not
  // the client — and so the returned rates can be signed for that org. A
  // client-supplied weightOz of 0.1 would otherwise be enough to get a cheaper rate.
  let orgId = null;
  try{
    const catalogData = await getCatalogData(env);
    const host = classifyHost(new URL(request.url).hostname, catalogData.subdomainMap, env);
    if(host.kind === "locked") orgId = host.orgId;
    // The shop comes from the address the request was sent to. Only a developer's own machine
    // (localhost) may name it in the request instead.
    else if(host.kind === "root" && typeof body.org === "string" && /^(localhost|127\.0\.0\.1)$/.test(new URL(request.url).hostname)) orgId = body.org;
  }catch(e){ /* unresolved org → quotes are returned unsigned (not orderable) */ }

  // A storefront cart (the shop is known, so its rates get signed) is rebuilt from the catalog: each
  // line is the catalog's product — its weight, its type — and the quantity, and nothing else from
  // the request. A line the catalog doesn't have can't be quoted at all: left as it was sent, it
  // would be weighed and boxed on the request's own word and that rate would then be signed.
  if(orgId && env.DB){
    let products = null;
    try{ products = await getProductsByOrg(env.DB, orgId, true); }
    catch(e){ orgId = null; }
    if(products){
      const byId = new Map(products.map(p => [String(p.productId), p]));
      const cart = [];
      for(const it of items){
        const p = typeof it.productId === "string" ? byId.get(it.productId) : null;
        if(!p) return jsonResponse({status:"error", message:"An item in your cart is no longer available — please refresh the page."}, 400);
        cart.push({ productId: it.productId, qty: it.qty, weightOz: p.shipWeightOz > 0 ? p.shipWeightOz : Number(p.weightOz) > 0 ? Number(p.weightOz) : 0, type: p.type || "" });
      }
      items = cart;
    }
  }

  const totalWeightOz = items.reduce((sum, item) => {
    const w = (typeof item.weightOz === "number" && item.weightOz > 0)
      ? item.weightOz : DEFAULT_ITEM_WEIGHT_OZ;
    return sum + w * item.qty;
  }, 0);

  // Admin can supply explicit parcel dimensions to override automatic box selection.
  const parcelIn = body.parcel;
  const parcelOverride = (parcelIn &&
    parseFloat(parcelIn.length) > 0 &&
    parseFloat(parcelIn.width)  > 0 &&
    parseFloat(parcelIn.height) > 0)
    ? { length: String(parseFloat(parcelIn.length)), width: String(parseFloat(parcelIn.width)), height: String(parseFloat(parcelIn.height)) }
    : null;

  // Load DB-backed box presets (falls back to hardcoded defaults inside selectBox if none).
  let boxPresets = null, packAs = null;
  if (env.DB) {
    try { boxPresets = await getBoxPresets(env.DB); } catch(e) {}
    // Which package-size limit each product category counts against (migrations/0056).
    try { packAs = await getCategoryPackMap(env.DB); } catch(e) {}
  }

  // Select the smallest box that fits the order's item types + quantities.
  // If no box matches, return a manual-shipping notice instead of Shippo rates.
  const boxResult = parcelOverride ? { box: parcelOverride, packing: 0 } : selectBox(items, boxPresets, packAs);
  if(!boxResult){
    return jsonResponse({
      status: "ok",
      rates: [],
      manualShipping: true,
      message: "This order's size or combination of items requires a custom shipping quote. We'll follow up with the shipping cost, total, and payment options.",
    });
  }

  const { box, packing } = boxResult;
  // Add the box's own tare weight to get the total shipment weight.
  const boxWeightOz = parcelOverride
    ? (parseFloat(body.boxWeightOz) || 0)
    : (boxResult.boxWeightOz || 0);
  const shipWeightOz = totalWeightOz + boxWeightOz;

  let shipment;
  try{
    const res = await fetch("https://api.goshippo.com/shipments/", {
      method: "POST",
      headers: {
        "Authorization": "ShippoToken " + env.SHIPPO_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        address_from: { zip: shipFromZip, country: "US" },
        address_to:   { zip: String(zip), country: "US" },
        parcels: [{
          length: box.length,
          width:  box.width,
          height: box.height,
          distance_unit: "in",
          weight: String(shipWeightOz),
          mass_unit: "oz"
        }],
        async: false
      })
    });
    shipment = await res.json();
  }catch(err){
    console.error("Shippo API error:", err);
    return jsonResponse({status:"error", message:"Could not reach shipping provider."}, 502);
  }

  if(!shipment || !Array.isArray(shipment.rates)){
    console.error("Shippo unexpected response:", JSON.stringify(shipment).slice(0, 500));
    return jsonResponse({status:"error", message:"No rates returned."}, 502);
  }

  // Filter to valid, priced rates; sort cheapest first; cap at 3.
  // Add packing cost to each rate amount so the displayed price is all-in.
  const rates = shipment.rates
    .filter(r => r.amount && parseFloat(r.amount) > 0)
    .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))
    .slice(0, 3)
    .map(r => ({
      provider:      r.provider || "",
      service:       (r.servicelevel && r.servicelevel.name) ? r.servicelevel.name : (r.attributes || ""),
      amount:        Math.round((parseFloat(r.amount) + packing) * 100) / 100,
      currency:      r.currency || "USD",
      estimatedDays: typeof r.estimated_days === "number" ? r.estimated_days : null
    }));

  // Sign each rate so /api/orders can trust the amount the customer picked.
  // Only for a real storefront cart — the admin panel's manual parcel
  // override quotes are informational and never become an order's shipping.
  const cartKey = (orgId && !parcelOverride) ? canonicalItems(items) : null;
  if(cartKey){
    for(const r of rates){
      r.quoteToken = await signQuote(env, {
        orgId, zip: String(zip), items: cartKey,
        amountCents: Math.round(r.amount * 100),
        method: (r.provider + " " + r.service).trim(),
      });
    }
  }

  return jsonResponse({
    status: "ok",
    rates,
    shipment: {
      fromZip: shipFromZip,
      toZip:   String(zip),
      weightOz: shipWeightOz,
      parcel: { length: box.length, width: box.width, height: box.height, unit: "in" },
    },
  });
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
