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

// ---- The desktop edition (desktop/) ---------------------------------------------------------------
// The same code run on one computer by the desktop program: the Worker inside Miniflare, the
// database and files on that computer, the window on http://localhost:<port>. EDITION=desktop
// (set only by desktop/server.js) makes localhost the admin panel, and keeps the parts that need the
// internet switched off (FEATURES in db.js): the storefront and emailed design approval for good,
// and carrier shipping until a Shippo key is set in the program (Global settings → Carrier
// shipping). A cloud install never sets EDITION and behaves exactly as before.
export function desktopLockedFeatures(env){
  return env && env.SHIPPO_API_KEY ? ["storefront", "designVerification"] : ["storefront", "shipping", "designVerification"];
}
export function isDesktopEdition(env){
  return String((env && env.EDITION) || "").trim().toLowerCase() === "desktop";
}
// Supplier connections (Vendor integrations: PromoStandards product data, ordering, shipment
// tracking) need the internet, so the desktop version has them only once the owner turns them on in
// the program (Global settings → Supplier connections), which then sets DESKTOP_SUPPLIERS=on.
export function desktopSuppliersOn(env){
  return isDesktopEdition(env) && String((env && env.DESKTOP_SUPPLIERS) || "") === "on";
}
// Email: the desktop version sends only through the owner's own mailbox, once it is set up in the
// program (Global settings → Email, desktop/mailer.js), which then sets DESKTOP_EMAIL=on.
export function desktopEmailOn(env){
  return isDesktopEdition(env) && String((env && env.DESKTOP_EMAIL) || "") === "on";
}

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
 *   { kind: "admin" }           — the admin subdomain ({ kind: "admin", desktop: true } in the
 *                                 desktop edition, where it is localhost)
 *   { kind: "root" }            — the root domain itself (or www.)
 *   { kind: "unknown" }         — anything else (typo, probe, wildcard catch-all) — refused, never
 *                                 quietly treated as the root.
 */
export function classifyHost(hostname, subdomainMap, env){
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  // Desktop: the program's own window is the admin, and nothing else is anything. Refusing every
  // other name matters here: a web page the person visits could point a hostname of its own at
  // 127.0.0.1 (DNS rebinding) — its requests then arrive with that name and are refused.
  if(isDesktopEdition(env)){
    return host === "localhost" || host === "127.0.0.1" ? { kind: "admin", desktop: true } : { kind: "unknown" };
  }
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
  return { kind: "unknown" };
}
