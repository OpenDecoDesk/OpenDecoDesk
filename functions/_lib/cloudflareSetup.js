/**
 * The domain step of a Deploy-button install (Global settings → Your domain), all through Cloudflare's API
 * with one key the owner creates from a ready-made link (cloudflareTokenLink):
 *
 *   1. check the key, and find the owner's domain on the account (one domain is picked for them; with
 *      several they choose, so this may answer { status: "choose", zones })
 *   2. check the domain and this Worker are on the same account: the account's workers.dev subdomain is
 *      the one in the address the admin is open on (<worker>.<account>.workers.dev)
 *   3. attach admin.<domain> to this Worker (a Workers Custom Domain: Cloudflare makes the DNS record and
 *      the certificate; an existing DNS record there is refused, never overwritten)
 *   4. store the key and the ids as Worker secrets — CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID,
 *      CF_WORKER_NAME, and ROOT_DOMAIN last, the switch that makes the site use its domain — the same
 *      names the command-line installer uses, so "Automatic hostnames for new shops" works from then on.
 *
 * The caller (the connectCloudflare action in functions/api/orders.js) records the domain in the database
 * (the `site` setting, which the build reads) and attaches the hostnames of shops built before the domain.
 * The workers.dev address is switched off later (disableWorkersDev), once someone has signed in on
 * admin.<domain> — so a certificate that is slow to arrive can't lock the owner out.
 *
 * Nothing here logs or returns the key; errors say what to do, in words for a shop owner.
 */
import { ensureWorkerHostname } from "./customDomain.js";

const CF_SETUP_API = "https://api.cloudflare.com/client/v4";

// What the key may do. Workers Scripts: write this Worker's secrets and switch workers.dev off.
// Workers Routes + DNS: attach hostnames. Zone: find the domain. R2: the pictures step.
export const TOKEN_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_routes", type: "edit" },
  { key: "zone", type: "read" },
  { key: "dns", type: "edit" },
  { key: "workers_r2", type: "edit" },
];
export function cloudflareTokenLink() {
  return "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" + encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))
    + "&accountId=%2A&zoneId=all&name=" + encodeURIComponent("OpenDecoDesk");
}

// The secrets this step writes, in order (ROOT_DOMAIN last).
export const SETUP_SECRET_NAMES = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID", "CF_WORKER_NAME", "ROOT_DOMAIN"];

// "<worker>.<account>.workers.dev" → { worker, account }; anything else → null.
export function workersDevParts(hostname) {
  const m = /^([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev$/.exec(String(hostname || "").toLowerCase().replace(/\.$/, ""));
  return m ? { worker: m[1], account: m[2] } : null;
}

// What the owner typed as their domain: "https://www.MyShop.com/" → "myshop.com"; "" when it isn't one.
export function cleanDomain(raw) {
  const d = String(raw || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "").replace(/^www\./, "");
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) ? d : "";
}

function setupError_(message, code) { const e = new Error(message); e.userFacing = true; if (code) e.code = code; return e; }

async function cfSetup_(token, method, path, body) {
  const res = await fetch(CF_SETUP_API + path, {
    method,
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.success !== false, data };
}
const cfSetupMessage_ = (r) => ((r.data && r.data.errors) || []).map(e => e.message).filter(Boolean).join("; ") || ("HTTP " + r.status);
const RECREATE_KEY = " Make the key again with the button on this page: it asks for exactly the permissions needed.";
const refused_ = (r) => (r.status === 401 || r.status === 403) ? RECREATE_KEY : "";

const ZONE_WAITING = (name) => `Cloudflare is still waiting for ${name} to point at it. At the company where you bought the domain, change its nameservers to the two Cloudflare shows for it (Cloudflare → Domains → ${name}). It can take up to a day; when it shows Active, come back and connect again.`;

/**
 * connectCloudflare({ token, domain, hostname, adminSubdomain })
 *   token     the key the owner pasted
 *   domain    the chosen domain, or "" to pick the only one
 *   hostname  the address this request came in on (must be this Worker's workers.dev address)
 * → { status: "choose", zones: [{ name, active }] }  when there is more than one domain to pick from, or
 *   { status: "connected", rootDomain, adminHost, adminUrl, steps, cfg }  (cfg holds the key: for the caller
 *   to attach shop hostnames with, never to send back)
 */
export async function connectCloudflare({ token, domain, hostname, adminSubdomain = "admin" }) {
  token = String(token || "").trim();
  if (!token) throw setupError_("Paste the key Cloudflare showed you.");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw setupError_("That doesn't look like a Cloudflare key: it is one line of letters, numbers, - and _. Copy it again from Cloudflare's page.");
  const here = workersDevParts(hostname);
  if (!here) throw setupError_("Do this step on the admin's workers.dev address (the one Cloudflare gave you when you deployed).");

  // 1. The key, and the domain.
  const verify = await cfSetup_(token, "GET", "/user/tokens/verify");
  if (!verify.ok || !verify.data.result || verify.data.result.status !== "active")
    throw setupError_("Cloudflare didn't accept that key (" + cfSetupMessage_(verify) + "). Copy it again, or make a new one with the button on this page.");
  let zone;
  const wanted = String(domain || "").trim() ? cleanDomain(domain) : "";
  if (String(domain || "").trim() && !wanted) throw setupError_(`"${domain}" isn't a domain name (it looks like myshop.com).`);
  if (wanted) {
    const r = await cfSetup_(token, "GET", "/zones?name=" + encodeURIComponent(wanted));
    if (!r.ok) throw setupError_("Couldn't look up your domain on Cloudflare: " + cfSetupMessage_(r) + "." + refused_(r));
    zone = (r.data.result || []).find(z => String(z.name).toLowerCase() === wanted);
    if (!zone) throw setupError_(`${wanted} isn't on this Cloudflare account, or the key can't see it. Add it in Cloudflare (Domains → Add a domain) and connect again.`);
  } else {
    const r = await cfSetup_(token, "GET", "/zones?per_page=50");
    if (!r.ok) throw setupError_("Couldn't list your domains on Cloudflare: " + cfSetupMessage_(r) + "." + refused_(r));
    const zones = r.data.result || [];
    if (!zones.length) throw setupError_("There is no domain on this Cloudflare account yet. Add yours in Cloudflare (Domains → Add a domain: Cloudflare walks you through it), then come back and connect again.", "no_zone");
    if (zones.length > 1) return { status: "choose", zones: zones.map(z => ({ name: String(z.name).toLowerCase(), active: z.status === "active" })).sort((a, b) => a.name.localeCompare(b.name)) };
    zone = zones[0];
  }
  const rootDomain = String(zone.name).toLowerCase();
  if (zone.status !== "active") throw setupError_(ZONE_WAITING(rootDomain), "zone_pending");
  const accountId = zone.account && zone.account.id;
  if (!accountId) throw setupError_("Cloudflare didn't say which account " + rootDomain + " is on. Try again in a minute.");

  // 2. Same account as this Worker?
  const sub = await cfSetup_(token, "GET", `/accounts/${accountId}/workers/subdomain`);
  if (!sub.ok) throw setupError_("Couldn't check this site's Cloudflare account: " + cfSetupMessage_(sub) + "." + refused_(sub));
  if (String((sub.data.result || {}).subdomain || "").toLowerCase() !== here.account)
    throw setupError_(`${rootDomain} is on a different Cloudflare account from this site. Add the domain to the account this site runs on, or make the key while signed in to that account.`);
  const settings = await cfSetup_(token, "GET", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(here.worker)}/settings`);
  if (!settings.ok) throw setupError_("Couldn't find this site's Worker on Cloudflare: " + cfSetupMessage_(settings) + "." + refused_(settings));
  // A plain setting (in wrangler.toml [vars]) of the same name would clash with the secret.
  const plain = ((settings.data.result || {}).bindings || []).filter(b => b.type === "plain_text" && SETUP_SECRET_NAMES.includes(b.name)).map(b => b.name);
  if (plain.length) throw setupError_(`This site already sets ${plain.join(", ")} in wrangler.toml. It was installed from the command line: change the domain with \`npm run setup\` instead.`);

  // 3. admin.<domain>
  const cfg = { token, accountId, zoneId: zone.id, service: here.worker };
  const adminHost = adminSubdomain + "." + rootDomain;
  const attached = await ensureWorkerHostname(cfg, adminHost);
  const steps = [adminHost + ": " + (attached.steps || []).join(", ")];

  // 4. The secrets; ROOT_DOMAIN last.
  const values = { CF_API_TOKEN: token, CF_ACCOUNT_ID: accountId, CF_ZONE_ID: zone.id, CF_WORKER_NAME: here.worker, ROOT_DOMAIN: rootDomain };
  for (const name of SETUP_SECRET_NAMES) {
    const r = await cfSetup_(token, "PUT", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(here.worker)}/secrets`, { name, text: values[name], type: "secret_text" });
    if (!r.ok) throw setupError_(`Couldn't save the setting ${name} on this site's Worker: ${cfSetupMessage_(r)}.` + refused_(r) + " Nothing is lost: connect again.");
  }
  steps.push("saved on the Worker: " + SETUP_SECRET_NAMES.join(", "));
  return { status: "connected", rootDomain, adminHost, adminUrl: "https://" + adminHost + "/", steps, cfg };
}

// Switches this Worker's workers.dev address (and its preview addresses) off. cfg as customDomainConfig gives it.
export async function disableWorkersDev(cfg) {
  const r = await cfSetup_(cfg.token, "POST", `/accounts/${cfg.accountId}/workers/scripts/${encodeURIComponent(cfg.service)}/subdomain`, { enabled: false, previews_enabled: false });
  if (!r.ok) throw setupError_("Couldn't switch the workers.dev address off: " + cfSetupMessage_(r) + "." + refused_(r));
  return true;
}
