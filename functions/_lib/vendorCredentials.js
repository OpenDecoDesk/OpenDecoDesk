// A vendor connection's id + password (PromoStandards), encrypted at rest in D1 with AES-GCM under one master
// key: the VENDOR_CREDENTIALS_KEY variable (encrypted, set once in the Cloudflare dashboard — any long random
// string; the AES key is its SHA-256). Stored as base64(iv ‖ ciphertext). The credentials never go back to the
// browser; without the master key nothing is stored and the screen says what to set.
const vcEnc_ = new TextEncoder(), vcDec_ = new TextDecoder();
const vcB64_ = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const vcUnb64_ = (s) => Uint8Array.from(atob(String(s || "")), c => c.charCodeAt(0));

async function vcKey_(env) {
  const secret = env && env.VENDOR_CREDENTIALS_KEY;
  if (!secret || String(secret).length < 16) return null;
  const raw = await crypto.subtle.digest("SHA-256", vcEnc_.encode(String(secret)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export const vendorCredentialsReady = (env) => !!(env && env.VENDOR_CREDENTIALS_KEY && String(env.VENDOR_CREDENTIALS_KEY).length >= 16);

export async function encryptVendorCredentials(env, creds) {
  const k = await vcKey_(env);
  if (!k) throw new Error("Set the VENDOR_CREDENTIALS_KEY variable (a long random string) in Cloudflare first.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = vcEnc_.encode(JSON.stringify({ id: String(creds.id || ""), password: String(creds.password || "") }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, data));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return vcB64_(out);
}

export async function decryptVendorCredentials(env, stored) {
  if (!stored) return null;
  const k = await vcKey_(env);
  if (!k) throw new Error("The VENDOR_CREDENTIALS_KEY variable isn't set, so the saved vendor login can't be read.");
  try {
    const all = vcUnb64_(stored);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, k, all.slice(12));
    return JSON.parse(vcDec_.decode(pt));
  } catch (e) { throw new Error("The saved vendor login can't be read (was VENDOR_CREDENTIALS_KEY changed?) — enter it again."); }
}
