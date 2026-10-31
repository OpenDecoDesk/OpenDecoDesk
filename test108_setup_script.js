const fs = require("fs");
const os = require("os");
const path = require("path");
const { createD1 } = require("./testlib/d1-shim.js");

// `npm run setup` (scripts/setup.mjs) — the installer. It can't be run against Cloudflare here, so
// this drives it with a SIMULATED wrangler: the real flow, the real file rewriting and the real
// secrets-file handling, with every external command answered by the stand-in below. What this
// proves: the questions, the command sequence, that a dry run calls nothing and changes nothing,
// that secrets never reach the screen or a command line, that wrangler.toml is rewritten without
// losing a comment, and that a second run repeats nothing. What it can't prove: that the real
// wrangler answers the way the stand-in does.
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const hex = (n, ch) => ch.repeat(n);
const UUID = [hex(8, "1a"), hex(4, "b"), hex(4, "c"), hex(4, "d"), hex(12, "e")].map((s, i) => s.slice(0, [8, 4, 4, 4, 12][i])).join("-");

(async () => {
  const S = await import("./scripts/setup.mjs");
  const src = read("scripts/setup.mjs");
  // The file as shipped has file storage off (so the Deploy to Cloudflare button doesn't ask for R2);
  // the checks of how the installer edits the file start from it switched on, as on an account with R2.
  const shippedToml = read("wrangler.toml");
  const tomlSrc = S.rewriteWranglerToml(shippedToml, { fileStorage: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-setup-test-"));
  const copy = (name) => { const p = path.join(tmp, name); fs.writeFileSync(p, shippedToml); return p; };

  console.log("=== Input checks ===");
  const v = (f, x) => f(x).value, e = (f, x) => !!f(x).error;
  ok("a domain is lower-cased and loses a leading www.", v(S.validateDomain, " WWW.MyShop.co.uk ") === "myshop.co.uk" && v(S.validateDomain, "stitch-works.shop.") === "stitch-works.shop");
  ok("a URL, a path, a bare word, an address with a space or @, and the placeholder example.com are refused",
    ["https://myshop.com", "myshop.com/admin", "myshop", "my shop.com", "me@myshop.com", "example.com", "admin.example.com", "", "-bad.com", "myshop.123"].every(x => e(S.validateDomain, x)));
  ok("the admin subdomain is one label, and not one a shop can't use either", v(S.validateSubdomain, " Admin ") === "admin" && v(S.validateSubdomain, "back-office") === "back-office" &&
    ["", "a.b", "-x", "x-", "www", "api", "images", "ad min"].every(x => e(S.validateSubdomain, x)));
  ok("an email is checked the way the business profile checks it", v(S.validateEmail, " owner@myshop.com ") === "owner@myshop.com" && ["owner", "owner@", "a b@c.com", "<a@b.com>", ""].every(x => e(S.validateEmail, x)));
  ok("a time zone must be a real IANA name", v(S.validateTimeZone, "Europe/London") === "Europe/London" && v(S.validateTimeZone, "UTC") === "UTC" && ["", "Mars/Olympus", "London time"].every(x => e(S.validateTimeZone, x)));
  ok("the images address must be https, and loses a trailing slash", v(S.validatePublicUrl, "https://images.myshop.com/") === "https://images.myshop.com" && ["images.myshop.com", "http://images.myshop.com", "https://a.com/?x=1", ""].every(x => e(S.validatePublicUrl, x)));
  ok("a name loses control characters and extra spaces", v(S.validateName, "  Thread \n &  Needle ") === "Thread & Needle" && e(S.validateName, "  "));
  ok("a pasted key can't contain a space or a line break", v(S.validateToken, " abc123 ") === "abc123" && e(S.validateToken, "abc 123") && e(S.validateToken, "a\nb") && !!S.validateToken("abc", { min: 10 }).error && !S.validateToken("abcdefghij", { min: 10 }).error);

  console.log("\n=== Generated secrets ===");
  const a1 = S.generateSecret(), a2 = S.generateSecret();
  ok("a generated secret is 64 hex characters and different every time", /^[0-9a-f]{64}$/.test(a1) && a1 !== a2);
  ok("…long enough for the send-agent relay, which refuses a token under 32 characters", a1.length >= 32 && /MIN_TOKEN_LENGTH = 32\b/.test(read("functions/api/agent.js") + read("functions/_lib/agentRelay.js")));
  const p1 = S.generatePassphrase(), p2 = S.generatePassphrase();
  ok("the admin passphrase is six groups of four typeable characters, different every time", /^([a-z2-9]{4}-){5}[a-z2-9]{4}$/.test(p1) && p1 !== p2 && !/[lo01]/.test(p1 + p2));
  ok("its alphabet has 32 distinct characters (so a byte modulo 32 is unbiased)", S.PASSPHRASE_ALPHABET.length === 32 && new Set(S.PASSPHRASE_ALPHABET).size === 32);
  ok("with fixed 'random' bytes it is deterministic (the generator has no other input)", S.generatePassphrase(() => Buffer.alloc(24, 0)) === "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa" && S.generateSecret(4, () => Buffer.from([1, 2, 3, 255])) === "010203ff");

  console.log("\n=== wrangler.toml ===");
  ok("as shipped, the three bucket blocks are commented out in the installer's marked block, so a new site needs no R2", S.readWranglerToml(shippedToml).storageOff &&
    !/^\[\[r2_buckets\]\]/m.test(shippedToml) && shippedToml.includes(S.STORAGE_OFF_BEGIN) && Object.keys(S.readWranglerToml(shippedToml).buckets).sort().join() === "DESIGNS,IMAGES,RECEIPTS");
  ok("…and switching file storage on gives exactly three live bucket blocks", (tomlSrc.match(/^\[\[r2_buckets\]\]/gm) || []).length === 3 && !S.readWranglerToml(tomlSrc).storageOff);
  const before = S.readWranglerToml(tomlSrc);
  ok("the shipped file is read: name, database, the three buckets, the placeholder id, no hostnames or settings yet", before.name === "opendecodesk" && before.databaseName === "opendecodesk-db" &&
    before.buckets.IMAGES === "opendecodesk-images" && before.buckets.RECEIPTS === "opendecodesk-receipts" && before.buckets.DESIGNS === "opendecodesk-designs" &&
    /^REPLACE/.test(before.databaseId) && before.hosts.length === 0 && Object.keys(before.vars).length === 0);
  const out1 = S.rewriteWranglerToml(tomlSrc, { databaseId: UUID, hosts: ["admin.myshop.com"], vars: { ROOT_DOMAIN: "myshop.com", ADMIN_SUBDOMAIN: "admin", TIMEZONE: "Europe/London" } });
  const after = S.readWranglerToml(out1);
  ok("the database id, the hostname and the settings are written", after.databaseId === UUID && after.hosts.join() === "admin.myshop.com" && after.vars.ROOT_DOMAIN === "myshop.com" && after.vars.TIMEZONE === "Europe/London");
  const origLines = tomlSrc.split("\n").filter(l => l.trim() && !/database_id/.test(l)), outLines = out1.split("\n");
  let at = -1; const inOrder = origLines.every(l => { const i = outLines.indexOf(l, at + 1); if (i < 0) return false; at = i; return true; });
  ok("every other line of the file — every comment — is still there, in the same order", inOrder && origLines.filter(l => l.startsWith("#")).length > 15);
  ok("the hostname is a custom domain (Cloudflare makes the DNS record), in a marked block", out1.includes(S.ROUTES_BEGIN) && out1.includes('  { pattern = "admin.myshop.com", custom_domain = true },') && out1.includes(S.ROUTES_END));
  ok("routes is a top-level key, so the block sits above the first [table] — right under the commented example", out1.indexOf("routes = [\n") < out1.search(/^\[/m) && out1.indexOf("# ]") < out1.indexOf(S.ROUTES_BEGIN));
  ok("the settings are a [vars] table at the end of the file, sorted, in a marked block", out1.trimEnd().endsWith(S.VARS_END) && out1.indexOf("[vars]") > out1.lastIndexOf("[[r2_buckets]]") &&
    /\[vars\]\nADMIN_SUBDOMAIN = "admin"\nROOT_DOMAIN = "myshop.com"\nTIMEZONE = "Europe\/London"\n/.test(out1));
  ok("no table is opened twice, and the three bucket blocks and the database block are untouched", (out1.match(/^\[vars\]/gm) || []).length === 1 && (out1.match(/^routes = \[/gm) || []).length === 1 &&
    (out1.match(/^\[\[r2_buckets\]\]/gm) || []).length === 3 && /\[\[d1_databases\]\]\nbinding = "DB"\ndatabase_name = "opendecodesk-db"\ndatabase_id = "/.test(out1));
  ok("running it again with the same answers changes nothing", S.rewriteWranglerToml(out1, { databaseId: UUID, hosts: ["admin.myshop.com"], vars: { ROOT_DOMAIN: "myshop.com", ADMIN_SUBDOMAIN: "admin", TIMEZONE: "Europe/London" } }) === out1);
  const withShop = out1.replace('  { pattern = "admin.myshop.com", custom_domain = true },', '  { pattern = "admin.myshop.com", custom_domain = true },\n  { pattern = "league.myshop.com", custom_domain = true },');
  const out2 = S.rewriteWranglerToml(withShop, { hosts: ["admin.myshop.com"], vars: { R2_PUBLIC_BASE: "https://images.myshop.com", TIMEZONE: "" } });
  const again = S.readWranglerToml(out2);
  ok("a shop hostname added by hand survives the next run", again.hosts.join() === "admin.myshop.com,league.myshop.com");
  ok("a setting is added, one given as blank is removed, the others stay, and the database id isn't touched", again.vars.R2_PUBLIC_BASE === "https://images.myshop.com" && !("TIMEZONE" in again.vars) && again.vars.ROOT_DOMAIN === "myshop.com" && again.databaseId === UUID);
  const storageOff = S.rewriteWranglerToml(out1, { fileStorage: false });
  ok("file storage off: the three bucket blocks become comments in a marked block, nothing else changes, and the names are still read", !/^\[\[r2_buckets\]\]/m.test(storageOff) && storageOff.includes(S.STORAGE_OFF_BEGIN + "\n# [[r2_buckets]]\n# binding = \"IMAGES\"\n# bucket_name = \"opendecodesk-images\"\n#\n") &&
    S.readWranglerToml(storageOff).storageOff && Object.values(S.readWranglerToml(storageOff).buckets).join() === Object.values(before.buckets).join() && S.readWranglerToml(storageOff).vars.ROOT_DOMAIN === "myshop.com" && storageOff.trimEnd().endsWith(S.VARS_END));
  ok("…switching it back on gives the file as it was, byte for byte, and saying nothing leaves it alone either way", S.rewriteWranglerToml(storageOff, { fileStorage: true }) === out1 && S.rewriteWranglerToml(storageOff, {}) === storageOff &&
    S.rewriteWranglerToml(storageOff, { fileStorage: false }) === storageOff && S.rewriteWranglerToml(out1, { fileStorage: true }) === out1 && !S.readWranglerToml(out1).storageOff);
  const odd = S.readWranglerToml(S.rewriteWranglerToml(tomlSrc, { vars: { EMAIL_FROM: 'a"b\\c@myshop.com' } }));
  ok("a value with a quote or a backslash is written as a valid string and read back the same", odd.vars.EMAIL_FROM === 'a"b\\c@myshop.com');
  const throws = (f) => { try { f(); return ""; } catch (err) { return err instanceof S.SetupError ? err.message : "other: " + err.message; } };
  ok("a file with its own routes is not guessed at: it stops and says what to add by hand",
    /already has its own routes/.test(throws(() => S.rewriteWranglerToml(tomlSrc.replace("[observability]", 'routes = [ { pattern = "x.myshop.com/*", zone_name = "myshop.com" } ]\n\n[observability]'), { hosts: ["admin.myshop.com"] }))));
  ok("…nor one with its own [vars]", /already has its own \[vars\]/.test(throws(() => S.rewriteWranglerToml(tomlSrc + '\n[vars]\nFOO = "1"\n', { vars: { ROOT_DOMAIN: "myshop.com" } }))));
  ok("…and a file that lost its database block is refused", /no database_id line/.test(throws(() => S.rewriteWranglerToml(tomlSrc.replace(/database_id = .*\n/, ""), { databaseId: UUID }))));
  ok("a file with no commented example still gets the hostnames above its first table", (() => { const t = S.rewriteWranglerToml(tomlSrc.replace(/# routes = \[[\s\S]*?# \]\n/, ""), { hosts: ["admin.myshop.com"] }); return t.indexOf("routes = [") > 0 && t.indexOf("routes = [") < t.search(/^\[/m); })());

  console.log("\n=== Reading wrangler's answers ===");
  ok("the database id is found by name in `d1 list --json`, even after a banner line", S.parseD1List(' ⛅️ wrangler\n[{"uuid":"' + UUID + '","name":"opendecodesk-db"},{"uuid":"x","name":"other"}]', "opendecodesk-db") === UUID);
  ok("…'' when it isn't there, null when the answer isn't a list", S.parseD1List("[]", "opendecodesk-db") === "" && S.parseD1List("Error!", "opendecodesk-db") === null);
  ok("the id is read from `d1 create`'s answer in either layout", S.parseD1Create('"database_' + 'id": "' + UUID + '"') === UUID && S.parseD1Create("database_" + "id = \"" + UUID.toUpperCase() + "\"") === UUID && S.parseD1Create("nope") === "");
  ok("bucket names are read from `r2 bucket list`", S.parseBucketList("Listing buckets...\nname:           opendecodesk-images\ncreation_date:  2026\n\nname:           other\n").join() === "opendecodesk-images,other");
  ok("secret names are read from `secret list`", S.parseSecretList('[{"name":"CRON_SECRET","type":"secret_text"}]').join() === "CRON_SECRET" && S.parseSecretList("no worker").length === 0);

  console.log("\n=== The business profile SQL, against the real schema and the real reader ===");
  {
    const d1 = await createD1();
    d1._raw.exec(read("schema.sql"));
    const strip = (s) => s.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
    const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { getBusinessProfile, setBusinessProfile };")();
    ok("nothing to save → no SQL at all", S.businessSql({ name: "", ownerEmail: null }) === "" && S.businessSql({}) === "");
    d1._raw.exec(S.businessSql({ name: `O'Brien's "Stitch" & Co`, ownerEmail: "owner@myshop.com" }));
    let p = await lib.getBusinessProfile(d1);
    ok("a fresh database gets the name (apostrophes and quotes intact) and the owner's email", p.name === `O'Brien's "Stitch" & Co` && p.ownerEmail === "owner@myshop.com" && p.supportEmail === "");
    ok("…and the catalog version starts at 1", d1.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0].value === "1");
    await lib.setBusinessProfile(d1, { ...p, supportEmail: "hello@myshop.com", venmo: "stitch" });
    d1._raw.exec(S.businessSql({ name: "New Name" }));
    p = await lib.getBusinessProfile(d1);
    ok("a second run changes only what was typed: the rest of a profile filled in from the admin stays", p.name === "New Name" && p.ownerEmail === "owner@myshop.com" && p.supportEmail === "hello@myshop.com" && p.venmo === "stitch");
    ok("…and bumps the catalog version so cached pages pick the name up", d1.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0].value === "2");
    d1._raw.exec("UPDATE global_settings SET value = 'not json' WHERE key = 'business'");
    d1._raw.exec(S.businessSql({ name: "Recovered" }));
    ok("a damaged saved value is replaced rather than breaking the install", (await lib.getBusinessProfile(d1)).name === "Recovered");
  }

  console.log("\n=== A new database ===");
  {
    const names = fs.readdirSync(path.join(__dirname, "migrations"));
    const rec = S.migrationRecordSql([...names, "README.md", "notes.sql", "0099 bad name.sql"]);
    ok("the migration record lists every NNNN_name.sql file once, in order, and nothing else", (rec.match(/\('\d{4}_[^']+\.sql'\)/g) || []).length === names.filter(n => /^\d{4}_.*\.sql$/.test(n)).length && !/README|notes\.sql|bad name/.test(rec) &&
      rec.indexOf("0001_") < rec.indexOf("0052_"));
    ok("it creates the table exactly as wrangler does, and never duplicates a row", /CREATE TABLE IF NOT EXISTS d1_migrations\(\s*id\s+INTEGER PRIMARY KEY AUTOINCREMENT,\s*name\s+TEXT UNIQUE,\s*applied_at\s+TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\s*\);/.test(rec) && /INSERT OR IGNORE INTO d1_migrations \(name\)/.test(rec));
    ok("with no migration files it refuses rather than recording nothing", /No migration files/.test(throws(() => S.migrationRecordSql(["README.md"]))));
    const fresh = S.freshDatabaseSql(read("schema.sql"), names);
    ok("a new database's SQL is schema.sql, untouched, followed by the record", fresh.startsWith(read("schema.sql").replace(/\s*$/, "\n")) && fresh.endsWith(rec));
    const d = await createD1(); d._raw.exec(fresh); d._raw.exec(fresh);
    ok("it can be run twice without error or duplicates (schema.sql only creates what's missing)", d.q("SELECT count(*) n FROM d1_migrations")[0].n === names.filter(n => /^\d{4}_.*\.sql$/.test(n)).length && d.q("SELECT count(*) n FROM accounts")[0].n === 5);
    ok("the state questions run on an empty and on a built database", S.parseD1Rows(JSON.stringify([{ results: (await createD1()).q(S.DB_STATE_SQL) }])).hasSchema === 0 && d.q(S.DB_STATE_SQL)[0].hasSchema === 1 && d.q(S.DB_STATE_SQL)[0].hasLog === 1 &&
      d.q(S.DB_APPLIED_SQL)[0].n > 50 && d.q(S.DB_ORDERS_SQL)[0].n === 0);
    ok("an answer from `d1 execute --json` is read past a banner; anything else is null", S.parseD1Rows(' ⛅️ wrangler\n[{"results":[{"n":3}],"success":true}]').n === 3 && S.parseD1Rows("[]") === null && S.parseD1Rows("Error") === null && S.parseD1Rows('[{"results":[]}]') === null);
    const printed = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "scripts/setup.mjs"), "--print-fresh-sql"], { encoding: "utf8" });
    ok("`--print-fresh-sql` prints exactly that SQL and nothing else (for installing by hand)", printed.status === 0 && printed.stdout === fresh);
    ok("the reason is real: the first migration alters a table instead of creating one", /^ALTER TABLE orders/m.test(read("migrations/0001_add_parcel_dimensions.sql")) && !/CREATE TABLE/.test(read("migrations/0001_add_parcel_dimensions.sql")));
  }

  console.log("\n=== Commands ===");
  ok("a command is an argument list for wrangler, never a shell string", Object.values(S.commands).every(f => Array.isArray(f("a", "b"))) &&
    S.commands.deploy("w.toml", "/t/s.json").join(" ") === "deploy --config w.toml --secrets-file /t/s.json" && S.commands.deploy("w.toml", "").join(" ") === "deploy --config w.toml" &&
    S.commands.migrate("w.toml").join(" ") === "d1 migrations apply DB --remote --config w.toml");
  ok("printing a command blanks any known secret and quotes what needs quoting", S.maskCommand(["npx", "wrangler", "x", "--token", "s3cr3tvalue", "a b"], ["s3cr3tvalue"]) === "npx wrangler x --token ******** 'a b'");
  ok("the script runs external programs in exactly one place, with no shell, and makes no network call of its own", (src.match(/spawnSync\(/g) || []).length === 1 && /shell: false/.test(src) &&
    !/\bexecSync\b|execFile|spawn\(|shell: true|fetch\(|https?\.request|node:https?|node:net/.test(src) && (src.match(/= exec\(/g) || []).length === 1 && (src.match(/realExec/g) || []).length === 2);
  ok("it uses nothing but Node's standard library", [...src.matchAll(/^import .* from "([^"]+)";$/gm)].every(m => m[1].startsWith("node:")) && !/require\(/.test(src));
  ok("it says, at the top and in --help, how far a real install has got: one, the smallest", /ONE INSTALL HAS BEEN COMPLETED ON A REAL CLOUDFLARE ACCOUNT, THE SMALLEST ONE/.test(src.slice(0, 1500)) && /ONE REAL INSTALL SO FAR, THE SMALLEST ONE/.test(src));
  ok("flags are parsed, and an unknown one is refused", S.parseArgs(["--dry-run", "--config", "x.toml", "--new-passphrase"]).dryRun === true && S.parseArgs(["--config", "x.toml"]).config === "x.toml" &&
    S.parseArgs([]).config === "wrangler.toml" && /Unknown option/.test(throws(() => S.parseArgs(["--force"]))));

  // ---- a stand-in for wrangler ----------------------------------------------------------------
  // Its database is a real SQLite (sql.js): the installer's SQL actually runs, and
  // `d1 migrations apply` behaves like wrangler's — it applies whatever isn't in d1_migrations, which
  // on a database with no tables fails at the first migration (it alters a table that isn't there).
  const MIGRATIONS = fs.readdirSync(path.join(__dirname, "migrations")).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
  const newDb = async () => createD1();
  const cloud = (state) => {
    const st = Object.assign({ loggedIn: true, dbs: [], buckets: [], secrets: [], deployed: 0, failOn: null, failWith: null, lateBucket: null, calls: [], secretsSeen: null, secretsMode: null, migrated: 0, sql: [], db: null, files: [] }, state);
    st.exec = (file, args) => {
      st.calls.push([file, ...args].join(" "));
      const w = args.slice(1), is = (...words) => words.every((x, i) => w[i] === x);
      const okOut = (stdout) => ({ status: 0, stdout: stdout || "", stderr: "" }), bad = (stderr) => ({ status: 1, stdout: "", stderr });
      if (file !== "npx" || args[0] !== "wrangler") return bad("unexpected program " + file);
      if (st.failOn && w.join(" ").startsWith(st.failOn)) return st.failWith ? { status: 1, stdout: st.failWith.stdout || "", stderr: st.failWith.stderr || "" } : bad("X [ERROR] simulated failure of " + st.failOn);
      if (is("--version")) return okOut("4.0.0");
      if (is("whoami")) return st.loggedIn ? okOut("You are logged in with an OAuth Token") : bad("You are not authenticated. Please run `wrangler login`.");
      if (is("d1", "list")) {
        if (st.lateBucket) { st.buckets.push(st.lateBucket); st.lateBucket = null; }   // made by someone else after the installer's listing
        return okOut(" ⛅️ wrangler\n" + JSON.stringify(st.dbs));
      }
      if (is("d1", "create")) { st.dbs.push({ uuid: UUID, name: w[2] }); return okOut("✅ Successfully created DB\n{ \"d1_databases\": [ { \"binding\": \"DB\", \"database_name\": \"" + w[2] + "\", \"database_" + "id\": \"" + UUID + "\" } ] }"); }
      if (is("r2", "bucket", "list")) return okOut("Listing buckets...\n" + st.buckets.map(b => "name:           " + b + "\ncreation_date:  2026-01-01\n").join("\n"));
      if (is("r2", "bucket", "create")) {
        if (st.buckets.includes(w[3])) return bad("X [ERROR] The bucket you tried to create already exists, and you own it. [code: 10004]");
        st.buckets.push(w[3]); return okOut("Created bucket");
      }
      if (is("d1", "migrations", "apply")) {
        st.tomlAtMigrate = fs.readFileSync(w[w.indexOf("--config") + 1], "utf8");
        let applied = [];
        try { applied = st.db.q("SELECT name FROM d1_migrations").map(r => r.name); } catch (err) { /* no record yet: wrangler would create it, empty */ }
        const todo = MIGRATIONS.filter(m => !applied.includes(m));
        st.migrateTodo = todo.length;
        for (const m of todo) { try { st.db.execFile(read("migrations/" + m)); } catch (err) { return bad("Migration " + m + " failed: " + err.message); } }
        st.migrated++; return okOut(todo.length ? "applied " + todo.length : "No migrations to apply!");
      }
      if (is("d1", "execute")) {
        const fi = w.indexOf("--file"), ci = w.indexOf("--command");
        try {
          if (fi >= 0) { const text = fs.readFileSync(w[fi + 1], "utf8"); st.files.push({ path: w[fi + 1], text, mode: fs.statSync(w[fi + 1]).mode & 0o777 }); st.db._raw.exec(text); return okOut("Executed"); }
          if (w.includes("--json")) return okOut(" ⛅️ wrangler\n" + JSON.stringify([{ results: st.db.q(w[ci + 1]), success: true, meta: {} }]));
          st.sql.push(w[ci + 1]); st.db._raw.exec(w[ci + 1]); return okOut("");
        } catch (err) { return bad("D1_ERROR: " + err.message); }
      }
      if (is("secret", "list")) return st.deployed ? okOut(JSON.stringify(st.secrets.map(name => ({ name, type: "secret_text" })))) : bad("This Worker does not exist on your account.");
      if (is("deploy")) {
        const gone = [...fs.readFileSync(w[w.indexOf("--config") + 1], "utf8").matchAll(/^\[\[r2_buckets\]\]\nbinding = "[A-Z]+"\nbucket_name = "([^"]+)"/gm)].map(m => m[1]).find(b => !st.buckets.includes(b));
        if (gone) return bad("X [ERROR] R2 bucket '" + gone + "' not found.");   // a deploy can't bind a bucket that doesn't exist
        const i = w.indexOf("--secrets-file");
        if (i >= 0) { const f = w[i + 1]; st.secretsSeen = JSON.parse(fs.readFileSync(f, "utf8")); st.secretsMode = fs.statSync(f).mode & 0o777; st.secretsPath = f;
          for (const k of Object.keys(st.secretsSeen)) if (!st.secrets.includes(k)) st.secrets.push(k); } else st.secretsSeen = null;
        st.tomlAtDeploy = fs.readFileSync(w[w.indexOf("--config") + 1], "utf8"); st.deployed++; return okOut("Deployed");
      }
      return bad("the stand-in doesn't know: " + w.join(" "));
    };
    return st;
  };
  const scripted = (answers) => {
    const io = { lines: [], asked: [], ask: async (id, question, opts) => { io.asked.push({ id, question, secret: !!(opts && opts.secret) }); io.lines.push(question); return answers[id] || ""; }, print: (s) => io.lines.push(String(s)) };
    io.text = () => io.lines.join("\n");
    return io;
  };
  const go = async ({ answers, state, dryRun, flags, config }) => {
    const st = state || cloud(), io = scripted(answers);
    if (!st.db) st.db = await newDb();
    const run = S.createRunner({ dryRun: !!dryRun, exec: st.exec, print: io.print });
    let result = null, error = null;
    try { result = await S.setup({ io, run, files: S.realFiles, configPath: config, flags: flags || {} }); } catch (err) { error = err; }
    return { st, io, run, result, error };
  };
  const SK = "sk_test_" + "Zq9".repeat(10), WH = "wh" + "sec_" + "Kp4".repeat(9), SHIPPO = "shippo_test_" + "ab12".repeat(8), RESEND = "re_" + "Xy7".repeat(10), TS = "0x4" + "Bn8".repeat(10), CFTOK = "cf_" + "Lm3".repeat(12);
  const BASE = { rootDomain: "MyShop.com", adminSubdomain: "", businessName: "Thread & Needle", ownerEmail: "owner@myshop.com", timeZone: "Europe/London", r2PublicBase: "" };
  const FULL = { ...BASE, r2PublicBase: "https://images.myshop.com/",
    stripe: "y", "stripe.STRIPE_SECRET_KEY": SK, "stripe.STRIPE_WEBHOOK_SECRET": "",
    shippo: "y", "shippo.SHIPPO_API_KEY": SHIPPO,
    email: "r", "email.RESEND_API_KEY": RESEND, "email.EMAIL_FROM": "",
    turnstile: "y", "turnstile.TURNSTILE_SITE_KEY": "0x4AAAsitekey", "turnstile.TURNSTILE_SECRET_KEY": TS,
    access: "", domains: "y", "domains.CF_API_TOKEN": CFTOK, "domains.CF_ACCOUNT_ID": "acct0123456789", "domains.CF_ZONE_ID": "zone0123456789",
    agent: "y" };
  const typedSecrets = [SK, WH, SHIPPO, RESEND, TS, CFTOK];

  console.log("\n=== A dry run: nothing is called, nothing is changed ===");
  {
    const cfgPath = copy("dry.toml");
    const { st, io, run, result, error } = await go({ answers: FULL, dryRun: true, config: cfgPath });
    const text = io.text();
    ok("it finishes", !error && result && result.ok === true && result.deployed === false);
    ok("the only program run is `wrangler --version` (which talks to nobody)", st.calls.join("|") === "npx wrangler --version");
    ok("wrangler.toml is byte-for-byte unchanged, and no other file appeared", fs.readFileSync(cfgPath, "utf8") === shippedToml && fs.readdirSync(tmp).join() === "dry.toml");
    const would = io.lines.filter(l => /\[dry run\] would run:/.test(l)).map(l => l.replace(/^.*would run: npx wrangler /, "").replace(cfgPath, "CFG"));
    ok("it prints every command it would run, in order", would.length === 14 && would[0] === "whoami" && would[1] === "r2 bucket list" && would[2] === "d1 list --json" && would[3] === "d1 create opendecodesk-db" &&
      would[4] === "r2 bucket create opendecodesk-images" && would[5] === "r2 bucket create opendecodesk-receipts" && would[6] === "r2 bucket create opendecodesk-designs" &&
      /^d1 execute DB --remote --json --yes --config CFG --command 'SELECT \(SELECT count/.test(would[7]) && would[8] === "d1 execute DB --remote --yes --config CFG --file '<temporary file: schema.sql + the migration record>'" &&
      would[9] === "d1 migrations apply DB --remote --config CFG" && would[10] === "d1 execute DB --remote --json --yes --config CFG --command 'SELECT subdomain FROM orgs ORDER BY subdomain'" &&
      would[11] === "secret list --format json --config CFG" && /^d1 execute DB --remote --yes --config CFG --command 'INSERT INTO global_settings/.test(would[12]) &&
      would[13] === "deploy --config CFG --secrets-file '<temporary file>'");
    if (would.length !== 14) console.log(would);
    ok("it explains the two ways the tables are made: a new database from schema.sql, an existing one from new migrations only", /a NEW database gets every table from schema\.sql and a record that all \d+ migrations are part of it/.test(text) && /an EXISTING database skips that/.test(text));
    ok("it says what it would write into wrangler.toml", /would set database_id, add the hostname admin\.myshop\.com, and set: ADMIN_SUBDOMAIN, R2_PUBLIC_BASE, ROOT_DOMAIN, TIMEZONE/.test(text) &&
      /would also set: CF_ACCOUNT_ID, CF_WORKER_NAME, CF_ZONE_ID, TURNSTILE_SITE_KEY/.test(text));
    ok("it names the secrets it would store — names only", /would write 9 secrets to a temporary file[^\n]*\(AGENT_TOKEN, CF_API_TOKEN, CRON_SECRET, PROXY_ADMIN_PASSPHRASE, RESEND_API_KEY, SHIPPO_API_KEY, SIGNING_SECRET, STRIPE_SECRET_KEY, TURNSTILE_SECRET_KEY\)/.test(text));
    ok("no typed secret appears anywhere in the output or in a command", typedSecrets.every(s => !text.includes(s)) && run.log.every(c => typedSecrets.every(s => !c.includes(s))));
    ok("no generated secret appears either: nothing on screen looks like a 64-character key or a passphrase", !/[0-9a-f]{64}/.test(text) && !/([a-z2-9]{4}-){5}[a-z2-9]{4}/.test(text) && !/Shown ONCE/.test(text));
    ok("it is plainly marked as a dry run", /DRY RUN: nothing is created, changed or deployed/.test(text) && /Dry run finished — nothing was changed/.test(text));
  }

  console.log("\n=== A first install (simulated Cloudflare) ===");
  const cfgPath = copy("wrangler.toml");
  {
    const { st, io, run, result, error } = await go({ answers: FULL, config: cfgPath });
    const text = io.text();
    if (error) console.log(error);
    ok("it finishes and deploys", !error && result.ok && result.deployed === true && st.deployed === 1);
    const seq = st.calls.map(c => c.replace("npx wrangler ", "").replace(cfgPath, "CFG").replace(/--secrets-file \S+/, "--secrets-file TMP").replace(/--command .*/, "--command SQL").replace(/--file \S+/, "--file TMP"));
    ok("the commands run in the right order: check (wrangler, sign-in, R2), database, buckets, migrations, the shops' hostnames, secrets, profile, deploy", seq.join(" | ") === ["--version", "whoami", "r2 bucket list", "d1 list --json", "d1 create opendecodesk-db",
      "r2 bucket create opendecodesk-images", "r2 bucket create opendecodesk-receipts", "r2 bucket create opendecodesk-designs",
      "d1 execute DB --remote --json --yes --config CFG --command SQL", "d1 execute DB --remote --yes --config CFG --file TMP", "d1 migrations apply DB --remote --config CFG",
      "d1 execute DB --remote --json --yes --config CFG --command SQL", "secret list --format json --config CFG", "d1 execute DB --remote --yes --config CFG --command SQL", "deploy --config CFG --secrets-file TMP"].join(" | "));
    console.log("--- a new database ---");
    const tablesIn = (db) => db.q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name").map(r => r.name).join();
    const ref = await newDb(); ref._raw.exec(read("schema.sql"));
    ok("the new database was built from schema.sql: every table is there", st.files.length === 1 && tablesIn(st.db) === tablesIn(ref) && tablesIn(st.db).split(",").length > 50);
    ok("…with its starting rows (accounts, expense categories, needle sizes)", st.db.q("SELECT count(*) n FROM accounts")[0].n >= 5 && st.db.q("SELECT count(*) n FROM expense_categories")[0].n > 5 && st.db.q("SELECT count(*) n FROM needle_sizes")[0].n >= 2);
    ok("every migration file is recorded as already applied, by its file name", st.db.q("SELECT name FROM d1_migrations ORDER BY name").map(r => r.name).join() === MIGRATIONS.join() && MIGRATIONS.length >= 52);
    ok("…in the table wrangler keeps (id, name, applied_at), so its own `migrations apply` then finds nothing to do", st.migrateTodo === 0 && st.migrated === 1 &&
      st.db.q("PRAGMA table_info(d1_migrations)").map(c => c.name).join() === "id,name,applied_at" && !!st.db.q("SELECT applied_at FROM d1_migrations LIMIT 1")[0].applied_at);
    ok("the SQL went to wrangler as a file only its owner could read, deleted afterwards", st.files[0].mode === 0o600 && !fs.existsSync(st.files[0].path) && /fresh-database\.sql$/.test(st.files[0].path));
    ok("migrations alone could not have built it: on an empty database the first one fails", await (async () => { const empty = cloud(); empty.db = await newDb(); const res = empty.exec("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", cfgPath]); return res.status === 1 && /0001_/.test(res.stderr); })());
    ok("the business profile really landed in that database", JSON.parse(st.db.q("SELECT value FROM global_settings WHERE key='business'")[0].value).name === "Thread & Needle");
    if (!error) console.log("   " + seq.length + " commands");
    const t = S.readWranglerToml(fs.readFileSync(cfgPath, "utf8"));
    ok("wrangler.toml has the new database's id, the admin hostname and the plain settings", t.databaseId === UUID && t.hosts.join() === "admin.myshop.com" && t.vars.ROOT_DOMAIN === "myshop.com" && t.vars.ADMIN_SUBDOMAIN === "admin" &&
      t.vars.TIMEZONE === "Europe/London" && t.vars.R2_PUBLIC_BASE === "https://images.myshop.com");
    ok("…and the non-secret half of each service: Turnstile's site key, the ids for custom domains and this Worker's name", t.vars.TURNSTILE_SITE_KEY === "0x4AAAsitekey" && t.vars.CF_ACCOUNT_ID === "acct0123456789" && t.vars.CF_ZONE_ID === "zone0123456789" && t.vars.CF_WORKER_NAME === "opendecodesk");
    ok("the migrations ran against a config that already had the database id", S.readWranglerToml(st.tomlAtMigrate).databaseId === UUID);
    ok("the deploy saw the finished config", st.tomlAtDeploy === fs.readFileSync(cfgPath, "utf8"));
    ok("no secret is in wrangler.toml", [...typedSecrets, ...Object.values(st.secretsSeen)].every(s => !fs.readFileSync(cfgPath, "utf8").includes(s)));
    ok("the secrets reached the deploy in one file: the three generated ones, the typed ones and the send-agent token", Object.keys(st.secretsSeen).sort().join() ===
      "AGENT_TOKEN,CF_API_TOKEN,CRON_SECRET,PROXY_ADMIN_PASSPHRASE,RESEND_API_KEY,SHIPPO_API_KEY,SIGNING_SECRET,STRIPE_SECRET_KEY,TURNSTILE_SECRET_KEY" &&
      st.secretsSeen.STRIPE_SECRET_KEY === SK && st.secretsSeen.RESEND_API_KEY === RESEND && /^[0-9a-f]{64}$/.test(st.secretsSeen.SIGNING_SECRET) && st.secretsSeen.SIGNING_SECRET !== st.secretsSeen.CRON_SECRET && st.secretsSeen.AGENT_TOKEN.length >= 32);
    ok("…a file only its owner could read, deleted (with its folder) as soon as the deploy returned", st.secretsMode === 0o600 && !fs.existsSync(st.secretsPath) && !fs.existsSync(path.dirname(st.secretsPath)));
    ok("the webhook secret left blank was not stored (and didn't cancel Stripe)", !("STRIPE_WEBHOOK_SECRET" in st.secretsSeen) && result.chosen.includes("stripe"));
    ok("no secret is on any command line", run.log.every(c => [...typedSecrets, ...Object.values(st.secretsSeen)].every(s => !c.includes(s))) && st.calls.every(c => Object.values(st.secretsSeen).every(s => !c.includes(s))));
    ok("no typed secret is ever printed", typedSecrets.every(s => !text.includes(s)));
    const count = (needle) => text.split(needle).length - 1;
    ok("the new admin passphrase is shown exactly once, at the very end", count(st.secretsSeen.PROXY_ADMIN_PASSPHRASE) === 1 && text.indexOf(st.secretsSeen.PROXY_ADMIN_PASSPHRASE) > text.indexOf("What to do next") && /Shown ONCE/.test(text));
    ok("…as is the send-agent token (the agent's computer needs it), and nothing else that was generated", count(st.secretsSeen.AGENT_TOKEN) === 1 && count(st.secretsSeen.SIGNING_SECRET) === 0 && count(st.secretsSeen.CRON_SECRET) === 0);
    ok("every secret was asked for with hidden input, and nothing else was", io.asked.filter(q => q.secret).map(q => q.id.split(".")[1]).sort().join() === "CF_API_TOKEN,RESEND_API_KEY,SHIPPO_API_KEY,STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,TURNSTILE_SECRET_KEY" &&
      io.asked.filter(q => !q.secret).every(q => !S.SECRET_NAMES.includes(q.id.split(".")[1])));
    ok("every optional service was offered, with skipping as the default", ["stripe", "shippo", "email", "turnstile", "access", "domains", "agent"].every(id => io.asked.some(q => q.id === id)) &&
      io.asked.filter(q => ["stripe", "shippo", "turnstile", "access", "domains", "agent"].includes(q.id)).every(q => /\[y\/N\]/.test(q.question)) && /Enter to skip/.test(io.asked.find(q => q.id === "email").question));
    ok("Access, answered with Enter, was skipped and set nothing", !("ACCESS_AUD" in t.vars) && !result.chosen.includes("access"));
    ok("the business name and owner email were sent as one statement", st.sql.length === 1 && st.sql[0].includes('"name":"Thread & Needle"') && st.sql[0].includes('"ownerEmail":"owner@myshop.com"'));
    ok("the to-do list covers signing in, 2FA, the setup status, the sending domain, the Stripe webhook address and its events, and the first shop",
      /Open https:\/\/admin\.myshop\.com and sign in/.test(text) && /Security \(2FA\)/.test(text) && /Setup status/.test(text) && /Verify myshop\.com as a sending domain/.test(text) &&
      text.includes("https://admin.myshop.com/api/stripe-webhook") && S.STRIPE_WEBHOOK_EVENTS.every(ev => text.includes(ev)) && /paste its signing secret/.test(text) && /Create your first shop/.test(text) && /attached automatically/.test(text));
    ok("…and doesn't nag about the images bucket, which was given", !/Make the images bucket/.test(text));
    ok("…and says which payload format Stripe's webhook needs", /If it asks for a payload format, choose Snapshot/.test(text));
    ok("the webhook events it lists are exactly the ones the webhook handles", S.STRIPE_WEBHOOK_EVENTS.slice().sort().join() === [...new Set([...read("functions/api/stripe-webhook.js").matchAll(/event\.type === "([a-z_.]+)"/g)].map(m => m[1]))].sort().join());

    console.log("\n=== Running it again ===");
    const tomlBefore = fs.readFileSync(cfgPath, "utf8");
    const second = await go({ answers: { rootDomain: "", adminSubdomain: "", businessName: "", ownerEmail: "", timeZone: "", r2PublicBase: "", stripe: "y", "stripe.STRIPE_SECRET_KEY": "", "stripe.STRIPE_WEBHOOK_SECRET": WH }, state: st, config: cfgPath });
    const t2 = second.io.text(), calls2 = st.calls.slice(seq.length).map(c => c.replace("npx wrangler ", "").replace(cfgPath, "CFG").replace(/--secrets-file \S+/, "--secrets-file TMP"));
    ok("the earlier answers are offered as defaults, so Enter all the way through works", !second.error && second.io.asked.find(q => q.id === "rootDomain").question.includes("[myshop.com]") && second.io.asked.find(q => q.id === "timeZone").question.includes("[Europe/London]") &&
      second.io.asked.find(q => q.id === "r2PublicBase").question.includes("[https://images.myshop.com]"));
    ok("nothing is created twice: the database and the buckets are found and reused", !calls2.some(c => /d1 create|bucket create/.test(c)) && st.dbs.length === 1 && st.buckets.length === 3 && /Already exists — using it/.test(t2));
    ok("a second run that skips the Email question doesn't claim email isn't set up", !/Email isn't set up/.test(t2) && /Verify myshop\.com as a sending domain/.test(t2));
    ok("the tables aren't rebuilt: an existing database only gets `migrations apply` (nothing to do here)", st.files.length === 1 && !calls2.some(c => /--file/.test(c)) && calls2.filter(c => /migrations apply/.test(c)).length === 1 && st.migrateTodo === 0 && /are up to date/.test(t2));
    ok("no new passphrase or signing secrets: only the webhook secret typed this time is stored", Object.keys(st.secretsSeen).join() === "STRIPE_WEBHOOK_SECRET" && st.secretsSeen.STRIPE_WEBHOOK_SECRET === WH && !/Shown ONCE/.test(t2) && /nothing new \(already set\)/.test(t2));
    ok("…the Stripe key that's already set was kept by pressing Enter", second.io.asked.find(q => q.id === "stripe.STRIPE_SECRET_KEY").question.includes("already set — Enter keeps it") && second.result.chosen.includes("stripe"));
    ok("the business profile isn't written when nothing was typed", st.sql.length === 1 && !calls2.some(c => /INSERT INTO global_settings/.test(c)));
    ok("wrangler.toml comes out identical", fs.readFileSync(cfgPath, "utf8") === tomlBefore);
    ok("the to-do list no longer asks for the webhook secret, and says the passphrase is the one you have", !/paste its signing secret/.test(t2) && /passphrase you already have/.test(t2));
    const third = await go({ answers: {}, state: st, config: cfgPath });
    ok("a third run with nothing new deploys without a secrets file at all", !third.error && st.calls[st.calls.length - 1] === "npx wrangler deploy --config " + cfgPath && st.secretsSeen === null);
    const fourth = await go({ answers: {}, state: st, config: cfgPath, flags: { newPassphrase: true } });
    ok("--new-passphrase replaces the passphrase and shows the new one once", Object.keys(st.secretsSeen).join() === "PROXY_ADMIN_PASSPHRASE" && fourth.io.text().split(st.secretsSeen.PROXY_ADMIN_PASSPHRASE).length === 2);
    const skip = await go({ answers: {}, state: st, config: cfgPath, flags: { skipDeploy: true, newPassphrase: true } });
    ok("--skip-deploy stops before the deploy, stores no secret and shows none", st.deployed === 4 && /not deploying/.test(skip.io.text()) && !/Shown ONCE/.test(skip.io.text()) && Object.keys(skip.result.shown).length === 0);
  }

  console.log("\n=== Half a service is not set up ===");
  {
    const p = copy("half.toml");
    const { st, io, result } = await go({ config: p, answers: { ...BASE, turnstile: "y", "turnstile.TURNSTILE_SITE_KEY": "0x4AAAsitekey", "turnstile.TURNSTILE_SECRET_KEY": "",
      email: "c", "email.CF_EMAIL_API_TOKEN": CFTOK, "email.CF_ACCOUNT_ID": "", access: "y", "access.ACCESS_TEAM_DOMAIN": "team.cloudflareaccess.com", "access.ACCESS_AUD": "" } });
    const t = S.readWranglerToml(fs.readFileSync(p, "utf8"));
    ok("a Turnstile site key without its secret sets neither (a lone key would refuse every order)", !("TURNSTILE_SITE_KEY" in t.vars) && !("TURNSTILE_SECRET_KEY" in st.secretsSeen) && !result.chosen.includes("turnstile"));
    ok("Cloudflare email without the account id sets neither", !("CF_EMAIL_API_TOKEN" in st.secretsSeen) && !("CF_ACCOUNT_ID" in t.vars) && !result.chosen.some(c => c.startsWith("email")));
    ok("Access with only the team domain sets neither (it would lock the admin)", !("ACCESS_TEAM_DOMAIN" in t.vars) && !("ACCESS_AUD" in t.vars));
    ok("it says each was skipped, that email isn't set up, and how to make the images bucket public", (io.text().match(/Left blank — skipped/g) || []).length === 3 && /Email isn't set up, so no email is sent/.test(io.text()) && /Make the images bucket "opendecodesk-images" public/.test(io.text()));
    ok("a bare install stores just the three generated secrets", Object.keys(st.secretsSeen).sort().join() === "CRON_SECRET,PROXY_ADMIN_PASSPHRASE,SIGNING_SECRET");
    ok("without automatic hostnames, it says how a new shop's hostname gets attached, and to deploy with npm run deploy from now on", /Then run `npm run deploy`: it lists the shop's hostname in/.test(io.text()) && /not a bare `wrangler deploy`, which detaches any shop hostname that isn't listed/.test(io.text()));
  }
  {
    const p = copy("cfmail.toml");
    const { st } = await go({ config: p, answers: { ...BASE, email: "c", "email.CF_EMAIL_API_TOKEN": CFTOK, "email.CF_ACCOUNT_ID": "acct0123456789", "email.EMAIL_FROM": "shop@myshop.com" } });
    const t = S.readWranglerToml(fs.readFileSync(p, "utf8"));
    const sub = await go({ config: copy("submail.toml"), answers: { ...BASE, email: "r", "email.RESEND_API_KEY": RESEND, "email.EMAIL_FROM": "orders@mail.myshop.com" } });
    ok("the to-do list names the domain the sender address is on, which is the one to verify", /Verify mail\.myshop\.com as a sending domain/.test(sub.io.text()) && !/Verify myshop\.com as a sending domain/.test(sub.io.text()));
    ok("Cloudflare email, complete: the token is a secret, the account id and the sender are plain settings", st.secretsSeen.CF_EMAIL_API_TOKEN === CFTOK && t.vars.CF_ACCOUNT_ID === "acct0123456789" && t.vars.EMAIL_FROM === "shop@myshop.com" && !("RESEND_API_KEY" in st.secretsSeen));
  }

  console.log("\n=== Upgrading: npm run deploy keeps every shop's hostname ===");
  // `wrangler deploy` makes the Worker's hostnames exactly the ones in wrangler.toml, so a shop
  // whose hostname was attached in the dashboard (or by the admin) and isn't listed there goes
  // offline at the next deploy. The upgrade command lists every shop from the database first.
  {
    const p = copy("up.toml");
    const first = await go({ answers: BASE, config: p });
    const st = first.st, addShop = (id, sub) => st.db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('${id}', '${sub}', '${id}', 't', 't')`);
    addShop("league-101", "league"); addShop("club-7", "club");
    const lines = [], from = st.calls.length;
    const up = async (opts = {}) => { lines.length = 0; let error = null, result = null;
      try { result = await S.upgrade({ print: (l) => lines.push(String(l)), run: S.createRunner({ dryRun: !!opts.dryRun, exec: st.exec, print: (l) => lines.push(String(l)) }), files: S.realFiles, configPath: opts.config || p }); } catch (e) { error = e; }
      return { error, result, text: lines.join("\n") }; };
    let u = await up({ dryRun: true });
    ok("a dry run shows the three steps and changes nothing", !u.error && /would run: npx wrangler d1 migrations apply/.test(u.text) && /SELECT subdomain FROM orgs/.test(u.text) && /would run: npx wrangler deploy/.test(u.text) &&
      st.calls.length === from && S.readWranglerToml(fs.readFileSync(p, "utf8")).hosts.join() === "admin.myshop.com");
    u = await up();
    const after = S.readWranglerToml(fs.readFileSync(p, "utf8"));
    const did = st.calls.slice(from).map(c => c.replace("npx wrangler ", "").replace(p, "CFG").replace(/--command .*/, "--command SQL"));
    ok("it looks at the database, runs the migrations, reads the site and the shops, then deploys — in that order", !u.error && did.join(" | ") === ["d1 execute DB --remote --json --yes --config CFG --command SQL", "d1 execute DB --remote --json --yes --config CFG --command SQL",
      "d1 migrations apply DB --remote --config CFG", "d1 execute DB --remote --json --yes --config CFG --command SQL", "d1 execute DB --remote --json --yes --config CFG --command SQL", "deploy --config CFG"].join(" | "));
    ok("every shop's hostname is in wrangler.toml before the deploy, beside the admin's, and the deploy saw that file", after.hosts.join() === "admin.myshop.com,club.myshop.com,league.myshop.com" && st.tomlAtDeploy === fs.readFileSync(p, "utf8") &&
      /2 shops in the database; added to .*: club\.myshop\.com, league\.myshop\.com\. 3 hostnames in all/.test(u.text));
    ok("nothing else in the file moved: the database id, the settings and the secrets are as they were", after.databaseId === UUID && after.vars.ROOT_DOMAIN === "myshop.com" && st.secretsSeen === null);
    const tomlNow = fs.readFileSync(p, "utf8");
    u = await up();
    ok("running it again adds nothing and says so", !u.error && fs.readFileSync(p, "utf8") === tomlNow && /all already listed/.test(u.text));
    addShop("choir-9", "choir"); st.db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('odd', 'Not A Label!', 'odd', 't', 't'), ('www-shop', 'www', 'w', 't', 't')`);
    u = await up();
    ok("a shop made since then is picked up; something that isn't a hostname label (or is reserved) is never written into the file", S.readWranglerToml(fs.readFileSync(p, "utf8")).hosts.join() === "admin.myshop.com,club.myshop.com,league.myshop.com,choir.myshop.com");
    ok("the installer run again keeps them too (it used to list the admin's hostname only)", !(await go({ answers: { ...BASE, rootDomain: "" }, state: st, config: p })).error && S.readWranglerToml(st.tomlAtDeploy).hosts.length === 4);
    const deploys = st.deployed;
    st.failOn = "d1 execute DB --remote --json --yes --config " + p + " --command SELECT subdomain";
    u = await up();
    ok("if the shops can't be read it does NOT deploy: deploying without the list would take shops offline", u.error instanceof S.SetupError && /Could not read the shops/.test(u.error.message) && /take shops offline/.test(u.error.message) && st.deployed === deploys);
    st.failOn = "d1 migrations";
    u = await up();
    ok("if a migration fails it stops there: no deploy on a database the new code doesn't fit", u.error instanceof S.SetupError && /Applying the database migrations failed/.test(u.error.message) && st.deployed === deploys);
    st.failOn = null;
    u = await up({ config: copy("fresh.toml") });
    ok("a copy that was never installed is told to run the installer, and nothing is run", u.error instanceof S.SetupError && /npm run setup/.test(u.error.message) && st.deployed === deploys);
    ok("the hostnames come from the shops' subdomains and the root domain, lower-cased, once each", S.shopHostnames([{ subdomain: "League" }, { subdomain: "league" }, { subdomain: "" }, {}, null, { subdomain: "a.b" }, { subdomain: "-x" }, { subdomain: "images" }], "MyShop.com").join() === "league.myshop.com" &&
      S.shopHostnames([{ subdomain: "league" }], "").length === 0 && S.parseD1AllRows(' ⛅️ wrangler\n[{"results":[],"success":true}]').length === 0 && S.parseD1AllRows("not json") === null);
    ok("npm run deploy is that command", JSON.parse(read("package.json")).scripts.deploy === "node scripts/deploy.mjs" && /import \{ upgrade, createRunner, realExec, realFiles, SetupError \} from "\.\/setup\.mjs";/.test(read("scripts/deploy.mjs")));
  }

  console.log("\n=== npm run deploy as Cloudflare's build runs it (a Deploy-button site) ===");
  // The button makes an EMPTY database and runs `npm run deploy` in Cloudflare's build. The site's
  // domain, once the owner has set it up in the admin, is kept in the database, not wrangler.toml.
  {
    const p = copy("button.toml");
    const st = cloud(); st.db = await newDb();
    st.dbs.push({ uuid: UUID, name: "opendecodesk-db" });   // the button makes the database and the buckets, empty
    st.buckets.push("opendecodesk-images", "opendecodesk-receipts", "opendecodesk-designs");
    const lines = [];
    const up = async (opts = {}) => { lines.length = 0; let error = null, result = null;
      try { result = await S.upgrade({ print: (l) => lines.push(String(l)), run: S.createRunner({ exec: st.exec, print: (l) => lines.push(String(l)) }), files: S.realFiles, configPath: p, ci: opts.ci !== false, diagnose: !!opts.diagnose }); } catch (e) { error = e; }
      return { error, result, text: lines.join("\n") }; };
    let u = await up({ ci: false });
    ok("outside Cloudflare's build, a copy never installed is still told to run the installer", u.error instanceof S.SetupError && /npm run setup/.test(u.error.message) && st.deployed === 0);
    u = await up({ diagnose: true });
    if (u.error) console.log("   ", u.error.message.split("\n").slice(0, 6).join(" / "));
    const tables = (await st.db.q("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('orgs','orders','users')"))[0].n;
    ok("in the build, the empty database gets every table from schema.sql and the record of every migration — then the deploy", !u.error && tables === 3 && st.files.length === 1 && st.db.q("SELECT count(*) n FROM d1_migrations")[0].n === MIGRATIONS.length && st.deployed === 1);
    ok("…with no domain yet, the workers.dev address is on (it is where the owner first signs in) and no hostname is listed", u.result.workersDev === true && /workers_dev = true/.test(st.tomlAtDeploy) && S.readWranglerToml(st.tomlAtDeploy).hosts.length === 0 && /No domain yet/.test(u.text));
    ok("…and asked to, it says what it sees — nothing secret", /What this build sees/.test(u.text) && /running in Cloudflare's build: yes/.test(u.text) && /database "opendecodesk-db" \(id not set\)/.test(u.text));
    // The owner sets the domain up in the admin; the app keeps it in the database.
    st.db._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('site', '{"rootDomain":"MyShop.com","adminSubdomain":"office"}')`);
    st.db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('league-101', 'league', 'League', 't', 't')`);
    u = await up();
    let t = S.readWranglerToml(st.tomlAtDeploy);
    ok("the next build lists no hostname: the app attached the admin's and the shops' itself, and a deploy that lists none leaves them alone", !u.error && t.hosts.length === 0 && st.files.length === 1 && /attached by the app/.test(u.text) && /myshop\.com/.test(u.text));
    ok("…and keeps the workers.dev address on until the admin has been reached on the new domain", u.result.workersDev === true && t.workersDev === true);
    st.db._raw.exec(`UPDATE global_settings SET value = '{"rootDomain":"myshop.com","adminSubdomain":"office","adminHostSeen":true}' WHERE key = 'site'`);
    u = await up();
    ok("once it has, the next build switches the workers.dev address off", !u.error && u.result.workersDev === false && S.readWranglerToml(st.tomlAtDeploy).workersDev === false && /now off/.test(u.text));
    ok("the site setting is read defensively: a damaged one means no domain, never a made-up one", S.parseSiteSetting({ value: "not json" }).rootDomain === "" && S.parseSiteSetting({ value: '{"rootDomain":"https://x.com/y","adminSubdomain":"Bad Label"}' }).rootDomain === "" &&
      S.parseSiteSetting({ value: '{"rootDomain":"x.com","adminSubdomain":"Bad Label"}' }).adminSubdomain === "admin" && S.parseSiteSetting(null).adminHostSeen === false);
    ok("a site installed from the command line never gets the workers.dev address: the installer writes it off", /^workers_dev = true$/m.test(tomlSrc) && S.readWranglerToml(fs.readFileSync(cfgPath, "utf8")).workersDev === false);
  }

  console.log("\n=== When something goes wrong ===");
  {
    let x = await go({ answers: BASE, state: cloud({ loggedIn: false }), config: copy("a.toml") });
    ok("not signed in to Cloudflare: it stops at once and says to run wrangler login", x.error instanceof S.SetupError && /isn't signed in/.test(x.error.message) && /npx wrangler login/.test(x.error.message) && x.st.calls.length === 2 && x.io.asked.length === 0);
    const r2off = copy("r2off.toml");
    x = await go({ answers: BASE, state: cloud({ failOn: "r2 bucket list" }), config: r2off });
    ok("the bucket listing fails for some other reason: it stops before asking anything and points at wrangler's own message", x.error instanceof S.SetupError && /Could not list your R2 buckets/.test(x.error.message) && /simulated failure/.test(x.error.message) &&
      /wrangler's message above says why/.test(x.error.message) && /This run changed nothing/.test(x.error.message) && /docs\/accounts-and-keys\.md/.test(x.error.message) && !/isn't switched on/.test(x.error.message) && x.io.asked.length === 0);
    ok("…and nothing was created or written: no database, no bucket, wrangler.toml untouched", x.st.calls.length === 3 && x.st.dbs.length === 0 && x.st.buckets.length === 0 && !x.st.calls.some(c => /create|execute|deploy/.test(c)) &&
      fs.readFileSync(r2off, "utf8") === shippedToml && x.error.done.length === 1);
    // Modelled on wrangler's output: the banner on stdout, the error (then a log-file line) on stderr. The R2-off lines are
    // as a real run printed them; the several-accounts ones are wrangler's message, not taken from a run.
    const BANNER = "\n ⛅️ wrangler 4.0.0\n───────────────────\nListing buckets...\n";
    const r2Off = () => cloud({ failOn: "r2 bucket list", failWith: { stdout: BANNER,
      stderr: "\nX [ERROR] A request to the Cloudflare API (/accounts/abc/r2/buckets) failed.\n\n  Please enable R2 through the Cloudflare Dashboard. [code: 10042]\n\n  If you think this is a bug, please open an issue.\n\n\nLogs were written to \"wrangler.log\"\n" } });
    const off = r2Off(), offPath = copy("r2real.toml");
    x = await go({ answers: BASE, config: offPath, state: off });
    const offText = x.io.text(), offToml = fs.readFileSync(offPath, "utf8");
    ok("R2 off: it says so, asks whether to install without file storage, and carries on by default", !x.error && x.io.asked[0].id === "withoutStorage" && /\[Y\/n\]/.test(x.io.asked[0].question) &&
      /isn't switched on for this Cloudflare account/.test(offText) && /can't be uploaded until it is on/.test(offText) && off.deployed === 1 && x.result.done.some(d => /file storage was skipped/.test(d)));
    ok("…no bucket is made, the bucket address isn't asked for, and the deploy is given no bucket lines", !off.calls.some(c => /bucket create/.test(c)) && off.buckets.length === 0 && !x.io.asked.some(q => q.id === "r2PublicBase") &&
      !/^\[\[r2_buckets\]\]/m.test(off.tomlAtDeploy) && off.tomlAtDeploy === offToml);
    ok("…the bucket blocks are kept as comments in a marked block, and their names can still be read", offToml.includes(S.STORAGE_OFF_BEGIN) && offToml.includes(S.STORAGE_OFF_END) && (offToml.match(/^# \[\[r2_buckets\]\]/gm) || []).length === 3 &&
      S.readWranglerToml(offToml).storageOff === true && S.readWranglerToml(offToml).buckets.DESIGNS === "opendecodesk-designs" && S.readWranglerToml(offToml).databaseId === UUID);
    ok("…and the to-do list says what is missing and how to add it, instead of asking for the bucket's address", /File storage is off/.test(offText) && /switch on R2 \(Cloudflare dashboard → Storage & databases → R2 → Overview/.test(offText) && !/Make the images bucket/.test(offText));
    off.failOn = null; off.failWith = null;
    const on = await go({ answers: { ...BASE, rootDomain: "" }, config: offPath, state: off }), onToml = fs.readFileSync(offPath, "utf8");
    ok("once R2 is switched on, the next run makes the three buckets, puts the blocks back and deploys with them", !on.error && off.buckets.length === 3 && off.deployed === 2 && (onToml.match(/^\[\[r2_buckets\]\]/gm) || []).length === 3 &&
      !onToml.includes(S.STORAGE_OFF_BEGIN) && off.tomlAtDeploy === onToml && on.io.asked.some(q => q.id === "r2PublicBase") && !on.io.asked.some(q => q.id === "withoutStorage") && /the three bucket blocks are back/.test(on.io.text()));
    const noPath = copy("r2no.toml");
    x = await go({ answers: { ...BASE, withoutStorage: "n" }, config: noPath, state: r2Off() });
    ok("answering no stops there, having changed nothing, and says where R2 is switched on", x.error instanceof S.SetupError && /isn't switched on for this account/.test(x.error.message) && /Storage & databases → R2 → Overview/.test(x.error.message) &&
      /This run changed nothing/.test(x.error.message) && x.io.asked.length === 1 && x.st.calls.length === 3 && fs.readFileSync(noPath, "utf8") === shippedToml);
    x = await go({ answers: BASE, config: copy("r2multi.toml"), state: cloud({ failOn: "r2 bucket list", failWith: {
      stdout: BANNER + "Getting User settings...\nYou are logged in with an OAuth Token.\n┌──────────────┬────────────┐\n│ Account Name │ Account ID │\n├──────────────┼────────────┤\n│ One          │ aaa        │\n│ Two          │ bbb        │\n└──────────────┴────────────┘\n",
      stderr: "X [ERROR] More than one account available but unable to select one in non-interactive mode.\n" } }) });
    ok("several accounts is not blamed on R2: wrangler's line is shown, and the hint names the account id, the token and the connection", /More than one account available/.test(x.error.message) && /wrangler's message above says why/.test(x.error.message) &&
      /CLOUDFLARE_ACCOUNT_ID=<your account id> npm run setup/.test(x.error.message) && /R2 permission/.test(x.error.message) && !/isn't switched on/.test(x.error.message) && x.io.asked.length === 0 && /This run changed nothing/.test(x.error.message));
    x = await go({ answers: BASE, config: copy("jsonerr.toml"), state: cloud({ failOn: "d1 execute", failWith: { stderr: "",
      stdout: JSON.stringify({ error: { text: "A request to the Cloudflare API failed.", notes: [{ text: "Authentication error [code: 10000]" }], kind: "error", name: "APIError", code: 7500, accountTag: "abc" } }, null, 2) } }) });
    ok("an error wrangler reports on stdout, as its --json commands do, is shown with its reason", x.error instanceof S.SetupError && /A request to the Cloudflare API failed/.test(x.error.message) && /Authentication error \[code: 10000\]/.test(x.error.message));
    const one = cloud({ buckets: ["opendecodesk-receipts"] });
    x = await go({ answers: BASE, state: one, config: copy("one.toml") });
    ok("one bucket already there: exactly the two missing ones are created", !x.error && one.deployed === 1 && one.buckets.length === 3 && one.calls.filter(c => /bucket create/.test(c)).length === 2 && !one.calls.some(c => /bucket create opendecodesk-receipts/.test(c)));
    const late = cloud({ lateBucket: "opendecodesk-images" });
    x = await go({ answers: BASE, state: late, config: copy("late.toml") });
    ok("a bucket that appears after the first check is not an error: wrangler's 'already exists' is accepted", !x.error && late.deployed === 1 && late.buckets.length === 3 && late.calls.filter(c => /bucket create/.test(c)).length === 3);
    x = await go({ answers: BASE, state: cloud({ failOn: "--version" }), config: copy("b.toml") });
    ok("no wrangler: it says how to get it", x.error instanceof S.SetupError && /Could not run wrangler/.test(x.error.message) && /npm ci/.test(x.error.message));
    const pm = copy("c.toml");
    x = await go({ answers: BASE, state: cloud({ failOn: "d1 migrations" }), config: pm });
    ok("migrations fail: it stops, shows wrangler's error, and nothing after it runs — no secrets, no deploy", x.error instanceof S.SetupError && /migrations failed/.test(x.error.message) && /simulated failure/.test(x.error.message) &&
      x.st.deployed === 0 && !x.st.calls.some(c => /deploy|secret list|INSERT INTO global_settings/.test(c)));
    ok("…it lists what was already done, and those steps are kept", x.error.done.length === 4 && /database/.test(x.error.done[1]) && /buckets/.test(x.error.done[2]) && S.readWranglerToml(fs.readFileSync(pm, "utf8")).databaseId === UUID);
    x.st.failOn = null;
    const resumed = await go({ answers: { ...BASE, rootDomain: "" }, state: x.st, config: pm });
    ok("running it again carries on from there without repeating anything", !resumed.error && resumed.st.deployed === 1 && resumed.st.dbs.length === 1 && resumed.st.buckets.length === 3 && resumed.st.calls.filter(c => /d1 create/.test(c)).length === 1 &&
      resumed.st.files.length === 1);
    // The tables were made but the run died before the migration record was written.
    const half = cloud(); half.db = await newDb(); half.db._raw.exec(read("schema.sql"));
    x = await go({ answers: BASE, state: half, config: copy("f.toml") });
    ok("a database left half set up (tables, no migration record, no orders) is finished, not refused", !x.error && half.files.length === 1 && half.db.q("SELECT count(*) n FROM d1_migrations")[0].n === MIGRATIONS.length && half.migrateTodo === 0 && /didn't finish last time/.test(x.io.text()));
    const used = cloud(); used.db = await newDb(); used.db._raw.exec(read("schema.sql"));
    used.db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t'); INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('A-1','acme','C','c@x.com','2026-01-01T00:00:00Z');`);
    x = await go({ answers: BASE, state: used, config: copy("g.toml") });
    ok("a database WITH orders and no migration record is never guessed at: it stops and points to the docs", x.error instanceof S.SetupError && /orders in it but no record of which migrations/.test(x.error.message) && /docs\/operations\.md/.test(x.error.message) &&
      used.files.length === 0 && used.migrated === 0 && used.deployed === 0 && /A database without a migration record/.test(read("docs/operations.md")));
    const older = cloud(); older.db = await newDb(); older.db._raw.exec(read("testlib/schema-pre-0006.sql"));
    older.db._raw.exec(S.migrationRecordSql(MIGRATIONS.filter(m => m < "0006")));
    x = await go({ answers: BASE, state: older, config: copy("h.toml") });
    ok("an existing install that is behind gets exactly the migrations it's missing, and its tables are not rebuilt", !x.error && older.files.length === 0 && older.migrateTodo === MIGRATIONS.filter(m => m >= "0006").length &&
      older.db.q("SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'").length === 1);
    const st = cloud({ failOn: "deploy" });
    const realExec = st.exec; let seenPath = "";
    st.exec = (f, a) => { const i = a.indexOf("--secrets-file"); if (i >= 0) seenPath = a[i + 1]; return realExec(f, a); };
    x = await go({ answers: BASE, state: st, config: copy("d.toml") });
    ok("the deploy fails: the secrets file is still deleted, and no passphrase is shown for a Worker that doesn't have it", x.error instanceof S.SetupError && /deploy failed/.test(x.error.message) && !!seenPath && !fs.existsSync(seenPath) &&
      !/Shown ONCE/.test(x.io.text()) && !/([a-z2-9]{4}-){5}[a-z2-9]{4}/.test(x.io.text() + x.error.message));
    ok("…with a hint for the most likely cause (a DNS record already on the hostname)", /already has a DNS record/.test(x.error.message));
    x = await go({ answers: { ...BASE, rootDomain: "not a domain" }, config: copy("e.toml") });
    ok("an answer that never becomes valid stops the run instead of looping forever", x.error instanceof S.SetupError && /No valid answer/.test(x.error.message) && x.io.asked.filter(q => q.id === "rootDomain").length === 5);
    x = await go({ answers: BASE, config: path.join(tmp, "missing.toml") });
    ok("no wrangler.toml: it says to run from the repository folder", x.error instanceof S.SetupError && /Can't find/.test(x.error.message));
  }

  console.log("\n=== It only sets things the code reads ===");
  const code = fs.readdirSync(path.join(__dirname, "functions/_lib")).map(f => read("functions/_lib/" + f)).join("\n") + fs.readdirSync(path.join(__dirname, "functions/api")).map(f => read("functions/api/" + f)).join("\n") + read("src/worker.js");
  const setNames = [...new Set([...S.SECRET_NAMES, "ROOT_DOMAIN", "ADMIN_SUBDOMAIN", "TIMEZONE", "R2_PUBLIC_BASE", "CF_WORKER_NAME",
    ...S.INTEGRATIONS.flatMap(i => [...(i.fields || []), ...Object.values((i.choice || {}).options || {}).flat(), ...(i.after || [])]).map(f => f.name)])];
  const unread = setNames.filter(n => !new RegExp("env\\." + n + "\\b").test(code));
  if (unread.length) console.log("   not read by the code:", unread.join(", "));
  ok("every variable and secret the installer can set is one the code reads (env.NAME)", setNames.length >= 20 && unread.length === 0);
  ok("the names of the database binding and the buckets it expects are the ones in wrangler.toml and the code", /binding = "DB"/.test(tomlSrc) && ["IMAGES", "RECEIPTS", "DESIGNS"].every(b => new RegExp('binding = "' + b + '"').test(tomlSrc) && new RegExp("env\\." + b + "\\b").test(code)));

  console.log("\n=== Wiring ===");
  const pkg = JSON.parse(read("package.json"));
  ok("npm run setup runs it, and it added no dependency (wrangler is pinned to an exact version, for npm ci)", pkg.scripts.setup === "node scripts/setup.mjs" && Object.keys(pkg.dependencies).join() === "jsdom" &&
    Object.keys(pkg.devDependencies).sort().join() === "pdfjs-dist,sql.js,wrangler" && /^\d+\.\d+\.\d+$/.test(pkg.devDependencies.wrangler));
  ok("the old secrets script is gone and nothing points at it", !fs.existsSync(path.join(__dirname, "scripts/set-worker-secrets.py")) &&
    ["wrangler.toml", "README.md", "test105_locale.js", "package.json"].every(f => !/set-worker-secrets/.test(read(f))));
  ok("wrangler.toml as shipped still has only placeholders (the installer writes the real values on your copy)", /REPLACE-WITH-YOUR-D1-DATABASE-ID/.test(tomlSrc) && !tomlSrc.includes(S.VARS_BEGIN) && !/^routes\s*=/m.test(tomlSrc));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error("test108 crashed:", err); console.log("test108 crashed: false"); process.exit(1); });
