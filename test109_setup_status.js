const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Setup status (Tools → Global settings, top of the page; action getSetupStatus;
// functions/_lib/setupStatus.js): which parts of the install are configured, so a fresh install
// that is missing something says so instead of failing quietly. It reports only set / not set —
// never a value. Real SQL (sql.js), real db.js / orders.js, and the real admin page in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), httpSrc = strip(read("functions/_lib/http.js")), hostSrc = strip(read("functions/_lib/hostConfig.js"));
const statusSrc = strip(read("functions/_lib/setupStatus.js"));
const lib = new Function(dbSrc + "\n" + statusSrc + "\nreturn { setupStatus, setupSummary, getPublicCatalogData, setBusinessProfile, setSalesTaxSettings, setLocaleSettings };")();
const api = new Function("catalogData", hostSrc + "\n" + httpSrc + "\n" + statusSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async (env, host, key) => (host.kind === 'admin' && key === 'x') ? null : jsonResponse({ status: 'error', message: 'Unauthorized' }, 401); const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = (env) => catalogData(env);\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const checkShippedDeliveries = async () => ({}), checkBlankShipments = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost };");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(res => setTimeout(res, ms || 40));
const by = (items) => Object.fromEntries(items.map(i => [i.key, i]));
const DB = { prepare(){} }, bucket = { put(){} };
// Every secret-like value is distinctive, so a leak anywhere in an answer is caught by a plain search.
const SECRETS = { PROXY_ADMIN_PASSPHRASE: "PASSPHRASE-zzq1", SIGNING_SECRET: "SIGNING-zzq2", CRON_SECRET: "CRON-zzq3", STRIPE_SECRET_KEY: "sk_test_zzq4", STRIPE_WEBHOOK_SECRET: "wh_zzq5",
  SHIPPO_API_KEY: "shippo_zzq6", RESEND_API_KEY: "re_zzq7", CF_EMAIL_API_TOKEN: "cfmail_zzq8", TURNSTILE_SECRET_KEY: "ts_zzq9", CF_API_TOKEN: "cfapi_zzq10", AGENT_TOKEN: "agent_zzq11_" + "a".repeat(32),
  LINK_SIGNING_SECRET: "link_zzq12", QUOTE_SIGNING_SECRET: "quote_zzq13", TOTP_SECRET: "totp_zzq14" };
const IDS = { CF_ACCOUNT_ID: "acct_zzq15", CF_ZONE_ID: "zone_zzq16", TURNSTILE_SITE_KEY: "site_zzq17", ACCESS_AUD: "aud_zzq18", ACCESS_TEAM_DOMAIN: "team-zzq19.cloudflareaccess.com", R2_PUBLIC_BASE: "https://images-zzq20.myshop.com" };
const FULL_ENV = { ...SECRETS, ...IDS, DB, IMAGES: bucket, RECEIPTS: bucket, DESIGNS: bucket, AGENT_MAILBOX: {}, ROOT_DOMAIN: "myshop.com", CF_WORKER_NAME: "opendecodesk", TIMEZONE: "Europe/London" };
const FULL_SETTINGS = { business: { name: "Thread & Needle", ownerEmail: "owner@myshop.com" }, salesTax: { rateBps: 600, jurisdiction: "OH" }, locale: { timeZone: "Europe/London" } };

(async () => {
  console.log("=== The list ===");
  const EXPECT = ["rootDomain", "database", "signingSecret", "email", "images", "receipts", "designs", "business", "salesTax", "timeZone", "stripe", "shippo", "turnstile", "access", "customDomains", "agentRelay", "cronSecret"];
  let items = lib.setupStatus(FULL_ENV, FULL_SETTINGS), s = by(items);
  ok("it covers the domain, database, signing secret, email, the three buckets, business profile, tax, time zone, and each optional service", items.map(i => i.key).join() === EXPECT.join());
  ok("each line has a name, a level, and one sentence on what it affects", items.every(i => i.label && ["required", "recommended", "optional"].includes(i.level) && i.affects.length > 30 && typeof i.ready === "boolean" && typeof i.note === "string"));
  ok("a fully configured install: everything is ready", items.every(i => i.ready) && JSON.stringify(lib.setupSummary(items)) === JSON.stringify({ required: 0, recommended: 0, optional: 0, total: 17 }));
  ok("it names the email provider in use (Resend wins when its key is set, as in email.js)", /Resend/.test(s.email.note));
  const leak = (obj) => [...Object.values(SECRETS), ...Object.values(IDS)].filter(v => JSON.stringify(obj).includes(v));
  ok("no key, token, passphrase, id or address appears anywhere in it", leak(items).length === 0);

  items = lib.setupStatus({}, {}); s = by(items);
  ok("nothing configured at all: nothing is ready, and it doesn't crash on an empty environment", items.every(i => !i.ready) && lib.setupStatus(null, null).length === 17 && lib.setupStatus(undefined).every(i => !i.ready));
  ok("…three required, four recommended, ten optional (file storage is optional)", JSON.stringify(lib.setupSummary(items)) === JSON.stringify({ required: 3, recommended: 4, optional: 10, total: 17 }));
  ok("the required ones are the domain, the database and the signing secret", items.filter(i => i.level === "required").map(i => i.key).join() === "rootDomain,database,signingSecret");

  console.log("\n=== Each line follows what the code actually needs ===");
  const st = (env, settings) => by(lib.setupStatus(env, settings || {}));
  ok("root domain: unset or the example.com placeholder is not ready", !st({}).rootDomain.ready && !st({ ROOT_DOMAIN: "example.com" }).rootDomain.ready && st({ ROOT_DOMAIN: "MyShop.com" }).rootDomain.ready &&
    /DEFAULT_ROOT_DOMAIN = "example\.com"/.test(read("functions/_lib/hostConfig.js")));
  ok("signing secret: SIGNING_SECRET is ready; a fallback counts but is called out; none is not ready", st({ SIGNING_SECRET: "x" }).signingSecret.note === "" && st({ STRIPE_SECRET_KEY: "x" }).signingSecret.ready &&
    /fallback/.test(st({ QUOTE_SIGNING_SECRET: "x" }).signingSecret.note) && !st({}).signingSecret.ready);
  ok("…the same fallbacks the signing code uses", /env\.SIGNING_SECRET \|\| env\.QUOTE_SIGNING_SECRET \|\| env\.STRIPE_SECRET_KEY/.test(read("functions/_lib/quoteToken.js")) &&
    /env\.SIGNING_SECRET \|\| env\.LINK_SIGNING_SECRET \|\| env\.QUOTE_SIGNING_SECRET \|\| env\.STRIPE_SECRET_KEY/.test(read("functions/api/receipt.js")));
  ok("email: Resend key, or a Cloudflare binding, or the Cloudflare token WITH the account id", st({ RESEND_API_KEY: "k" }).email.ready && st({ EMAIL: { send(){} } }).email.ready && /binding/.test(st({ EMAIL: { send(){} } }).email.note) &&
    st({ CF_EMAIL_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }).email.ready && /API token/.test(st({ CF_EMAIL_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }).email.note));
  ok("…a token without the account id is not ready and says which half is missing; nothing at all says what to set", !st({ CF_EMAIL_API_TOKEN: "t" }).email.ready && /CF_ACCOUNT_ID is not/.test(st({ CF_EMAIL_API_TOKEN: "t" }).email.note) &&
    /Set RESEND_API_KEY, or CF_EMAIL_API_TOKEN with CF_ACCOUNT_ID/.test(st({}).email.note) && /verified/.test(st({}).email.note));
  ok("images: needs the bucket AND its public address (uploads are refused without either, as upload.js does)", !st({ IMAGES: bucket }).images.ready && /R2_PUBLIC_BASE/.test(st({ IMAGES: bucket }).images.note) &&
    !st({ R2_PUBLIC_BASE: "https://i" }).images.ready && /No file storage on this install/.test(st({ R2_PUBLIC_BASE: "https://i" }).images.note) && st({ IMAGES: bucket, R2_PUBLIC_BASE: "https://i" }).images.ready &&
    /!env\.IMAGES \|\| !env\.R2_PUBLIC_BASE/.test(read("functions/api/upload.js")));
  ok("file storage is optional: with no buckets the three lines are 'optional' and say how to add R2; only a pictures bucket without its address is a nudge", ["images", "receipts", "designs"].every(k => st({})[k].level === "optional" && !st({})[k].ready && /switch on R2/.test(st({})[k].note)) &&
    st({ IMAGES: bucket })[ "images"].level === "recommended" && st({ IMAGES: bucket, R2_PUBLIC_BASE: "https://i" }).images.level === "optional" && st({ RECEIPTS: bucket }).receipts.ready && st({ DESIGNS: bucket }).designs.ready);
  ok("receipts and designs: the private buckets just need to be bound", st({ RECEIPTS: bucket }).receipts.ready && !st({}).receipts.ready && st({ DESIGNS: bucket }).designs.ready && !st({}).designs.ready);
  ok("business profile: a name and an inbox (the profile's, or OWNER_EMAIL)", !st({}, { business: { name: "X" } }).business.ready && /inbox/.test(st({}, { business: { name: "X" } }).business.note) &&
    !st({}, { business: { ownerEmail: "o@x.com" } }).business.ready && st({}, { business: { name: "X", ownerEmail: "o@x.com" } }).business.ready && st({ OWNER_EMAIL: "o@x.com" }, { business: { name: "X" } }).business.ready);
  ok("sales tax: a rate and a home state; no rate says none is collected", st({}, { salesTax: { rateBps: 600, jurisdiction: "OH" } }).salesTax.ready && /no sales tax is collected/.test(st({}, { salesTax: { rateBps: 0 } }).salesTax.note) &&
    !st({}, { salesTax: { rateBps: 600, jurisdiction: "" } }).salesTax.ready && /no home state/.test(st({}, { salesTax: { rateBps: 600 } }).salesTax.note));
  ok("time zone: saved in Region, or the TIMEZONE variable; neither means UTC", st({}, { locale: { timeZone: "Asia/Tokyo" } }).timeZone.ready && /TIMEZONE variable/.test(st({ TIMEZONE: "UTC" }).timeZone.note) && /UTC is used/.test(st({}).timeZone.note));
  ok("Stripe: the key AND the webhook secret; the key alone warns that payments aren't recorded", st({ STRIPE_SECRET_KEY: "k", STRIPE_WEBHOOK_SECRET: "w" }).stripe.ready && !st({ STRIPE_SECRET_KEY: "k" }).stripe.ready &&
    /not recorded/.test(st({ STRIPE_SECRET_KEY: "k" }).stripe.note) && st({}).stripe.note === "");
  ok("Turnstile: both keys; the secret alone warns that EVERY order is refused; the site key alone that it's off", st({ TURNSTILE_SECRET_KEY: "s", TURNSTILE_SITE_KEY: "k" }).turnstile.ready &&
    /EVERY order is refused/.test(st({ TURNSTILE_SECRET_KEY: "s" }).turnstile.note) && /check is off/.test(st({ TURNSTILE_SITE_KEY: "k" }).turnstile.note));
  ok("Access: both values, or it isn't checked", st({ ACCESS_TEAM_DOMAIN: "t", ACCESS_AUD: "a" }).access.ready && /not being checked/.test(st({ ACCESS_AUD: "a" }).access.note) &&
    /env\.ACCESS_TEAM_DOMAIN && env\.ACCESS_AUD/.test(read("functions/_lib/access.js")));
  ok("automatic hostnames: the token, both ids and the Worker's name", st({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", CF_ZONE_ID: "z", CF_WORKER_NAME: "w" }).customDomains.ready &&
    !st({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", CF_ZONE_ID: "z" }).customDomains.ready && /at least one is missing/.test(st({ CF_API_TOKEN: "t" }).customDomains.note) && st({}).customDomains.note === "");
  ok("send-agent relay: a token of 32+ characters and the mailbox binding", st({ AGENT_TOKEN: "a".repeat(32), AGENT_MAILBOX: {} }).agentRelay.ready && !st({ AGENT_TOKEN: "short", AGENT_MAILBOX: {} }).agentRelay.ready &&
    /shorter than 32/.test(st({ AGENT_TOKEN: "short" }).agentRelay.note) && /MIN_TOKEN_LENGTH = 32/.test(read("functions/api/agent.js")));
  ok("Shippo and the manual roll-up key are simply set or not", st({ SHIPPO_API_KEY: "k" }).shippo.ready && st({ CRON_SECRET: "k" }).cronSecret.ready && /scheduled roll-up doesn't need it/.test(st({}).cronSecret.affects));
  ok("blank and whitespace-only values count as not set", !st({ ROOT_DOMAIN: "  ", SHIPPO_API_KEY: "", RESEND_API_KEY: " " }).rootDomain.ready && !st({ SHIPPO_API_KEY: " " }).shippo.ready && !st({ RESEND_API_KEY: " " }).email.ready);
  ok("the file imports nothing and never returns an environment value", !/^import /m.test(read("functions/_lib/setupStatus.js")) && leak(lib.setupStatus({ ...FULL_ENV, RESEND_API_KEY: "", EMAIL: undefined }, FULL_SETTINGS)).length === 0);

  console.log("\n=== The admin action ===");
  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  const env = { ...FULL_ENV, DB: d1, STRIPE_WEBHOOK_SECRET: "", R2_PUBLIC_BASE: "", TIMEZONE: "", TURNSTILE_SITE_KEY: "" };
  const A = api(async () => ({ ...(await lib.getPublicCatalogData(d1)), subdomainMap: { acme: "acme" } }));
  const post = async (host, body) => { const res = await A.post({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `https://${host}.myshop.com/api/orders`, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, text: await res.text() }; };
  let r = await post("admin", { action: "getSetupStatus", key: "wrong" });
  ok("it takes an admin", r.status === 401 && !/items/.test(r.text));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  r = await post("acme", { action: "getSetupStatus", key: "x" });
  ok("…on the admin host: a shop's own address is refused even with the right key", r.status === 401 && !/items/.test(r.text));
  r = await post("admin", { action: "getSetupStatus", key: "x" });
  let body = JSON.parse(r.text); s = by(body.items);
  ok("the admin gets the list and a summary", r.status === 200 && body.status === "ok" && body.items.length === 17 && body.summary.total === 17);
  ok("a fresh database: no business profile, no tax, no time zone", !s.business.ready && !s.salesTax.ready && !s.timeZone.ready && s.rootDomain.ready && s.database.ready && s.signingSecret.ready);
  ok("the half-configured services are flagged: Stripe without its webhook secret, the images bucket without an address, a Turnstile secret without its site key",
    !s.stripe.ready && /not recorded/.test(s.stripe.note) && !s.images.ready && /R2_PUBLIC_BASE/.test(s.images.note) && !s.turnstile.ready && /EVERY order/.test(s.turnstile.note));
  ok("the answer contains no secret value, id or address — only names of settings", leak(body).length === 0 && !/zzq/.test(r.text));
  await lib.setBusinessProfile(d1, { name: "Thread & Needle", ownerEmail: "owner@myshop.com" });
  await lib.setSalesTaxSettings(d1, { rateBps: 725, jurisdiction: "OH" });
  await lib.setLocaleSettings(d1, { timeZone: "Europe/London" });
  body = JSON.parse((await post("admin", { action: "getSetupStatus", key: "x" })).text); s = by(body.items);
  ok("filling in the business profile, the tax rate and the region turns those three ready", s.business.ready && s.salesTax.ready && s.timeZone.ready && body.summary.recommended === 1);
  ok("the owner's email saved in the profile is not echoed back", !/owner@myshop\.com/.test(JSON.stringify(body)));
  const brokenEnv = { ...env, DB: { prepare(){ throw new Error("D1 is down"); } } };
  ok("it is an ordinary admin action: listed with the catalog-admin actions, and not behind any feature switch", /"getSetupStatus"/.test(read("functions/api/orders.js").match(/const CATALOG_ADMIN_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1]) &&
    !/getSetupStatus/.test(read("functions/api/orders.js").match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1]) && !!brokenEnv);

  console.log("\n=== Global settings shows it at the top ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  let statusFails = false;
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.myshop.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) {
          const b = JSON.parse(opts.body);
          if (b.action === "getSetupStatus" && statusFails) return { ok: false, status: 500, json: async () => ({ status: "error", message: "boom" }) };
          const res = await post("admin", b);
          return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(res.text) };
        }
        if (String(url).includes("/api/catalog")) return { ok: true, status: 200, json: async () => ({ status: "admin", business: {}, features: {}, country: "US" }) };
        if (String(url).includes("127.0.0.1")) throw new Error("no agent in tests");
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      win.confirm = () => true;
    } });
  const w = dom.window, doc = w.document;
  await tick(150); await w.loadAdminScript();
  w.eval('adminKey = "x"; adminOrgs = [{orgId:"acme", name:"Acme"}];');
  const open = async () => { w.location.hash = "#settings"; await w.adminRoute(); for (let i = 0; i < 80 && !doc.getElementById("gBizName"); i++) await tick(25); };
  await open();
  const box = doc.getElementById("gSetupStatus"), rows = [...doc.querySelectorAll("#gSetupStatus .setup-row")];
  const panel = doc.getElementById("adminPanel");
  ok("a Setup status section is the first thing on the page, above the Business profile", !!box && panel.querySelector("h2").textContent === "Setup status" &&
    (box.compareDocumentPosition(doc.getElementById("gBizName")) & w.Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  ok("one row per item, each with its name, ready / not set up, and what it affects", rows.length === 17 && rows.every(r => r.querySelector("strong").textContent && /Ready|Not set up/.test(r.textContent) && r.querySelector(".admin-note").textContent.length > 30));
  const keys = rows.map(r => r.dataset.key), ready = (k) => rows.find(r => r.dataset.key === k).dataset.ready === "1";
  ok("what's missing comes first: needed things, then optional ones that are off, then everything that's ready", (() => {
    const rk = rows.map(r => r.dataset.ready === "1" ? 3 : r.dataset.level === "required" ? 0 : r.dataset.level === "recommended" ? 1 : 2);
    return rk.every((v, i) => i === 0 || rk[i - 1] <= v) && keys[0] === "images";
  })());
  ok("it matches the server: images, Stripe and Turnstile not set up; the domain, email and the business profile ready", !ready("images") && !ready("stripe") && !ready("turnstile") && ready("rootDomain") && ready("email") && ready("business"));
  ok("it says how many things still need setting up, and where server-side settings are changed", box.dataset.need === "1" && /1 thing still needs setting up/.test(panel.textContent) && /npm run setup/.test(panel.textContent) && /docs\/configuration\.md/.test(panel.textContent));
  ok("an optional service that's off is marked optional, not as a problem", /Not set up \(optional\)/.test(rows.find(r => r.dataset.key === "stripe").textContent) && !/required/.test(rows.find(r => r.dataset.key === "stripe").textContent));
  ok("a half-configured service shows its warning", /EVERY order is refused/.test(rows.find(r => r.dataset.key === "turnstile").textContent));
  ok("it promises — and shows — no key or password", /never a key or password/.test(panel.textContent) && !/zzq/.test(panel.innerHTML));
  ok("the rest of the form is still there and still saves", !!doc.getElementById("gBizName") && doc.getElementById("gBizName").value === "Thread & Needle" && typeof w.submitGlobalSettings === "function" && !!doc.getElementById("gFeatures"));
  ok("drawn with escaped text only", w.setupStatusHtml_([{ key: "x", label: "<b>L</b>", level: "optional", ready: false, affects: "<img src=x onerror=1>", note: "<i>n</i>" }]).includes("&lt;b&gt;L&lt;/b&gt;") &&
    !/<img|<i>n/.test(w.setupStatusHtml_([{ key: "x", label: "L", level: "optional", ready: false, affects: "<img src=x onerror=1>", note: "<i>n</i>" }])));
  ok("everything ready: it says so", /Everything this site needs is set up/.test(w.setupStatusHtml_(lib.setupStatus(FULL_ENV, FULL_SETTINGS))) && w.setupStatusHtml_(null) === "" && w.setupStatusHtml_([]) === "");
  statusFails = true;
  await open();
  ok("if the status can't be loaded, the settings page still opens without it", !doc.getElementById("gSetupStatus") && !!doc.getElementById("gBizName") && doc.getElementById("adminPanel").querySelector("h2").textContent === "Business profile");
  ok("admin.js still parses as a classic script", (() => { try { new Function(adminJs); return true; } catch (e) { return false; } })());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("test109 crashed:", e); console.log("test109 crashed: false"); process.exit(1); });
