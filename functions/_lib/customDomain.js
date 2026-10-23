/**
 * TWO MODES (chosen by which env var is set; the Worker mode wins when both are):
 *
 *  Worker mode  (CF_WORKER_NAME) — the site runs as a Cloudflare Worker with static assets. Attaches
 *     <subdomain>.example.com as a Workers Custom Domain (PUT /accounts/:id/workers/domains).
 *     Cloudflare creates the proxied DNS record and the certificate itself, so there is no separate
 *     DNS step. A host that already reaches this Worker through a ROUTE (a route placed in front of an
 *     existing DNS record) is reported as set up and left alone. A hostname that already has some other
 *     DNS record is refused: move it deliberately, it isn't overwritten.
 *  Pages mode   (CF_PAGES_PROJECT) — for a site deployed as a Cloudflare Pages project, below.
 *
 * Pages mode: adds an org's storefront subdomain (<subdomain>.example.com) to this Cloudflare Pages
 * project, the same thing as Workers & Pages → the project → Custom domains → Set up a domain:
 *   1. a proxied CNAME <subdomain> → <project>.pages.dev in the example.com zone
 *      (adding a Pages domain through the API doesn't create the DNS record for you), then
 *   2. the Pages custom domain itself, after which Cloudflare validates it and issues the
 *      certificate (status "pending" → "active", usually a few minutes).
 * Idempotent: an existing matching record/domain is reused, and a domain stuck in "error" gets
 * its validation retried. An existing DNS record pointing somewhere else is never overwritten.
 *
 * Needs four env vars (off until all are set):
 *   CF_API_TOKEN      (encrypted) — Pages mode: Account: Cloudflare Pages Edit + Zone: DNS Edit.
 *                     Worker mode: Account → Workers Scripts: Edit, Zone → Workers Routes: Edit, Zone → DNS: Read
 *                     (Workers Routes: Read alone is enough to SEE the status of hosts served by a route).
 *   CF_ACCOUNT_ID, CF_ZONE_ID (plain)
 *   CF_PAGES_PROJECT (Pages mode, e.g. "opendecodesk")  or  CF_WORKER_NAME (Worker mode, e.g. this Worker's name)
 */

import { rootDomain, adminSubdomains, RESERVED_SUBDOMAINS } from "./hostConfig.js";

const API = "https://api.cloudflare.com/client/v4";
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function customDomainConfig(env) {
  const base = { token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID, zoneId: env.CF_ZONE_ID };
  if (!base.token || !base.accountId || !base.zoneId) return null;
  if (env.CF_WORKER_NAME) return { ...base, mode: "worker", service: env.CF_WORKER_NAME };
  if (env.CF_PAGES_PROJECT) return { ...base, mode: "pages", project: env.CF_PAGES_PROJECT };
  return null;
}

export function orgHostname(subdomain, env) {
  const label = String(subdomain || "").trim().toLowerCase();
  if (!LABEL_RE.test(label)) throw domainError_(`"${subdomain}" isn't a valid subdomain (letters, numbers and inner hyphens only).`);
  if (RESERVED_SUBDOMAINS.includes(label) || adminSubdomains(env).includes(label)) throw domainError_(`"${label}" is reserved and can't be used for a shop.`);
  return label + "." + rootDomain(env);
}

function domainError_(message) { const e = new Error(message); e.userFacing = true; return e; }

async function cf_(cfg, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.success !== false, data };
}
const cfMessage_ = (r) => ((r.data && r.data.errors) || []).map(e => e.message).filter(Boolean).join("; ") || ("HTTP " + r.status);
// A refused request almost always means the API token lacks a permission; say which ones Worker mode needs.
const WORKER_PERMISSION_HINT = " — the CF_API_TOKEN needs Account → Workers Scripts: Edit, Zone → Workers Routes: Edit and Zone → DNS: Read (edit the token in Cloudflare → My Profile → API Tokens; its value doesn't change).";
const authHint_ = (r) => (r.status === 401 || r.status === 403) ? WORKER_PERMISSION_HINT : "";

function summarize_(d) {
  return {
    status: d.status || "unknown",
    validation: (d.validation_data && d.validation_data.status) || "",
    error: (d.validation_data && d.validation_data.error_message) || (d.verification_data && d.verification_data.error_message) || "",
  };
}

// ---- Worker mode ------------------------------------------------------------------------------
async function workerDomain_(cfg, hostname) {
  const r = await cf_(cfg, "GET", `/accounts/${cfg.accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`);
  if (!r.ok) throw domainError_("Cloudflare custom-domain lookup failed: " + cfMessage_(r) + authHint_(r));
  const list = Array.isArray(r.data.result) ? r.data.result : [];
  return list.find(d => String(d.hostname).toLowerCase() === hostname) || null;
}

// A hostname can reach this Worker two ways: a Workers Custom Domain (what a NEW shop gets) or a
// Worker route in front of an existing DNS record (e.g. one listed under `routes` in wrangler.toml). Reports the
// route that covers the host for this Worker, if any: an exact "host/*" or a "*.zone/*" wildcard.
async function workerRoute_(cfg, hostname) {
  const r = await cf_(cfg, "GET", `/zones/${cfg.zoneId}/workers/routes`);
  if (!r.ok) throw domainError_("Cloudflare Worker-routes lookup failed: " + cfMessage_(r) + authHint_(r));
  const routes = Array.isArray(r.data.result) ? r.data.result : [];
  return routes.find(x => {
    if (x.script !== cfg.service) return false;
    const host = String(x.pattern || "").split("/")[0].toLowerCase();
    return host === hostname || (host.startsWith("*.") && hostname.endsWith(host.slice(1)));
  }) || null;
}

// Looks in both places. Missing API permission on one lookup doesn't hide a hit from the other;
// only when NOTHING is found and a lookup failed is that failure reported.
async function findWorkerHost_(cfg, hostname) {
  let error = null, domain = null, route = null;
  try { domain = await workerDomain_(cfg, hostname); } catch (e) { error = error || e; }
  try { route = await workerRoute_(cfg, hostname); } catch (e) { error = error || e; }
  if (!domain && !route && error) throw error;
  return { domain, route };
}

async function getWorkerDomainStatus_(cfg, hostname) {
  const { domain, route } = await findWorkerHost_(cfg, hostname);
  if (domain && domain.service && domain.service !== cfg.service && !route) {
    return { configured: true, hostname, exists: true, status: "error", validation: "", error: `Attached to a different Worker (${domain.service}).` };
  }
  if (!domain && !route) return { configured: true, hostname, exists: false };
  // A Workers Custom Domain has no pending/active field of its own: once attached, Cloudflare
  // issues the certificate within a few minutes. A route needs nothing more.
  return { configured: true, hostname, exists: true, status: "active", validation: "", error: "",
    via: domain && domain.service === cfg.service ? "custom domain" : "Worker route" };
}

async function ensureWorkerDomain_(cfg, hostname) {
  const steps = [];
  const { domain: current, route } = await findWorkerHost_(cfg, hostname);
  if (route || (current && current.service === cfg.service)) {
    return { configured: true, hostname, exists: true,
      steps: [route && !(current && current.service === cfg.service) ? "already served by a Worker route" : "custom domain already added"],
      status: "active", validation: "", error: "" };
  }
  if (!current) {
    // Refuse to take over a hostname that already has a DNS record.
    const list = await cf_(cfg, "GET", `/zones/${cfg.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
    if (!list.ok) throw domainError_("Cloudflare DNS lookup failed: " + cfMessage_(list));
    const existing = list.data.result || [];
    if (existing.length) {
      throw domainError_(`${hostname} already has a DNS record (${existing.map(rec => rec.type + " → " + rec.content).join(", ")}). Remove it (and any Pages custom domain) in Cloudflare first — it isn't overwritten automatically.`);
    }
  }
  const put = await cf_(cfg, "PUT", `/accounts/${cfg.accountId}/workers/domains`,
    { hostname, service: cfg.service, environment: "production", zone_id: cfg.zoneId });
  if (!put.ok) throw domainError_("Cloudflare couldn't add the custom domain: " + cfMessage_(put) + authHint_(put));
  steps.push(current ? `custom domain moved to ${cfg.service}` : "custom domain added (DNS record and certificate are created by Cloudflare)");
  return { configured: true, hostname, exists: true, steps, status: "active", validation: "", error: "" };
}

// Current state of the org's domain on the Pages project (or Worker), without changing anything.
export async function getOrgDomainStatus(env, subdomain) {
  const cfg = customDomainConfig(env);
  if (!cfg) return { configured: false };
  const hostname = orgHostname(subdomain, env);
  if (cfg.mode === "worker") return getWorkerDomainStatus_(cfg, hostname);
  const r = await cf_(cfg, "GET", `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(cfg.project)}/domains/${hostname}`);
  if (r.status === 404) return { configured: true, hostname, exists: false };
  if (!r.ok) throw domainError_("Cloudflare: " + cfMessage_(r));
  return { configured: true, hostname, exists: true, ...summarize_(r.data.result || {}) };
}

export async function ensureOrgDomain(env, subdomain) {
  const cfg = customDomainConfig(env);
  if (!cfg) return { configured: false };
  const hostname = orgHostname(subdomain, env);
  if (cfg.mode === "worker") return ensureWorkerDomain_(cfg, hostname);
  const target = cfg.project + ".pages.dev";
  const steps = [];

  // 1. DNS: reuse a matching CNAME, create one if nothing's there, refuse to clobber anything else.
  const list = await cf_(cfg, "GET", `/zones/${cfg.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  if (!list.ok) throw domainError_("Cloudflare DNS lookup failed: " + cfMessage_(list));
  const existing = list.data.result || [];
  const match = existing.find(rec => rec.type === "CNAME" && String(rec.content).toLowerCase() === target);
  if (match) steps.push("DNS record already in place");
  else if (existing.length) {
    throw domainError_(`${hostname} already has a DNS record (${existing.map(rec => rec.type + " → " + rec.content).join(", ")}). Remove or change it in Cloudflare DNS first — it isn't overwritten automatically.`);
  } else {
    const made = await cf_(cfg, "POST", `/zones/${cfg.zoneId}/dns_records`,
      { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1, comment: "Shop storefront (added by the admin panel)" });
    if (!made.ok) throw domainError_("Cloudflare couldn't create the DNS record: " + cfMessage_(made));
    steps.push("DNS record created");
  }

  // 2. The Pages custom domain: add it, or retry validation if it's stuck in error.
  const base = `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(cfg.project)}/domains`;
  const cur = await cf_(cfg, "GET", `${base}/${hostname}`);
  let result;
  if (cur.status === 404) {
    const added = await cf_(cfg, "POST", base, { name: hostname });
    if (!added.ok) throw domainError_("Cloudflare couldn't add the custom domain: " + cfMessage_(added));
    steps.push("custom domain added");
    result = added.data.result || {};
  } else if (!cur.ok) {
    throw domainError_("Cloudflare custom-domain lookup failed: " + cfMessage_(cur));
  } else {
    result = cur.data.result || {};
    if (result.status === "error" || (result.validation_data && result.validation_data.status === "error")) {
      const retry = await cf_(cfg, "PATCH", `${base}/${hostname}`);
      if (!retry.ok) throw domainError_("Cloudflare couldn't retry validation: " + cfMessage_(retry));
      steps.push("validation retried");
      result = retry.data.result || result;
    } else steps.push("custom domain already added");
  }
  return { configured: true, hostname, exists: true, steps, ...summarize_(result) };
}
