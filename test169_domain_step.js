const { makeAuth, answer, read } = require("./testlib/auth-harness");

// The domain step of a Deploy-button install (Global settings → Your domain, functions/_lib/cloudflareSetup.js):
// the owner pastes one Cloudflare key; the app finds the domain, attaches admin.<domain>, keeps the key and the
// ids as Worker secrets (ROOT_DOMAIN last), records the domain for the build, and gives the shops built in
// preview mode their addresses. The workers.dev address is switched off after the first sign-in on the domain.
// Cloudflare's API is a stand-in here, keeping what was asked of it.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

const KEY = "Abc_def-1234567890ghijklmnopqrstuv", OTHER_KEY = "Zzz_zzz-0000000000zzzzzzzzzzzzzzzz";
function cloudflare() {
  const st = {
    keys: { [KEY]: "active" },
    zones: [{ id: "zone-1", name: "myshop.com", status: "active", account: { id: "acct-1" } }],
    accountSubdomain: { "acct-1": "someone" },
    bindings: [{ name: "PROXY_ADMIN_PASSPHRASE", type: "secret_text" }],
    dns: [], domains: [], secrets: [], subdomainOff: [], calls: [],
  };
  const reply = (status, result, errors) => ({ ok: status < 400, status, json: async () => ({ success: status < 400, result, errors: errors || [] }) });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname.replace(/^\/client\/v4/, ""), method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null, key = String((init.headers || {}).Authorization || "").replace(/^Bearer /, "");
    st.calls.push(method + " " + path + u.search);
    if (path === "/user/tokens/verify") return st.keys[key] ? reply(200, { status: st.keys[key] }) : reply(401, null, [{ message: "Invalid API Token" }]);
    if (!st.keys[key]) return reply(403, null, [{ message: "Authentication error" }]);
    if (path === "/zones" && method === "GET") return reply(200, u.searchParams.get("name") ? st.zones.filter(z => z.name === u.searchParams.get("name")) : st.zones);
    let m;
    if ((m = /^\/accounts\/([^/]+)\/workers\/subdomain$/.exec(path))) return reply(200, { subdomain: st.accountSubdomain[m[1]] });
    if ((m = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/settings$/.exec(path))) return m[2] === "opendecodesk" ? reply(200, { bindings: st.bindings }) : reply(404, null, [{ message: "This Worker does not exist on your account." }]);
    if ((m = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/secrets$/.exec(path)) && method === "PUT") { st.secrets.push({ account: m[1], worker: m[2], ...body }); return reply(200, { name: body.name, type: body.type }); }
    if ((m = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path)) && method === "POST") { st.subdomainOff.push({ worker: m[2], ...body }); return reply(200, body); }
    if (/^\/accounts\/[^/]+\/workers\/domains$/.test(path) && method === "GET") return reply(200, st.domains.filter(d => d.hostname === u.searchParams.get("hostname")));
    if (/^\/accounts\/[^/]+\/workers\/domains$/.test(path) && method === "PUT") { st.domains.push(body); return reply(200, body); }
    if (/^\/zones\/[^/]+\/workers\/routes$/.test(path)) return reply(200, []);
    if (/^\/zones\/[^/]+\/dns_records$/.test(path) && method === "GET") return reply(200, st.dns.filter(r => r.name === u.searchParams.get("name")));
    return reply(404, null, [{ message: "no such stand-in: " + method + " " + path }]);
  };
  return st;
}

(async () => {
  const S = await import("./functions/_lib/cloudflareSetup.js");

  console.log("=== The key's link ===");
  const link = new URL(S.cloudflareTokenLink());
  const perms = JSON.parse(link.searchParams.get("permissionGroupKeys"));
  ok("it opens Cloudflare's own token page with the permissions filled in, for every account and zone, named for the app", link.origin === "https://dash.cloudflare.com" && link.pathname === "/profile/api-tokens" &&
    link.searchParams.get("accountId") === "*" && link.searchParams.get("zoneId") === "all" && link.searchParams.get("name") === "OpenDecoDesk");
  ok("…asking for Workers scripts and routes, the zone, its DNS and R2 — nothing about billing, members or other keys",
    perms.map(p => p.key + ":" + p.type).sort().join() === "dns:edit,workers_r2:edit,workers_routes:edit,workers_scripts:edit,zone:read" && !/billing|api_tokens|member/.test(link.search));
  ok("the address it is opened on names the Worker and the account; nothing else does", JSON.stringify(S.workersDevParts("OpenDecoDesk.Someone.workers.dev.")) === '{"worker":"opendecodesk","account":"someone"}' &&
    ["admin.myshop.com", "a.b.c.workers.dev", "someone.workers.dev", "x.someone.workers.dev.evil.com"].every(h => S.workersDevParts(h) === null));
  ok("a domain is read the way people type it", S.cleanDomain(" https://www.MyShop.com/shop ") === "myshop.com" && S.cleanDomain("myshop") === "" && S.cleanDomain("my shop.com") === "");

  console.log("\n=== Connecting, as the library sees it ===");
  const H = "opendecodesk.someone.workers.dev";
  const attempt = async (cf, args) => { globalThis.fetch = cf.fetch; try { return { r: await S.connectCloudflare({ token: KEY, domain: "", hostname: H, ...args }) }; } catch (e) { return { e }; } };
  let cf = cloudflare(), a;
  a = await attempt(cf, { token: "" });
  const b = await attempt(cf, { token: "not a key" }), c = await attempt(cf, { hostname: "admin.myshop.com" });
  ok("no key, something that isn't one, or not on the workers.dev address: refused before Cloudflare is asked anything", /Paste the key/.test(a.e.message) && /doesn't look like a Cloudflare key/.test(b.e.message) &&
    /workers\.dev address/.test(c.e.message) && cf.calls.length === 0 && [a, b, c].every(x => x.e.userFacing));
  a = await attempt(cf, { token: OTHER_KEY });
  ok("a key Cloudflare doesn't accept says so", /didn't accept that key/.test(a.e.message) && /Invalid API Token/.test(a.e.message));
  cf = cloudflare(); cf.zones = [];
  a = await attempt(cf);
  ok("no domain on the account: says how to add one", a.e.code === "no_zone" && /Add a domain/.test(a.e.message));
  cf = cloudflare(); cf.zones.push({ id: "zone-2", name: "another.org", status: "pending", account: { id: "acct-1" } });
  a = await attempt(cf);
  ok("several domains: the owner picks (in order, the ones still waiting marked) and nothing is changed yet", a.r.status === "choose" && JSON.stringify(a.r.zones) === '[{"name":"another.org","active":false},{"name":"myshop.com","active":true}]' && !cf.secrets.length && !cf.domains.length);
  a = await attempt(cf, { domain: "another.org" });
  ok("a domain still waiting for its nameservers: says what to do at the registrar, and nothing is changed", a.e.code === "zone_pending" && /nameservers/.test(a.e.message) && !cf.secrets.length && !cf.domains.length);
  a = await attempt(cf, { domain: "elsewhere.net" });
  ok("a domain that isn't on the account says so", /elsewhere\.net isn't on this Cloudflare account/.test(a.e.message));
  cf = cloudflare(); cf.accountSubdomain["acct-1"] = "someone-else";
  a = await attempt(cf);
  ok("a domain on a different account from this site is refused, with nothing changed", /different Cloudflare account/.test(a.e.message) && !cf.secrets.length && !cf.domains.length);
  cf = cloudflare(); cf.bindings.push({ name: "ROOT_DOMAIN", type: "plain_text" });
  a = await attempt(cf);
  ok("a site installed from the command line (ROOT_DOMAIN in wrangler.toml) is sent to npm run setup", /installed from the command line/.test(a.e.message) && /npm run setup/.test(a.e.message) && !cf.secrets.length);
  cf = cloudflare(); cf.dns.push({ name: "admin.myshop.com", type: "A", content: "192.0.2.10" });
  a = await attempt(cf);
  ok("admin.<domain> already in use: refused, never overwritten, and no setting saved", /already has a DNS record/.test(a.e.message) && /A → 192\.0\.2\.10/.test(a.e.message) && !cf.domains.length && !cf.secrets.length);
  cf = cloudflare();
  a = await attempt(cf, { adminSubdomain: "office" });
  ok("it works: office.<domain> attached to this Worker, in production, on the domain's zone", a.r.status === "connected" && a.r.adminHost === "office.myshop.com" && a.r.adminUrl === "https://office.myshop.com/" &&
    cf.domains.length === 1 && cf.domains[0].hostname === "office.myshop.com" && cf.domains[0].service === "opendecodesk" && cf.domains[0].zone_id === "zone-1" && cf.domains[0].environment === "production");
  ok("…the key and the ids saved as secrets on this Worker, with ROOT_DOMAIN last", cf.secrets.map(x => x.name).join() === "CF_API_TOKEN,CF_ACCOUNT_ID,CF_ZONE_ID,CF_WORKER_NAME,ROOT_DOMAIN" &&
    cf.secrets.every(x => x.type === "secret_text" && x.worker === "opendecodesk" && x.account === "acct-1") && cf.secrets[0].text === KEY && cf.secrets[4].text === "myshop.com" && cf.secrets[3].text === "opendecodesk");
  ok("…and the answer carries the key only in cfg (for the caller), not in what is shown", !JSON.stringify({ ...a.r, cfg: undefined }).includes(KEY) && a.r.cfg.token === KEY);
  a = await attempt(cf, { adminSubdomain: "office" });
  ok("running it again is harmless: the hostname is already there", a.r.status === "connected" && cf.domains.length === 1 && /already added/.test(a.r.steps[0]));
  await S.disableWorkersDev({ token: KEY, accountId: "acct-1", service: "opendecodesk" });
  ok("switching the workers.dev address off switches its previews off too", JSON.stringify(cf.subdomainOff.pop()) === '{"worker":"opendecodesk","enabled":false,"previews_enabled":false}');

  console.log("\n=== In the admin ===");
  const W = "https://opendecodesk.someone.workers.dev";
  const req = (url, body, cookie) => { const h = { origin: new URL(url).origin, cookie: cookie ? "__Host-odd_admin=" + cookie : "", "cf-connecting-ip": "203.0.113.9" };
    return { url, method: "POST", json: async () => body, headers: { get: (n) => h[String(n).toLowerCase()] || null } }; };
  const B = await makeAuth({ passphrase: "a long setup password", realDomains: true });
  delete B.env.ROOT_DOMAIN;
  const at = async (origin, path, body, cookie) => { const later = [];
    const res = await answer(await B.raw[path].POST({ request: req(origin + path, body, cookie), env: B.env, waitUntil: (p) => later.push(p) }));
    await Promise.all(later.map(p => Promise.resolve(p).catch(() => {}))); return res; };
  const first = await at(W, "/api/admin-session", { email: "", key: "a long setup password" });
  await B.password({ action: "account", name: "Olive Owner", email: "olive@myshop.com", next: "correct horse battery" }, first.cookie);
  const owner = (await at(W, "/api/admin-session", { email: "olive@myshop.com", key: "correct horse battery" })).cookie;
  const manager = await B.addUser(owner, "manager", "Max Manager", "max@myshop.com");
  cf = cloudflare(); globalThis.fetch = cf.fetch;
  await at(W, "/api/orders", { action: "createOrg", orgId: "league", subdomain: "league", name: "League" }, owner);
  const shown = await at(W, "/api/orders", { action: "getCloudflareSetup" }, owner);
  ok("on the workers.dev address with no domain, the admin is offered the step, with the key's link", shown.status === 200 && shown.body.cloudflare.onWorkersDev === true && shown.body.cloudflare.hasDomain === false &&
    shown.body.cloudflare.tokenLink === S.cloudflareTokenLink() && shown.body.cloudflare.adminSubdomain === "admin");
  const asManager = [await at(W, "/api/orders", { action: "getCloudflareSetup" }, manager), await at(W, "/api/orders", { action: "connectCloudflare", token: KEY }, manager)];
  ok("a manager can neither see nor do it (the key can change the account's Workers and DNS)", asManager.every(r => r.status === 403) && !cf.calls.length);
  const elsewhere = await at("https://admin.example.com", "/api/orders", { action: "connectCloudflare", token: KEY }, owner);
  ok("it is done on the workers.dev address only", elsewhere.status === 409 && /workers\.dev address/.test(elsewhere.body.message) && !cf.calls.length);
  const wrong = await at(W, "/api/orders", { action: "connectCloudflare", token: OTHER_KEY }, owner);
  ok("a refused key comes back as the message, and the attempt is in the audit log without the key", wrong.status === 400 && /didn't accept that key/.test(wrong.body.message) &&
    B.audit("site.domain_connect").length === 1 && B.audit("site.domain_connect_failed").length === 1);
  const done = await at(W, "/api/orders", { action: "connectCloudflare", token: KEY }, owner);
  const site = JSON.parse(B.d1.q("SELECT value FROM global_settings WHERE key = 'site'")[0].value);
  ok("connected: the admin is told its new address", done.status === 200 && done.body.connected.adminHost === "admin.myshop.com" && done.body.connected.adminUrl === "https://admin.myshop.com/");
  ok("…the domain is recorded for the build, not yet reached (so workers.dev stays on)", site.rootDomain === "myshop.com" && site.adminSubdomain === "admin" && site.viaSetup === true && site.adminHostSeen === false && !site.workersDevOff);
  ok("…the shop built in preview mode gets its address now", cf.domains.map(d => d.hostname).join() === "admin.myshop.com,league.myshop.com" && done.body.connected.shops.length === 1 && done.body.connected.shops[0].ok && done.body.connected.shops[0].hostname === "league.myshop.com");
  const everything = JSON.stringify(done.body) + JSON.stringify(B.d1.q("SELECT * FROM audit_log")) + JSON.stringify(B.d1.q("SELECT * FROM global_settings"));
  ok("…and the key appears nowhere: not in the answer, the audit log or the settings", !everything.includes(KEY) && B.audit("site.domain_connected").length === 1);
  Object.assign(B.env, Object.fromEntries(cf.secrets.map(x => [x.name, x.text])));   // the next version of the Worker has the secrets
  const twice = await at(W, "/api/orders", { action: "connectCloudflare", token: KEY }, owner);
  ok("once the site has its domain, the step isn't offered again", twice.status === 409 && /already has its domain \(myshop\.com\)/.test(twice.body.message));
  const onDev = (await at(W, "/api/orders", { action: "getCloudflareSetup" }, owner)).body.cloudflare;
  ok("…the workers.dev page now says where the admin has moved", onDev.hasDomain === true && onDev.rootDomain === "myshop.com" && onDev.onWorkersDev === true);
  const signIn = await at(W, "/api/admin-session", { email: "olive@myshop.com", key: "correct horse battery" });
  ok("signing in on the workers.dev address doesn't switch it off", signIn.status === 200 && !cf.subdomainOff.length);
  cf.keys[KEY] = undefined;                                       // the key was deleted in Cloudflare
  const there = await at("https://admin.myshop.com", "/api/admin-session", { email: "olive@myshop.com", key: "correct horse battery" });
  const site2 = () => JSON.parse(B.d1.q("SELECT value FROM global_settings WHERE key = 'site'")[0].value);
  ok("the first sign-in on admin.<domain> works even when switching workers.dev off fails, and it is tried again later", there.status === 200 && site2().adminHostSeen === true && !site2().workersDevOff && !cf.subdomainOff.length);
  cf.keys[KEY] = "active";
  await at("https://admin.myshop.com", "/api/admin-session", { email: "olive@myshop.com", key: "correct horse battery" });
  ok("…then switched off, once", cf.subdomainOff.length === 1 && cf.subdomainOff[0].enabled === false && site2().workersDevOff === true);
  await at("https://admin.myshop.com", "/api/admin-session", { email: "olive@myshop.com", key: "correct horse battery" });
  ok("…and not asked again", cf.subdomainOff.length === 1);

  console.log("\n=== The page ===");
  const adminJs = read("public/admin.js");
  ok("Global settings has the Your domain box, loaded for an admin only", /<div id="domainSetupBox"><\/div>\n    <div id="setupStatusBox"><\/div>/.test(adminJs) && /async function loadDomainSetup_\(\)\{\n  const box = document\.getElementById\("domainSetupBox"\);\n  if \(!box \|\| !adminCan_\("admin"\)\) return;/.test(adminJs));
  ok("…the key is typed into a password box and sent only to this site", /<input type="password" id="cfToken" autocomplete="off"/.test(adminJs) && /action: "connectCloudflare", token: token\.trim\(\)/.test(adminJs));
  ok("…and it says what the key can do", /What the key can do: change this Cloudflare account's Workers/.test(adminJs));
  ok("the Setup status line for the domain points there", /connect your domain under Your domain/.test(read("functions/_lib/setupStatus.js")));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.log("test169 crashed:", e); console.log("test169 crashed: false"); });
