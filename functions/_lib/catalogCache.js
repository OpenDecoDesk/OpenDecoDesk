/**
 * Shared catalog-data cache. Every handler that needs the catalog calls
 * getCatalogData(env): it reads the live org/product catalog from D1 and
 * caches it at the edge, so a new org or a price change made through the
 * admin panel goes live without a code push or redeploy.
 *
 * ---- HOW INVALIDATION WORKS ----
 * The cache key embeds the current catalog version, read from D1
 * (global_settings.catalogVersion, e.g. .../catalog-data/<ns>/v7). Clicking
 * "Publish" in the admin panel bumps that version, so every request after
 * that computes a NEW cache key — the old entry just becomes unreachable
 * rather than needing an explicit purge.
 *
 * ---- NAMESPACE ----
 * Two environments on the same Cloudflare zone share the Cache API, so keys
 * also carry a random per-database id (global_settings.cacheNs, created on
 * first use). Each environment has its own D1, hence its own namespace.
 *
 * ---- RESILIENCE ----
 * On a D1 read failure the last successfully-fetched catalog for this colo
 * (Cache API) is served. Only throws if there is nothing to fall back to yet.
 */

import { getPublicCatalogData, getCatalogCacheState } from "./db.js";

const CACHE_TTL_SECONDS = 300;
const CACHE_BASE = "https://catalog-cache.internal/catalog-data/";

// Module-level memory cache for {version, ns}. The version only changes when
// an admin clicks Publish, so holding it for 30 seconds keeps this to about
// one D1 read per isolate per half-minute. A 30s stale window is fine — the
// Cache API's own 5-minute TTL is the actual freshness bound after a Publish.
let _state = { v: null, ns: null, at: 0 };
const MEM_STATE_TTL_MS = 30_000;

async function getCacheState_(env){
  if(!env.DB) return { version: "0", ns: "no-db" };
  const now = Date.now();
  if(_state.v !== null && now - _state.at < MEM_STATE_TTL_MS){
    return { version: _state.v, ns: _state.ns };
  }
  try{
    const { version, ns } = await getCatalogCacheState(env.DB);
    _state = { v: version, ns, at: now };
    return { version, ns };
  }catch{
    if(_state.v !== null) return { version: _state.v, ns: _state.ns };
    // D1 unavailable and nothing remembered: a one-off random namespace, so this request can
    // never read another environment's cache (it just misses and goes to D1). Not memoized.
    return { version: "0", ns: "db-unavailable-" + crypto.randomUUID() };
  }
}

// Called by the publish action so the new version is visible immediately
// within this Worker instance without waiting for the TTL.
export function invalidateCatalogVersionCache(){
  _state = { v: null, ns: _state.ns, at: 0 };
}

// Test hook.
export function _resetCatalogCacheState(){ _state = { v: null, ns: null, at: 0 }; }

function versionedCacheKey(ns, version){
  return CACHE_BASE + ns + "/v" + encodeURIComponent(version);
}
function staleFallbackKey(ns){
  return CACHE_BASE + ns + "/last-known-good";
}

async function fetchFromD1_(env){
  if(!env.DB){
    throw new Error("Server misconfigured — D1 binding (DB) not set.");
  }
  const data = await getPublicCatalogData(env.DB);
  if(!data.subdomainMap || !data.orgs){
    throw new Error("D1 catalog query: response missing subdomainMap or orgs");
  }
  return data;
}

export async function getCatalogData(env){
  const { version, ns } = await getCacheState_(env);

  const cache = caches.default;
  const key = versionedCacheKey(ns, version);
  const cached = await cache.match(key);
  if(cached){
    return await cached.json();
  }

  try{
    const data = await fetchFromD1_(env);
    const response = new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + CACHE_TTL_SECONDS }
    });
    await cache.put(key, response.clone());
    await cache.put(staleFallbackKey(ns), response.clone());
    return data;
  }catch(err){
    const stale = await cache.match(staleFallbackKey(ns));
    if(stale){
      return await stale.json();
    }
    throw err;
  }
}
