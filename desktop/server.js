// The desktop program's server: the Worker (src/worker.js) run by Miniflare — Cloudflare's own
// local runtime, the one `wrangler dev` uses — with its database, files and Durable Object kept in
// a folder on this computer. desktop/main.js starts it and points the window at it; it also runs on
// its own, without Electron, for trying the desktop edition in a browser:
//
//   node desktop/server.js [data folder]      → prints the address to open
//
// Nothing here talks to Cloudflare. The server listens on 127.0.0.1 only, and the Worker answers
// only to the names localhost / 127.0.0.1 (hostConfig.js, EDITION=desktop).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readSources, migrate } = require("./migrate.js");

// Pictures are stored with this address (R2_PUBLIC_BASE), whatever port the server is on, so they
// keep working when the port changes. ".invalid" can never be a real address (RFC 2606); the
// desktop window answers it from the IMAGES bucket (main.js), and the Worker's own picture
// handling (image-proxy.js, orphanImages.js) reads it like any image host.
const IMAGES_HOST = "images.desktop.invalid";
const IMAGES_BASE = "https://" + IMAGES_HOST;

// The repository files the program carries: the Worker, the pages, the database files.
function appRoot() {
  return path.join(__dirname, "..");
}

// desktop.json in the data folder: the port to reuse, the secrets the Worker signs and
// encrypts with, and the last migration this database has had. `protect` / `unprotect` encrypt the
// secrets at rest when the program provides them (Electron's safeStorage, main.js); without them
// (node desktop/server.js) the file holds them as they are — it is the user's own folder.
function loadConfig(dataDir, { unprotect } = {}) {
  const file = path.join(dataDir, "desktop.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* first start */ }
  let secrets = null;
  if (cfg.secrets && typeof cfg.secrets === "object") secrets = cfg.secrets;
  else if (typeof cfg.secretsProtected === "string" && unprotect) {
    try { secrets = JSON.parse(unprotect(cfg.secretsProtected)); } catch (e) { secrets = null; }
  }
  return { cfg, secrets };
}
function saveConfig(dataDir, cfg, secrets, { protect } = {}) {
  const out = { ...cfg };
  delete out.secrets; delete out.secretsProtected;
  if (protect) out.secretsProtected = protect(JSON.stringify(secrets));
  else out.secrets = secrets;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "desktop.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
const newSecret = () => crypto.randomBytes(32).toString("hex");
function makeSecrets() {
  // SIGNING_SECRET: short-lived links to receipts and design files. PROXY_ADMIN_PASSPHRASE: the
  // installer's passphrase (adminAuth.js) — the way in to a new install, which the program uses
  // for the first sign-in and nobody types. VENDOR_CREDENTIALS_KEY: encrypts saved supplier logins.
  return { SIGNING_SECRET: newSecret(), PROXY_ADMIN_PASSPHRASE: newSecret(), VENDOR_CREDENTIALS_KEY: newSecret() };
}

// public/_headers is written for the web. In the window (main.js) its Content-Security-Policy is
// rewritten by this, without the parts that only make sense online: Cloudflare's analytics and bot
// check, and web fonts from Google (bundled instead).
function desktopCsp(csp) {
  return csp.split(";").map(d => d.trim()).filter(Boolean).map(d => {
    const [name, ...vals] = d.split(/\s+/);
    const keep = vals.filter(v => !/cloudflareinsights|challenges\.cloudflare|fonts\.googleapis|fonts\.gstatic|127\.0\.0\.1:8787/.test(v));
    if (name === "font-src") keep.push("'self'");
    if (name === "frame-src" && !keep.length) keep.push("'none'");
    return [name, ...new Set(keep)].join(" ");
  }).join("; ");
}

// Whether an active admin has a password that works under this passphrase — when none does, the
// passphrase opens the admin (adminAuth.js bootstrapState). A password record carries a mark of
// the passphrase it was made under (adminAuth.js secretMark_), so after Reset sign-in no record
// counts. Asked before offering the passphrase, so a normal start never spends a failed sign-in.
async function adminHasUsablePassword(db, passphrase) {
  const mark = crypto.createHmac("sha256", passphrase).update("odd-admin-password-v1").digest("hex").slice(0, 16);
  const { results } = await db.prepare("SELECT password FROM users WHERE role = 'admin' AND status = 'active'").all();
  return (results || []).some((r) => { try { return JSON.parse(r.password).mark === mark; } catch (e) { return false; } });
}

// Where everything is kept, inside the data folder.
const statePaths = (dataDir) => {
  const state = path.join(dataDir, "state");
  return { state, d1: path.join(state, "d1"), r2: path.join(state, "r2"), durableObjects: path.join(state, "do") };
};

// Copies the stored state (database, files, mailbox) to a new folder — only while the server is
// stopped, so the copy is whole. Returns the folder.
function copyState(dataDir, dest) {
  const { state } = statePaths(dataDir);
  if (!fs.existsSync(state)) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(state, dest, { recursive: true, errorOnExist: true, force: false });
  return dest;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

// Starts the server. Returns { url, port, mf, migrations, stop() }.
//   dataDir       the data folder (made if missing)
//   port          the port to try first (0 or missing: any free one); the one used is remembered
//   protect, unprotect   encrypt / decrypt the secrets at rest (optional, see loadConfig)
async function startServer({ dataDir, port, protect, unprotect, log = () => {} } = {}) {
  const { Miniflare } = require("miniflare");
  const root = appRoot();
  fs.mkdirSync(dataDir, { recursive: true });
  let { cfg, secrets } = loadConfig(dataDir, { unprotect });
  if (!secrets && (cfg.secrets || cfg.secretsProtected)) {
    // Saved secrets this start can't read (the system keychain locked or unavailable, or the folder
    // copied from another computer). Never replaced silently: every password is keyed with the
    // passphrase (adminAuth.js), so new secrets would void them all. The program asks first
    // (main.js), and resetSignIn() is the deliberate way to start over.
    throw Object.assign(new Error("The saved secrets in desktop.json couldn't be read on this computer."), { code: "SECRETS_UNREADABLE" });
  }
  const fresh = !secrets;
  if (fresh) secrets = makeSecrets();
  const src = readSources(root);
  const latest = src.migrations[src.migrations.length - 1].name;
  // Before a newer program updates an existing database, keep a copy of it as it was.
  if (cfg.lastMigration && cfg.lastMigration < latest && fs.existsSync(statePaths(dataDir).state)) {
    const dest = copyState(dataDir, path.join(dataDir, "backups", "before-update-" + stamp()));
    if (dest) log("Copied the database before updating it: " + dest);
  }
  const paths = statePaths(dataDir);
  const options = (p) => ({
    host: "127.0.0.1",
    port: p,
    modules: true,
    modulesRoot: root,
    // The Worker's files are ES modules with a .js name (there is no package.json "type" for them).
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    scriptPath: path.join(root, "src", "worker.js"),
    compatibilityDate: "2025-09-01",
    assets: {
      directory: path.join(root, "public"),
      binding: "ASSETS",
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false, static_routing: { user_worker: ["/api/*"] } },
      assetConfig: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash", has_static_routing: true },
    },
    d1Databases: { DB: "desktop" },
    r2Buckets: ["IMAGES", "RECEIPTS", "DESIGNS"],
    durableObjects: { AGENT_MAILBOX: "AgentMailbox" },
    d1Persist: paths.d1,
    r2Persist: paths.r2,
    durableObjectsPersist: paths.durableObjects,
    cachePersist: false,
    bindings: { EDITION: "desktop", R2_PUBLIC_BASE: IMAGES_BASE, ...secrets },
  });
  let mf = null, used = null;
  for (const p of [...new Set([port, cfg.port].filter(n => Number.isInteger(n) && n > 0)), 0]) {
    try {
      mf = new Miniflare(options(p));
      const url = await mf.ready;
      used = Number(url.port);
      break;
    } catch (e) {
      if (mf) { try { await mf.dispose(); } catch (_) {} mf = null; }
      // The port is taken (another program, or this one already open): try the next. Anything
      // else is a real failure.
      if (p === 0 || !/EADDRINUSE|address already in use/i.test(String((e && e.message) || "") + String((e && e.code) || ""))) throw e;
      log("Port " + p + " isn't free; trying another.");
    }
  }
  const db = await mf.getD1Database("DB");
  const result = await migrate(db, src);
  cfg = { ...cfg, port: used, lastMigration: latest };
  saveConfig(dataDir, cfg, secrets, { protect });
  const url = "http://localhost:" + used + "/";
  return {
    url, port: used, mf, migrations: result, fresh,
    // The passphrase for the program's own first sign-in (main.js), and only while no admin has
    // a password yet — after that the server refuses it anyway (adminAuth.js).
    async firstRunKey() {
      return (await adminHasUsablePassword(db, secrets.PROXY_ADMIN_PASSPHRASE)) ? null : secrets.PROXY_ADMIN_PASSPHRASE;
    },
    // A picture from the IMAGES bucket, for the window's images.desktop.invalid address.
    async image(key) {
      const bucket = await mf.getR2Bucket("IMAGES");
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { body: Buffer.from(await obj.arrayBuffer()), contentType: (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream" };
    },
    async stop() { await mf.dispose(); },
  };
}

// Locked out: new secrets. Every password stops working (they are keyed with the passphrase,
// adminAuth.js), so the next start signs in with the new passphrase and asks for a name, email and
// password again — the desktop version of `npm run setup -- --new-passphrase`. Only while stopped.
function resetSignIn(dataDir, { protect, unprotect } = {}) {
  const { cfg, secrets } = loadConfig(dataDir, { unprotect });
  const next = { ...(secrets || makeSecrets()), PROXY_ADMIN_PASSPHRASE: newSecret() };
  saveConfig(dataDir, cfg, next, { protect });
}

// Puts a copy made by copyState back, after moving the current state aside (never deleting it).
function restoreState(dataDir, from) {
  const { state } = statePaths(dataDir);
  if (!fs.existsSync(path.join(from, "d1"))) throw new Error("That folder isn't an OpenDecoDesk backup (it has no d1 folder).");
  let aside = null;
  if (fs.existsSync(state)) {
    aside = path.join(dataDir, "backups", "before-restore-" + stamp());
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    fs.renameSync(state, aside);
  }
  fs.cpSync(from, state, { recursive: true });
  return { aside };
}

module.exports = { startServer, adminHasUsablePassword, copyState, restoreState, resetSignIn, stamp, statePaths, IMAGES_HOST, IMAGES_BASE, desktopCsp };

if (require.main === module) {
  const dataDir = path.resolve(process.argv[2] || path.join(process.cwd(), "desktop-data"));
  startServer({ dataDir, port: 8791, log: (m) => console.log(m) }).then((s) => {
    console.log("OpenDecoDesk desktop edition, data in " + dataDir);
    console.log(s.migrations.isNew ? "New database." : "Database updates applied: " + (s.migrations.applied.join(", ") || "none"));
    console.log("Open " + s.url);
    const stop = () => s.stop().then(() => process.exit(0));
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  }).catch((e) => { console.error(e); process.exit(1); });
}
