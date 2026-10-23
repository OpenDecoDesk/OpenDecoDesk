/**
 * Shippo shipping label management.
 * =============================================================
 * Route: POST /api/shippo-label (admin-subdomain only)
 *
 * Three actions:
 *   action:"reprint"  — the label PDF link for a label that was already bought (no
 *                       purchase). Uses OUR record of the order's label and, if we
 *                       never stored the link, asks Shippo for it and saves it.
 *   action:"rates"    — fetch live Shippo rates for an order's address/weight.
 *                       Returns rates[] including carrier_account + servicelevel_token
 *                       so the purchase action can reference them directly.
 *   action:"purchase" — purchase a label from Shippo and return the PDF URL +
 *                       tracking number. The admin's UI then calls /api/orders
 *                       (action:"recordTracking") to persist the tracking number.
 *
 * Rates and purchase read the order's shipping address and weight from D1
 * server-side — they never trust the browser to supply an address, which would
 * allow a tampered request to generate a real label to an arbitrary destination.
 *
 * The sender ("ship from") address is admin-editable business info, not a
 * secret — it lives in D1 (Global Settings screen, getShipFromAddress/
 * setShipFromAddress in db.js), not as a Cloudflare env var. Only the actual
 * credential below is a real secret.
 *
 * ---- REQUIRED SECRET (see docs/configuration.md) ----
 * SHIPPO_API_KEY — Shippo Dashboard → API → "Shippo API Token".
 *                  Use shippo_test_... while testing.
 *
 * ---- PARCEL DIMENSIONS ----
 * Must match shipping.js — edit constants in both files together.
 */

import { classifyHost }  from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { requireAdmin }  from "../_lib/adminAuth.js";
import { jsonResponse, featureOffResponse }  from "../_lib/http.js";
import { getOrderForShipping, recordShippingLabel, getShipFromAddress, getOrderLabel, setShippingLabelUrl, getCategoryPackMap } from "../_lib/db.js";
import { selectBox } from "../_lib/boxSize.js";

// Fallback box used when selectBox() returns null (order doesn't match a
// standard configuration) — admin is purchasing the label manually and can
// verify dimensions; we still attempt a rate quote rather than refusing.
const FALLBACK_PARCEL = { length: "12", width: "12", height: "12" };
const DEFAULT_WEIGHT_OZ = 8; // fallback when WeightOz not stored on order

// Build the full address_from object from the D1-stored ship-from settings.
function addressFrom(shipFrom){
  return {
    name:    shipFrom.name    || "Shop",
    street1: shipFrom.street1 || "",
    city:    shipFrom.city    || "",
    state:   shipFrom.state   || "",
    zip:     String(shipFrom.zip || ""),
    country: "US",
    email:   shipFrom.email   || "",
    ...(shipFrom.phone ? { phone: shipFrom.phone } : {})
  };
}

export async function onRequestPost(context){
  const { request, env } = context;

  if(!env.SHIPPO_API_KEY){
    return jsonResponse({status:"error", message:"Shipping not configured — SHIPPO_API_KEY missing."}, 500);
  }
  if(!env.DB){
    return jsonResponse({status:"error", message:"Server misconfigured — DB binding not set."}, 500);
  }

  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({status:"error", message:"Invalid JSON."}, 400); }

  let catalogData;
  try{ catalogData = await getCatalogData(env); }
  catch(e){ return jsonResponse({status:"error", message:"Catalog temporarily unavailable."}, 503); }

  const host = classifyHost(new URL(request.url).hostname, catalogData.subdomainMap, env);

  // Back office work: any signed-in user (functions/_lib/adminAuth.js).
  const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", "staff");
  if(denied) return denied;
  // Global settings → Features → Shipping switched off: no labels (buying or reprinting).
  if((catalogData.features || {}).shipping === false) return featureOffResponse("shipping", "Shipping");

  const { action, org, orderId } = body;
  if(!org || !orderId) return jsonResponse({status:"error", message:"Missing org or orderId."}, 400);

  // ---- Reprint: re-open the PDF of a label that's already bought (never buys anything) ----
  if(action === "reprint"){
    const isHttps = (u) => /^https:\/\//i.test(String(u || ""));
    let label;
    try{ label = await getOrderLabel(env.DB, orderId); }
    catch(err){ console.error("getOrderLabel D1 error:", err); return jsonResponse({status:"error", message:"Could not load the label."}, 500); }
    if(!label) return jsonResponse({status:"error", message:"No label on record for this order."}, 404);
    let url = isHttps(label.labelUrl) ? label.labelUrl : "";
    if(!url){
      // The transaction id comes from OUR record of the order, never from the browser.
      try{
        const res = await fetch("https://api.goshippo.com/transactions/" + encodeURIComponent(label.shippoTransactionId), {
          headers: { "Authorization": "ShippoToken " + env.SHIPPO_API_KEY }
        });
        const t = await res.json();
        url = t && isHttps(t.label_url) ? t.label_url : "";
      }catch(err){
        console.error("Shippo transaction lookup error:", err);
        return jsonResponse({status:"error", message:"Could not reach Shippo."}, 502);
      }
      if(!url) return jsonResponse({status:"error", message:"Shippo has no label link for this transaction — check the Shippo dashboard."}, 502);
      try{ await setShippingLabelUrl(env.DB, label.id, url); }
      catch(err){ console.error("Could not save the label link for", orderId, err); } // still hand it back
    }
    return jsonResponse({status:"ok", labelUrl: url, trackingNumber: label.trackingNumber || ""});
  }

  // Rates and labels are built for US addresses (ZIP, 2-letter state, country "US"). Outside the US
  // (Global settings → Region → country) they're refused rather than sent to the carrier half-right.
  if(((catalogData.locale || {}).country) === "OTHER"){
    return jsonResponse({status:"error", message:"Carrier rates and shipping labels are only available when the country in Global settings → Region is US. Enter the shipping method, cost and tracking number by hand."}, 400);
  }

  const shipFrom = await getShipFromAddress(env.DB, env);
  if (!shipFrom.name && catalogData.business && catalogData.business.name) shipFrom.name = catalogData.business.name;   // the label\'s sender name defaults to the business name

  // ---- Fetch order shipping data from D1 (never trust client-supplied address) ----
  let orderData;
  try{
    orderData = await getOrderForShipping(env.DB, orderId);
  }catch(err){
    console.error("getOrderForShipping D1 error:", err);
    return jsonResponse({status:"error", message:"Could not load order."}, 500);
  }
  if(!orderData){
    return jsonResponse({status:"error", message:"Order not found."}, 404);
  }

  let addr;
  try{
    addr = typeof orderData.shippingAddress === "string"
      ? JSON.parse(orderData.shippingAddress)
      : orderData.shippingAddress;
  }catch(e){
    return jsonResponse({status:"error", message:"Order has no valid shipping address."}, 400);
  }
  if(!addr){
    return jsonResponse({status:"error", message:"Order has no shipping address."}, 400);
  }
  const weightOzOverride = body.weightOz && parseFloat(body.weightOz) > 0 ? parseFloat(body.weightOz) : 0;
  const weightOz = weightOzOverride || (orderData.totalWeightOz > 0 ? orderData.totalWeightOz : DEFAULT_WEIGHT_OZ);
  const customerName = orderData.customerName || "";

  const addrTo = {
    name:    addr.name || customerName,
    street1: addr.line1 || "",
    ...(addr.line2 ? { street2: addr.line2 } : {}),
    city:    addr.city  || "",
    state:   addr.state || "",
    zip:     String(addr.zip || ""),
    country: "US"
  };

  // Parcel priority: explicit request override > saved order dims > selectBox > fallback.
  const parcelIn = body.parcel;
  const parcelOverride = (parcelIn &&
    parseFloat(parcelIn.length) > 0 &&
    parseFloat(parcelIn.width)  > 0 &&
    parseFloat(parcelIn.height) > 0)
    ? { length: String(parseFloat(parcelIn.length)), width: String(parseFloat(parcelIn.width)), height: String(parseFloat(parcelIn.height)) }
    : null;

  const savedParcel = (orderData.parcelLength > 0 && orderData.parcelWidth > 0 && orderData.parcelHeight > 0)
    ? { length: String(orderData.parcelLength), width: String(orderData.parcelWidth), height: String(orderData.parcelHeight) }
    : null;

  // Which package-size limit each product category counts against (migrations/0056); the box
  // chooser falls back to guessing from the type's wording if this can't be read.
  let packAs = null;
  try { packAs = await getCategoryPackMap(env.DB); } catch (e) {}
  const boxResult = parcelOverride ? { box: parcelOverride }
    : savedParcel     ? { box: savedParcel }
    : selectBox(orderData.items || [], null, packAs);

  const parcel = (boxResult && boxResult.box) ? boxResult.box : FALLBACK_PARCEL;

  // ---- Rates ----
  if(action === "rates"){
    let shipment;
    try{
      const res = await fetch("https://api.goshippo.com/shipments/", {
        method: "POST",
        headers: {
          "Authorization": "ShippoToken " + env.SHIPPO_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          address_from: addressFrom(shipFrom),
          address_to:   addrTo,
          parcels: [{
            length: parcel.length,
            width:  parcel.width,
            height: parcel.height,
            distance_unit: "in",
            weight: String(weightOz),
            mass_unit: "oz"
          }],
          async: false
        })
      });
      shipment = await res.json();
    }catch(err){
      console.error("Shippo rates error:", err);
      return jsonResponse({status:"error", message:"Could not reach Shippo."}, 502);
    }

    if(!shipment || !Array.isArray(shipment.rates)){
      console.error("Shippo unexpected response:", JSON.stringify(shipment).slice(0, 500));
      return jsonResponse({status:"error", message:"No rates returned from Shippo."}, 502);
    }

    const rates = shipment.rates
      .filter(r => r.amount && parseFloat(r.amount) > 0 && r.carrier_account && r.servicelevel && r.servicelevel.token)
      .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))
      .slice(0, 5)
      .map(r => ({
        carrierId:     r.carrier_account,
        serviceToken:  r.servicelevel.token,
        provider:      r.provider || "",
        service:       r.servicelevel.name || "",
        amount:        parseFloat(r.amount),
        currency:      r.currency || "USD",
        estimatedDays: typeof r.estimated_days === "number" ? r.estimated_days : null
      }));

    const from = addressFrom(shipFrom);
    return jsonResponse({
      status: "ok",
      rates,
      weightOz,
      fromAddress: { name: from.name, street1: from.street1, city: from.city, state: from.state, zip: from.zip },
      toAddress: { name: addrTo.name, line1: addrTo.street1, line2: addrTo.street2 || "", city: addrTo.city, state: addrTo.state, zip: addrTo.zip },
      parcel: { length: parcel.length, width: parcel.width, height: parcel.height, unit: "in" },
    });
  }

  // ---- Purchase ----
  if(action === "purchase"){
    // USPS rejects a sender missing any of these ("address_from.<field> must
    // not be empty"). Fail clearly up front with everything that's missing,
    // rather than a confusing 502 from Shippo (or worse, only catching one
    // field at a time as each in turn trips a real customer's label purchase).
    const missing = ["street1", "city", "state", "zip", "phone"].filter(f => !shipFrom[f]);
    if(missing.length){
      return jsonResponse({status:"error", message:`Shipping not configured — set the ship-from ${missing.join(", ")} under Global Settings. (Rate quotes still work without it.)`}, 500);
    }
    const { carrierId, serviceToken } = body;
    if(!carrierId || !serviceToken){
      return jsonResponse({status:"error", message:"Missing carrierId or serviceToken."}, 400);
    }
    // Validate format — carrier_account is a UUID, serviceToken is alphanumeric+underscore
    if(!/^[0-9a-f]{32}$/i.test(carrierId) && !/^[0-9a-zA-Z\-]{10,50}$/.test(carrierId)){
      return jsonResponse({status:"error", message:"Invalid carrierId format."}, 400);
    }
    if(!/^[a-z0-9_]{3,50}$/.test(serviceToken)){
      return jsonResponse({status:"error", message:"Invalid serviceToken format."}, 400);
    }

    let txn;
    try{
      const res = await fetch("https://api.goshippo.com/transactions/", {
        method: "POST",
        headers: {
          "Authorization": "ShippoToken " + env.SHIPPO_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          shipment: {
            address_from: addressFrom(shipFrom),
            address_to:   addrTo,
            parcels: [{
              length: parcel.length,
              width:  parcel.width,
              height: parcel.height,
              distance_unit: "in",
              weight: String(weightOz),
              mass_unit: "oz"
            }]
          },
          carrier_account:    carrierId,
          servicelevel_token: serviceToken,
          async: false
        })
      });
      txn = await res.json();
    }catch(err){
      console.error("Shippo purchase error:", err);
      return jsonResponse({status:"error", message:"Could not reach Shippo."}, 502);
    }

    // Shippo reports a transaction's outcome in `status` ("SUCCESS", "ERROR",
    // "QUEUED", "WAITING"…) — not in `object_status`, which current API
    // versions don't send. Testing only `object_status` would report EVERY
    // purchase, including successful ones, as a failure: the label bought and
    // charged at Shippo but nothing recorded here, no tracking saved, the
    // label never opened. `object_status` stays as an older-API fallback.
    const txnStatus = txn && (txn.status || txn.object_status);
    if(!txn || txnStatus !== "SUCCESS"){
      // Shippo can return several messages (e.g. one per address field that
      // failed validation) — join them all rather than showing just the
      // first, so the admin sees the whole picture in one toast.
      const msgs = (txn && Array.isArray(txn.messages) ? txn.messages : []).map(m => m && m.text).filter(Boolean);
      const msg = msgs.length ? msgs.join(" · ")
        : txnStatus ? `Shippo returned status ${txnStatus} — check the Shippo dashboard.`
        : "Label purchase failed — check Shippo dashboard.";
      // Log the messages separately, in full, before the (capped) full object —
      // a short cap alone would cut the log off before it ever reached the
      // messages field of a longer transaction.
      console.error("Shippo transaction failed:", msg, "| full response:", JSON.stringify(txn).slice(0, 2000));
      return jsonResponse({status:"error", message: msg}, 502);
    }

    // Record the postage as an expense (shipping_labels). Depending on the
    // account's Shippo API version, `txn.rate` is either the rate's id or the
    // whole rate object embedded — use the embedded one, else look the id up
    // for its price. (Treating an embedded object as an id would look up
    // "/rates/[object Object]" and record every label at $0.) A failure
    // here never undoes the purchase — the label is already bought.
    let rate = null;
    try{
      if(txn.rate && typeof txn.rate === "object"){
        rate = txn.rate;
      }else if(txn.rate){
        const rr = await fetch("https://api.goshippo.com/rates/" + encodeURIComponent(txn.rate), {
          headers: { "Authorization": "ShippoToken " + env.SHIPPO_API_KEY }
        });
        rate = await rr.json();
      }
    }catch(err){ console.error("Shippo rate lookup failed for", txn.rate, err); }
    const amount = rate && rate.amount ? parseFloat(rate.amount) : 0;
    if(!amount) console.error("Label cost unknown for Shippo transaction", txn.object_id, "— recorded as $0");
    // The embedded rate names its service `servicelevel_name`; a looked-up one nests it as `servicelevel.name`.
    const carrier = (rate && rate.provider) || txn.provider || "";
    const service = (rate && ((rate.servicelevel && rate.servicelevel.name) || rate.servicelevel_name)) || (txn.servicelevel && txn.servicelevel.name) || "";
    let warning = "";
    try{
      await recordShippingLabel(env.DB, {
        orderId, shippoTransactionId: txn.object_id || ("unknown-" + Date.now()),
        carrier, service, amount, trackingNumber: txn.tracking_number || "", labelUrl: txn.label_url || "",
      });
    }catch(err){
      console.error("Could not record shipping label for", orderId, err);
      // Say so out loud — the label is already bought and charged, so the admin needs to know it isn't in the books.
      warning = `The label was bought ($${amount.toFixed(2)}, tracking ${txn.tracking_number || "n/a"}) but couldn't be recorded on the site — note these details.`;
    }

    return jsonResponse({
      status: "ok",
      labelUrl:       txn.label_url,
      trackingNumber: txn.tracking_number,
      carrier,
      service,
      labelCost:      amount,
      ...(warning ? { warning } : {})
    });
  }

  return jsonResponse({status:"error", message:"Unknown action. Use 'rates' or 'purchase'."}, 400);
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
