/**
 * Signed shipping quotes.
 * ========================================================================
 * /api/shipping returns carrier rates the customer picks from. If the chosen
 * amount came back to /api/orders as a plain client-supplied `shippingCost`,
 * anyone could submit a negative or zero shipping cost and underpay. So every
 * rate carries a `quoteToken`: an HMAC-signed payload binding the org,
 * destination ZIP, the cart contents it was quoted for, the amount, the
 * service name, and an expiry. orders.js ignores any client-supplied
 * shipping cost and only accepts a token that verifies.
 *
 * Signing key: SIGNING_SECRET — the site's one signing secret, shared with the
 * signed download links (each use is domain-separated by its own label, so one
 * signature can't be confused with another). An install that hasn't set it yet
 * falls back to the older QUOTE_SIGNING_SECRET, then STRIPE_SECRET_KEY.
 * Rotating it just invalidates quotes that are < 2h old.
 */

const LABEL = "odd-shipping-quote-v1:";
export const QUOTE_TTL_SECONDS = 2 * 60 * 60;

function signingSecret(env){
  return env.SIGNING_SECRET || env.QUOTE_SIGNING_SECRET || env.STRIPE_SECRET_KEY || "";
}

function b64urlEncode(str){
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str){
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(s + "===".slice((s.length + 3) % 4))));
}

// An install that started under another name (a copy of this code made before it was OpenDecoDesk) signed its
// passwords, sessions and links with labels starting with that name instead of "odd". LEGACY_LABEL_PREFIX (a plain
// variable, e.g. "myshop") makes the checks accept those too, so moving such an install over doesn't void everyone's
// password or the links already sent. New marks, tokens and cookies always use the odd- labels. Kept identical in
// adminAuth.js, quoteToken.js, http.js and db.js (test177 checks): the tests paste these files together.
function legacyLabels_(env, label) {
  const p = String((env && env.LEGACY_LABEL_PREFIX) || "").trim().toLowerCase();
  return /^[a-z][a-z0-9]{0,19}$/.test(p) && p !== "odd" && label.includes("odd") ? [label, label.replace("odd", p)] : [label];
}

async function hmacHex(secret, data, label = LABEL){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(label + secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b){
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Canonical "what was quoted" string: [productId, totalQty] pairs, sorted, so
// cart order and how items are split across lines don't matter — but adding
// items after quoting does (a quote for 1 hoodie can't ship 20). It is JSON, so
// no product id, whatever characters it holds, can read as two products.
//
// Quantities are whole numbers by the time they get here: /api/shipping and /api/orders both read
// each line through lineQty (db.js) and refuse anything else, so the count that is signed is the
// count that was weighed and the count that is ordered. A quantity that still isn't a whole number
// is never rounded into one: the cart then has no key at all (null), and both callers treat no key
// as "can't be signed" and "doesn't match".
export function canonicalItems(items){
  const qtyById = new Map();
  for(const it of items || []){
    const id = String((it && it.productId) || "");
    const q = (it && it.qty) == null ? 1 : it.qty;
    if(!Number.isInteger(q) || q < 1) return null;
    qtyById.set(id, (qtyById.get(id) || 0) + q);
  }
  return JSON.stringify([...qtyById.keys()].sort().map(id => [id, qtyById.get(id)]));
}

export function canSignQuotes(env){
  return !!signingSecret(env);
}

// payload: { orgId, zip, items (canonical string), amountCents, method }
export async function signQuote(env, payload){
  const secret = signingSecret(env);
  if(!secret) return null;
  const body = b64urlEncode(JSON.stringify({
    o: payload.orgId, z: payload.zip, i: payload.items,
    a: payload.amountCents, m: payload.method,
    e: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS,
  }));
  return body + "." + await hmacHex(secret, body);
}

// Returns {ok:true, orgId, zip, items, amountCents, method} or {ok:false, reason}.
export async function verifyQuote(env, token){
  const secret = signingSecret(env);
  if(!secret) return { ok: false, reason: "Shipping quotes are not configured." };
  if(typeof token !== "string" || token.length > 2000 || !token.includes(".")){
    return { ok: false, reason: "Missing shipping quote." };
  }
  const [body, sig] = token.split(".");
  let signed = false;
  for(const label of legacyLabels_(env, LABEL)) if(constantTimeEqual(await hmacHex(secret, body, label), sig || "")) signed = true;
  if(!signed) return { ok: false, reason: "Invalid shipping quote." };
  let p;
  try{ p = JSON.parse(b64urlDecode(body)); }
  catch{ return { ok: false, reason: "Invalid shipping quote." }; }
  if(!p || typeof p.e !== "number" || p.e < Math.floor(Date.now() / 1000)){
    return { ok: false, reason: "Shipping quote expired — please refresh shipping rates." };
  }
  if(!Number.isInteger(p.a) || p.a < 0) return { ok: false, reason: "Invalid shipping quote." };
  return { ok: true, orgId: p.o, zip: p.z, items: p.i, amountCents: p.a, method: p.m };
}
