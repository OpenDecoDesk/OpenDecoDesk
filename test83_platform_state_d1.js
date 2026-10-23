const fs = require("fs");
const { makePlatformDb, platformGlobals, sha256Hex } = require("./testlib/platform-db");
Object.assign(global, platformGlobals());

// Platform state lives in D1:
// admin sessions (admin_sessions), the catalog version, the TOTP secret and replay counter
// (global_settings). This exercises the real db.js functions and the real adminAuth.js
// against real SQLite, plus migration 0043 against the real migration chain.

const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");

(async () => {
  global.rateLimitCheck = async () => ({ blocked: false });
  global.rateLimitHit = async () => {};
  global.rateLimitCheckGlobal = async () => ({ blocked: false }); global.rateLimitHitGlobal = async () => {};
  global.rateLimitResponse = () => new Response("", { status: 429 });
  const auth = new Function(strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/access.js")) + "\n" +
    strip(read("functions/_lib/adminAuth.js")) +
    "\nreturn { issueSession, revokeSession, getActiveSecret, saveTotpSecret, clearTotpSecret, requireAdmin };")();

  console.log("=== Migration 0043 + schema.sql create admin_sessions ===");
  {
    const { createD1 } = require("./testlib/d1-shim");
    const d = await createD1();
    d.execFile(read("migrations/0043_admin_sessions.sql"));
    const cols = d.q("SELECT name FROM pragma_table_info('admin_sessions') ORDER BY name").map(c => c.name);
    console.log("Migration creates admin_sessions(expiresAt, tokenHash):", cols.join(",") === "expiresAt,tokenHash");
    console.log("schema.sql defines it too:", /CREATE TABLE IF NOT EXISTS admin_sessions/.test(read("schema.sql")));
  }

  console.log("\n=== Sessions: issue, validate, revoke, sweep ===");
  {
    const DB = await makePlatformDb();
    const env = { DB };
    const { token, expires } = await auth.issueSession(env);
    console.log("Token has the expected shape:", /^sess_[0-9a-f]{48}$/.test(token));
    console.log("Expiry is about 24h out:", Math.abs(new Date(expires) - (Date.now() + 86400e3)) < 5000);
    const row = DB.q("SELECT tokenHash FROM admin_sessions")[0];
    console.log("Only the SHA-256 of the token is stored:", row.tokenHash === await sha256Hex(token) && !JSON.stringify(row).includes(token));
    await auth.revokeSession(env, token);
    console.log("Revoking removes it:", DB.q("SELECT count(*) AS c FROM admin_sessions")[0].c === 0);
    await auth.revokeSession(env, "not-a-token"); // must not throw
    console.log("Revoking junk is a harmless no-op:", true);

    await DB.prepare("INSERT INTO admin_sessions (tokenHash, expiresAt) VALUES ('old1', ?), ('old2', ?)")
      .bind(new Date(Date.now() - 86400e3).toISOString(), new Date(Date.now() - 1000).toISOString()).run();
    const live = await auth.issueSession(env);
    const left = DB.q("SELECT tokenHash FROM admin_sessions").map(r => r.tokenHash);
    console.log("Issuing a session sweeps expired rows:", left.length === 1 && left[0] === await sha256Hex(live.token));
  }

  console.log("\n=== TOTP replay counter is claimed atomically and only moves forward ===");
  {
    const DB = await makePlatformDb();
    console.log("first use of a counter is accepted:", (await claimTotpCounter(DB, 1000)) === true);
    console.log("the same counter again is a replay:", (await claimTotpCounter(DB, 1000)) === false);
    console.log("an older counter is refused:", (await claimTotpCounter(DB, 999)) === false);
    console.log("a newer counter is accepted:", (await claimTotpCounter(DB, 1001)) === true);
    console.log("stored value is the latest:", (await getSettingRaw(DB, "totpLastCounter")) === "1001");
    const [a, b] = await Promise.all([claimTotpCounter(DB, 2000), claimTotpCounter(DB, 2000)]);
    console.log("two simultaneous claims of one counter: exactly one wins:", [a, b].filter(Boolean).length === 1);
  }

  console.log("\n=== TOTP secret: D1 first, then the env var; disable turns 2FA off ===");
  {
    const DB = await makePlatformDb();
    console.log("nothing configured -> empty (2FA off):", (await auth.getActiveSecret({ DB })) === "");
    console.log("env var secret still honoured:", (await auth.getActiveSecret({ DB, TOTP_SECRET: "ENVSECRET" })) === "ENVSECRET");
    await auth.saveTotpSecret({ DB }, "STORED");
    console.log("a D1 secret wins over the env var:", (await auth.getActiveSecret({ DB, TOTP_SECRET: "ENVSECRET" })) === "STORED");

    await auth.clearTotpSecret({ DB });
    console.log("disable removes the D1 secret:", (await getSettingRaw(DB, "totpSecret")) === null);
    console.log("2FA is really off afterwards:", (await auth.getActiveSecret({ DB })) === "");
  }

  console.log("\n=== Catalog version: Publish counts up atomically ===");
  {
    const DB = await makePlatformDb();
    console.log("no version yet reads as 0:", (await getCatalogCacheState(DB)).version === "0");
    console.log("first publish -> 1:", (await bumpCatalogVersion(DB)) === 1);
    console.log("second publish -> 2:", (await bumpCatalogVersion(DB)) === 2);
    const results = await Promise.all([bumpCatalogVersion(DB), bumpCatalogVersion(DB), bumpCatalogVersion(DB)]);
    console.log("three parallel publishes land on 5 (none lost):", (await getSettingRaw(DB, "catalogVersion")) === "5" && results.length === 3);
    const st = await getCatalogCacheState(DB);
    console.log("state read returns the version and a stable namespace:", st.version === "5" && /^[0-9a-f]{16}$/.test(st.ns) && (await getCatalogCacheState(DB)).ns === st.ns);
  }

  console.log("\n=== No KV namespace in the platform ===");
  {
    const files = ["functions/_lib/adminAuth.js", "functions/_lib/catalogCache.js", "functions/api/admin-session.js",
      "functions/api/admin-2fa.js", "functions/api/orders.js"];
    console.log("no function code references a KV binding:", files.every(f => !/CATALOG_META/.test(read(f))));
    console.log("wrangler.toml declares no KV namespace:", !/kv_namespaces/.test(read("wrangler.toml")));
  }
})();
