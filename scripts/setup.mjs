#!/usr/bin/env node
// OpenDecoDesk installer — `npm run setup` (add `-- --dry-run` to see what it would do).
//
// For someone with a Cloudflare account and a domain already on Cloudflare. It asks a few
// questions, creates the database and the three file buckets (reusing ones that exist; on an
// account without R2 it offers to carry on without file storage), writes the
// database id, the admin hostname and the plain settings into wrangler.toml, creates the tables (a
// new database from schema.sql; an existing one gets only new migrations), generates the secrets it can, asks about the optional services one by one, saves the
// business name and owner email, deploys the Worker, and prints what to do next.
//
// ONE INSTALL HAS BEEN COMPLETED ON A REAL CLOUDFLARE ACCOUNT, THE SMALLEST ONE: an account
// without R2, so no file storage, and every optional service skipped. Everything else here
// (creating the buckets, each optional service, a second run) is covered by
// test108_setup_script.js with a simulated `wrangler`, and the command lines were checked against
// `wrangler --help`, but has not run for real. Read docs/setup.md, try `--dry-run` first, and
// expect to fix something.
//
// Rules this file keeps:
//   - Node's standard library only.
//   - Every external command goes through ONE function, run() (createRunner below). With --dry-run
//     it prints the command instead of running it, so a dry run makes no Cloudflare call at all.
//   - A secret is never put on a command line, printed or logged. Secrets reach Cloudflare in one
//     temporary file (mode 0600, deleted straight after) given to `wrangler deploy --secrets-file`.
//     The one exception is by design: a NEWLY generated admin passphrase (and send-agent token) is
//     shown once at the very end, because nothing else could tell you what it is.
//   - Safe to run again: every step first looks at what exists. Nothing is deleted or replaced
//     unless you type a new value for it.
//
// Flags:  --dry-run            print the commands, call nothing, change no file
//         --config <path>      the wrangler.toml to use (default: ./wrangler.toml)
//         --skip-deploy        stop before deploying (nothing new is live; secrets are NOT stored)
//         --new-passphrase     replace the admin passphrase even if one is already set. This is how
//                              a locked-out admin gets back in; it voids EVERY user's password
//                              (functions/_lib/adminAuth.js, "The installer's passphrase")
//         --print-fresh-sql    print the SQL that builds a new database, and stop
//         --help

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ================================================================================================
// Pure helpers (no I/O) — exported for the test.
// ================================================================================================

export class SetupError extends Error {}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Labels a shop can't use (functions/_lib/customDomain.js RESERVED) — so the admin can't either.
const RESERVED_LABELS = ["www", "api", "images"];

// "MyShop.com" → { value: "myshop.com" } or { error }. No scheme, no path, no "www.".
export function validateDomain(input) {
  let v = String(input == null ? "" : input).trim().toLowerCase().replace(/\.$/, "");
  if (!v) return { error: "Type your domain, e.g. myshop.com" };
  if (/^[a-z]+:\/\//.test(v) || /[\/\s?#@:]/.test(v)) return { error: "Just the domain — no https://, no path (e.g. myshop.com)" };
  if (v.startsWith("www.")) v = v.slice(4);
  if (v.length > 253 || !v.includes(".")) return { error: "That doesn't look like a domain (e.g. myshop.com)" };
  const labels = v.split(".");
  if (!labels.every(l => LABEL_RE.test(l)) || !/^[a-z][a-z0-9-]*$/.test(labels[labels.length - 1])) return { error: "That doesn't look like a domain (e.g. myshop.com)" };
  if (v === "example.com" || v.endsWith(".example.com")) return { error: "example.com is a placeholder — type the domain you own" };
  return { value: v };
}

export function validateSubdomain(input) {
  const v = String(input == null ? "" : input).trim().toLowerCase();
  if (!LABEL_RE.test(v)) return { error: "One word: letters, numbers and inner hyphens only (e.g. admin)" };
  if (RESERVED_LABELS.includes(v)) return { error: `"${v}" is reserved — pick another (e.g. admin)` };
  return { value: v };
}

// The same shape functions/_lib/db.js accepts for the business profile's emails.
export function validateEmail(input) {
  const v = String(input == null ? "" : input).trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) || v.length > 200) return { error: "That doesn't look like an email address" };
  return { value: v };
}

export function validateTimeZone(input) {
  const v = String(input == null ? "" : input).trim();
  if (!v) return { error: "Type a time zone name, e.g. Europe/London or America/Chicago" };
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }); } catch { return { error: `"${v.slice(0, 60)}" isn't a time zone name (e.g. Europe/London, America/Chicago, Asia/Tokyo)` }; }
  return { value: v };
}

export function validatePublicUrl(input) {
  const v = String(input == null ? "" : input).trim().replace(/\/+$/, "");
  let u; try { u = new URL(v); } catch { return { error: "A full address starting with https:// (e.g. https://images.myshop.com)" }; }
  if (u.protocol !== "https:" || u.search || u.hash || u.username) return { error: "A full address starting with https:// (e.g. https://images.myshop.com)" };
  return { value: v };
}

export function validateName(input, max = 120) {
  const v = String(input == null ? "" : input).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!v) return { error: "Type a name" };
  return { value: v.slice(0, max) };
}

// A value that goes into a plain variable or a secret: one line, no control characters.
export function validateToken(input, { min = 1, max = 500 } = {}) {
  const v = String(input == null ? "" : input).trim();
  if (/[\u0000-\u001f\u007f\s]/.test(v)) return { error: "No spaces or line breaks — paste the value on its own" };
  if (v.length < min) return { error: min > 1 ? `Too short (at least ${min} characters)` : "Type or paste the value" };
  if (v.length > max) return { error: "Too long" };
  return { value: v };
}

// 64 hex characters (256 random bits): signing keys, the cron key, the send-agent token.
export function generateSecret(bytes = 32, rand = randomBytes) { return rand(bytes).toString("hex"); }

// The admin passphrase a person types: 6 groups of 4 from 32 characters (120 random bits) —
// a–z without l and o, and 2–9, so nothing is mistaken for 1 or 0. 256 is a multiple of 32, so
// taking a byte modulo 32 is unbiased.
export const PASSPHRASE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export function generatePassphrase(rand = randomBytes) {
  const bytes = rand(24);
  let out = "";
  for (let i = 0; i < 24; i++) { out += PASSPHRASE_ALPHABET[bytes[i] % 32]; if (i % 4 === 3 && i < 23) out += "-"; }
  return out;
}

// ---- wrangler.toml ------------------------------------------------------------------------------
// The installer owns two marked blocks and one value (the database id), and it comments the three
// bucket blocks out (inside a third marked block) for an account without R2. Everything else in
// the file — every comment, every other setting — is left exactly as it is.
export const ROUTES_BEGIN = "# >>> npm run setup: hostnames (managed by the installer — you may add lines; keep both marker lines)";
export const ROUTES_END = "# <<< npm run setup: hostnames";
export const VARS_BEGIN = "# >>> npm run setup: plain settings (managed by the installer — not secrets; keep both marker lines)";
export const VARS_END = "# <<< npm run setup: plain settings";
export const STORAGE_OFF_BEGIN = "# >>> npm run setup: file storage is off, because R2 isn't switched on for the account. Switch it on and run setup again: it puts these lines back.";
export const STORAGE_OFF_END = "# <<< npm run setup: file storage";
const BUCKET_BLOCK_RE = /^\[\[r2_buckets\]\][ \t]*\n(?:[^\[\n][^\n]*\n?)*/gm;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blockRe = (begin, end) => new RegExp(esc(begin) + "\\n([\\s\\S]*?)" + esc(end) + "\\n?");
const tomlString = (v) => JSON.stringify(String(v));   // a TOML basic string takes the same escapes

function managedBlock(text, begin, end) { const m = blockRe(begin, end).exec(text); return m ? m[1] : null; }
function withoutBlock(text, begin, end) { return text.replace(blockRe(begin, end), ""); }

// What's in the file now: { name, databaseName, databaseId, buckets: {IMAGES, RECEIPTS, DESIGNS}, hosts: [], vars: {}, storageOff }.
// The bucket names are read whether their blocks are live or commented out by the installer.
export function readWranglerToml(text) {
  const first = (re) => { const m = re.exec(text); return m ? m[1] : ""; };
  const buckets = {};
  const off = managedBlock(text, STORAGE_OFF_BEGIN, STORAGE_OFF_END);
  for (const m of (off == null ? text : text + "\n" + off.replace(/^# ?/gm, "")).matchAll(/\[\[r2_buckets\]\]\s*\n((?:[^\[\n][^\n]*\n?)*)/g)) {
    const b = /^\s*binding\s*=\s*"([^"]+)"/m.exec(m[1]), n = /^\s*bucket_name\s*=\s*"([^"]+)"/m.exec(m[1]);
    if (b && n) buckets[b[1]] = n[1];
  }
  const hosts = [], vars = {};
  const rb = managedBlock(text, ROUTES_BEGIN, ROUTES_END);
  if (rb) for (const m of rb.matchAll(/pattern\s*=\s*"([^"\/*]+)"/g)) hosts.push(m[1]);
  const vb = managedBlock(text, VARS_BEGIN, VARS_END);
  if (vb) for (const m of vb.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/gm)) { try { vars[m[1]] = JSON.parse(m[2]); } catch { /* leave it out */ } }
  return {
    workersDev: /^workers_dev\s*=\s*true\s*$/m.test(text),
    name: first(/^name\s*=\s*"([^"]+)"/m),
    databaseName: first(/^\s*database_name\s*=\s*"([^"]+)"/m),
    databaseId: first(/^\s*database_id\s*=\s*"([^"]*)"/m),
    buckets, hosts, vars, storageOff: off != null,
  };
}

// Returns the new file text. `hosts` and `vars` are ADDED to what the managed blocks already hold
// (a var given as "" or null is removed). Throws SetupError when the file has its own routes or
// [vars] outside the managed blocks, rather than guessing how to merge them.
// fileStorage: false comments the bucket blocks out, true puts them back, undefined leaves them.
// workersDev: true/false sets the `workers_dev = …` line (the *.workers.dev address), undefined leaves it.
export function rewriteWranglerToml(text, { databaseId, hosts = [], vars = {}, fileStorage, workersDev } = {}) {
  const current = readWranglerToml(text);
  let out = String(text).replace(/\r\n/g, "\n");
  if (!out.endsWith("\n")) out += "\n";

  if (databaseId) {
    if (!/^\s*database_id\s*=\s*"[^"]*"/m.test(out)) throw new SetupError("wrangler.toml has no database_id line under [[d1_databases]] — restore that block from the repository and run again.");
    out = out.replace(/^(\s*database_id\s*=\s*)"[^"]*"/m, (_, lead) => lead + tomlString(databaseId));
  }

  // ---- the workers.dev address
  if (workersDev === true || workersDev === false) {
    if (!/^workers_dev\s*=\s*(true|false)\s*$/m.test(out)) throw new SetupError("wrangler.toml has no workers_dev line — restore it from the repository and run again.");
    out = out.replace(/^workers_dev\s*=\s*(true|false)\s*$/m, "workers_dev = " + workersDev);
  }

  // ---- file storage
  const isOff = managedBlock(out, STORAGE_OFF_BEGIN, STORAGE_OFF_END) != null;
  if (fileStorage === false && !isOff) {
    const blocks = out.match(BUCKET_BLOCK_RE) || [];
    if (blocks.length) {
      const commented = blocks.map(b => b.trimEnd().split("\n").map(l => "# " + l).join("\n")).join("\n#\n");
      let first = true;
      out = out.replace(BUCKET_BLOCK_RE, () => { if (!first) return ""; first = false; return "\u0000"; })
        .replace(/\u0000\n*/, () => STORAGE_OFF_BEGIN + "\n" + commented + "\n" + STORAGE_OFF_END + "\n\n");
    }
  } else if (fileStorage === true && isOff) {
    out = out.replace(blockRe(STORAGE_OFF_BEGIN, STORAGE_OFF_END), (_, body) => body.trimEnd().split("\n").map(l => l.replace(/^# ?/, "")).join("\n") + "\n");
  }

  // ---- hostnames
  const allHosts = [...new Set([...current.hosts, ...hosts].map(h => String(h).toLowerCase()))];
  let rest = withoutBlock(out, ROUTES_BEGIN, ROUTES_END);
  if (/^routes\s*=/m.test(rest) || /^\[\[routes\]\]/m.test(rest)) {
    throw new SetupError("wrangler.toml already has its own routes. Add your admin hostname to it by hand — { pattern = \"" + (hosts[0] || "admin.yourdomain") +
      "\", custom_domain = true } — or delete that routes setting and run setup again.");
  }
  if (allHosts.length) {
    const block = ROUTES_BEGIN + "\nroutes = [\n" + allHosts.map(h => `  { pattern = ${tomlString(h)}, custom_domain = true },`).join("\n") + "\n]\n" + ROUTES_END + "\n";
    if (managedBlock(out, ROUTES_BEGIN, ROUTES_END) != null) out = out.replace(blockRe(ROUTES_BEGIN, ROUTES_END), () => block);
    else {
      // `routes` is a top-level key, so it has to come before the first [table]. Preferred spot:
      // right under the commented-out example; otherwise just above the first table.
      const lines = out.split("\n");
      let at = -1;
      const ex = lines.findIndex(l => /^#\s*routes\s*=\s*\[/.test(l));
      if (ex >= 0) { const close = lines.findIndex((l, i) => i > ex && /^#\s*\]/.test(l)); if (close >= 0) at = close + 1; }
      const firstTable = lines.findIndex(l => /^\[/.test(l));
      if (at < 0 || (firstTable >= 0 && at > firstTable)) at = firstTable >= 0 ? firstTable : lines.length;
      lines.splice(at, 0, ...("\n" + block).split("\n"));
      out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    }
  }

  // ---- plain settings
  rest = withoutBlock(out, VARS_BEGIN, VARS_END);
  if (/^\[vars\]/m.test(rest)) throw new SetupError("wrangler.toml already has its own [vars] section. Move those lines inside the installer's block (or delete the section) and run setup again.");
  const allVars = { ...current.vars };
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new SetupError("Not a variable name: " + k);
    if (v == null || v === "") delete allVars[k]; else allVars[k] = String(v);
  }
  out = withoutBlock(out, VARS_BEGIN, VARS_END).replace(/\n+$/, "\n");
  if (Object.keys(allVars).length) {
    out += "\n" + VARS_BEGIN + "\n[vars]\n" + Object.keys(allVars).sort().map(k => `${k} = ${tomlString(allVars[k])}`).join("\n") + "\n" + VARS_END + "\n";
  }
  return out;
}

// ---- reading wrangler's answers -------------------------------------------------------------------
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function jsonIn(text) {   // wrangler sometimes prints a banner before the JSON
  const s = String(text || ""); const i = s.search(/[\[{]/);
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}
export function parseD1List(stdout, name) {
  const list = jsonIn(stdout);
  if (!Array.isArray(list)) return null;
  const hit = list.find(d => d && d.name === name);
  return hit ? String(hit.uuid || hit.database_id || hit.id || "") : "";
}
export function parseD1Create(stdout) { const m = UUID_RE.exec(String(stdout || "")); return m ? m[0].toLowerCase() : ""; }
export function parseBucketList(stdout) { return [...String(stdout || "").matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map(m => m[1]); }
export function parseSecretList(stdout) { const list = jsonIn(stdout); return Array.isArray(list) ? list.map(s => s && s.name).filter(Boolean) : []; }

// ---- the commands (argument lists for `wrangler`, never a shell string) ---------------------------
export const commands = {
  version: () => ["--version"],
  whoami: () => ["whoami"],
  d1List: () => ["d1", "list", "--json"],
  d1Create: (name) => ["d1", "create", name],
  r2List: () => ["r2", "bucket", "list"],
  r2Create: (name) => ["r2", "bucket", "create", name],
  migrate: (config) => ["d1", "migrations", "apply", "DB", "--remote", "--config", config],
  d1Query: (config, sql) => ["d1", "execute", "DB", "--remote", "--json", "--yes", "--config", config, "--command", sql],
  d1File: (config, file) => ["d1", "execute", "DB", "--remote", "--yes", "--config", config, "--file", file],
  d1Execute: (config, sql) => ["d1", "execute", "DB", "--remote", "--yes", "--config", config, "--command", sql],
  secretList: (config) => ["secret", "list", "--format", "json", "--config", config],
  deploy: (config, secretsFile) => ["deploy", "--config", config, ...(secretsFile ? ["--secrets-file", secretsFile] : [])],
};

// ---- a new database --------------------------------------------------------------------------------
// The files in migrations/ are CHANGES to an existing database (the first ones alter tables that
// must already be there), so they can't build a database from nothing. A new database is built
// from schema.sql — which test33 keeps equal to "every migration applied" — and then every
// migration is recorded as already applied, in the table wrangler itself keeps for that
// (d1_migrations: id, name, applied_at — the shape `wrangler d1 migrations apply` creates). From
// then on `wrangler d1 migrations apply` only runs migrations added by later versions.
export const DB_STATE_SQL = "SELECT (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='orgs') AS hasSchema, " +
  "(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='d1_migrations') AS hasLog";
export const DB_APPLIED_SQL = "SELECT count(*) AS n FROM d1_migrations";
export const DB_ORDERS_SQL = "SELECT count(*) AS n FROM orders";
export function migrationRecordSql(names) {
  const list = [...names].filter(n => /^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(n)).sort();
  if (!list.length) throw new SetupError("No migration files found in migrations/.");
  return "CREATE TABLE IF NOT EXISTS d1_migrations(\n  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n  name       TEXT UNIQUE,\n  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);\n" +
    "INSERT OR IGNORE INTO d1_migrations (name) VALUES\n" + list.map(n => "  ('" + n + "')").join(",\n") + ";\n";
}
export function freshDatabaseSql(schemaSql, migrationNames) {
  return String(schemaSql).replace(/\s*$/, "\n") + "\n-- Every migration is already part of the schema above: record them as applied.\n" + migrationRecordSql(migrationNames);
}
// The first row of a `wrangler d1 execute --json` answer, or null when it can't be read.
export function parseD1Rows(stdout) {
  const data = jsonIn(stdout);
  const first = Array.isArray(data) ? data[0] : data;
  const rows = first && Array.isArray(first.results) ? first.results : null;
  return rows && rows.length ? rows[0] : null;
}
// Every row of a `d1 execute --json` answer ([] when there are none; null when it isn't one).
export function parseD1AllRows(stdout) {
  const data = jsonIn(stdout);
  const first = Array.isArray(data) ? data[0] : data;
  return first && Array.isArray(first.results) ? first.results : null;
}

// ---- shop hostnames ----------------------------------------------------------------------------------
// `wrangler deploy` makes the Worker's hostnames EXACTLY the ones in wrangler.toml: a hostname
// attached any other way — in the Cloudflare dashboard, or by the admin when a shop is created
// ("Automatic hostnames") — is detached by the next deploy, DNS record and all. So before a
// deploy, every shop in the database gets its line in the hostnames block.
export const SHOP_SUBDOMAINS_SQL = "SELECT subdomain FROM orgs ORDER BY subdomain";
export function shopHostnames(rows, rootDomain) {
  const root = String(rootDomain || "").trim().toLowerCase();
  if (!root) return [];
  return [...new Set((rows || []).map(r => String((r && r.subdomain) || "").trim().toLowerCase())
    .filter(label => LABEL_RE.test(label) && !RESERVED_LABELS.includes(label)).map(label => label + "." + root))];
}

// The SQL that saves the business name / owner email: merges into what's saved (a second run
// doesn't wipe a profile filled in from the admin) and bumps the catalog version so cached pages
// pick it up — the same two writes the admin's "Save" makes (setBusinessProfile + bumpCatalogVersion).
const sqlText = (s) => "'" + String(s).replace(/'/g, "''") + "'";
export function businessSql(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (v != null && String(v).trim() !== "") clean[k] = String(v).trim();
  if (!Object.keys(clean).length) return "";
  return "INSERT INTO global_settings (key, value) VALUES ('business', " + sqlText(JSON.stringify(clean)) + ") " +
    "ON CONFLICT(key) DO UPDATE SET value = json_patch(CASE WHEN json_valid(value) THEN value ELSE '{}' END, excluded.value); " +
    "INSERT INTO global_settings (key, value) VALUES ('catalogVersion', '1') " +
    "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);";
}

// For printing a command: any known secret value is replaced, and long SQL is shortened.
export function maskCommand(argv, secrets = []) {
  return argv.map(a => {
    let s = String(a);
    for (const sec of secrets) if (sec && s.includes(sec)) s = s.split(sec).join("********");
    if (s.length > 160) s = s.slice(0, 157) + "...";
    return /[\s"'$;&|<>(){}]/.test(s) ? "'" + s.replace(/'/g, "'\\''") + "'" : s;
  }).join(" ");
}

// ---- the ONE place an external command is run -----------------------------------------------------
// exec(file, args, options) → { status, stdout, stderr }. The real one is spawnSync with no shell and
// no stdin (so wrangler never stops to ask a question); the test passes a simulated one.
// run(args, { local, stream, describe }) → { ok, stdout, stderr, skipped }.
//   local:  doesn't talk to Cloudflare (wrangler --version) — still runs in a dry run.
//   stream: show the command's own output as it happens (deploy, migrations).
export function createRunner({ dryRun = false, exec, print = () => {}, wrangler = ["npx", "wrangler"] } = {}) {
  const log = [], secrets = [];
  const run = (args, opts = {}) => {
    const argv = [...wrangler, ...args];
    const shown = maskCommand(argv, secrets);
    log.push(shown);
    if (dryRun && !opts.local) { print("  [dry run] would run: " + shown); return { ok: true, skipped: true, stdout: "", stderr: "" }; }
    print("  $ " + shown);
    const r = exec(argv[0], argv.slice(1), { stream: !!opts.stream });
    return { ok: r.status === 0, skipped: false, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), status: r.status };
  };
  run.log = log;
  run.dryRun = dryRun;
  // Values to blank out if they ever turned up in a command (they shouldn't: secrets travel in a file).
  run.addSecrets = (list) => { for (const v of list) if (v) secrets.push(String(v)); };
  return run;
}

export function realExec(file, args, { stream }) {
  const r = spawnSync(file, args, { encoding: "utf8", shell: false, stdio: ["ignore", stream ? "inherit" : "pipe", stream ? "inherit" : "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (r.error) return { status: 127, stdout: "", stderr: String(r.error.message || r.error) };
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// ================================================================================================
// The optional services, asked one by one. `secret` values are read with hidden input.
// Names and meanings come from the code — see docs/configuration.md for the full reference.
// ================================================================================================
export const INTEGRATIONS = [
  { id: "stripe", title: "Card payments (Stripe)",
    about: "Lets customers pay by card and lets you email payment links. You need a Stripe account.",
    fields: [
      { name: "STRIPE_SECRET_KEY", secret: true, ask: "Stripe secret key (sk_test_… or sk_live_…)", min: 10 },
      { name: "STRIPE_WEBHOOK_SECRET", secret: true, optional: true, min: 10,
        ask: "Stripe webhook signing secret (whsec_…) — you only get this after adding the webhook address shown at the end; press Enter to add it on a later run" },
    ] },
  { id: "shippo", title: "Shipping rates and labels (Shippo, US only)",
    about: "Carrier rates at checkout and label purchase. Needs a Shippo account and Region → country US.",
    fields: [{ name: "SHIPPO_API_KEY", secret: true, ask: "Shippo API token (shippo_test_… or shippo_live_…)", min: 10 }] },
  { id: "email", title: "Email",
    about: "Order confirmations, design proofs and the morning roll-up. Without it, no email is sent at all.",
    choice: { question: "Send email through: [r] Resend, [c] Cloudflare Email Service (paid Workers plan), or Enter to skip",
      options: {
        r: [{ name: "RESEND_API_KEY", secret: true, ask: "Resend API key", min: 10 }],
        c: [{ name: "CF_EMAIL_API_TOKEN", secret: true, ask: "Cloudflare API token with ONLY the Email Sending permission", min: 10 },
            { name: "CF_ACCOUNT_ID", ask: "Cloudflare account id", min: 8 }],
      } },
    after: [{ name: "EMAIL_FROM", optional: true, kind: "email", ask: "Address emails are sent from (Enter = orders@<your domain>)" }] },
  { id: "turnstile", title: "Bot check on orders (Cloudflare Turnstile)",
    about: "Stops scripts from placing orders. Create a Turnstile widget for your shop hostnames first. Once set, an order without a valid check is refused.",
    fields: [{ name: "TURNSTILE_SITE_KEY", ask: "Turnstile site key", min: 6 }, { name: "TURNSTILE_SECRET_KEY", secret: true, ask: "Turnstile secret key", min: 10 }] },
  { id: "access", title: "Cloudflare Access in front of the admin",
    about: "A real sign-in (Google, email code…) before the admin loads. ONLY say yes if the Access application for your admin hostname already exists — once these are set, every admin request without a valid Access sign-in is refused.",
    fields: [{ name: "ACCESS_TEAM_DOMAIN", ask: "Access team domain (e.g. yourteam.cloudflareaccess.com)", min: 4 }, { name: "ACCESS_AUD", ask: "The Access application's Audience (AUD) tag", min: 8 }] },
  { id: "domains", title: "Automatic hostnames for new shops",
    about: "When you create a shop in the admin, its address (shop.yourdomain) is attached to the Worker for you. Needs a Cloudflare API token that can edit this Worker and its routes and read DNS on your zone.",
    fields: [{ name: "CF_API_TOKEN", secret: true, ask: "Cloudflare API token for custom domains", min: 10 }, { name: "CF_ACCOUNT_ID", ask: "Cloudflare account id", min: 8 },
             { name: "CF_ZONE_ID", ask: "Zone id of your domain", min: 8 }],
    fixed: (ctx) => ({ CF_WORKER_NAME: ctx.workerName }) },
  { id: "agent", title: "Send-agent relay (embroidery machines from a phone or tablet)",
    about: "Only if you run the separate send-agent program on a computer in the shop. A token is generated and shown once at the end; the agent needs it.",
    generate: ["AGENT_TOKEN"] },
];
export const SECRET_NAMES = ["PROXY_ADMIN_PASSPHRASE", "SIGNING_SECRET", "CRON_SECRET", "AGENT_TOKEN",
  ...INTEGRATIONS.flatMap(i => [...(i.fields || []), ...Object.values((i.choice || {}).options || {}).flat(), ...(i.after || [])]).filter(f => f.secret).map(f => f.name)];

export const STRIPE_WEBHOOK_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "charge.refunded", "charge.dispute.created", "charge.dispute.closed", "payout.paid"];

// ================================================================================================
// The flow. Everything it touches is passed in, so the test can run it end to end.
//   io:   { ask(id, question, { default, secret }) → Promise<string>, print(line) }
//   run:  from createRunner
//   files:{ read(path), write(path, text), writeSecret(text) → path, remove(path), exists(path) }
// Returns { ok, done: [steps], shown: {…} } — or throws SetupError (message is for the person).
// ================================================================================================
export async function setup({ io, run, files, configPath = "wrangler.toml", flags = {} }) {
  const dry = !!run.dryRun;
  const done = [];
  const say = (s = "") => io.print(s);
  const step = (n, title) => { say(""); say(`── ${n}. ${title}`); };
  const fail = (what, r, hint) => {
    // wrangler writes its error to stderr and its banner (after a sign-in problem, a whole account
    // table) to stdout. The error goes last, next to the hint, and is never crowded out.
    const lines = (s) => String(s || "").split("\n").map(l => l.trimEnd()).filter(l => l.trim());
    const errLines = lines(r && r.stderr);   // `--json` commands report their error on stdout instead
    const tail = [...lines(r && r.stdout).slice(errLines.length ? -4 : -14), ...errLines.slice(-10)].join("\n");
    throw Object.assign(new SetupError(what + (tail ? "\n\n" + tail : "") + (hint ? "\n\n" + hint : "")), { done });
  };
  // Ask until the answer passes `check` ({value} | {error}); an empty answer takes the default, or
  // returns "" when the question is optional.
  const askValid = async (id, question, check, { def = "", optional = false, secret = false } = {}) => {
    for (let tries = 0; tries < 5; tries++) {
      const raw = String(await io.ask(id, question + (def && !secret ? ` [${def}]` : "") + ": ", { secret }) || "").trim();
      const answer = raw || def;
      if (!answer && optional) return "";
      const res = check(answer);
      if (res.value !== undefined) return res.value;
      say("   " + res.error);
    }
    throw Object.assign(new SetupError("No valid answer for: " + question), { done });
  };
  const yes = async (id, question, def = false) => {
    const a = String(await io.ask(id, `${question} [${def ? "Y/n" : "y/N"}]: `, {}) || "").trim().toLowerCase();
    return a ? /^y/.test(a) : def;
  };

  say("OpenDecoDesk setup" + (dry ? "  —  DRY RUN: nothing is created, changed or deployed" : ""));
  say("This installer has completed one real install so far, the smallest one (no file storage, no optional services). If a step fails, it says what was done; run it again to carry on.");

  // ---- 1. Tools ------------------------------------------------------------------------------
  step(1, "Checking wrangler (Cloudflare's command-line tool)");
  let r = run(commands.version(), { local: true });
  if (!r.ok) fail("Could not run wrangler.", r, "Install Node.js 22 or newer, run `npm ci` in this folder, and check that `npx wrangler --version` prints a version.");
  r = run(commands.whoami());
  if (!r.skipped && (!r.ok || /not authenticated|not logged in/i.test(r.stdout + r.stderr))) fail("wrangler isn't signed in to Cloudflare.", r, "Run `npx wrangler login`, then `npm run setup` again.");
  done.push("wrangler is available" + (dry ? "" : " and signed in"));
  // R2 is switched on by hand in the dashboard, and an install works without it (no uploads). Find
  // out now, before a question is asked or the database is created; step 4 uses this listing.
  // This is also the first command that needs an account, so only wrangler's own words decide
  // that R2 is the reason.
  const R2_WHERE = "Cloudflare dashboard → Storage & databases → R2 → Overview; expect to be asked for a payment method";
  const listed = run(commands.r2List());
  let noStorage = false;
  if (!listed.skipped && !listed.ok) {
    if (!/enable R2|\b10042\b/i.test(listed.stderr + listed.stdout)) fail("Could not list your R2 buckets.", listed, "wrangler's message above says why. With more than one Cloudflare account, run `CLOUDFLARE_ACCOUNT_ID=<your account id> npm run setup`; an API token needs R2 permission; or the connection failed. This run changed nothing. See docs/accounts-and-keys.md, then run `npm run setup` again.");
    say("   R2 (file storage) isn't switched on for this Cloudflare account.");
    say("   Everything else works without it, but product pictures, receipts and design files can't be uploaded until it is on.");
    noStorage = await yes("withoutStorage", "   Install without file storage for now?", true);
    if (!noStorage) fail("R2 (file storage) isn't switched on for this account.", null, `Switch it on (${R2_WHERE}), then run \`npm run setup\` again. This run changed nothing. See docs/accounts-and-keys.md.`);
  }

  if (!files.exists(configPath)) throw new SetupError(`Can't find ${configPath}. Run this from the repository folder (npm run setup).`);
  const original = files.read(configPath);
  const cfg = readWranglerToml(original);
  if (!cfg.name || !cfg.databaseName || !cfg.buckets.IMAGES || !cfg.buckets.RECEIPTS || !cfg.buckets.DESIGNS) {
    throw new SetupError(`${configPath} is missing its name, database or bucket settings — restore it from the repository and run again.`);
  }

  // ---- 2. Questions --------------------------------------------------------------------------
  step(2, "A few questions (Enter accepts the suggestion in [brackets])");
  const rootDomain = await askValid("rootDomain", "Your domain (it must already be on your Cloudflare account)", validateDomain, { def: cfg.vars.ROOT_DOMAIN || "" });
  const adminSub = await askValid("adminSubdomain", "Subdomain for the admin panel", validateSubdomain, { def: (cfg.vars.ADMIN_SUBDOMAIN || "admin").split(",")[0].trim() });
  const adminHost = adminSub + "." + rootDomain;
  const businessName = await askValid("businessName", "Business name (shown to customers; Enter to leave what's saved)", validateName, { optional: true });
  const ownerEmail = await askValid("ownerEmail", "Owner's email (order notices and the morning roll-up go here; Enter to leave what's saved)", validateEmail, { optional: true });
  let guessTz = "UTC"; try { guessTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* UTC */ }
  const timeZone = await askValid("timeZone", "Time zone", validateTimeZone, { def: cfg.vars.TIMEZONE || guessTz });
  const publicBase = noStorage ? "" : await askValid("r2PublicBase", "Public address of the images bucket, if you already have one (https://…; Enter to set it up later)", validatePublicUrl,
    { def: cfg.vars.R2_PUBLIC_BASE || "", optional: true });
  say(`   Admin panel: https://${adminHost}`);

  // ---- 3. Database ---------------------------------------------------------------------------
  step(3, `Database (D1) "${cfg.databaseName}"`);
  let databaseId = "";
  r = run(commands.d1List());
  if (r.skipped) say("   (created only if it doesn't exist yet)");
  else {
    if (!r.ok) fail("Could not list your D1 databases.", r);
    const found = parseD1List(r.stdout, cfg.databaseName);
    if (found === null) fail("Could not read wrangler's list of D1 databases.", r);
    if (found) { databaseId = found; say("   Already exists — using it."); }
  }
  if (!databaseId) {
    const c = run(commands.d1Create(cfg.databaseName));
    if (!c.skipped) {
      if (!c.ok) fail(`Could not create the database "${cfg.databaseName}".`, c);
      databaseId = parseD1Create(c.stdout);
      if (!databaseId) { const again = run(commands.d1List()); databaseId = (again.ok && parseD1List(again.stdout, cfg.databaseName)) || ""; }
      if (!databaseId) fail("The database was created, but its id could not be read from wrangler's answer.", c, "Run `npx wrangler d1 list`, put the id into database_id in wrangler.toml, and run setup again.");
    }
  }
  done.push(`database "${cfg.databaseName}" ${dry ? "would be found or created" : "is ready"}`);

  // ---- 4. Buckets ----------------------------------------------------------------------------
  step(4, "File storage (R2): images, receipts, designs");
  if (noStorage) say("   Skipped: R2 is off. Run setup again after switching it on; the buckets are made then.");
  if (listed.skipped) say("   (each is created only if it doesn't exist yet)");
  const have = listed.skipped ? [] : parseBucketList(listed.stdout);
  for (const binding of noStorage ? [] : ["IMAGES", "RECEIPTS", "DESIGNS"]) {
    const name = cfg.buckets[binding];
    if (have.includes(name)) { say(`   ${name}: already exists — using it.`); continue; }
    const c = run(commands.r2Create(name));
    if (!c.skipped && !c.ok && !/already exists/i.test(c.stdout + c.stderr)) fail(`Could not create the bucket "${name}".`, c);
  }
  done.push(noStorage ? "file storage was skipped (R2 is off for this account)" : "the three buckets " + (dry ? "would be found or created" : "are ready"));

  // ---- 5. wrangler.toml ----------------------------------------------------------------------
  step(5, `Writing ${configPath}`);
  const vars = { ROOT_DOMAIN: rootDomain, ADMIN_SUBDOMAIN: adminSub, TIMEZONE: timeZone };
  if (publicBase) vars.R2_PUBLIC_BASE = publicBase;
  // A dry run doesn't know whether R2 is on, so it leaves the bucket lines as they are.
  // The command-line installer gives the site its domain from the start, so the *.workers.dev address
  // (which the Deploy button needs for its first sign-in) is switched off.
  let nextToml = rewriteWranglerToml(original, { databaseId: dry ? undefined : databaseId, hosts: [adminHost], vars, fileStorage: listed.skipped ? undefined : !noStorage, workersDev: false });
  if (noStorage) say("   The three bucket blocks are commented out, so the deploy doesn't ask for buckets that don't exist. A later run puts them back.");
  else if (cfg.storageOff && !listed.skipped) say("   R2 is on now: the three bucket blocks are back.");
  if (dry) say(`   [dry run] would set database_id, add the hostname ${adminHost}, and set: ${Object.keys(vars).sort().join(", ")}`);
  else { files.write(configPath, nextToml); done.push(`${configPath} has the database id, the hostname ${adminHost} and the plain settings`); }
  say("   Other shops' hostnames are not added here: turn on \"Automatic hostnames for new shops\" below, or add a line per shop to the hostnames block later.");

  // ---- 6. Tables ------------------------------------------------------------------------------
  step(6, "Creating / updating the database tables");
  const { isNew } = prepareTables({ run, files, configPath, say, fail });
  done.push("database tables " + (dry ? "would be created or updated" : isNew ? "created" : "are up to date"));

  // An install that already has shops: list their hostnames, or this deploy would detach them.
  {
    const q = run(commands.d1Query(configPath, SHOP_SUBDOMAINS_SQL));
    if (q.skipped) say("   [dry run] would list every shop's hostname in the hostnames block (a deploy detaches any that isn't there)");
    else {
      const rows = q.ok ? parseD1AllRows(q.stdout) : null;
      if (rows === null) fail("Could not read the shops from the database.", q, "Stopping before the deploy: it would detach every shop hostname that isn't listed in " + configPath + ".");
      const before = readWranglerToml(nextToml).hosts, shops = shopHostnames(rows, rootDomain);
      const added = shops.filter(h => !before.includes(h));
      if (added.length) { nextToml = rewriteWranglerToml(nextToml, { hosts: shops }); files.write(configPath, nextToml); }
      if (shops.length) say(`   Shop hostnames: ${shops.length} listed in ${configPath}` + (added.length ? ` (added ${added.join(", ")})` : "") + ".");
    }
  }

  // ---- 7. Secrets and optional services --------------------------------------------------------
  step(7, "Secrets");
  let existing = [];
  r = run(commands.secretList(configPath));
  if (!r.skipped && r.ok) existing = parseSecretList(r.stdout);   // a failure here just means the Worker doesn't exist yet
  const secrets = {}, shown = {};
  if (!existing.includes("PROXY_ADMIN_PASSPHRASE") || flags.newPassphrase) { secrets.PROXY_ADMIN_PASSPHRASE = generatePassphrase(); shown.PROXY_ADMIN_PASSPHRASE = secrets.PROXY_ADMIN_PASSPHRASE; }
  for (const name of ["SIGNING_SECRET", "CRON_SECRET"]) if (!existing.includes(name)) secrets[name] = generateSecret();
  say("   Generated: " + (Object.keys(secrets).join(", ") || "nothing new (already set)") + ".");

  say(""); say("   Optional services — Enter skips each one. You can run setup again later to add any of them.");
  const ctx = { workerName: cfg.name };
  // One service's answers are collected first and only kept if it is complete: half a service is
  // worse than none (a Turnstile secret without its site key would refuse every order).
  const askFields = async (integ, fields, got) => {
    for (const f of fields) {
      const already = f.secret ? existing.includes(f.name) : !!(cfg.vars[f.name] || vars[f.name]);
      const check = f.kind === "email" ? validateEmail : (v) => validateToken(v, { min: f.min || 1 });
      const v = await askValid(`${integ.id}.${f.name}`, "   " + f.ask + (already && f.secret ? " (already set — Enter keeps it)" : ""), check,
        { optional: true, secret: !!f.secret, def: f.secret ? "" : (cfg.vars[f.name] || vars[f.name] || "") });
      if (v) (f.secret ? got.secrets : got.vars)[f.name] = v;
      else if (!already && !f.optional) return false;   // nothing typed for something required
    }
    return true;
  };
  const chosen = [];
  for (const integ of INTEGRATIONS) {
    say(""); say(`   ${integ.title} — ${integ.about}`);
    let fields = integ.fields || [], tag = integ.id;
    if (integ.choice) {
      const pick = String(await io.ask(integ.id, "   " + integ.choice.question + ": ", {}) || "").trim().toLowerCase().slice(0, 1);
      if (!integ.choice.options[pick]) { say("   Skipped."); continue; }
      fields = [...integ.choice.options[pick], ...(integ.after || [])]; tag = integ.id + ":" + pick;
    } else if (!(await yes(integ.id, "   Set this up now?", false))) { say("   Skipped."); continue; }
    const got = { secrets: {}, vars: {} };
    if (!(await askFields(integ, fields, got))) { say("   Left blank — skipped; nothing was changed for this one."); continue; }
    for (const name of integ.generate || []) {
      if (existing.includes(name)) say(`   ${name} is already set — kept.`);
      else { got.secrets[name] = generateSecret(); shown[name] = got.secrets[name]; }
    }
    Object.assign(secrets, got.secrets);
    Object.assign(vars, got.vars, integ.fixed ? integ.fixed(ctx) : {});
    chosen.push(tag);
  }
  run.addSecrets(Object.values(secrets));
  if (!dry) { nextToml = rewriteWranglerToml(nextToml, { vars }); files.write(configPath, nextToml); }
  else say(`   [dry run] would also set: ${Object.keys(vars).filter(k => !["ROOT_DOMAIN", "ADMIN_SUBDOMAIN", "TIMEZONE", "R2_PUBLIC_BASE"].includes(k)).sort().join(", ") || "(no more plain settings)"}`);

  // ---- 8. Business profile ---------------------------------------------------------------------
  step(8, "Business profile");
  const sql = businessSql({ name: businessName, ownerEmail });
  if (!sql) say("   Nothing typed — left as it is. (Fill it in later under Tools → Global settings → Business profile.)");
  else {
    r = run(commands.d1Execute(configPath, sql));
    if (!r.skipped && !r.ok) fail("Could not save the business name / owner email.", r, "Everything before this is done. You can also type them in the admin later (Tools → Global settings → Business profile).");
    done.push("business name / owner email " + (dry ? "would be saved" : "saved"));
  }

  // ---- 9. Deploy -------------------------------------------------------------------------------
  step(9, "Deploying");
  const names = Object.keys(secrets).sort();
  if (flags.skipDeploy) {
    say("   --skip-deploy: not deploying. The secrets above were NOT stored anywhere; they will be generated again on the next run.");
    return { ok: true, done, deployed: false, shown: {}, adminHost, rootDomain, secretNames: names, chosen };
  }
  let secretsFile = "";
  if (names.length) {
    if (dry) { secretsFile = "<temporary file>"; say(`   [dry run] would write ${names.length} secrets to a temporary file readable only by you (${names.join(", ")}) and delete it after the deploy`); }
    else secretsFile = files.writeTemp("secrets.json", JSON.stringify(secrets));
  }
  try {
    r = run(commands.deploy(configPath, secretsFile), { stream: true });
  } finally {
    if (secretsFile && !dry) files.remove(secretsFile);
  }
  if (!r.skipped && !r.ok) fail("The deploy failed.", r, "The database, buckets, wrangler.toml and migrations are done; the secrets were not stored. Fix the problem and run `npm run setup` again." +
    `\nIf it says the hostname ${adminHost} already has a DNS record, delete that record in the Cloudflare dashboard (DNS) and run again.`);
  done.push(dry ? "the Worker would be deployed" : `deployed — https://${adminHost}`);

  // ---- What next -------------------------------------------------------------------------------
  say(""); say("══ " + (dry ? "Dry run finished — nothing was changed." : "Done.") + " ══");
  for (const d of done) say("  ✓ " + d);
  say(""); say("What to do next:");
  const next = [];
  next.push(`Open https://${adminHost} and sign in with the admin passphrase${shown.PROXY_ADMIN_PASSPHRASE ? (dry ? " (a real run shows it once at the end)" : " shown below") : " you already have"}. (A new hostname can take a few minutes to get its certificate.) Leave the email empty the first time: it then asks for your name, your email and a password of your own, and from then on you sign in with those. Add other people under Security → Users.`);
  next.push("Turn on two-step sign-in: Security → Security (2FA).");
  next.push("Tools → Global settings: check the Setup status list at the top, then fill in the Business profile, Region and Sales tax.");
  if (noStorage) next.push(`File storage is off, so product pictures, receipts and design files can't be uploaded. To add it: switch on R2 (${R2_WHERE}), then run setup again. It makes the three buckets and turns uploads on.`);
  else if (!vars.R2_PUBLIC_BASE && !cfg.vars.R2_PUBLIC_BASE) next.push(`Make the images bucket "${cfg.buckets.IMAGES}" public (Cloudflare dashboard → Storage & databases → R2 → the bucket → Settings: a custom domain such as images.${rootDomain}, or its r2.dev address), then run setup again and give that address. Until then product pictures can't be uploaded. Keep the receipts and designs buckets private.`);
  const sender = String(vars.EMAIL_FROM || cfg.vars.EMAIL_FROM || ""), sendDomain = sender.includes("@") ? sender.slice(sender.lastIndexOf("@") + 1).replace(/[>\s].*$/, "") : rootDomain;
  if (chosen.some(c => c.startsWith("email:")) || existing.includes("RESEND_API_KEY") || existing.includes("CF_EMAIL_API_TOKEN")) next.push(`Verify ${sendDomain} as a sending domain with your email provider (it gives you DNS records to add), or no email will be delivered. See docs/email.md.`);
  else next.push("Email isn't set up, so no email is sent (orders still work). Run setup again to add Resend or Cloudflare email. See docs/email.md.");
  if (secrets.STRIPE_SECRET_KEY || existing.includes("STRIPE_SECRET_KEY")) next.push(`In Stripe, add a webhook endpoint: https://${adminHost}/api/stripe-webhook with the events ${STRIPE_WEBHOOK_EVENTS.join(", ")}. If it asks for a payload format, choose Snapshot.` +
    (secrets.STRIPE_WEBHOOK_SECRET || existing.includes("STRIPE_WEBHOOK_SECRET") ? "" : " Then run setup again and paste its signing secret (whsec_…) — until then card payments are taken but not recorded."));
  next.push("Create your first shop: Manage catalog → + New Org, add products, then Publish. " +
    (chosen.includes("domains") ? "Its hostname is attached automatically." : "Then run `npm run deploy`: it lists the shop's hostname in " + configPath + " and attaches it.") +
    " From now on deploy with `npm run deploy`, not a bare `wrangler deploy`, which detaches any shop hostname that isn't listed in " + configPath + ".");
  next.push(`Keep ${configPath} — it now holds your database id and hostnames (see docs/operations.md before upgrading).`);
  next.forEach((n, i) => say(`  ${i + 1}. ${n}`));
  if (dry) return { ok: true, done, deployed: false, shown: {}, adminHost, rootDomain, secretNames: names, chosen };
  if (Object.keys(shown).length) {
    say(""); say("Shown ONCE — write these down now. They can't be read back later (only replaced):");
    if (shown.PROXY_ADMIN_PASSPHRASE) say("  Admin passphrase:   " + shown.PROXY_ADMIN_PASSPHRASE);
    if (shown.AGENT_TOKEN) say("  Send-agent token:   " + shown.AGENT_TOKEN);
  }
  return { ok: true, done, deployed: true, shown, adminHost, rootDomain, secretNames: names, chosen };
}

// ================================================================================================
// Command line
// ================================================================================================
// ---- the tables ---------------------------------------------------------------------------------
// A NEW database gets every table from schema.sql and a record that every migration is already in
// it; an EXISTING one gets only the migrations it doesn't have. (Running the migrations on an empty
// database would fail at the first one: it alters a table that only schema.sql creates.) Shared by
// the installer and by `npm run deploy`, which is also what Cloudflare runs after the Deploy button
// has made an empty database. Returns { isNew }.
export function prepareTables({ run, files, configPath, say, fail }){
  const dry = !!run.dryRun;
  let r;
  const query = (sql, what) => {
    const q = run(commands.d1Query(configPath, sql));
    if (q.skipped) return null;
    if (!q.ok) fail("Could not " + what + ".", q);
    const row = parseD1Rows(q.stdout);
    if (!row) fail("Could not read wrangler's answer when trying to " + what + ".", q);
    return row;
  };
  const state = query(DB_STATE_SQL, "look at the database");
  let isNew = !state || !Number(state.hasSchema);
  if (state && Number(state.hasSchema)) {
    // Tables exist. With a migration record, it's an existing install: apply what's new. Without
    // one, an earlier run stopped halfway — safe to finish only while the database is still empty.
    const applied = Number(state.hasLog) ? Number(query(DB_APPLIED_SQL, "read the migration record").n) : 0;
    if (!applied) {
      if (Number(query(DB_ORDERS_SQL, "count the orders").n) > 0) {
        fail("This database has orders in it but no record of which migrations were applied, so it isn't safe to guess.", null,
          "See \"A database without a migration record\" in docs/operations.md.");
      }
      say("   The tables are there but the setup didn't finish last time — finishing it (the database is empty).");
      isNew = true;
    }
  }
  if (isNew) {
    if (dry) say("   [dry run] a NEW database gets every table from schema.sql and a record that all " + files.migrationNames().length + " migrations are part of it:");
    else say("   New database: creating every table from schema.sql.");
    let sqlFile = "<temporary file: schema.sql + the migration record>";
    if (!dry) sqlFile = files.writeTemp("fresh-database.sql", freshDatabaseSql(files.read(files.schemaPath()), files.migrationNames()));
    try {
      r = run(commands.d1File(configPath, sqlFile), { stream: true });
    } finally { if (!dry) files.remove(sqlFile); }
    if (!r.skipped && !r.ok) fail("Creating the tables failed.", r, "Nothing after this step was done. Fix the problem and run it again.");
    if (dry) say("   [dry run] an EXISTING database skips that, and gets only migrations it doesn't have yet:");
  }
  // Always: on a new database this finds nothing to do, which confirms wrangler recognises the record.
  r = run(commands.migrate(configPath), { stream: true });
  if (!r.skipped && !r.ok) fail("Applying the database migrations failed.", r, "Nothing after this step was done. Fix the problem and run it again — migrations that were applied are not repeated.");
  return { isNew };
}

// ---- npm run deploy: upgrade an installed site --------------------------------------------------
// New tables or migrations, then every hostname the site uses into wrangler.toml, then the deploy —
// in that order, stopping at the first failure. Use this instead of a bare `wrangler deploy`: that
// would detach any hostname that isn't listed in wrangler.toml (see "shop hostnames" above).
// It is also what Cloudflare runs on every build of a site installed with the Deploy button
// (`ci: true`): there the database was made empty by the button, and the site's domain is kept in
// the database (the `site` setting) rather than in wrangler.toml.
//   ci        running in Cloudflare's build (Workers Builds) rather than on someone's computer
//   diagnose  print what the build sees (for checking a new Cloudflare setup), nothing secret
export const SITE_SETTING_SQL = "SELECT value FROM global_settings WHERE key = 'site'";
export function parseSiteSetting(row) {
  let v = null;
  try { v = row && row.value ? JSON.parse(row.value) : null; } catch { v = null; }
  const label = (x) => { const t = String(x || "").trim().toLowerCase(); return LABEL_RE.test(t) ? t : ""; };
  const root = String((v && v.rootDomain) || "").trim().toLowerCase();
  return { rootDomain: validateDomain(root).value || "", adminSubdomain: label(v && v.adminSubdomain) || "admin", adminHostSeen: !!(v && v.adminHostSeen) };
}
export async function upgrade({ print, run, files, configPath = "wrangler.toml", ci = false, diagnose = false }) {
  const stop = (what, r, hint) => {
    const lines = (t) => String(t || "").split("\n").map(l => l.trimEnd()).filter(l => l.trim());
    const tail = r ? [...lines(r.stdout).slice(-4), ...lines(r.stderr).slice(-10)].join("\n") : "";
    throw new SetupError(what + (tail ? "\n\n" + tail : "") + (hint ? "\n\n" + hint : ""));
  };
  if (!files.exists(configPath)) stop(`Can't find ${configPath}. Run this from the repository folder (npm run deploy).`);
  const original = files.read(configPath), cfg = readWranglerToml(original);
  const placeholder = !cfg.databaseId || /^REPLACE/.test(cfg.databaseId);
  if (placeholder && !ci) stop(`${configPath} has no database id yet: this copy hasn't been installed. Run \`npm run setup\` first.`);
  if (diagnose) {
    print(""); print("── What this build sees");
    print(`   running in Cloudflare's build: ${ci ? "yes" : "no"} · Node ${process.version}`);
    print(`   Worker "${cfg.name}" · database "${cfg.databaseName}" (id ${placeholder ? "not set" : "set"}) · buckets ${Object.values(cfg.buckets).join(", ") || "none"}${cfg.storageOff ? " (file storage off)" : ""} · workers.dev ${cfg.workersDev ? "on" : "off"} · ${cfg.hosts.length} hostname(s)`);
  }

  print(""); print("── 1. Database tables");
  prepareTables({ run, files, configPath, say: print, fail: stop });

  print(""); print("── 2. Hostnames");
  // Where the domain comes from: wrangler.toml (installed from the command line) or the database
  // (installed with the Deploy button and set up in the admin's Setup page).
  let site = { rootDomain: "", adminSubdomain: "admin", adminHostSeen: false };
  let r = run(commands.d1Query(configPath, SITE_SETTING_SQL));
  if (!r.skipped) {
    if (!r.ok) stop("Could not read the site's settings from the database, so nothing was deployed.", r);
    const rows = parseD1AllRows(r.stdout);
    if (rows === null) stop("Could not read wrangler's answer about the site's settings, so nothing was deployed.", r);
    site = parseSiteSetting(rows[0]);
  }
  const root = cfg.vars.ROOT_DOMAIN || site.rootDomain;
  let next = original;
  const want = [];
  if (!root) {
    print(cfg.vars.ROOT_DOMAIN === undefined && !site.rootDomain && ci
      ? "   No domain yet: the admin answers on this Worker's workers.dev address until one is set (the admin's Setup page)."
      : `   ${configPath} has no ROOT_DOMAIN setting, so the shops' hostnames can't be worked out. This deploy keeps only the hostnames already listed there.`);
  } else if (!cfg.vars.ROOT_DOMAIN) {
    // A Deploy-button site: the app attached the admin's hostname and each shop's through Cloudflare's API
    // (functions/_lib/cloudflareSetup.js, "Automatic hostnames"). A deploy that lists no hostname leaves
    // those alone; listing them here would also need the build's own key to reach the domain.
    print(`   ${root}: the admin's and the shops' hostnames are attached by the app; this deploy leaves them as they are.`);
  } else {
    r = run(commands.d1Query(configPath, SHOP_SUBDOMAINS_SQL));
    if (r.skipped) print("   (every shop in the database gets a line in the hostnames block)");
    else {
      const rows = r.ok ? parseD1AllRows(r.stdout) : null;
      if (rows === null) stop("Could not read the shops from the database, so nothing was deployed.", r, `A deploy detaches every hostname that isn't listed in ${configPath}; deploying without the list would take shops offline.`);
      const shops = shopHostnames(rows, root);
      want.push(...shops);
      const added = want.filter(h => !cfg.hosts.includes(h));
      if (added.length) next = rewriteWranglerToml(next, { hosts: want });
      const listed = readWranglerToml(next).hosts.length;
      print(`   ${shops.length} shop${shops.length === 1 ? "" : "s"} in the database` + (added.length ? `; added to ${configPath}: ${added.join(", ")}` : "; all already listed") + `. ${listed} hostname${listed === 1 ? "" : "s"} in all.`);
    }
  }
  // The workers.dev address: a Deploy-button site needs it until its admin has been reached on its
  // own domain; a site installed from the command line never does.
  const workersDev = !cfg.vars.ROOT_DOMAIN && !(site.rootDomain && site.adminHostSeen);
  if (cfg.workersDev !== workersDev) {
    next = rewriteWranglerToml(next, { workersDev });
    print(`   The workers.dev address is now ${workersDev ? "on (the admin is reached there until the domain is set up)" : "off (the admin is on its own domain)"}.`);
  }
  if (next !== original && !run.dryRun) files.write(configPath, next);

  print(""); print("── 3. Deploying");
  r = run(commands.deploy(configPath, ""), { stream: true });
  if (!r.skipped && !r.ok) stop("The deploy failed.", r, "Nothing else was changed. Fix the problem above and run `npm run deploy` again.");
  print(""); print(run.dryRun ? "Dry run finished — nothing was changed." : "Done. A hostname attached for the first time can take a few minutes to get its certificate.");
  return { ok: true, hosts: readWranglerToml(next).hosts.length, workersDev };
}

export function parseArgs(argv) {
  const flags = { dryRun: false, skipDeploy: false, newPassphrase: false, help: false, printFreshSql: false, config: "wrangler.toml" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--skip-deploy") flags.skipDeploy = true;
    else if (a === "--new-passphrase") flags.newPassphrase = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--print-fresh-sql") flags.printFreshSql = true;
    else if (a === "--config") { flags.config = argv[++i]; if (!flags.config) throw new SetupError("--config needs a path"); }
    else throw new SetupError("Unknown option: " + a + " (try --help)");
  }
  return flags;
}

// Terminal questions. A secret is read with the terminal's echo off; when input is piped (not a
// terminal) there is nothing to echo, and lines are simply read in order.
function terminalIo() {
  const stdin = process.stdin, stdout = process.stdout;
  let piped = null;
  const pipedLine = () => {
    if (!piped) piped = new Promise((resolve) => { let buf = ""; stdin.setEncoding("utf8"); stdin.on("data", d => { buf += d; }); stdin.on("end", () => resolve(buf.split(/\r?\n/))); });
    return piped.then(lines => lines.shift() || "");
  };
  const ask = (id, question, { secret } = {}) => {
    if (!stdin.isTTY) { stdout.write(question + "\n"); return pipedLine(); }
    return new Promise((resolve) => {
      stdout.write(question);
      stdin.setEncoding("utf8"); stdin.resume();
      if (secret) stdin.setRawMode(true);
      let buf = "";
      const finish = () => { stdin.removeListener("data", onData); if (secret) { stdin.setRawMode(false); stdout.write("\n"); } stdin.pause(); resolve(buf.replace(/\r?\n$/, "")); };
      const onData = (chunk) => {
        if (!secret) { buf += chunk; if (/\n/.test(buf)) finish(); return; }
        for (const ch of chunk) {
          if (ch === "\u0003") { stdin.setRawMode(false); stdout.write("\n"); process.exit(130); }
          else if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
          else if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else if (ch >= " ") buf += ch;
        }
      };
      stdin.on("data", onData);
    });
  };
  return { ask, print: (s) => stdout.write(s + "\n") };
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const realFiles = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, "utf8"),
  write: (p, text) => fs.writeFileSync(p, text),
  // A file in a new private folder, readable only by this user; remove() deletes the folder.
  writeTemp: (name, text) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendecodesk-setup-"));
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode: 0o600 });
    return file;
  },
  schemaPath: () => path.join(REPO, "schema.sql"),
  migrationNames: () => fs.readdirSync(path.join(REPO, "migrations")).filter(f => f.endsWith(".sql")),
  remove: (p) => { try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* best effort */ } },
};

const HELP = `npm run setup [-- options]

Installs OpenDecoDesk on your Cloudflare account (see docs/setup.md).
ONE REAL INSTALL SO FAR, THE SMALLEST ONE — try --dry-run first.

  --dry-run          print every command it would run; call nothing, change no file
  --config <path>    the wrangler.toml to use (default: ./wrangler.toml)
  --skip-deploy      do everything except the deploy (secrets are not stored)
  --new-passphrase   replace the admin passphrase: gets a locked-out admin back in, and voids every user's password
  --print-fresh-sql  print the SQL that builds a NEW database (schema.sql plus the record that
                     every migration is already in it) and stop — for installing by hand
`;

async function main() {
  let flags;
  try { flags = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (flags.help) { process.stdout.write(HELP); return; }
  // For installing by hand: the SQL that builds a NEW database (see docs/setup.md).
  if (flags.printFreshSql) { process.stdout.write(freshDatabaseSql(realFiles.read(realFiles.schemaPath()), realFiles.migrationNames())); return; }
  const io = terminalIo();
  const run = createRunner({ dryRun: flags.dryRun, exec: realExec, print: io.print });
  try {
    await setup({ io, run, files: realFiles, configPath: flags.config, flags });
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    io.print(""); io.print("✗ Setup stopped: " + e.message);
    if (e.done && e.done.length) { io.print(""); io.print("Already done (kept, and not repeated next time):"); e.done.forEach(d => io.print("  ✓ " + d)); }
    io.print(""); io.print("Fix the problem above, then run `npm run setup` again.");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
