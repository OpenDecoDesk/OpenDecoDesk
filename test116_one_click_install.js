const fs = require("fs");
const { makeAuth, read, strip } = require("./testlib/auth-harness");

// Installing with the Deploy to Cloudflare button. The button copies this repository, makes the
// database and buckets, asks for the secrets listed in .dev.vars.example (with the descriptions in
// package.json) and runs `npm run deploy` in Cloudflare's build. The site has no domain then: its
// admin answers on the Worker's own workers.dev address, and the first sign-in is with the setup
// password the owner chose on Cloudflare's page — refused while it is the example's placeholder or
// too short, because that address is public from the moment it is deployed.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  console.log("=== The admin on the workers.dev address ===");
  const { classifyHost } = new Function(strip(read("functions/_lib/hostConfig.js")) + "\nreturn { classifyHost };")();
  const env = { ROOT_DOMAIN: "myshop.com" }, map = { league: "league-101" };
  ok("the Worker's own address (<worker>.<account>.workers.dev) is the admin", classifyHost("opendecodesk.someone.workers.dev", map, {}).kind === "admin" && classifyHost("OpenDecoDesk.Someone.workers.dev.", map, env).kind === "admin");
  ok("nothing else that merely mentions workers.dev is: a deeper name, the bare domain, or a look-alike under another domain", ["a.b.c.workers.dev", "someone.workers.dev", "workers.dev", "opendecodesk.someone.workers.dev.evil.com", "opendecodesk.someone.workers.devx", "op_x.someone.workers.dev"]
    .every(h => classifyHost(h, map, env).kind === "unknown"));
  ok("shops and the admin on the real domain are as before", classifyHost("league.myshop.com", map, env).kind === "locked" && classifyHost("admin.myshop.com", map, env).kind === "admin" && classifyHost("myshop.com", map, env).kind === "root");

  console.log("\n=== The setup password ===");
  const placeholder = (read(".dev.vars.example").match(/^PROXY_ADMIN_PASSPHRASE=(.*)$/m) || [])[1];
  for (const [what, secret] of [["the example's placeholder", placeholder], ["a short one", "short-pass1"]]) {
    const A = await makeAuth({ passphrase: secret });
    const a = await A.signIn("", secret);
    ok(`${what} doesn't open a new site, says where to change it, and creates nothing`, a.status === 403 && a.body.code === "weak_setup_password" && /Variables and Secrets/.test(a.body.message) && !a.cookie && A.d1.q("SELECT count(*) n FROM users")[0].n === 0);
  }
  const A = await makeAuth({ passphrase: "a long setup password" });
  ok("a setup password of 12 characters or more does", (await A.signIn("", "a long setup password")).body.pending === "account");

  console.log("\n=== The site's own domain ===");
  // Requests to any address (the harness's own helper always uses admin.example.com).
  const req = (url, body, cookie) => { const h = { origin: new URL(url).origin, cookie: cookie ? "__Host-odd_admin=" + cookie : "", "cf-connecting-ip": "203.0.113.9" };
    return { url, method: "POST", json: async () => body, headers: { get: (n) => h[String(n).toLowerCase()] || null } }; };
  const { answer } = require("./testlib/auth-harness");
  const W = "https://opendecodesk.someone.workers.dev", S = await import("./scripts/setup.mjs");
  const B = await makeAuth({ passphrase: "a long setup password" });
  delete B.env.ROOT_DOMAIN;                                     // a button install: no domain yet
  const site = () => S.parseSiteSetting(B.d1.q("SELECT value FROM global_settings WHERE key = 'site'")[0]);
  const signInAt = async (origin, email, key) => answer(await B.raw["/api/admin-session"].POST({ request: req(origin + "/api/admin-session", { email, key }), env: B.env }));
  const first = await signInAt(W, "", "a long setup password");
  await B.password({ action: "account", name: "Olive Owner", email: "olive@myshop.com", next: "correct horse battery" }, first.cookie);
  const own = await signInAt(W, "olive@myshop.com", "correct horse battery");
  ok("signing in on the workers.dev address works and records nothing about a domain", own.status === 200 && !own.body.pending && !site().adminHostSeen && !site().rootDomain);
  const ordersAt = async (origin, body, cookie) => answer(await B.raw["/api/orders"].POST({ request: req(origin + "/api/orders", body, cookie), env: B.env, waitUntil: () => {} }));
  const shop = { action: "createOrg", orgId: "league", subdomain: "league", name: "League" };
  const made = await ordersAt(W, shop, own.cookie);
  ok("a shop can be built before the site has a domain, with no address set up for it (it would be <name>.example.com)", made.status === 200 && made.body.domain && made.body.domain.noDomain === true &&
    B.d1.q("SELECT count(*) n FROM orgs")[0].n === 1 && !B.d1.q("SELECT ready FROM orgs WHERE orgId='league'")[0].ready);
  const openIt = await ordersAt(W, { action: "setOrgReady", orgId: "league", ready: true }, own.cookie);
  const openAtBirth = await ordersAt(W, { ...shop, orgId: "club", subdomain: "club", name: "Club", ready: true }, own.cookie);
  const league = (await ordersAt(W, { action: "listOrgsAdmin" }, own.cookie)).body.orgs.find(o => o.orgId === "league");
  const openByForm = await ordersAt(W, { ...league, action: "updateOrg", ready: true }, own.cookie);
  ok("…but it can't be opened for orders: not from the wizard, not made open, not from the shop form — each says why",
    [openIt, openAtBirth, openByForm].every(r => r.status === 409 && r.body.code === "no_domain" && /can't open for orders until your site has its own domain/.test(r.body.message)) &&
    !B.d1.q("SELECT ready FROM orgs WHERE orgId='league'")[0].ready && B.d1.q("SELECT count(*) n FROM orgs")[0].n === 1);

  B.env.ROOT_DOMAIN = "myshop.com";                              // the Setup page's domain step
  const there = await signInAt("https://admin.myshop.com", "olive@myshop.com", "correct horse battery");
  ok("the first sign-in on admin.<domain> records that the domain works, which lets the next deploy switch workers.dev off", there.status === 200 &&
    site().adminHostSeen === true && site().rootDomain === "myshop.com" && site().adminSubdomain === "admin");
  const again = await signInAt(W, "olive@myshop.com", "correct horse battery");
  ok("…and a later sign-in on the workers.dev address (still on until that deploy) doesn't undo it", again.status === 200 && site().adminHostSeen === true);
  const openNow = await ordersAt("https://admin.myshop.com", { action: "setOrgReady", orgId: "league", ready: true }, there.cookie);
  ok("with a domain, the shop can be opened for orders", openNow.status === 200 && openNow.body.ready === true && !!B.d1.q("SELECT ready FROM orgs WHERE orgId='league'")[0].ready);
  B.env.SIGNING_SECRET = "a signing secret for the preview links";
  const previewAt = async (origin, cookie) => answer(await B.raw["/api/orders"].POST({ request: req(origin + "/api/orders", { action: "getPreviewLink", org: "league" }, cookie), env: B.env, waitUntil: () => {} }));
  const linked = await previewAt("https://admin.myshop.com", there.cookie);
  ok("a draft preview links to the shop's own address on the domain", linked.status === 200 && /^https:\/\/league\.myshop\.com\/\?preview=/.test(linked.body.url));
  delete B.env.ROOT_DOMAIN;
  const devLink = await previewAt(W, own.cookie);
  ok("without a domain, the draft preview opens on the admin's own workers.dev address and names its shop", devLink.status === 200 &&
    /^https:\/\/opendecodesk\.someone\.workers\.dev\/\?shop=league&preview=\d+\.[0-9a-f]{64}$/.test(devLink.body.url));
  const { prelude } = require("./testlib/auth-harness");
  const shopCatalog = new Function(prelude().replace("const getCatalogData = async () => ({ subdomainMap: {}, business: {} });", "let getCatalogData;") +
    strip(read("functions/api/catalog.js")) + "\nreturn { get: onRequestGet, set: (f) => { getCatalogData = f; } };")();
  const dbLib = await import("./functions/_lib/db.js");
  shopCatalog.set(async () => ({ ...(await dbLib.getPublicCatalogData(B.d1)), subdomainMap: {} }));
  const at = async (u, e = B.env) => JSON.parse(await (await shopCatalog.get({ request: { url: u.replace(/^(https:\/\/[^/]+)\//, "$1/api/catalog") }, env: e })).text());
  const shown = await at(devLink.body.url);
  ok("…where that link shows the shop's draft, which takes no orders", shown.status === "ok" && shown.preview === true && shown.orgId === "league" && shown.catalog.name === "League");
  const tok = new URL(devLink.body.url).searchParams.get("preview");
  const probes = [W + "/?shop=other&preview=" + tok, W + "/?shop=league&preview=" + tok.replace(/.$/, c => c === "0" ? "1" : "0"), W + "/?shop=league", W + "/?shop=league&preview=1.ab"];
  ok("a token for another shop, a changed or missing token: the admin answer, nothing about the shop", (await Promise.all(probes.map(u => at(u)))).every(a => a.status === "admin" && !a.catalog && !a.orgId));
  ok("…and once the site has a domain, the workers.dev address serves no shop at all", (await at(devLink.body.url, { ...B.env, ROOT_DOMAIN: "myshop.com" })).status === "admin");
  B.env.ROOT_DOMAIN = "myshop.com"; delete B.env.SIGNING_SECRET;

  const catalog = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\nconst getCatalogData = async () => ({ subdomainMap: {}, business: {}, features: {} });\n" +
    strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
  const adminAnswer = async (host, e) => JSON.parse(await (await catalog({ request: { url: `https://${host}/api/catalog` }, env: e })).text());
  const noDomain = await adminAnswer("opendecodesk.someone.workers.dev", {}), withDomain = await adminAnswer("admin.myshop.com", { ROOT_DOMAIN: "myshop.com" });
  ok("the admin is told the site's domain, or \"\" when there is none — never example.com", noDomain.status === "admin" && noDomain.site.rootDomain === "" && withDomain.site.rootDomain === "myshop.com");
  const adminJs = read("public/admin.js");
  ok("the admin (the shop wizard too) no longer works the domain out from its own address", /function siteRootDomain_\(\)\{ return String\(\(typeof siteInfo_/.test(adminJs) && !/siteRootDomain_[^\n]*location\.hostname/.test(adminJs) &&
    !/location\.hostname\.split\("\."\)\.slice\(1\)/.test(adminJs) && /siteInfo_ = data\.site \|\| \{\}/.test(read("public/index.html")));
  ok("…and with no domain the wizard warns on its first screen and goes on in preview mode, with the server's own words", adminJs.includes(`NO_DOMAIN_YET_ = "${openIt.body.message}"`) &&
    /noDomain && !made \? \{ nextLabel: "Continue in preview mode" \}/.test(adminJs) && /\$\{noDomain \? `<div class="wiz-warn">\$\{escapeHtml\(NO_DOMAIN_YET_\)\}<\/div>` : ""\}/.test(adminJs) && !/return NO_DOMAIN_YET_;/.test(adminJs));
  ok("…and its last step offers Preview instead of opening the shop", /if \(!root\) return \{\n    title: "Ready to open the shop\?", noNext: true,/.test(adminJs) && /onclick="previewShop_\(/.test(adminJs));

  console.log("\n=== The signing secret ===");
  // Cloudflare's page asks only for the setup password, so a button install has no SIGNING_SECRET
  // (draft previews, invoices, receipts and design links are signed with it). The Worker makes one.
  const wk = await import("./src/worker.js");
  const { createD1 } = require("./testlib/d1-shim.js");
  const sd1 = await createD1(); sd1._raw.exec(read("schema.sql"));
  const e1 = await wk.withSigningSecret({ DB: sd1 }), e2 = await wk.withSigningSecret({ DB: sd1, PROXY_ADMIN_PASSPHRASE: "x" });
  const stored = sd1.q("SELECT value FROM global_settings WHERE key = 'signingSecret'");
  ok("with none set, a random one is made once, kept in the database, and handed on as env.SIGNING_SECRET", /^[0-9a-f]{64}$/.test(e1.SIGNING_SECRET) && e2.SIGNING_SECRET === e1.SIGNING_SECRET &&
    stored.length === 1 && stored[0].value === e1.SIGNING_SECRET && e1.DB === sd1 && e2.PROXY_ADMIN_PASSPHRASE === "x");
  const ownSecret = { DB: sd1, SIGNING_SECRET: "the site's own" };
  ok("a site with its own SIGNING_SECRET keeps it (the env is passed on untouched)", (await wk.withSigningSecret(ownSecret)) === ownSecret);
  const lib = await import("./functions/_lib/db.js");
  const d2 = await createD1(); d2._raw.exec(read("schema.sql"));
  const [s1, s2] = await Promise.all([lib.ensureSigningSecret(d2), lib.ensureSigningSecret(d2)]);
  ok("two first requests at once end up with the same secret", s1 === s2 && d2.q("SELECT value FROM global_settings WHERE key = 'signingSecret'")[0].value === s1);
  const workerSrc = read("src/worker.js");
  ok("every request and the scheduled roll-up get it", /env = await withSigningSecret\(env\);\n  return handler\(/.test(workerSrc) && /handleScheduled\(event, env\) \{\n  env = await withSigningSecret\(env\);/.test(workerSrc));

  console.log("\n=== A forgotten password ===");
  ok("the sign-in box says what to do: ask an admin, or (the only admin) give the site a new setup password in Cloudflare and sign in with it",
    /Forgot your password\?/.test(adminJs) && /they can give you a new one under Users/.test(adminJs) && /Variables and Secrets<\/strong>, and change <strong>PROXY_ADMIN_PASSPHRASE/.test(adminJs) &&
    /npm run setup -- --new-passphrase/.test(adminJs) && /every user needs a new password/.test(adminJs) && /the one you chose on Cloudflare's page/.test(adminJs));

  console.log("\n=== What the button reads ===");
  const example = read(".dev.vars.example").split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const pkg = JSON.parse(read("package.json")), toml = read("wrangler.toml");
  ok(".dev.vars.example asks for the setup password only, and its value is the placeholder the site refuses", example.length === 1 && example[0] === "PROXY_ADMIN_PASSPHRASE=" + placeholder &&
    new RegExp('SETUP_PASSWORD_PLACEHOLDER = "' + placeholder + '"').test(read("functions/_lib/adminAuth.js")));
  ok("every value it asks for has a description written for someone who isn't technical", example.every(l => { const d = ((pkg.cloudflare || {}).bindings || {})[l.split("=")[0]]; return d && d.description.length > 80 && /workers\.dev/.test(d.description) && !/wrangler|CLI|terminal/i.test(d.description); }));
  ok("the build runs `npm run deploy`, which makes a new database's tables and manages the hostnames", pkg.scripts.deploy === "node scripts/deploy.mjs" && /process\.env\.WORKERS_CI/.test(read("scripts/deploy.mjs")) && !!pkg.version);
  ok("wrangler.toml works as the button finds it: the DB binding, the workers.dev address on, no previews, no active hostname list", /^\[\[d1_databases\]\]\nbinding = "DB"/m.test(toml) && /^workers_dev = true$/m.test(toml) && /^preview_urls = false$/m.test(toml) && !/^routes\s*=/m.test(toml));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.log("test116 crashed:", e); console.log("test116 crashed: false"); });
