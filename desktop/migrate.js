// The desktop program's database set-up: what `npm run setup` / `npm run deploy` do for a cloud
// install (scripts/setup.mjs prepareTables), done through the database binding itself, because
// the desktop program has no wrangler.
//
//   A NEW database gets every table from schema.sql and a record that every migration is already
//   part of it (the d1_migrations table, in the shape wrangler keeps). An EXISTING one gets only
//   the migrations it hasn't had, oldest first, each in one transaction with its own record row,
//   so a failure leaves the database as it was before that migration.
//
// `db` is anything with D1's prepare().bind().run()/first()/all() and batch() — the real binding
// from Miniflare in the program, testlib/d1-shim.js in the tests. Plain CommonJS with no
// dependencies, so both can load it.

const fs = require("fs");
const path = require("path");

// Splits a .sql file into statements. A ';' ends a statement except inside a quoted string or
// name, a comment, or a trigger's BEGIN … END body (a trigger is one statement with several ';'
// inside it — schema.sql and migrations/0031 have them). Comments are kept inside the statement
// text (SQLite ignores them); statements that are only comments are dropped.
function splitSql(sql) {
  const out = [];
  let cur = "", i = 0, depth = 0, word = "", inTrigger = false;
  const n = sql.length;
  const endWord = () => {
    const w = word.toUpperCase(); word = "";
    if (!w) return;
    // "CREATE [TEMP] TRIGGER": from here to the matching END is one statement.
    if (w === "TRIGGER" && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?$/i.test(stripComments_(cur).slice(0, -"TRIGGER".length))) inTrigger = true;
    else if (inTrigger && w === "BEGIN") depth++;
    else if (inTrigger && w === "CASE") depth++;            // CASE … END inside a trigger body
    else if (inTrigger && w === "END" && depth > 0) depth--;
  };
  while (i < n) {
    const c = sql[i], next = sql[i + 1];
    if (c === "-" && next === "-") {                         // -- comment to end of line
      endWord();
      const e = sql.indexOf("\n", i); const stop = e === -1 ? n : e + 1;
      cur += sql.slice(i, stop); i = stop; continue;
    }
    if (c === "/" && next === "*") {                         // /* comment */
      endWord();
      const e = sql.indexOf("*/", i + 2); const stop = e === -1 ? n : e + 2;
      cur += sql.slice(i, stop); i = stop; continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {  // quoted string or name
      endWord();
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === close) { if (close !== "]" && sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) { word += c; cur += c; i++; continue; }
    endWord();
    if (c === ";" && depth === 0) {
      const stmt = cur.trim();
      if (stripComments_(stmt).trim()) out.push(stmt);
      cur = ""; inTrigger = false; i++; continue;
    }
    cur += c; i++;
  }
  endWord();
  if (stripComments_(cur).trim()) out.push(cur.trim());
  return out;
}
function stripComments_(s) {
  return String(s).replace(/--[^\n]*(\n|$)/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const MIGRATION_NAME_RE = /^\d{4}_[A-Za-z0-9_.-]+\.sql$/;
const MIGRATIONS_TABLE_SQL = "CREATE TABLE IF NOT EXISTS d1_migrations(\n  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n  name       TEXT UNIQUE,\n  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)";

// The schema and migration files, read from the program's copy of the repository.
function readSources(root) {
  const dir = path.join(root, "migrations");
  const names = fs.readdirSync(dir).filter(f => MIGRATION_NAME_RE.test(f)).sort();
  return {
    schema: fs.readFileSync(path.join(root, "schema.sql"), "utf8"),
    migrations: names.map(name => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") })),
  };
}

// Brings the database up to date. `beforeChange()` (optional) is called once, before the first
// migration is applied to an EXISTING database — the program copies the database file there, so
// an upgrade that goes wrong can be undone. Returns { isNew, applied: [names] }.
async function migrate(db, { schema, migrations }, { beforeChange } = {}) {
  if (!migrations.length) throw new Error("No migration files found.");
  const state = await db.prepare(
    "SELECT (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='orgs') AS hasSchema, " +
    "(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='d1_migrations') AS hasLog").first();
  if (!Number(state.hasSchema)) {
    // Everything in one batch (one transaction): a database is either fully made or left empty.
    const stmts = splitSql(schema).map(s => db.prepare(s));
    stmts.push(db.prepare(MIGRATIONS_TABLE_SQL));
    for (const m of migrations) stmts.push(db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(m.name));
    await db.batch(stmts);
    return { isNew: true, applied: [] };
  }
  if (!Number(state.hasLog)) {
    // Tables without a record of which migrations made them: not one this program made (it writes
    // both in one transaction), so guessing could damage it.
    throw new Error("This database has tables but no record of which updates were applied, so it can't be updated safely.");
  }
  const done = new Set(((await db.prepare("SELECT name FROM d1_migrations").all()).results || []).map(r => r.name));
  const todo = migrations.filter(m => !done.has(m.name));
  if (todo.length && beforeChange) await beforeChange(todo.map(m => m.name));
  const applied = [];
  for (const m of todo) {
    const stmts = splitSql(m.sql).map(s => db.prepare(s));
    stmts.push(db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name));
    try { await db.batch(stmts); }
    catch (e) { throw new Error("Updating the database failed at " + m.name + ": " + (e && e.message)); }
    applied.push(m.name);
  }
  return { isNew: false, applied };
}

module.exports = { splitSql, readSources, migrate };
