/**
 * Users: who can sign in to the back office, and as what.
 * ========================================================================
 * POST /api/admin-users
 *   { action: "me" }                       any signed-in user, even one with a step to finish:
 *                                          → { user: { id, name, email, role }, pending, require2fa }
 *   Everything else is for an ADMIN:
 *   { action: "list" }                     → { users: [...], require2fa }
 *   { action: "create", name, email, role }→ { user, temporaryPassword }   (shown once)
 *   { action: "update", id, name, email }
 *   { action: "setRole", id, role }        role: "staff" | "manager" | "admin"
 *   { action: "setStatus", id, status }    status: "active" | "disabled"
 *   { action: "resetPassword", id }        → { temporaryPassword }          (shown once)
 *   { action: "reset2fa", id }             a lost phone: they enrol again
 *   { action: "setRequire2fa", on }        the install-wide "Require two-step sign-in" switch
 *
 * Rules kept here:
 *   - A user is disabled, never deleted, so the audit log and old orders keep their attribution.
 *   - There is always at least one active admin: the statement that changes a role or a status
 *     refuses to remove the last one (functions/_lib/db.js setUserRoleAndStatus).
 *   - You can't change your own role or status, or reset your own password or two-step here
 *     (that is Security → Change password, and Security (2FA), which ask for proof it is you).
 *   - Changing someone's role or status, or resetting their password or two-step, signs them out
 *     everywhere. A disabled user can't sign in and their sessions are gone at once.
 *   - A temporary password is made here, returned once, never logged; whoever gets it must
 *     replace it at their first sign-in.
 *   - Every change is written to the audit log FIRST; no record, no change.
 */

import { classifyHost }   from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { jsonResponse }   from "../_lib/http.js";
import {
  requireAdmin, adminActor, adminUser, isRole, userHasUsablePassword, setUserPassword, generateTempPassword,
  require2fa, setRequire2fa, recoveryCodesLeft,
} from "../_lib/adminAuth.js";
import { insertAuditLog, listUsers, getUserById, getUserByEmail, insertUser, updateUser, setUserRoleAndStatus, deleteUserSessions } from "../_lib/db.js";

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const bad = (message, status = 400) => jsonResponse({status:"error", message}, status);

export async function onRequestPost(context){
  const { request, env } = context;

  let catalogData;
  try{ catalogData = await getCatalogData(env); }
  catch(e){ return jsonResponse({status:"error", message:"Catalog unavailable"}, 503); }
  const host = classifyHost(new URL(request.url).hostname, catalogData.subdomainMap, env);

  let body;
  try{ body = await request.json(); }
  catch(e){ return bad("Bad request"); }
  const action = String((body && body.action) || "");
  const self = action === "me";

  // "me" is everyone's; the rest is user management, which is an admin's alone.
  const authErr = await requireAdmin(env, host, String((body && body.key) || ""), request, "Not available here.",
    self ? "staff" : "admin", self ? { pending: ["account", "password", "2fa"] } : undefined);
  if(authErr) return authErr;
  const me = adminUser(request);

  try{
    if(self){
      return jsonResponse({status:"ok", user: me && me.id != null ? { id: me.id, name: me.name, email: me.email, role: me.role } : null,
        pending: (me && me.pending) || null, require2fa: await require2fa(env)});
    }
    if(!me || me.id == null || me.bootstrap) return bad("Sign in through the admin page first.", 403);

    const view = async (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, has2fa: !!u.totpSecret,
      recoveryCodesLeft: recoveryCodesLeft(u), mustChangePassword: !!u.mustChangePassword, passwordUsable: await userHasUsablePassword(env, u),
      lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt });
    const audit = async (auditAction, target, detail) => {
      try{
        await insertAuditLog(env.DB, { orgId: null, orderId: null, action: auditAction, detail, actor: adminActor(request),
          ip: request.headers.get("CF-Connecting-IP") || null, actorUserId: me.id, targetUserId: target ? target.id : null });
        return null;
      }catch(e){
        console.error("AUDIT WRITE FAILED:", auditAction, e);
        return bad("Could not record this change — try again.", 503);
      }
    };
    const who = (u) => ({ email: u.email, name: u.name });

    if(action === "list"){
      const users = [];
      for(const u of await listUsers(env.DB)) users.push(await view(u));
      return jsonResponse({status:"ok", users, require2fa: await require2fa(env), me: me.id});
    }

    if(action === "setRequire2fa"){
      const on = body.on === true;
      const auditErr = await audit("security.require_2fa_changed", null, { on });
      if(auditErr) return auditErr;
      await setRequire2fa(env, on);
      return jsonResponse({status:"ok", require2fa: on});
    }

    if(action === "create"){
      const name = typeof body.name === "string" ? body.name.trim() : "", email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const role = String(body.role || "");
      if(!name || name.length > 80) return bad("Give the person's name (up to 80 characters).");
      if(email.length > 200 || !EMAIL_RE.test(email)) return bad("Give the email address they will sign in with.");
      if(!isRole(role)) return bad("Choose a role.");
      if(await getUserByEmail(env.DB, email)) return bad("A user with that email already exists. A disabled user can be enabled again.", 409);
      const auditErr = await audit("security.user_created", null, { name, email, role });
      if(auditErr) return auditErr;
      let user;
      try{ user = await insertUser(env.DB, { name, email, role, status: "active" }); }
      catch(e){ if(/UNIQUE/i.test(String(e && e.message))) return bad("A user with that email already exists.", 409); throw e; }
      const temporaryPassword = generateTempPassword();
      await setUserPassword(env, user.id, temporaryPassword, { mustChange: true });
      const res = jsonResponse({status:"ok", user: await view(await getUserById(env.DB, user.id)), temporaryPassword});
      res.headers.set("Cache-Control", "no-store");
      return res;
    }

    // Everything below acts on one existing user.
    const target = Number.isInteger(body.id) ? await getUserById(env.DB, body.id) : null;
    if(!target) return bad("No such user.", 404);
    const isMe = target.id === me.id;

    if(action === "update"){
      const name = typeof body.name === "string" ? body.name.trim() : "", email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if(!name || name.length > 80) return bad("Give the person's name (up to 80 characters).");
      if(email.length > 200 || !EMAIL_RE.test(email)) return bad("Give the email address they will sign in with.");
      const taken = await getUserByEmail(env.DB, email);
      if(taken && taken.id !== target.id) return bad("Another user already has that email.", 409);
      const auditErr = await audit("security.user_updated", target, { before: who(target), after: { email, name } });
      if(auditErr) return auditErr;
      try{ await updateUser(env.DB, target.id, { name, email }); }
      catch(e){ if(/UNIQUE/i.test(String(e && e.message))) return bad("Another user already has that email.", 409); throw e; }
      return jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id))});
    }

    if(action === "setRole" || action === "setStatus"){
      const role = action === "setRole" ? String(body.role || "") : null, status = action === "setStatus" ? String(body.status || "") : null;
      if(role !== null && !isRole(role)) return bad("Choose a role.");
      if(status !== null && status !== "active" && status !== "disabled") return bad("Choose active or disabled.");
      if(isMe) return bad("You can't change your own role or disable yourself. Another admin has to.", 409);
      if((role !== null && role === target.role) || (status !== null && status === target.status)) return jsonResponse({status:"ok", user: await view(target)});
      const auditAction = role !== null ? "security.user_role_changed" : status === "disabled" ? "security.user_disabled" : "security.user_enabled";
      const auditErr = await audit(auditAction, target, role !== null ? { ...who(target), from: target.role, to: role } : who(target));
      if(auditErr) return auditErr;
      if(!(await setUserRoleAndStatus(env.DB, target.id, { role, status }))){
        return bad("That would leave no active admin. Make someone else an admin first.", 409);
      }
      // Whatever they could do a moment ago, they sign in again to find out what they can do now.
      await deleteUserSessions(env.DB, target.id);
      return jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id))});
    }

    if(action === "resetPassword"){
      if(isMe) return bad("Change your own password under Security → Change password.", 409);
      const auditErr = await audit("security.user_password_reset", target, who(target));
      if(auditErr) return auditErr;
      const temporaryPassword = generateTempPassword();
      await setUserPassword(env, target.id, temporaryPassword, { mustChange: true });
      await deleteUserSessions(env.DB, target.id);
      const res = jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id)), temporaryPassword});
      res.headers.set("Cache-Control", "no-store");
      return res;
    }

    if(action === "reset2fa"){
      if(isMe) return bad("Switch your own two-step sign-in off under Security (2FA); it asks for a code first.", 409);
      const auditErr = await audit("security.user_2fa_reset", target, who(target));
      if(auditErr) return auditErr;
      await updateUser(env.DB, target.id, { totpSecret: null, totpLastCounter: null, recoveryCodes: null });
      await deleteUserSessions(env.DB, target.id);
      return jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id))});
    }

    return bad("Unknown action.");
  }catch(e){
    console.error("admin-users " + action + " failed:", e);
    return bad("Could not do that — try again.", 503);
  }
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
