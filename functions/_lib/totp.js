/**
 * TOTP (RFC 6238) verification using the Web Crypto API.
 * No external dependencies — runs in Cloudflare Workers.
 */

// RFC 4648 Base32 decode. Accepts upper/lowercase, strips whitespace and padding.
function base32Decode(str){
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const s = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out = [];
  for(const ch of s){
    const idx = ALPHABET.indexOf(ch);
    if(idx === -1) throw new Error("Invalid Base32 character: " + ch);
    value = (value << 5) | idx;
    bits += 5;
    if(bits >= 8){ out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

// TOTP: HMAC-SHA1, 30-second window, 6 digits.
// Accepts the current window ±1 step for clock drift.
// Returns {valid, counter} — counter is the matching 30s step value, used
// by callers to record last-used counter and prevent same-code replay.
export async function verifyTOTP(secret, code){
  if(!secret || !code) return {valid: false, counter: null};
  const cleanCode = String(code).replace(/\s/g, "");
  if(!/^\d{6}$/.test(cleanCode)) return {valid: false, counter: null};
  let keyBytes;
  try{ keyBytes = base32Decode(secret); }catch(e){ return {valid: false, counter: null}; }
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, {name: "HMAC", hash: "SHA-1"}, false, ["sign"]
  );
  const counter = Math.floor(Date.now() / 30000);
  for(const step of [counter - 1, counter, counter + 1]){
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(step), false);
    const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, buf));
    const offset = hmac[19] & 0xf;
    const otp = (
      ((hmac[offset]     & 0x7f) << 24) |
      ( hmac[offset + 1]         << 16) |
      ( hmac[offset + 2]         <<  8) |
        hmac[offset + 3]
    ) % 1_000_000;
    if(otp.toString().padStart(6, "0") === cleanCode) return {valid: true, counter: step};
  }
  return {valid: false, counter: null};
}
