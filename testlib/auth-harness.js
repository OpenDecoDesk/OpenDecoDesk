// Test helper: the real sign-in code (adminAuth.js and the four account endpoints) on real SQL.
//
//   const { makeAuth, totpNow } = require("./testlib/auth-harness");
//   const A = await makeAuth();                       // a new, empty install; A.env, A.d1
//   let a = await A.signIn("", A.PRINTED);            // → { status, body, cookie }
//   a = await A.password({ action: "account", ... }, a.cookie);
//   A.users(body, cookie)   A.twoFactor(body, cookie)   A.hits (failed-credential counts)
//
// Only the rate limiter, Cloudflare Access and the catalog are stand-ins; `hits` records every
// call that would have counted against the sign-in failure budget.
const fs = require("fs");
const crypto = require("crypto");
const { createD1 } = require("./d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/../" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const ORIGIN = "https://admin.example.com";

// The sources every endpoint needs, with the real adminAuth.js. `extra` is appended (an endpoint).
// `realLimits`: the real rate limiter on the same database instead of the stand-ins (failures are then
// counted in rate_limits, not in `hits`).
// `realDomains`: the real Cloudflare calls (customDomain.js, against whatever `fetch` the test puts in place)
// instead of stand-ins that attach nothing.
const prelude = (realLimits, realDomains) => strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/totp.js")) + "\n" +
  (realLimits ? strip(read("functions/_lib/rateLimit.js")) + "\n" :
  "const rateLimitCheck = async () => ({ blocked: false }), rateLimited = async () => ({ blocked: false }), rateLimitResponse = () => null, rateLimitHit = async (env, bucket) => { __hits.push(bucket); };\n" +
  "const rateLimitCheckGlobal = async () => ({ blocked: false }), rateLimitHitGlobal = async () => {};\n") +
  "const accessEnabled = () => false, verifyAccess = async () => ({ ok: true }); const getCatalogData = async () => ({ subdomainMap: {}, business: {} });\n" +
  strip(read("functions/_lib/adminAuth.js")) + "\n" + strip(read("functions/_lib/cloudflareSetup.js")) + "\n" +
  (realDomains ? strip(read("functions/_lib/customDomain.js")) + "\n" : "const ensureWorkerHostname = async () => ({ steps: [] }), ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n");

function request(path, body, { cookie = "", origin = ORIGIN, headers = {} } = {}) {
  const h = Object.assign({ origin, cookie: cookie ? "__Host-odd_admin=" + cookie : "", "cf-connecting-ip": "203.0.113.9" }, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));
  return { url: ORIGIN + path, method: "POST", json: async () => body, headers: { get: (name) => h[String(name).toLowerCase()] || null } };
}
async function answer(res) {
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body, cookie: ((res.headers.get("Set-Cookie") || "").match(/__Host-odd_admin=([^;]*)/) || [])[1] };
}

// A six-digit code for a Base32 secret, as an authenticator app would show it now (+step*30s).
function totpNow(secret, step = 0) {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0; const out = [];
  for (const ch of secret.toUpperCase().replace(/=+$/, "")) { value = (value << 5) | ALPHABET.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + step));
  const h = crypto.createHmac("sha1", Buffer.from(out)).update(buf).digest(), o = h[19] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, "0");
}

async function makeAuth({ d1, passphrase = "abcd-efgh-jkmn-pqrs-tuvw-xyz2", realLimits = false, realDomains = false } = {}) {
  if (!d1) { d1 = await createD1(); d1._raw.exec(read("schema.sql")); }
  const hits = [];
  const load = (file, ret) => new Function("__hits", prelude(realLimits, realDomains) + (file ? strip(read(file)) : "") + "\nreturn " + ret + ";")(hits);
  const session = load("functions/api/admin-session.js", "{ post: onRequestPost, del: onRequestDelete }");
  const password = load("functions/api/admin-password.js", "onRequestPost");
  const users = load("functions/api/admin-users.js", "onRequestPost");
  const twoFactor = load("functions/api/admin-2fa.js", "onRequestPost");
  // Internals a test needs to stage an older install (a password record as the old code stored it).
  const lib = load("", "{ passwordRecordFor_, requireAdmin, adminUser, adminActor, setUserRoleAndStatus, getAuditLog }");
  // The real limiter's own functions, when realLimits (to test it directly).
  const limits = realLimits ? load("", "{ rateLimited, rateLimitCheck, rateLimitHit, rateLimitCheckGlobal, rateLimitHitGlobal, ipv6Prefix64 }") : null;
  // The orders endpoint — the 207 back-office actions — behind the real gate. Everything it does
  // AFTER the gate may fail here for want of data; tests of the gate only look at who is let past.
  let ordersPost = null;
  const orders = async (body, cookie, opts) => {
    if (!ordersPost) ordersPost = new Function("__hits", prelude(realLimits, realDomains) + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
      "const verifyTurnstile = async () => ({ ok: true }); const invalidateCatalogVersionCache = () => {}; const selectBox = () => null;\n" +
      strip(read("functions/_lib/setupStatus.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")(hits);
    try { return await answer(await ordersPost({ request: request("/api/orders", body, Object.assign({ cookie }, opts)), env, waitUntil: (p) => Promise.resolve(p).catch(() => {}) })); }
    catch (e) { return { status: 0, body: { threw: String(e && e.message) }, cookie: undefined }; }   // got past the gate, then lacked data
  };
  const env = { DB: d1, PROXY_ADMIN_PASSPHRASE: passphrase, ROOT_DOMAIN: "example.com" };
  const call = (fn, path) => async (body, cookie, opts) => answer(await fn({ request: request(path, body, Object.assign({ cookie }, opts)), env, waitUntil: () => {} }));
  // The endpoints themselves, by path and method, for a caller that has its own request objects
  // (scripts/admin-local.js --sign-in serves them over real HTTP).
  const raw = { "/api/admin-session": { POST: session.post, DELETE: session.del }, "/api/admin-password": { POST: password }, "/api/admin-users": { POST: users }, "/api/admin-2fa": { POST: twoFactor },
    "/api/orders": { POST: async (ctx) => { await orders({}, ""); return ordersPost(ctx); } } };
  return {
    d1, env, hits, lib, limits, raw, PRINTED: passphrase,
    signIn: async (email, key, code) => answer(await session.post({ request: request("/api/admin-session", Object.assign({ email, key }, code ? { totpCode: code } : {})), env })),
    signOut: async (cookie) => answer(await session.del({ request: request("/api/admin-session", null, { cookie }), env })),
    password: call(password, "/api/admin-password"), users: call(users, "/api/admin-users"), twoFactor: call(twoFactor, "/api/admin-2fa"), orders,
    sessions: () => d1.q("SELECT count(*) n FROM admin_sessions")[0].n,
    user: (email) => d1.q("SELECT * FROM users").find(u => u.email === email) || null,
    audit: (action) => d1.q("SELECT * FROM audit_log ORDER BY id").filter(r => r.action === action),
    // Signs in with the installer's passphrase and finishes the account: the usual first minute
    // of an install. Returns a signed-in admin's cookie.
    firstAdmin: async function (name = "Olive Owner", email = "olive@myshop.com", pass = "correct horse battery") {
      const a = await this.signIn("", passphrase);
      await this.password({ action: "account", name, email, next: pass }, a.cookie);
      return (await this.signIn(email, pass)).cookie;
    },
    // Creates a user as that admin and has them replace the temporary password. Returns their cookie.
    addUser: async function (adminCookie, role, name, email, pass = "a password of their own") {
      const c = await this.users({ action: "create", name, email, role }, adminCookie);
      const first = await this.signIn(email, c.body.temporaryPassword);
      await this.password({ action: "change", current: c.body.temporaryPassword, next: pass }, first.cookie);
      return (await this.signIn(email, pass)).cookie;
    },
  };
}

module.exports = { makeAuth, totpNow, request, answer, prelude, strip, read, ORIGIN };
