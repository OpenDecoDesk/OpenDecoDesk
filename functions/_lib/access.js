/**
 * Optional Cloudflare Access verification for the admin subdomain.
 * ========================================================================
 * Cloudflare Access (Zero Trust, free for up to 50 users) can sit in front of
 * admin.example.com and require a real login (Google, email code, etc.)
 * before any request reaches these Functions. Access then attaches a signed
 * JWT to every request (Cf-Access-Jwt-Assertion header). Verifying it here
 * means (a) a request that somehow bypassed Access (e.g. a misconfigured
 * policy) is still refused, and (b) every admin action gets a real person's
 * email for the audit log instead of one shared passphrase.
 *
 * Opt-in: enforced only when BOTH env vars are set —
 *   ACCESS_TEAM_DOMAIN  e.g. "example.cloudflareaccess.com"
 *   ACCESS_AUD          the Access application's "Application Audience (AUD) Tag"
 * Once set it FAILS CLOSED: missing/invalid/expired token, or unreachable
 * signing keys → refused.
 */

const JWKS_TTL_MS = 60 * 60 * 1000;
let _jwks = { team: null, keys: null, at: 0 };

export function accessEnabled(env){
  return !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

function teamDomain(env){
  return String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function b64urlToBytes(s){
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(s){
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function getSigningKeys(team){
  const now = Date.now();
  if(_jwks.team === team && _jwks.keys && now - _jwks.at < JWKS_TTL_MS) return _jwks.keys;
  const res = await fetch("https://" + team + "/cdn-cgi/access/certs");
  if(!res.ok) throw new Error("Access certs HTTP " + res.status);
  const data = await res.json();
  if(!data || !Array.isArray(data.keys)) throw new Error("Access certs: no keys");
  _jwks = { team, keys: data.keys, at: now };
  return data.keys;
}

function readToken(request){
  const h = request.headers.get("Cf-Access-Jwt-Assertion");
  if(h) return h;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : "";
}

// Returns {ok:true, email} or {ok:false, reason}.
export async function verifyAccess(env, request){
  const token = readToken(request);
  if(!token) return { ok: false, reason: "Cloudflare Access login required." };
  const parts = token.split(".");
  if(parts.length !== 3) return { ok: false, reason: "Invalid Access token." };

  let header, payload;
  try{ header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch{ return { ok: false, reason: "Invalid Access token." }; }
  if(header.alg !== "RS256") return { ok: false, reason: "Invalid Access token." };

  const team = teamDomain(env);
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if(!aud.includes(env.ACCESS_AUD)) return { ok: false, reason: "Access token is for a different application." };
  if(payload.iss !== "https://" + team) return { ok: false, reason: "Access token issuer mismatch." };
  if(typeof payload.exp !== "number" || payload.exp < now) return { ok: false, reason: "Access session expired — reload the page." };
  if(typeof payload.nbf === "number" && payload.nbf > now + 60) return { ok: false, reason: "Invalid Access token." };

  let keys;
  try{ keys = await getSigningKeys(team); }
  catch(e){
    console.error("Access: could not fetch signing keys — refusing (fail closed):", e);
    return { ok: false, reason: "Sign-in service temporarily unavailable — try again shortly." };
  }
  const jwk = keys.find(k => k.kid === header.kid);
  if(!jwk) return { ok: false, reason: "Invalid Access token." };

  try{
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]));
    if(!ok) return { ok: false, reason: "Invalid Access token." };
  }catch(e){
    return { ok: false, reason: "Invalid Access token." };
  }
  return { ok: true, email: String(payload.email || payload.sub || "unknown") };
}

// Test hook: reset the per-isolate key cache.
export function _resetAccessKeyCache(){ _jwks = { team: null, keys: null, at: 0 }; }
