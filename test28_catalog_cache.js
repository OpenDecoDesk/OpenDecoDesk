const fs = require("fs");
const { makePlatformDb, platformGlobals, brokenDb } = require("./testlib/platform-db");
Object.assign(global, platformGlobals());

// Loads the REAL functions/_lib/catalogCache.js (every other test file mocks
// getCatalogData() entirely — this is the one place its actual
// implementation, including the fallback, is exercised).
// The catalog version and per-environment cache namespace live in D1
// (global_settings), exercised here against a real SQLite database. The
// catalog query itself (getPublicCatalogData) is stripped and replaced with a
// global mock so the test can control what D1 "returns".
let src = fs.readFileSync(__dirname + "/functions/_lib/catalogCache.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function")
  .replace(/export function/g, "function");
eval(src);

function makeCachesMock(){
  const store = new Map();
  global.caches = {
    default: {
      async match(key){
        const k = typeof key === "string" ? key : key.url;
        const hit = store.get(k);
        return hit ? hit.clone() : undefined;
      },
      async put(key, response){
        const k = typeof key === "string" ? key : key.url;
        store.set(k, response);
      }
    }
  };
  return store;
}

(async () => {
  console.log("=== Happy path: fetches from D1 and caches in the Cache API ===");
  {
    const store = makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    global.getPublicCatalogData = async () => ({subdomainMap:{x:"org-x"}, orgs:{}});
    const data = await getCatalogData({ DB });
    console.log("Returns the fetched data:", data.subdomainMap.x === "org-x");
    console.log("Stored a versioned entry and a last-known-good entry:", store.size === 2);
    console.log("A cache namespace was created in D1 on first use:", /^[0-9a-f]{16}$/.test(DB.q("SELECT value FROM global_settings WHERE key='cacheNs'")[0].value));
  }

  console.log("\n=== Cache API hit: a cached versioned response is served without calling D1 again ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let d1Calls = 0;
    global.getPublicCatalogData = async () => { d1Calls++; return {subdomainMap:{x:"org-x"}, orgs:{}}; };
    const env = { DB };
    await getCatalogData(env);
    await getCatalogData(env);
    console.log("D1 queried only once (second call served from Cache API):", d1Calls === 1);
  }

  console.log("\n=== Publishing a new version computes a fresh cache key (old entry becomes unreachable) ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let d1Calls = 0;
    global.getPublicCatalogData = async () => { d1Calls++; return {subdomainMap:{x:"org-x-v"+d1Calls}, orgs:{}}; };
    const env = { DB };
    const first = await getCatalogData(env);
    const v = await bumpCatalogVersion(DB); // what the real publish action does
    invalidateCatalogVersionCache();
    const second = await getCatalogData(env);
    console.log("First fetch got v1 data:", first.subdomainMap.x === "org-x-v1");
    console.log("Publish bumps the version in D1 (1):", v === 1);
    console.log("Version bump triggers a real second D1 query, not a stale hit:", second.subdomainMap.x === "org-x-v2");
    console.log("D1 called twice (once per version):", d1Calls === 2);
    console.log("A second Publish counts up (2), atomically:", (await bumpCatalogVersion(DB)) === 2);
  }

  console.log("\n=== The version is held in memory for 30 s (one state read per isolate, not per request) ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    global.getPublicCatalogData = async () => ({subdomainMap:{x:"org-x"}, orgs:{}});
    let stateReads = 0;
    const counting = { prepare: (sql) => { if(/cacheNs/.test(sql) && /SELECT/.test(sql)) stateReads++; return DB.prepare(sql); } };
    const env = { DB: counting };
    await getCatalogData(env); await getCatalogData(env); await getCatalogData(env);
    console.log("Three requests -> one state lookup (plus none after creation):", stateReads <= 2);
  }

  console.log("\n=== D1 down, but the Cache API stale-fallback entry is still there ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let succeed = true;
    global.getPublicCatalogData = async () => {
      if(succeed) return {subdomainMap:{x:"org-x"}, orgs:{}};
      throw new Error("D1 down");
    };
    const env = { DB };
    await getCatalogData(env); // seeds the Cache API
    await bumpCatalogVersion(DB); // force a cache miss on the next call
    invalidateCatalogVersionCache();
    succeed = false;
    const data = await getCatalogData(env);
    console.log("Served from the Cache API stale-fallback despite D1 being down:", data.subdomainMap.x === "org-x");
  }

  console.log("\n=== D1 down AND no Cache API entry -> nothing to fall back to, throws ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    global.getPublicCatalogData = async () => { throw new Error("D1 unreachable"); };
    let threw = false;
    try{ await getCatalogData({ DB }); }catch(e){ threw = true; }
    console.log("Throws when there's truly nothing to fall back to:", threw);
  }

  console.log("\n=== State table unreadable (broken DB) but the catalog query works: request still succeeds ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    global.getPublicCatalogData = async () => ({subdomainMap:{x:"org-x"}, orgs:{}});
    const data = await getCatalogData({ DB: brokenDb("D1 down") });
    console.log("Still served (uses a one-off namespace, never another env's cache):", data.subdomainMap.x === "org-x");
  }

  console.log("\n=== Missing DB binding -> throws immediately (misconfigured server) ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    global.getPublicCatalogData = async () => ({subdomainMap:{}, orgs:{}});
    let threw = false;
    try{ await getCatalogData({}); }catch(e){ threw = true; }
    console.log("Throws with missing DB binding:", threw);
  }

  console.log("\n=== Cache keys are namespaced per environment (two environments can share one zone's Cache API) ===");
  {
    const store = makeCachesMock();
    const prodDb = await makePlatformDb(), stageDb = await makePlatformDb();
    await setSettingRaw(prodDb, "catalogVersion", "7"); await setSettingRaw(stageDb, "catalogVersion", "7"); // SAME version number
    _resetCatalogCacheState();
    global.getPublicCatalogData = async () => ({ subdomainMap: { prod: "org-prod" }, orgs: {} });
    await getCatalogData({ DB: prodDb });
    _resetCatalogCacheState();
    global.getPublicCatalogData = async () => ({ subdomainMap: { teststaging: "org-stage" }, orgs: {} });
    const stageData = await getCatalogData({ DB: stageDb });
    console.log("A second environment with the same version number gets ITS OWN catalog, not the first's:", !!stageData.subdomainMap.teststaging && !stageData.subdomainMap.prod);
    const prodNs = prodDb.q("SELECT value FROM global_settings WHERE key='cacheNs'")[0].value;
    const stageNs = stageDb.q("SELECT value FROM global_settings WHERE key='cacheNs'")[0].value;
    console.log("Each environment stored its own namespace id:", !!prodNs && !!stageNs && prodNs !== stageNs);
    const keys = [...store.keys()];
    console.log("No shared, un-namespaced keys left in the cache:", keys.every(k => k.includes(prodNs) || k.includes(stageNs)));
    // D1 outage in the second environment: its fallback must be its own last-good, never the first's.
    _resetCatalogCacheState();
    global.getPublicCatalogData = async () => { throw new Error("D1 down"); };
    await setSettingRaw(stageDb, "catalogVersion", "8"); // force a cache miss
    const fb = await getCatalogData({ DB: stageDb });
    console.log("An outage there falls back to its own last-good copy:", !!fb.subdomainMap.teststaging && !fb.subdomainMap.prod);
    _resetCatalogCacheState();
  }
})();
