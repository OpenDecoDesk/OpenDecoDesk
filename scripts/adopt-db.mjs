// Adopt a database made by an earlier copy of this code whose migrations were numbered differently.
//
// `wrangler d1 migrations apply` decides what still has to run by FILE NAME (the d1_migrations table). A copy of
// this code that went its own way — an install from before OpenDecoDesk, or a private fork — has applied the same
// migrations under other numbers ("0056_users_and_roles.sql" where this repository has "0053_users_and_roles.sql"),
// so `npm run db:migrate` would try to run them all again and fail on the first column that's already there.
//
// This matches the database's applied migrations to this repository's by their DESCRIPTION — the part after the
// number — and writes SQL that records this repository's names for the ones already applied. The old rows are left
// as they are (so going back to the old code still works). After it, `npm run db:migrate` runs only what this
// repository has and the database doesn't. Nothing is changed here: it prints SQL for you to read and run.
//
//   npx wrangler d1 execute DB --remote --json --command "SELECT name FROM d1_migrations ORDER BY id" > applied.json
//   node scripts/adopt-db.mjs applied.json            # the report: matched, still to run, unknown to this repository
//   node scripts/adopt-db.mjs applied.json --sql > adopt.sql
//   npx wrangler d1 execute DB --remote --file adopt.sql
//   npm run db:pending && npm run db:migrate
//   (undo: node scripts/adopt-db.mjs applied.json --undo-sql > undo.sql)
//
// Take a backup first (npm run db:backup:now). docs/operations.md, "A database from an earlier copy". test177.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME_RE = /^\d{4}_([A-Za-z0-9_.-]+\.sql)$/;
export const descriptionOf = (name) => { const m = NAME_RE.exec(String(name || "")); return m ? m[1] : null; };

// The applied names, from a `wrangler d1 execute --json` answer or plain text (one name per line).
export function readAppliedNames(text) {
  const s = String(text || "").trim();
  try {
    const data = JSON.parse(s.slice(s.indexOf("[")));
    const first = Array.isArray(data) ? data[0] : data;
    if (first && Array.isArray(first.results)) return first.results.map(r => r && r.name).filter(Boolean);
  } catch (e) { /* not JSON: one name per line */ }
  return s.split(/\r?\n/).map(l => l.trim()).filter(l => NAME_RE.test(l));
}

// {matched: [[applied, ours]], alreadyOurs: [names], pending: [ours not applied], unknown: [applied with no match],
//  problems: [text]} — `problems` stops the adoption (a description that appears twice can't be matched safely).
export function planAdoption(appliedNames, repoNames) {
  const ours = [...repoNames].filter(n => NAME_RE.test(n)).sort();
  const applied = [...new Set(appliedNames)].filter(n => NAME_RE.test(n));
  const problems = [];
  const byDesc = new Map();
  for (const n of ours) {
    const d = descriptionOf(n);
    if (byDesc.has(d)) problems.push(`This repository has two migrations named "${d}": ${byDesc.get(d)}, ${n}.`);
    byDesc.set(d, n);
  }
  const appliedDesc = new Map();
  for (const n of applied) {
    const d = descriptionOf(n);
    if (appliedDesc.has(d) && appliedDesc.get(d) !== n) problems.push(`The database has two applied migrations named "${d}": ${appliedDesc.get(d)}, ${n}.`);
    appliedDesc.set(d, n);
  }
  const appliedSet = new Set(applied);
  const matched = [], alreadyOurs = [], unknown = [];
  for (const n of applied) {
    const mine = byDesc.get(descriptionOf(n));
    if (!mine) unknown.push(n);
    else if (mine === n) alreadyOurs.push(n);
    else if (!appliedSet.has(mine)) matched.push([n, mine]);
  }
  const covered = new Set(alreadyOurs.concat(matched.map(m => m[1])));
  const pending = ours.filter(n => !covered.has(n));
  if (!applied.length) problems.push("The database has no applied migrations recorded — this is for a database that has them (see \"A database without a migration record\").");
  return { matched, alreadyOurs, pending, unknown, problems };
}

const quote = (n) => "'" + String(n).replace(/'/g, "''") + "'";
export function adoptionSql(plan) {
  if (plan.problems.length) throw new Error(plan.problems.join("\n"));
  if (!plan.matched.length) return "-- Nothing to record: every applied migration already has this repository's name.\n";
  return "-- Record this repository's names for migrations the database already has under other numbers.\n" +
    plan.matched.map(([old, mine]) => `-- ${old} → ${mine}`).join("\n") + "\n" +
    "INSERT OR IGNORE INTO d1_migrations (name) VALUES\n" + plan.matched.map(([, mine]) => "  (" + quote(mine) + ")").join(",\n") + ";\n";
}
export function undoSql(plan) {
  if (!plan.matched.length) return "-- Nothing to undo.\n";
  return "-- Remove the names adopt-db recorded (the database's own rows were never touched).\n" +
    "DELETE FROM d1_migrations WHERE name IN (" + plan.matched.map(([, mine]) => quote(mine)).join(", ") + ");\n";
}
export function adoptionReport(plan) {
  const lines = [];
  lines.push(`Applied under another number, to record under this repository's name: ${plan.matched.length}`);
  for (const [old, mine] of plan.matched) lines.push(`  ${old}  →  ${mine}`);
  lines.push(`Applied already under this repository's name: ${plan.alreadyOurs.length}`);
  lines.push(`Still to run with npm run db:migrate: ${plan.pending.length}`);
  for (const n of plan.pending) lines.push(`  ${n}`);
  if (plan.unknown.length) {
    lines.push(`Applied in the database but not in this repository (left as they are — check each is something this code doesn't need): ${plan.unknown.length}`);
    for (const n of plan.unknown) lines.push(`  ${n}`);
  }
  for (const p of plan.problems) lines.push("PROBLEM: " + p);
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  if (!file) { console.error("Usage: node scripts/adopt-db.mjs <applied.json|applied.txt> [--sql | --undo-sql]"); process.exit(2); }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plan = planAdoption(readAppliedNames(fs.readFileSync(file, "utf8")), fs.readdirSync(path.join(repo, "migrations")));
  try {
    if (args.includes("--sql")) process.stdout.write(adoptionSql(plan));
    else if (args.includes("--undo-sql")) process.stdout.write(undoSql(plan));
    else process.stdout.write(adoptionReport(plan));
  } catch (e) { console.error(e.message); process.exit(1); }
  if (plan.problems.length) process.exit(1);
}
