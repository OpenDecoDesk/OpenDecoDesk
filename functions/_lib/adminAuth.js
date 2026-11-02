/**
 * The gate every back-office endpoint goes through, and who is behind a request.
 * ========================================================================
 * PEOPLE. There are users (the `users` table), each with a role:
 *     staff   ("Back office")  day-to-day work
 *     manager                  staff + shops, publishing, the books
 *     admin                    everything, incl. users, the audit log and Global settings
 * requireAdmin(env, host, key, request, message, role) is the ONE place a role is enforced.
 * `role` is the LOWEST role allowed: "staff" or "manager". Anything else — including leaving it
 * out — means admin only, so a call nobody thought about is closed to everyone but admins.
 *
 * CREDENTIALS, in order:
 *   1. Cloudflare Access (optional — see access.js). When ACCESS_TEAM_DOMAIN + ACCESS_AUD are
 *      set, a valid Access JWT is REQUIRED on top of 2/3. It is an outer gate only: who you are
 *      inside the app is still the user you signed in as.
 *   2. A session COOKIE (`__Host-odd_admin`), issued by /api/admin-session after email +
 *      password (+ a code when two-step is on). HttpOnly, so page JavaScript — and therefore an
 *      XSS — can never read it; Secure; SameSite=Strict; 24h. Cookie requests must also carry a
 *      same-origin `Origin` header (SameSite alone still admits sibling *.example.com shops).
 *      The session belongs to a user: a disabled user's sessions stop working at once, and a
 *      session can be PENDING — the user must first finish setting up their account, replace a
 *      temporary password, or enrol in two-step — in which case only the route that finishes
 *      that step answers.
 *   3. The installer's passphrase (the PROXY_ADMIN_PASSPHRASE secret) sent with the request.
 *      It is the way in to a NEW install and the way back in to a locked one, nothing more: it
 *      is accepted only while no active admin has a usable password (see "The installer's
 *      passphrase" below), and never when that admin has two-step sign-in.
 * Bearer "sess_…" tokens in the body/header are NOT accepted: a token page JavaScript can hold
 * is one any XSS could copy out and replay.
 *
 * Every storage-dependent check FAILS CLOSED (503) — unlike the rate limiter, which may fail
 * open. The failure budget is checked BEFORE the credential, and only a FAILED CREDENTIAL counts
 * against it: being told "your role can't do that" or "finish setting up first" does not, or one
 * person clicking around would lock the whole office out.
 */

import { rateLimitCheck, rateLimitHit, rateLimitResponse, rateLimitCheckGlobal, rateLimitHitGlobal } from "./rateLimit.js";
import { jsonResponse } from "./http.js";
import { accessEnabled, verifyAccess } from "./access.js";
import {
  insertAdminSession, deleteAdminSession, getSettingRaw, setSettingRaw, getAdminSession, setAdminSessionPending,
  deleteAllAdminSessions, getBootstrapState, insertFirstAdmin, updateUser, replaceRecoveryCodes, deleteUserSessions,
} from "./db.js";

const ADMIN_AUTH_BUCKET = "admin_auth";
// FAILED credential attempts per IP per minute. Only failures are counted
// (see requireAdmin), so this can be tight without ever throttling a signed-in
// admin clicking around — and those clicks cost no rate-limit writes at all.
const ADMIN_AUTH_LIMIT  = 10;
// FAILED sign-in attempts across the whole install, from any address, per 15 minutes. The per-address
// limit above is no limit against someone with many addresses; this one caps how fast a password,
// passphrase or code can be guessed at all. While it is used up, NEW sign-ins are refused for the rest
// of the window — people already signed in are not affected (their session is checked first).
// ADMIN_AUTH_GLOBAL_LIMIT overrides the number; 0 turns it off.
export const ADMIN_AUTH_GLOBAL_BUCKET = "admin_auth_all";
export const ADMIN_AUTH_GLOBAL_WINDOW = 15 * 60;
export function adminAuthGlobalLimit(env){
  const n = Number(env && env.ADMIN_AUTH_GLOBAL_LIMIT);
  return Number.isFinite(n) && String(env.ADMIN_AUTH_GLOBAL_LIMIT).trim() !== "" ? Math.max(0, Math.floor(n)) : 100;
}

const SESSION_PREFIX  = "sess_";
export const SESSION_TTL_SEC = 24 * 60 * 60; // 24 hours
// __Host- prefix: the browser only accepts it with Secure + Path=/ + no
// Domain attribute, so a sibling subdomain can't plant or overwrite it.
export const SESSION_COOKIE = "__Host-odd_admin";

// Who performed the current admin request (for the audit log), keyed by the
// Request object so no handler signature has to change.
const _actors = new WeakMap();
// …and the user behind it: { id, email, name, role, pending, tokenHash, bootstrap }.
const _users = new WeakMap();

// Roles, lowest to highest. Written out rather than looked up in an object, so no odd string
// ("constructor") can pass for a role.
const roleRank_ = (role) => role === "admin" ? 3 : role === "manager" ? 2 : role === "staff" ? 1 : 0;
export const isRole = (role) => roleRank_(role) > 0;
export const ROLE_LABELS = { staff: "Back office", manager: "Manager", admin: "Admin" };

function errorResponse(message, status){
  return jsonResponse({status:"error", message}, status);
}

// Constant-time string compare — prevents timing-based passphrase guessing.
export function timingSafeEqual(a, b){
  if(typeof a !== "string" || typeof b !== "string") return false;
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(request, name){
  const header = (request.headers && request.headers.get("Cookie")) || "";
  for(const part of header.split(";")){
    const i = part.indexOf("=");
    if(i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

export function sessionCookieHeader(token, maxAgeSec){
  return SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAgeSec;
}
// The session cookie this request carries: ours, else (an adopted install, LEGACY_LABEL_PREFIX) the one the install
// set under its old name, so its signed-in admins aren't signed out by the move. New sessions always get ours.
export function readSessionCookie(request, env){
  const own = readCookie(request, SESSION_COOKIE);
  if(own) return own;
  const legacy = legacyLabels_(env, "odd")[1];
  return legacy ? readCookie(request, "__Host-" + legacy + "_admin") : null;
}
export function clearSessionCookieHeader(){
  return SESSION_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

// CSRF guard for cookie-authenticated requests: the browser always sends
// Origin on a cross-origin POST/DELETE, and on same-origin fetch() POSTs.
export function isSameOrigin(request){
  const origin = request.headers.get("Origin");
  if(!origin) return false;
  try{ return new URL(origin).host === new URL(request.url).host; }
  catch{ return false; }
}

async function sha256Hex_(text){
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

// Issue a new session token and store its hash in D1.
// Returns {token, expires} on success; throws on a storage failure.
// `userId` is whose session it is; `pending` a step they must finish first (see the header).
export async function issueSession(env, userId = null, pending = null){
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token   = SESSION_PREFIX + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const expires = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  await insertAdminSession(env.DB, await sha256Hex_(token), expires, userId, pending);
  return {token, expires};
}

export async function revokeSession(env, token){
  if(token && /^sess_[0-9a-f]{48}$/.test(token) && env.DB){
    await deleteAdminSession(env.DB, await sha256Hex_(token));
  }
}

// "Sign out everywhere": every session of the user this token belongs to, this one included.
// Returns that user's id, or null when the token isn't a live session.
export async function revokeUserSessionsFor(env, token){
  if(!token || !/^sess_[0-9a-f]{48}$/.test(token) || !env.DB) return null;
  const sess = await readSession_(env, token);
  if(!sess || sess === "unavailable" || !sess.user) { await revokeSession(env, token); return null; }
  await deleteUserSessions(env.DB, sess.user.id);
  return sess.user.id;
}

// Returns the active TOTP secret: the one stored in D1 (set via the admin panel) takes
// precedence over the TOTP_SECRET env var (backward compat for installs that set the secret
// manually). Returns "" if neither is configured.
//
// THROWS on a storage error rather than returning "". Returning "" there would mean "2FA is
// off", so an outage would silently downgrade login to passphrase-only. Callers must treat a
// throw as "auth unavailable" (503), never as "no 2FA".
export async function getActiveSecret(env){
  if(env.DB){
    const stored = await getSettingRaw(env.DB, "totpSecret");
    if(stored) return stored;
  }
  return env.TOTP_SECRET || "";
}

// ---- Passwords ---------------------------------------------------------------------------------
// Each user's password is kept as a salted hash in users.password.
//   - The hash is keyed with the PROXY_ADMIN_PASSPHRASE secret, so a copy of the database alone
//     can't be used to guess anyone's password. That is also why the stretching is light: a
//     Worker gets very little CPU per request, and sign-in has to fit in it.
//   - A short mark of the secret is stored in each record. Replace the secret
//     (`npm run setup -- --new-passphrase`) and no record's mark matches any more: every stored
//     password is void. That is the price of recovering a locked-out install, and the Users page
//     says who needs a new one.
const LEGACY_PASSWORD_SETTING = "adminPassword";   // where the one shared password lived before users
const SECRET_MARK_SETTING = "adminSecretMark";     // the mark of the secret last used to get in or set a password
const PASSWORD_ITERATIONS = 10000;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

// An install that started under another name (a copy of this code made before it was OpenDecoDesk) signed its
// passwords, sessions and links with labels starting with that name instead of "odd". LEGACY_LABEL_PREFIX (a plain
// variable, e.g. "myshop") makes the checks accept those too, so moving such an install over doesn't void everyone's
// password or the links already sent. New marks, tokens and cookies always use the odd- labels. Kept identical in
// adminAuth.js, quoteToken.js, http.js and db.js (test177 checks): the tests paste these files together.
function legacyLabels_(env, label) {
  const p = String((env && env.LEGACY_LABEL_PREFIX) || "").trim().toLowerCase();
  return /^[a-z][a-z0-9]{0,19}$/.test(p) && p !== "odd" && label.includes("odd") ? [label, label.replace("odd", p)] : [label];
}

const hex_ = (buf) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
async function hmacHex_(keyText, data){
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex_(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? new TextEncoder().encode(data) : data));
}
async function passwordHash_(env, password, saltHex, iterations){
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g), h => parseInt(h, 16));
  return hmacHex_(env.PROXY_ADMIN_PASSPHRASE, await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, k, 256));
}
async function secretMark_(env, label = "odd-admin-password-v1"){ return (await hmacHex_(env.PROXY_ADMIN_PASSPHRASE, label)).slice(0, 16); }
// Is this a mark made under the secret in force now (under any accepted label — see legacyLabels_)?
async function markIsCurrent_(env, mark){
  if(!mark) return false;
  for(const label of legacyLabels_(env, "odd-admin-password-v1")) if(mark === await secretMark_(env, label)) return true;
  return false;
}

// A stored record as an object, or null if it isn't one (nothing stored, not JSON, or numbers
// that would be a way to burn CPU).
function passwordRecord_(raw){
  if(!raw || typeof raw !== "string") return null;
  let rec;
  try{ rec = JSON.parse(raw); }catch(e){ return null; }
  if(!rec || typeof rec.hash !== "string" || typeof rec.salt !== "string" || !/^(?:[0-9a-f]{2}){8,64}$/.test(rec.salt)) return null;
  if(!Number.isInteger(rec.iterations) || rec.iterations < 1 || rec.iterations > 100000) return null;
  return rec;
}
// …and only if it was made under the secret in force now.
async function usableRecord_(env, raw){
  const rec = passwordRecord_(raw);
  return rec && env.PROXY_ADMIN_PASSPHRASE && await markIsCurrent_(env, rec.mark) ? rec : null;
}

export async function userHasUsablePassword(env, user){
  return !!(user && await usableRecord_(env, user.password));
}

// True only for an existing user with a usable password who typed it. Does the same work for a
// user that doesn't exist or has no password, so the time taken says nothing about either.
export async function verifyUserPassword(env, user, key){
  if(!env.PROXY_ADMIN_PASSPHRASE || typeof key !== "string" || key.length > MAX_PASSWORD_LENGTH) return false;
  const rec = user ? await usableRecord_(env, user.password) : null;
  const got = await passwordHash_(env, key, rec ? rec.salt : "00112233445566778899aabbccddeeff", rec ? rec.iterations : PASSWORD_ITERATIONS);
  const ok = !!rec && timingSafeEqual(got, rec.hash);
  // A record marked under a legacy label (an adopted install) is re-marked under the odd- label the first time its
  // password is typed — the hash doesn't change — so LEGACY_LABEL_PREFIX can be removed once everyone has signed in.
  const now = ok ? await secretMark_(env) : "";
  if(ok && rec.mark !== now && user.id != null){
    await updateUser(env.DB, user.id, { password: JSON.stringify(Object.assign({}, rec, { mark: now })) }).catch(() => {});
    await setSettingRaw(env.DB, SECRET_MARK_SETTING, now).catch(() => {});
  }
  return ok;
}

async function passwordRecordFor_(env, password){
  const salt = hex_(crypto.getRandomValues(new Uint8Array(16)));
  return JSON.stringify({ v: 1, salt, iterations: PASSWORD_ITERATIONS, hash: await passwordHash_(env, password, salt, PASSWORD_ITERATIONS),
    mark: await secretMark_(env), changedAt: new Date().toISOString() });
}

export async function setUserPassword(env, userId, password, { mustChange = false } = {}){
  await updateUser(env.DB, userId, { password: await passwordRecordFor_(env, password), mustChangePassword: mustChange });
  await setSettingRaw(env.DB, SECRET_MARK_SETTING, await secretMark_(env));
}

// Why a new password is refused, or "" if it is fine. `current` is what it replaces, if anything.
export function passwordProblem(env, next, current){
  if(typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) return `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if(next.length > MAX_PASSWORD_LENGTH) return `A password can be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if(next !== next.trim()) return "A password can't start or end with a space.";
  if(next === current || next === env.PROXY_ADMIN_PASSPHRASE) return "Choose a password different from the current one.";
  return "";
}

// A password to hand to someone once (a new user, a reset): they must replace it at sign-in.
const TEMP_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function randomGroups_(groups, size){
  const bytes = crypto.getRandomValues(new Uint8Array(groups * size));
  const out = [];
  for(let g = 0; g < groups; g++) out.push(Array.from(bytes.slice(g * size, (g + 1) * size), b => TEMP_ALPHABET[b % TEMP_ALPHABET.length]).join(""));
  return out.join("-");
}
export function generateTempPassword(){ return randomGroups_(4, 4); }

// ---- The installer's passphrase -----------------------------------------------------------------
// PROXY_ADMIN_PASSPHRASE opens the admin only while NO active admin has a usable password:
//   - a new install (no users yet): the first sign-in with it creates the first admin;
//   - an install from before there were users: its owner is adopted as the first admin here,
//     with the password and two-step secret they already had;
//   - a locked-out install: replacing the secret voids every password, so the new passphrase
//     gets the first admin back in.
// Whoever gets in this way must then set a name, an email and a password of their own.
// bootstrapState(env) → { open, admin, replaced, totp }
//   open      the passphrase is accepted right now
//   admin     the user it signs in as (the oldest active admin; else the oldest admin), or null
//   replaced  the secret is not the one last used here — the lock-out recovery case
//   totp      that admin has two-step sign-in (so the bare passphrase in a request is refused)
// THROWS on a storage error; callers answer 503 rather than guess.
export async function bootstrapState(env){
  if(!env.DB) return { open: true, admin: null, replaced: false, totp: !!env.TOTP_SECRET };
  let st = await getBootstrapState(env.DB);
  if(st.userCount === 0){
    // An install that predates users: bring its one owner across, once.
    const oldPassword = passwordRecord_(await getSettingRaw(env.DB, LEGACY_PASSWORD_SETTING));
    const oldTotp = (await getSettingRaw(env.DB, "totpSecret")) || env.TOTP_SECRET || "";
    if(oldPassword || oldTotp){
      const counter = parseInt(await getSettingRaw(env.DB, "totpLastCounter"), 10);
      await insertFirstAdmin(env.DB, { password: oldPassword ? JSON.stringify(oldPassword) : null, totpSecret: oldTotp || null, totpLastCounter: Number.isInteger(counter) ? counter : null });
      if(oldPassword && oldPassword.mark && !(await getSettingRaw(env.DB, SECRET_MARK_SETTING))) await setSettingRaw(env.DB, SECRET_MARK_SETTING, oldPassword.mark);
      st = await getBootstrapState(env.DB);
    }
  }
  const active = st.admins.filter(a => a.status === "active");
  let usable = false;
  for(const a of active) if(await usableRecord_(env, a.password)) usable = true;
  const admin = active[0] || st.admins[0] || null;
  const mark = env.PROXY_ADMIN_PASSPHRASE ? await getSettingRaw(env.DB, SECRET_MARK_SETTING) : null;
  return { open: !usable, admin, replaced: !!mark && !(await markIsCurrent_(env, mark)), totp: !!(admin && admin.totpSecret) };
}

// The placeholder `.dev.vars.example` offers on the Deploy to Cloudflare page. Signing in with it — or
// with any setup password shorter than a real password may be — is refused: the admin's address is
// public from the moment it is deployed, so the first sign-in must not be guessable.
export const SETUP_PASSWORD_PLACEHOLDER = "choose-a-long-setup-password";
export function weakSetupPassword(env){
  const p = String(env.PROXY_ADMIN_PASSPHRASE || "");
  return p.length < MIN_PASSWORD_LENGTH || p.toLowerCase() === SETUP_PASSWORD_PLACEHOLDER;
}

// Remembers which secret was last used to get in (see `replaced` above).
export async function rememberSecret(env){
  await setSettingRaw(env.DB, SECRET_MARK_SETTING, await secretMark_(env));
}

// ---- Two-step sign-in: the setting, and recovery codes ------------------------------------------
// "Require two-step sign-in" is a switch for the whole install (global_settings `require2fa`).
// Turning it on signs nobody out; at each user's next sign-in, one without an authenticator gets
// a session that is pending "2fa" and can do nothing but enrol.
export async function require2fa(env){
  return !!env.DB && (await getSettingRaw(env.DB, "require2fa")) === "1";
}
export async function setRequire2fa(env, on){
  await setSettingRaw(env.DB, "require2fa", on ? "1" : "0");
}

// Recovery codes stand in for the authenticator once each (a lost phone). Only keyed hashes are
// stored; the codes themselves are shown once, when they are made.
export const RECOVERY_CODE_COUNT = 10;
export function generateRecoveryCodes(){ return Array.from({ length: RECOVERY_CODE_COUNT }, () => randomGroups_(2, 5)); }
const cleanRecoveryCode_ = (code) => String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const looksLikeRecoveryCode = (code) => cleanRecoveryCode_(code).length === 10 && !/^\d{6}$/.test(String(code || "").trim());
async function recoveryHash_(env, userId, code){ return hmacHex_(env.PROXY_ADMIN_PASSPHRASE, "recovery:" + userId + ":" + cleanRecoveryCode_(code)); }
export async function saveRecoveryCodes(env, userId, codes){
  const hashes = [];
  for(const c of codes) hashes.push(await recoveryHash_(env, userId, c));
  await updateUser(env.DB, userId, { recoveryCodes: JSON.stringify(hashes) });
}
export function recoveryCodesLeft(user){
  try{ const a = JSON.parse((user && user.recoveryCodes) || "[]"); return Array.isArray(a) ? a.length : 0; }catch(e){ return 0; }
}
// Spends one code. True once per code: the write only happens if the list is still the one read.
export async function spendRecoveryCode(env, user, code){
  let list;
  try{ list = JSON.parse(user.recoveryCodes || "[]"); }catch(e){ return false; }
  if(!Array.isArray(list) || !list.length) return false;
  const h = await recoveryHash_(env, user.id, code);
  let at = -1;
  for(let i = 0; i < list.length; i++) if(timingSafeEqual(String(list[i]), h)) at = i;
  if(at < 0) return false;
  return replaceRecoveryCodes(env.DB, user.id, user.recoveryCodes, JSON.stringify(list.filter((_, i) => i !== at)));
}

// ---- Steps a user must finish before anything else -----------------------------------------------
// The first that applies, or null: "account" (no name, email or password of their own yet),
// "password" (they were given a temporary one), "2fa" (two-step is required and they have none).
export async function pendingFor(env, user){
  if(!user.email || !user.name || !(await userHasUsablePassword(env, user))) return "account";
  if(user.mustChangePassword) return "password";
  if(!user.totpSecret && await require2fa(env)) return "2fa";
  return null;
}
// After a step is done: works out what (if anything) is next for this request's own session and
// records it. `user` is the fresh row. Returns the new value.
export async function refreshPending(env, request, user){
  const me = _users.get(request);
  const next = await pendingFor(env, user);
  if(me && me.tokenHash) await setAdminSessionPending(env.DB, me.tokenHash, next);
  if(me) me.pending = next;
  return next;
}

// Signs every user out, everywhere.
export async function revokeAllSessions(env){
  await deleteAllAdminSessions(env.DB);
}

// The three functions around here (getActiveSecret, saveTotpSecret, clearTotpSecret) read and
// write the ONE shared two-step secret an install had before there were users. It is only read
// now, once, when that owner is adopted (bootstrapState); each user's own secret is in `users`.
export async function saveTotpSecret(env, secret){
  await setSettingRaw(env.DB, "totpSecret", secret);
}

export async function clearTotpSecret(env){
  await env.DB.prepare("DELETE FROM global_settings WHERE key = 'totpSecret'").run();
}

// The session behind a cookie: "unavailable" (storage error — fail closed), null (unknown,
// expired, signed out, or from before sessions belonged to users), or { tokenHash, pending, user }.
async function readSession_(env, token){
  if(!/^sess_[0-9a-f]{48}$/.test(token || "")) return null;
  try{
    const tokenHash = await sha256Hex_(token);
    const row = await getAdminSession(env.DB, tokenHash);
    if(!row || !(new Date(row.expiresAt) > new Date()) || !row.user) return null;
    return { tokenHash, pending: row.pending, user: row.user };
  }catch(e){
    console.error("readSession storage error — refusing (fail closed):", e);
    return "unavailable";
  }
}

// The audit-log actor for a request that passed requireAdmin(): the user's email (their name
// until they have one), or "passphrase" for the installer's.
export function adminActor(request){
  return _actors.get(request) || "unknown";
}

// The user behind a request that passed requireAdmin(): { id, email, name, role, pending,
// tokenHash, bootstrap }. id is null for the installer's passphrase on an install with no users.
export function adminUser(request){
  return _users.get(request) || null;
}

const SETUP_MESSAGES = {
  account:  "Finish setting up your account first.",
  password: "Choose a new password first.",
  "2fa":    "Set up two-step sign-in first.",
};

// Checks the failure budget, then the credential, then that the user may do this. Returns a
// Response to send back immediately, or null when the request may go ahead.
//   role     the LOWEST role allowed: "staff" or "manager". Anything else means admin only.
//   options  { pending: [...] } — the unfinished steps this route is there to finish
//            (see the header); every other route refuses a pending session.
export async function requireAdmin(env, host, providedKey, request, notAdminMessage, role, options){
  if(host.kind !== "admin"){
    return errorResponse(notAdminMessage || "Not available here.", 403);
  }

  const need = role === "staff" || role === "manager" ? role : "admin";
  // Someone already signed in is let through BEFORE any failure budget is looked at: junk requests
  // from the same address (another device on the network, a tab firing requests) mustn't lock a
  // signed-in user out. A session token is 192 random bits, so checking one is no guessing aid.
  const hasCookie = !!readSessionCookie(request, env);
  let result = null;
  if(hasCookie){
    result = await checkCredential(env, providedKey, request, need, options || {});
    if(!result.denied) return null;
  }

  const rl = await rateLimitCheck(env, ADMIN_AUTH_BUCKET, request, ADMIN_AUTH_LIMIT);
  if(rl.blocked) return rateLimitResponse(rl.retryAfter);
  if(!hasCookie){
    const all = await rateLimitCheckGlobal(env, ADMIN_AUTH_GLOBAL_BUCKET, adminAuthGlobalLimit(env), ADMIN_AUTH_GLOBAL_WINDOW);
    if(all.blocked) return rateLimitResponse(all.retryAfter);
  }

  if(!result) result = await checkCredential(env, providedKey, request, need, options || {});
  const { denied, wrongCredential } = result;
  // Only a rejected credential counts toward the budget. A 503 is our outage, and "your role
  // can't do this" or "finish setting up first" is not a guess at a password.
  if(denied && wrongCredential){
    await rateLimitHit(env, ADMIN_AUTH_BUCKET, request);
    // A wrong key with no session counts toward the install-wide budget too. A stale session cookie
    // doesn't: that's an open tab whose session ran out, not a guess.
    if(!hasCookie) await rateLimitHitGlobal(env, ADMIN_AUTH_GLOBAL_BUCKET, ADMIN_AUTH_GLOBAL_WINDOW);
  }
  return denied;
}

async function checkCredential(env, providedKey, request, need, options){
  const wrong = (message, status) => ({ denied: errorResponse(message, status), wrongCredential: true });
  const unavailable = () => ({ denied: errorResponse("Sign-in service temporarily unavailable — try again shortly.", 503), wrongCredential: false });

  // 1. Cloudflare Access (when configured) — required in addition to 2/3.
  let accessEmail = null;
  if(accessEnabled(env)){
    const acc = await verifyAccess(env, request);
    if(!acc.ok) return wrong(acc.reason, 403);
    accessEmail = acc.email;
  }

  // 2. Session cookie.
  const cookieToken = readSessionCookie(request, env);
  if(cookieToken){
    if(!isSameOrigin(request)){
      return wrong("Cross-origin admin request refused.", 403);
    }
    const sess = await readSession_(env, cookieToken);
    if(sess === "unavailable") return unavailable();
    // A disabled user's sessions are deleted when they are disabled; this covers the instant between.
    if(!sess || sess.user.status !== "active" || !isRole(sess.user.role)) return wrong("Session expired — please log in again.", 401);
    const u = sess.user;
    if(sess.pending && !(Array.isArray(options.pending) && options.pending.includes(sess.pending))){
      return { denied: jsonResponse({ status: "error", code: "setup_required", pending: sess.pending, message: SETUP_MESSAGES[sess.pending] || "Finish signing in first." }, 403), wrongCredential: false };
    }
    if(roleRank_(u.role) < roleRank_(need)){
      return { denied: jsonResponse({ status: "error", code: "forbidden", message: need === "admin" ? "Only an admin can do this." : "Your account can't do this. Ask an admin." }, 403), wrongCredential: false };
    }
    const who = u.email || u.name || ("user:" + u.id);
    _actors.set(request, accessEmail && accessEmail.toLowerCase() !== who ? who + " (Access: " + accessEmail + ")" : who);
    _users.set(request, { id: u.id, email: u.email, name: u.name, role: u.role, pending: sess.pending, tokenHash: sess.tokenHash, bootstrap: false });
    return { denied: null, wrongCredential: false };
  }

  const key = providedKey || "";

  // Bearer session tokens in the request are not honored (see the header comment).
  if(key.startsWith(SESSION_PREFIX)){
    return wrong("Session expired — please log in again.", 401);
  }

  // 3. The installer's passphrase, while it is still the way in.
  let boot;
  try{ boot = await bootstrapState(env); }
  catch(e){
    console.error("requireAdmin: could not read the sign-in state — refusing (fail closed):", e);
    return unavailable();
  }
  if(boot.totp){
    return wrong("Two-factor authentication is required. Please log in through the admin panel.", 403);
  }
  if(!env.PROXY_ADMIN_PASSPHRASE || !boot.open || !timingSafeEqual(key, env.PROXY_ADMIN_PASSPHRASE)){
    return wrong("Unauthorized", 401);
  }
  _actors.set(request, accessEmail || "passphrase");
  _users.set(request, { id: boot.admin ? boot.admin.id : null, email: "", name: "", role: "admin", pending: null, tokenHash: "", bootstrap: true });
  return { denied: null, wrongCredential: false };
}
