const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Automatic custom-domain setup for a new org (functions/_lib/customDomain.js): a proxied CNAME
// in the zone + the Pages custom domain, via the Cloudflare API (mocked here, statefully).
// Real db.js + orders.js + admin.js (jsdom).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const hostSrc = strip(read("functions/_lib/hostConfig.js"));
const domSrc = strip(read("functions/_lib/customDomain.js"));
const dom = new Function(hostSrc + "\n" + domSrc + "\nreturn { ensureOrgDomain, getOrgDomainStatus, orgHostname, customDomainConfig };")();

// ---- fake Cloudflare API --------------------------------------------------
let dns = [], domains = {}, calls = [], failNext = null;
const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
const fail = (status, message) => ({ status, body: { success: false, errors: [{ code: 1, message }], result: null } });
function cfApi(method, path, body, auth) {
  calls.push({ method, path, body, auth });
  if (failNext && failNext.match(method, path)) { const f = failNext; failNext = null; return fail(f.status, f.message); }
  let m;
  if ((m = path.match(/^\/zones\/ZONE\/dns_records\?name=(.+)$/)) && method === "GET") return ok(dns.filter(r => r.name === decodeURIComponent(m[1])));
  if (path === "/zones/ZONE/dns_records" && method === "POST") { const r = { id: "d" + (dns.length + 1), ...body }; dns.push(r); return ok(r); }
  if ((m = path.match(/^\/accounts\/ACCT\/pages\/projects\/opendecodesk\/domains\/(.+)$/))) {
    const d = domains[m[1]];
    if (method === "GET") return d ? ok(d) : fail(404, "Domain not found");
    if (method === "PATCH") { d.status = "pending"; d.validation_data = { status: "pending", method: "http" }; return ok(d); }
  }
  if (path === "/accounts/ACCT/pages/projects/opendecodesk/domains" && method === "POST") {
    domains[body.name] = { name: body.name, status: "initializing", validation_data: { status: "initializing", method: "http" } };
    return ok(domains[body.name]);
  }
  return fail(400, "unexpected " + method + " " + path);
}
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.cloudflare.com/client/v4")) return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  const r = cfApi(init.method || "GET", u.slice("https://api.cloudflare.com/client/v4".length), init.body ? JSON.parse(init.body) : null, init.headers && init.headers.Authorization);
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
const reset = () => { dns = []; domains = {}; calls = []; failNext = null; };
const ENV = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "ACCT", CF_ZONE_ID: "ZONE", CF_PAGES_PROJECT: "opendecodesk" };

(async () => {
  console.log("=== customDomain.js ===");
  console.log("off unless all four CF_* vars are set:", (await dom.ensureOrgDomain({ CF_API_TOKEN: "x" }, "club404")).configured === false && calls.length === 0);
  let threw = ""; try { dom.orgHostname("bad sub!"); } catch (e) { threw = e.message; }
  console.log("rejects an invalid subdomain before touching DNS:", /isn't a valid subdomain/.test(threw));
  threw = ""; try { dom.orgHostname("admin"); } catch (e) { threw = e.message; }
  console.log("refuses reserved names (admin, www…):", /reserved/.test(threw));

  reset();
  let d = await dom.ensureOrgDomain(ENV, "Club404");
  console.log("creates a proxied CNAME to the project's pages.dev host:", dns.length === 1 && dns[0].type === "CNAME" && dns[0].name === "club404.example.com" &&
    dns[0].content === "opendecodesk.pages.dev" && dns[0].proxied === true);
  console.log("then adds the Pages custom domain, reporting its status:", !!domains["club404.example.com"] && d.hostname === "club404.example.com" && d.status === "initializing" &&
    d.steps.join("|") === "DNS record created|custom domain added");
  console.log("authenticates with the API token:", calls.every(c => c.auth === "Bearer tok"));
  calls = [];
  d = await dom.ensureOrgDomain(ENV, "club404");
  console.log("running again changes nothing (idempotent):", dns.length === 1 && !calls.some(c => c.method === "POST") && d.steps.join("|") === "DNS record already in place|custom domain already added");
  domains["club404.example.com"].status = "error";
  d = await dom.ensureOrgDomain(ENV, "club404");
  console.log("a domain stuck in error gets its validation retried:", calls.some(c => c.method === "PATCH") && d.status === "pending" && d.steps.includes("validation retried"));
  domains["club404.example.com"].status = "active";
  const st = await dom.getOrgDomainStatus(ENV, "club404");
  console.log("status check reads without changing anything:", st.exists && st.status === "active" && calls.filter(c => c.method !== "GET").length === 1);
  console.log("status for a domain not added yet:", (await dom.getOrgDomainStatus(ENV, "nothere")).exists === false);

  reset(); dns.push({ id: "x", type: "A", name: "clash.example.com", content: "1.2.3.4" });
  threw = ""; try { await dom.ensureOrgDomain(ENV, "clash"); } catch (e) { threw = e.message; }
  console.log("never overwrites an existing, different DNS record:", /already has a DNS record \(A → 1\.2\.3\.4\)/.test(threw) && dns.length === 1 && !domains["clash.example.com"]);
  reset(); failNext = { match: (m, p) => m === "POST" && /domains$/.test(p), status: 403, message: "Authentication error" };
  threw = ""; try { await dom.ensureOrgDomain(ENV, "noperm"); } catch (e) { threw = e.message; }
  console.log("a Cloudflare error comes back with Cloudflare's message:", /couldn't add the custom domain: Authentication error/.test(threw));

  console.log("\n=== Admin actions (orders.js) ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const dbSrc = strip(read("functions/_lib/db.js"));
  const api = new Function(hostSrc + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + domSrc + "\n" +
    strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  let env = { DB: d1, ...ENV };
  const waits = [];
  const call = async (body) => {
    const x = await api({ env, waitUntil: (p) => waits.push(p), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits.splice(0));
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  reset();
  let r = await call({ action: "createOrg", orgId: "club-404", subdomain: "club404", name: "Example Club 404" });
  console.log("createOrg sets up the domain and returns its result:", r.status === 200 && r.body.domain.hostname === "club404.example.com" && r.body.domain.status === "initializing" &&
    dns.length === 1 && !!domains["club404.example.com"]);
  console.log("audited (org.domain_setup):", d1.q("SELECT orgId FROM audit_log WHERE action='org.domain_setup'").some(a => a.orgId === "club-404"));
  reset(); failNext = { match: (m, p) => m === "POST" && /dns_records$/.test(p), status: 403, message: "DNS permission missing" };
  r = await call({ action: "createOrg", orgId: "rec2", subdomain: "rec2", name: "REC 2" });
  console.log("a domain failure doesn't stop the org being created — it's reported:", r.status === 200 && /DNS permission missing/.test(r.body.domain.error) &&
    d1.q("SELECT count(*) n FROM orgs WHERE orgId='rec2'")[0].n === 1 && d1.q("SELECT count(*) n FROM audit_log WHERE action='org.domain_setup_failed'")[0].n === 1);
  r = await call({ action: "setupOrgDomain", orgId: "rec2" });
  console.log("setupOrgDomain retries it from the org's saved subdomain:", r.body.domain.hostname === "rec2.example.com" && !r.body.domain.error && !!domains["rec2.example.com"]);
  domains["rec2.example.com"].status = "active";
  r = await call({ action: "getOrgDomainStatus", orgId: "rec2" });
  console.log("getOrgDomainStatus reports it:", r.body.domain.status === "active");
  console.log("unknown org → 404:", (await call({ action: "setupOrgDomain", orgId: "nope" })).status === 404);
  env = { DB: d1 };
  r = await call({ action: "createOrg", orgId: "noenv", subdomain: "noenv", name: "No Env" });
  console.log("without the CF_* vars, createOrg still works and says setup isn't configured:", r.status === 200 && r.body.domain.configured === false);
  env = { DB: d1, ...ENV };

  console.log("\n=== Org edit page (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const jd = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = jd.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };
  const app = w.document.getElementById("app");
  const box = () => w.document.getElementById("orgDomainBox");
  const boxText = () => box().textContent.replace(/\s+/g, " ");
  w.renderOrgForm(app, { orgId: "rec2", subdomain: "rec2", name: "REC 2", designImages: {} });
  await wait(() => /live \(active\)/.test(boxText()));
  console.log("edit page shows the domain's live status:", /rec2\.example\.com is live \(active\)/.test(boxText()) && !/Set up domain|Retry setup/.test(boxText()));
  delete domains["rec2.example.com"];
  [...box().querySelectorAll("button")].find(b => /Check again/.test(b.textContent)).click();
  await wait(() => /hasn't been added/.test(boxText()));
  console.log("a missing domain offers Set up domain:", /hasn't been added/.test(boxText()) && /Set up domain/.test(boxText()));
  [...box().querySelectorAll("button")].find(b => /Set up domain/.test(b.textContent)).click();
  await wait(() => /added — status: initializing/.test(boxText()));
  console.log("clicking it sets the domain up and shows the new status:", /added — status: initializing/.test(boxText()) && !!domains["rec2.example.com"]);
  console.log("the new-org form has no status box (nothing to check yet):", (() => { w.renderOrgForm(app, null); return !box(); })());
})().catch(e => { console.log("test60 crashed:", false); console.error(e); process.exit(1); });
