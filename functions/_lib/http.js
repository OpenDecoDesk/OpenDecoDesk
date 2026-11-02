/**
 * Shared JSON response helpers for the API handlers.
 */
// ---- Proof that a card checkout is being started by the person who placed the order -------------
// An order number alone used to be enough to open Stripe Checkout for that order — and Stripe's page
// shows the customer's name and email. Placing an order now returns a token for THAT order (HMAC over
// the order id and an expiry), and /api/checkout asks for it (or for the order's own invoice link).
// Signed with the install's signing secret, under its own label.
// An install that started under another name (a copy of this code made before it was OpenDecoDesk) signed its
// passwords, sessions and links with labels starting with that name instead of "odd". LEGACY_LABEL_PREFIX (a plain
// variable, e.g. "myshop") makes the checks accept those too, so moving such an install over doesn't void everyone's
// password or the links already sent. New marks, tokens and cookies always use the odd- labels. Kept identical in
// adminAuth.js, quoteToken.js, http.js and db.js (test177 checks): the tests paste these files together.
function legacyLabels_(env, label) {
  const p = String((env && env.LEGACY_LABEL_PREFIX) || "").trim().toLowerCase();
  return /^[a-z][a-z0-9]{0,19}$/.test(p) && p !== "odd" && label.includes("odd") ? [label, label.replace("odd", p)] : [label];
}

const ORDER_TOKEN_TTL_SECONDS = 24 * 60 * 60;
function orderTokenSecret_(env){
  return (env && (env.SIGNING_SECRET || env.QUOTE_SIGNING_SECRET || env.STRIPE_SECRET_KEY)) || "";
}
async function orderTokenMac_(secret, data, label = "odd-order-pay-v1:"){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(label + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}
// (Both return a promise. Written as plain functions, like everything else exported from this file.)
export function signOrderToken(env, orderId){
  const secret = orderTokenSecret_(env);
  if(!secret || !orderId) return Promise.resolve(null);
  const exp = Math.floor(Date.now() / 1000) + ORDER_TOKEN_TTL_SECONDS;
  return orderTokenMac_(secret, String(orderId) + "|" + exp).then(mac => exp + "." + mac);
}
export function verifyOrderToken(env, orderId, token){
  const secret = orderTokenSecret_(env);
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(typeof token === "string" ? token : "");
  if(!secret || !orderId || !m) return Promise.resolve(false);
  if(Number(m[1]) < Math.floor(Date.now() / 1000)) return Promise.resolve(false);
  return Promise.all(legacyLabels_(env, "odd-order-pay-v1:").map(label => orderTokenMac_(secret, String(orderId) + "|" + m[1], label)))
    .then(macs => macs.some(expected => {
      let diff = 0;
      for(let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
      return diff === 0;
    }));
}

export function jsonResponse(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

// ---- Features (Global settings → Features; db.js FEATURES) --------------------------------------
// The answer every handler gives for something that belongs to a switched-off feature.
export function featureOffResponse(key, label){
  return jsonResponse({ status: "error", feature: key,
    message: `${label || key} is turned off. Turn it on under Tools → Global settings → Features.` }, 403);
}
// For handlers that don't already hold the cached catalog: is this feature switched off? One small
// read. Anything unexpected (no database, nothing saved, a read error) counts as ON — the default.
// (A plain function returning a promise: some test harnesses only strip "export function".)
export function featureIsOff(env, key){
  return (async () => {
    try{
      const row = await env.DB.prepare("SELECT value FROM global_settings WHERE key='features'").first();
      return !!row && JSON.parse(row.value)[key] === false;
    }catch(e){ return false; }
  })();
}
