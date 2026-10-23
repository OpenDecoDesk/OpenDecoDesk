// Test helper for code that keeps platform state in D1 (admin sessions, the catalog version,
// the TOTP secret/counter).
//
//   const { makePlatformDb, platformGlobals } = require("./testlib/platform-db");
//   Object.assign(global, platformGlobals());   // for tests that eval() stripped sources
//   const DB = await makePlatformDb();           // real SQLite via sql.js, real table definitions
//
// Tests that load source files by stripping their imports (new Function / eval) get the db.js
// functions those files import as globals; the real implementations run against the real tables.

const fs = require("fs");
const { createD1 } = require("./d1-shim");

const NAMES = [
  "getSettingRaw", "setSettingRaw", "deleteSettingRaw", "bumpCatalogVersion", "getCatalogCacheState",
  "claimTotpCounter", "insertAdminSession", "getAdminSessionExpiry", "deleteAdminSession",
  "getAdminSession", "setAdminSessionPending", "deleteUserSessions", "deleteAllAdminSessions",
  "getUserById", "getUserByEmail", "listUsers", "getBootstrapState", "insertUser", "insertFirstAdmin", "updateUser",
  "setUserRoleAndStatus", "claimUserTotpCounter", "replaceRecoveryCodes", "insertAuditLog", "recordFailedAdminLogin",
];

let _fns = null;
function platformGlobals(){
  if(!_fns){
    const src = fs.readFileSync(__dirname + "/../functions/_lib/db.js", "utf8")
      .replace(/export (async function|function|const)/g, "$1");
    _fns = new Function(src + "\nreturn {" + NAMES.join(",") + "};")();
  }
  return Object.assign({}, _fns);
}

async function makePlatformDb(){
  const db = await createD1();
  // The real definitions, cut out of schema.sql, so this can't drift from them.
  const schema = fs.readFileSync(__dirname + "/../schema.sql", "utf8");
  const table = (name) => { const m = new RegExp("CREATE TABLE IF NOT EXISTS " + name + " \\([\\s\\S]*?\\n\\);").exec(schema); if (!m) throw new Error("schema.sql has no table " + name); return m[0]; };
  db.execFile(["global_settings", "admin_sessions", "users", "audit_log"].map(table).join("\n"));
  return db;
}

// A D1 stand-in whose every call throws — for "storage outage fails closed" tests.
function brokenDb(message){
  const boom = () => { throw new Error(message || "D1 unavailable"); };
  return { prepare: boom, batch: boom };
}

async function sha256Hex(text){
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, "0")).join("");
}

// Stores a session as the app would (hash of the token) for a user — by default an admin made
// here, since a session belongs to someone. Returns that user's id.
async function seedSession(db, token, expiresIso, user){
  const u = Object.assign({ email: "owner@myshop.com", name: "Owner", role: "admin", status: "active" }, user || {});
  let row = await db.prepare("SELECT id FROM users WHERE email = ?").bind(u.email).first();
  if(!row){
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO users (email, name, role, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)").bind(u.email, u.name, u.role, u.status, now, now).run();
    row = await db.prepare("SELECT id FROM users WHERE email = ?").bind(u.email).first();
  }
  await db.prepare("INSERT INTO admin_sessions (tokenHash, expiresAt, userId, pending) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), expiresIso, row.id, u.pending || null).run();
  return row.id;
}

module.exports = { makePlatformDb, platformGlobals, brokenDb, sha256Hex, seedSession };
