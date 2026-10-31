/**
 * Which host is this request for? Shared by every API handler.
 *
 * One install serves one root domain: the admin panel at `admin.<root>` and each shop at
 * `<its subdomain>.<root>`. The root domain and the admin label come from the environment:
 *
 *   ROOT_DOMAIN      e.g. "myshop.com" (no "www."). REQUIRED in a real install.
 *   ADMIN_SUBDOMAIN  the admin label; default "admin". Several may be given, comma-separated.
 *
 * The subdomain -> shop map lives in the database (the `orgs` table) and is passed in by the
 * caller (getCatalogData(env).subdomainMap), so a new shop goes live without a deploy.
 */

// Used only when ROOT_DOMAIN isn't set (tests, a first run before configuration). A reserved
// documentation domain, so an unconfigured install serves no real hostname by accident.
export const DEFAULT_ROOT_DOMAIN = "example.com";

// Web addresses a shop can't have: the site's own (www, the images host, the default admin label) and ones a mail or
// API host would want. The admin label(s) actually configured (ADMIN_SUBDOMAIN) are refused too — see adminSubdomains.
// One list, for New shop (catalogValidation.js) and for attaching a shop's hostname (customDomain.js).
export const RESERVED_SUBDOMAINS = ["www", "api", "images", "mail", "admin", "all"];

export function rootDomain(env){
  return String((env && env.ROOT_DOMAIN) || DEFAULT_ROOT_DOMAIN).trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export function adminSubdomains(env){
  const list = String((env && env.ADMIN_SUBDOMAIN) || "admin").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ["admin"];
}

/**
 * Given a request's hostname, the current subdomain -> orgId map and the environment, returns:
 *   { kind: "locked", orgId }   — a recognized shop subdomain
 *   { kind: "admin" }           — the admin subdomain
 *   { kind: "root" }            — the root domain itself (or www.)
 *   { kind: "unknown" }         — anything else (typo, probe, wildcard catch-all) — refused, never
 *                                 quietly treated as the root.
 */
export function classifyHost(hostname, subdomainMap, env){
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const apex = rootDomain(env);
  if(host === apex || host === "www." + apex){
    return { kind: "root" };
  }
  // Treat localhost as "root" for local development — only reachable on the developer's machine.
  if(host === "localhost" || host === "127.0.0.1"){
    return { kind: "root" };
  }
  // Admin / shop subdomains must be EXACTLY "<label>.<root domain>". Looking only at the first label
  // would treat "admin.<anything>" — a preview URL for a branch named "admin", say — as the admin host.
  const suffix = "." + apex;
  if(host.endsWith(suffix)){
    const label = host.slice(0, -suffix.length);
    if(label && !label.includes(".")){
      if(adminSubdomains(env).includes(label)) return { kind: "admin" };
      if(subdomainMap && Object.prototype.hasOwnProperty.call(subdomainMap, label) && subdomainMap[label]){
        return { kind: "locked", orgId: subdomainMap[label] };
      }
    }
  }
  // A site installed with the Deploy to Cloudflare button has no domain at first: its admin answers
  // on the Worker's own <worker>.<account>.workers.dev address — the only workers.dev host that can
  // reach this Worker, and only while it is switched on. Once the domain is connected (Global settings →
  // Your domain) and someone has signed in on admin.<domain>, the app switches it off
  // (functions/api/admin-session.js) and so does every later build (scripts/setup.mjs); the
  // command-line installer never switches it on.
  if(/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(host)){
    return { kind: "admin" };
  }
  return { kind: "unknown" };
}
