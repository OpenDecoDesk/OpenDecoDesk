/**
 * Sign-in and sign-out.
 * ========================================================================
 * POST /api/admin-session
 *   Body: { email, key: "<password>", totpCode?: "<6-digit code or a recovery code>" }
 *
 * Finds the user by email, checks their password and — when they have two-step sign-in — a code
 * from their authenticator or one of their recovery codes (and a Cloudflare Access login, when
 * that is configured). An unknown email, a disabled user and a wrong password all get the same
 * answer. On success a 24-hour session is stored in D1 (admin_sessions, keyed by the token's
 * SHA-256) and set as an HttpOnly, Secure, SameSite=Strict `__Host-` cookie. The token is NEVER
 * returned in the body — page JavaScript (and so any XSS) can't read it.
 *
 * The reply says who signed in ({ user: { name, email, role } }) and, when there is one, the
 * step they must finish before anything else answers ({ pending: "account" | "password" |
 * "2fa" } — functions/_lib/adminAuth.js).
 *
 * THE INSTALLER'S PASSPHRASE signs in as the first admin — whatever is typed as the email — but
 * only while no active admin has a usable password: a new install, or one locked out and
 * recovered with `npm run setup -- --new-passphrase` (which voids every password). In the
 * recovery case that admin's two-step sign-in is cleared too and every session is revoked.
 * Either way the session is pending "account": a name, an email and a new password come first.
 *
 * Two-step flow:
 *   1. POST { email, key } — if a code is needed, the server answers { status:"totp_required" }.
 *   2. POST { email, key, totpCode } — both are checked and the session is issued.
 *
 * DELETE /api/admin-session
 *   Revokes the session in the cookie (server-side) and clears the cookie.
 */

import { classifyHost, rootDomain } from "../_lib/hostConfig.js";
import { getCatalogData }     from "../_lib/catalogCache.js";
import { rateLimited, rateLimitResponse, rateLimitCheckGlobal, rateLimitHitGlobal } from "../_lib/rateLimit.js";
import { jsonResponse }       from "../_lib/http.js";
import {
  timingSafeEqual, issueSession, revokeSession, readCookie, isSameOrigin,
  sessionCookieHeader, clearSessionCookieHeader, SESSION_COOKIE, SESSION_TTL_SEC, readSessionCookie,
  bootstrapState, rememberSecret, verifyUserPassword, pendingFor, revokeAllSessions, weakSetupPassword,
  looksLikeRecoveryCode, spendRecoveryCode, revokeUserSessionsFor,
  ADMIN_AUTH_GLOBAL_BUCKET, ADMIN_AUTH_GLOBAL_WINDOW, adminAuthGlobalLimit,
} from "../_lib/adminAuth.js";
import { accessEnabled, verifyAccess } from "../_lib/access.js";
import { verifyTOTP }         from "../_lib/totp.js";
import { disableWorkersDev }  from "../_lib/cloudflareSetup.js";
import {
  recordFailedAdminLogin, insertAuditLog, getUserByEmail, getUserById, insertFirstAdmin, insertUser, getBootstrapState,
  updateUser, setUserRoleAndStatus, claimUserTotpCounter, noteAdminHostSeen, getSiteSetting, noteWorkersDevOff,
} from "../_lib/db.js";

async function getHost(env, request){
  const url = new URL(request.url);
  const catalogData = await getCatalogData(env);
  return classifyHost(url.hostname, catalogData.subdomainMap, env);
}

export async function onRequestPost(context){
  const { request, env } = context;

  let host;
  try{ host = await getHost(env, request); }
  catch(e){ return jsonResponse({status:"error", message:"Catalog unavailable"}, 503); }

  if(host.kind !== "admin"){
    return jsonResponse({status:"error", message:"Not available here."}, 403);
  }

  // Login CSRF guard: only the admin page itself may start a session. Checked BEFORE counting, so a
  // page elsewhere can't spend this address's sign-in budget (and lock its owner out).
  if(!isSameOrigin(request)){
    return jsonResponse({status:"error", message:"Cross-origin login refused."}, 403);
  }

  const rl = await rateLimited(env, "admin_auth", request, 10);
  if(rl.blocked) return rateLimitResponse(rl.retryAfter);
  // …and the install-wide budget of FAILED sign-ins (adminAuth.js), whoever is asking.
  const all = await rateLimitCheckGlobal(env, ADMIN_AUTH_GLOBAL_BUCKET, adminAuthGlobalLimit(env), ADMIN_AUTH_GLOBAL_WINDOW);
  if(all.blocked) return rateLimitResponse(all.retryAfter);
  if(accessEnabled(env)){
    const acc = await verifyAccess(env, request);
    if(!acc.ok) return jsonResponse({status:"error", message:acc.reason}, 403);
  }

  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({status:"error", message:"Bad request"}, 400); }

  const email = String(body.email || "").trim().toLowerCase();
  const key   = String(body.key || "");
  const code  = String(body.totpCode || body.recoveryCode || "").trim();
  const ip    = request.headers.get("CF-Connecting-IP") || null;
  const unavailable = (what, e) => {
    console.error("admin-session: " + what + " — refusing (fail closed):", e);
    return jsonResponse({status:"error", message:"Sign-in service temporarily unavailable — try again shortly."}, 503);
  };
  const refuse = async (reason, message) => {
    await noteFailure(env, reason, request);
    await rateLimitHitGlobal(env, ADMIN_AUTH_GLOBAL_BUCKET, ADMIN_AUTH_GLOBAL_WINDOW);
    return jsonResponse({status:"error", message: message || "Unauthorized"}, 401);
  };

  if(!env.PROXY_ADMIN_PASSPHRASE || !env.DB) return refuse("passphrase");

  // Who is this? Either the installer's passphrase while it is still the way in, or a user.
  let boot, user = null, viaPassphrase = false;
  try{
    boot = await bootstrapState(env);
    if(boot.open && timingSafeEqual(key, env.PROXY_ADMIN_PASSPHRASE)){
      // The setup password is the way in to a new site: refuse one that is the example's placeholder
      // or too short to be safe on an address anyone can reach.
      if(weakSetupPassword(env)){
        return jsonResponse({status:"error", code:"weak_setup_password", message:"The setup password is still the example one, or shorter than 12 characters. Change it first: Cloudflare dashboard → Workers & Pages → this Worker → Settings → Variables and Secrets → PROXY_ADMIN_PASSPHRASE. Then sign in with the new one."}, 403);
      }
      viaPassphrase = true;
      user = boot.admin;
    }else{
      // The owner adopted from before there were users has no email yet: any (or none) finds them.
      user = (await getUserByEmail(env.DB, email)) || (email ? await getUserByEmail(env.DB, "") : null);
      const good = await verifyUserPassword(env, user && user.status === "active" ? user : null, key);
      if(!good) return refuse("passphrase");
    }
  }catch(e){ return unavailable("could not check the password", e); }

  // Two-step sign-in, when this user has it. The one exception: the secret was replaced to get
  // back into a locked install — then the authenticator may be exactly what was lost.
  const recovering = viaPassphrase && boot.replaced;
  let usedRecoveryCode = false;
  if(user && user.totpSecret && !recovering){
    if(!code){
      return jsonResponse({status:"totp_required", message:"Enter the 6-digit code from your authenticator app, or one of your recovery codes."});
    }
    try{
      if(looksLikeRecoveryCode(code)){
        if(!(await spendRecoveryCode(env, user, code))) return refuse("code", "That recovery code is not right, or was already used.");
        usedRecoveryCode = true;
      }else{
        const result = await verifyTOTP(user.totpSecret, code);
        if(!result.valid) return refuse("code", "Invalid authentication code. Check the time on your device and try again.");
        // Prevent replay: a counter is accepted once, and only if it is newer than the last one.
        if(!(await claimUserTotpCounter(env.DB, user.id, result.counter))){
          return jsonResponse({status:"error", message:"Code already used — wait for the next code from your authenticator app."}, 401);
        }
      }
    }catch(e){ return unavailable("could not check the code", e); }
  }

  let session, pending;
  try{
    if(viaPassphrase){
      // Written down first: this is the one way in that isn't a user's own password.
      await insertAuditLog(env.DB, { orgId: null, orderId: null, action: recovering ? "security.recovery_signin" : "security.first_signin",
        detail: { secretReplaced: recovering, twoStepCleared: !!(recovering && user && user.totpSecret) }, actor: "passphrase", ip,
        actorUserId: user ? user.id : null, targetUserId: user ? user.id : null });
      if(!user){
        // No admin at all: make one. (insertFirstAdmin only acts on an install with no users.)
        if(!(await insertFirstAdmin(env.DB))) await insertUser(env.DB, { role: "admin" });
        user = (await getBootstrapState(env.DB)).admins[0];
      }
      if(user.status !== "active") await setUserRoleAndStatus(env.DB, user.id, { status: "active" });
      if(recovering){
        if(user.totpSecret) await updateUser(env.DB, user.id, { totpSecret: null, totpLastCounter: null, recoveryCodes: null });
        await revokeAllSessions(env);
      }
      await rememberSecret(env);
      pending = "account";
    }else{
      if(usedRecoveryCode){
        await insertAuditLog(env.DB, { orgId: null, orderId: null, action: "security.recovery_code_used", detail: {}, actor: user.email || user.name || "user:" + user.id, ip,
          actorUserId: user.id, targetUserId: user.id });
      }
      pending = await pendingFor(env, user);
    }
    session = await issueSession(env, user.id, pending);
    await updateUser(env.DB, user.id, { lastLoginAt: new Date().toISOString() });
    user = await getUserById(env.DB, user.id);
  }catch(e){
    console.error("admin-session: could not issue a session:", e);
    return jsonResponse({status:"error", message:"Session storage unavailable — try again."}, 503);
  }

  // A sign-in on admin.<root domain> (not the workers.dev address) proves the domain works: noted
  // once, so the next deploy may switch workers.dev off. Never a reason to refuse the sign-in.
  if(env.ROOT_DOMAIN && !/\.workers\.dev$/i.test(new URL(request.url).hostname)){
    try{ await noteAdminHostSeen(env.DB, rootDomain(env), new URL(request.url).hostname.split(".")[0].toLowerCase()); }
    catch(e){ console.error("admin-session: could not note the admin host:", e); }
    // A site given its domain in the admin (functions/_lib/cloudflareSetup.js) no longer needs its
    // workers.dev address: switched off now, and tried again at later sign-ins until that works.
    if(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_WORKER_NAME){
      const off = (async () => {
        const site = await getSiteSetting(env.DB);
        if(!site.viaSetup || site.workersDevOff) return;
        await disableWorkersDev({ token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID, service: env.CF_WORKER_NAME });
        await noteWorkersDevOff(env.DB);
      })().catch(e => console.error("admin-session: could not switch the workers.dev address off:", e && e.message));
      if(typeof context.waitUntil === "function") context.waitUntil(off); else await off;
    }
  }

  // `session:"cookie"` tells admin.js the credential lives in the cookie; the
  // token itself never appears in the body.
  const res = jsonResponse({status:"ok", session:"cookie", expires: session.expires, pending: pending || null,
    user: { name: user.name, email: user.email, role: user.role }});
  res.headers.append("Set-Cookie", sessionCookieHeader(session.token, SESSION_TTL_SEC));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

// There is deliberately NO GET handler: one that returned the otpauth://
// URI (i.e. the TOTP secret) to anyone holding just the passphrase would
// make the second factor recoverable from the first. Authenticator setup
// goes through /api/admin-2fa (generate → activate), which requires an
// already-authenticated session.
export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}

// Revokes the cookie's session server-side and clears the cookie (sign-out). With ?all=1, every
// session of that user — "Sign out everywhere" on the Security page.
export async function onRequestDelete(context){
  const { request, env } = context;

  let host;
  try{ host = await getHost(env, request); }
  catch(e){ return jsonResponse({status:"error", message:"Catalog unavailable"}, 503); }

  if(host.kind !== "admin"){
    return jsonResponse({status:"error", message:"Not available here."}, 403);
  }

  if(!isSameOrigin(request)){
    return jsonResponse({status:"error", message:"Cross-origin request refused."}, 403);
  }

  const rl = await rateLimited(env, "admin_auth", request, 10);
  if(rl.blocked) return rateLimitResponse(rl.retryAfter);

  const everywhere = new URL(request.url).searchParams.get("all") === "1";
  try{
    if(everywhere){
      const userId = await revokeUserSessionsFor(env, readSessionCookie(request, env));
      if(userId != null) await insertAuditLog(env.DB, { orgId: null, orderId: null, action: "security.signed_out_everywhere", detail: {},
        actor: "user:" + userId, ip: request.headers.get("CF-Connecting-IP") || null, actorUserId: userId, targetUserId: userId }).catch(() => {});
    } else await revokeSession(env, readSessionCookie(request, env));
  }
  catch(e){ console.error("admin-session DELETE: session delete error:", e); }

  const res = jsonResponse({status:"ok"});
  res.headers.append("Set-Cookie", clearSessionCookieHeader());
  return res;
}

// Counts a failed sign-in for the owner's daily roll-up (never blocks the
// response: a D1 problem here must not change what the caller sees).
async function noteFailure(env, reason, request){
  if(!env.DB) return;
  try{ await recordFailedAdminLogin(env.DB, reason, request.headers.get("CF-Connecting-IP") || ""); }
  catch(e){ console.error("admin-session: could not record failed sign-in:", e); }
}
