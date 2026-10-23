/**
 * Your own account: finishing its set-up, and changing your password.
 * ========================================================================
 * POST /api/admin-password   (any signed-in user; these are the routes a session that is pending
 *                             "account" or "password" may still use — functions/_lib/adminAuth.js)
 *   { action: "status" }
 *     → { status: "ok", user: { name, email, role }, pending, hasPassword, minLength }
 *   { action: "account", name, email, next? }
 *     The first thing after signing in with the installer's passphrase, and what the owner of an
 *     install from before there were users sees once: a name, an email and — unless they already
 *     have a password of their own — a password (`next`).
 *   { action: "change", current: "<password now>", next: "<new password>" }
 *     Security → Change password, and the step after signing in with a temporary password.
 *
 * Setting a password signs that user out everywhere, this browser included (the cookie is
 * cleared): the next thing they do is sign in with it. Every change is written to the audit log
 * FIRST (no record, no change), and a wrong current password counts against the same failure
 * budget as a wrong sign-in. A forgotten password is reset by an admin (Users), or — for the only
 * admin — from the command line (`npm run setup -- --new-passphrase`).
 */

import { classifyHost }   from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { jsonResponse }   from "../_lib/http.js";
import { rateLimitHit }   from "../_lib/rateLimit.js";
import {
  requireAdmin, adminActor, adminUser, verifyUserPassword, userHasUsablePassword, setUserPassword, passwordProblem,
  refreshPending, clearSessionCookieHeader, MIN_PASSWORD_LENGTH,
} from "../_lib/adminAuth.js";
import { insertAuditLog, getUserById, getUserByEmail, updateUser, deleteUserSessions } from "../_lib/db.js";

const unavailable = () => jsonResponse({status:"error", message:"Sign-in service temporarily unavailable — try again shortly."}, 503);
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export async function onRequestPost(context){
  const { request, env } = context;

  let catalogData;
  try{ catalogData = await getCatalogData(env); }
  catch(e){ return jsonResponse({status:"error", message:"Catalog unavailable"}, 503); }
  const host = classifyHost(new URL(request.url).hostname, catalogData.subdomainMap, env);

  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({status:"error", message:"Bad request"}, 400); }
  const action = String((body && body.action) || "");

  const authErr = await requireAdmin(env, host, String((body && body.key) || ""), request, "Not available here.", "staff", { pending: ["account", "password"] });
  if(authErr) return authErr;
  const me = adminUser(request);
  if(!me || me.id == null || me.bootstrap) return jsonResponse({status:"error", message:"Sign in through the admin page first."}, 403);

  let user;
  try{ user = await getUserById(env.DB, me.id); }
  catch(e){ console.error("admin-password: could not read the user:", e); return unavailable(); }
  if(!user) return jsonResponse({status:"error", message:"Session expired — please log in again."}, 401);

  const audit = async (auditAction, detail) => {
    try{
      await insertAuditLog(env.DB, { orgId: null, orderId: null, action: auditAction, detail, actor: adminActor(request),
        ip: request.headers.get("CF-Connecting-IP") || null, actorUserId: user.id, targetUserId: user.id });
      return null;
    }catch(e){
      console.error("AUDIT WRITE FAILED:", auditAction, e);
      return jsonResponse({status:"error", message:"Could not record this change — try again."}, 503);
    }
  };
  // The password is set from here on; sign this user out everywhere so the next step is a
  // sign-in with it. If the sessions can't be cleared they still expire within a day — say so.
  const passwordSet = async () => {
    let signedOut = true;
    try{ await deleteUserSessions(env.DB, user.id); }
    catch(e){ signedOut = false; console.error("admin-password: could not revoke sessions:", e); }
    const res = jsonResponse({status:"ok", signedOut, signInAgain: true});
    res.headers.append("Set-Cookie", clearSessionCookieHeader());
    res.headers.set("Cache-Control", "no-store");
    return res;
  };

  if(action === "status"){
    try{
      return jsonResponse({status:"ok", user: { name: user.name, email: user.email, role: user.role }, pending: me.pending || null,
        hasPassword: await userHasUsablePassword(env, user), minLength: MIN_PASSWORD_LENGTH});
    }catch(e){ return unavailable(); }
  }

  if(action === "account"){
    const name  = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const next  = typeof body.next === "string" ? body.next : "";
    if(!name || name.length > 80) return jsonResponse({status:"error", message:"Give your name (up to 80 characters)."}, 400);
    if(email.length > 200 || !EMAIL_RE.test(email)) return jsonResponse({status:"error", message:"Give the email address you will sign in with."}, 400);
    let hasPassword;
    try{
      hasPassword = await userHasUsablePassword(env, user);
      const taken = await getUserByEmail(env.DB, email);
      if(taken && taken.id !== user.id) return jsonResponse({status:"error", message:"Another user already has that email."}, 409);
    }catch(e){ return unavailable(); }
    const setPassword = !hasPassword || !!next;
    if(setPassword){
      const problem = passwordProblem(env, next, null);
      if(problem) return jsonResponse({status:"error", message: problem}, 400);
    }
    const auditErr = await audit("security.account_set_up", { name, email, passwordSet: setPassword });
    if(auditErr) return auditErr;
    try{
      await updateUser(env.DB, user.id, { name, email });
      if(setPassword) await setUserPassword(env, user.id, next);
    }catch(e){
      if(/UNIQUE/i.test(String(e && e.message))) return jsonResponse({status:"error", message:"Another user already has that email."}, 409);
      console.error("admin-password: could not save the account:", e);
      return jsonResponse({status:"error", message:"Could not save — try again."}, 503);
    }
    if(setPassword) return passwordSet();
    try{ return jsonResponse({status:"ok", pending: await refreshPending(env, request, await getUserById(env.DB, user.id))}); }
    catch(e){ return unavailable(); }
  }

  if(action === "change"){
    const current = typeof body.current === "string" ? body.current : "";
    const next    = typeof body.next === "string" ? body.next : "";
    let good;
    try{ good = await verifyUserPassword(env, user, current); }
    catch(e){ console.error("admin-password: could not check the password:", e); return unavailable(); }
    if(!good){
      await rateLimitHit(env, "admin_auth", request);
      return jsonResponse({status:"error", message:"The current password is not right."}, 401);
    }
    const problem = passwordProblem(env, next, current);
    if(problem) return jsonResponse({status:"error", message: problem}, 400);
    const auditErr = await audit("security.password_changed", { replacedTemporary: !!user.mustChangePassword });
    if(auditErr) return auditErr;
    try{ await setUserPassword(env, user.id, next); }
    catch(e){ console.error("admin-password: could not store the new password:", e); return jsonResponse({status:"error", message:"Could not save the new password — try again."}, 503); }
    return passwordSet();
  }

  return jsonResponse({status:"error", message:"Unknown action."}, 400);
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
