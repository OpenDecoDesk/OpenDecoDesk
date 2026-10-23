const fs = require("fs");

// customDomain.js, Worker mode (CF_WORKER_NAME): attaches an org's subdomain as a Workers Custom
// Domain. Cloudflare creates the DNS record and certificate; an existing DNS record is never
// overwritten. Pages mode is covered by test60 and must be unchanged.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dom = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/customDomain.js")) +
  "\nreturn { ensureOrgDomain, getOrgDomainStatus, customDomainConfig };")();

let dns = [], workerDomains = [], routes = [], calls = [], denyWorkers = false, denyRoutes = false;
const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
const fail = (status, message) => ({ status, body: { success: false, errors: [{ code: 1, message }], result: null } });
global.fetch = async (url, init = {}) => {
  const path = String(url).slice("https://api.cloudflare.com/client/v4".length), method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path, body });
  let r, m;
  if (/^\/accounts\/ACCT\/workers\/domains/.test(path) && denyWorkers) r = fail(403, "Authentication error");
  else if (path === "/zones/ZONE/workers/routes" && method === "GET") r = denyRoutes ? fail(403, "Authentication error") : ok(routes);
  else if ((m = path.match(/^\/zones\/ZONE\/dns_records\?name=(.+)$/))) r = ok(dns.filter(x => x.name === decodeURIComponent(m[1])));
  else if ((m = path.match(/^\/accounts\/ACCT\/workers\/domains\?hostname=(.+)$/)) && method === "GET") r = ok(workerDomains.filter(x => x.hostname === decodeURIComponent(m[1])));
  else if (path === "/accounts/ACCT/workers/domains" && method === "PUT") {
    workerDomains = workerDomains.filter(x => x.hostname !== body.hostname);
    workerDomains.push({ hostname: body.hostname, service: body.service, zone_id: body.zone_id });
    r = ok(workerDomains.at(-1));
  } else r = fail(400, "unexpected " + method + " " + path);
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
const reset = () => { dns = []; workerDomains = []; routes = []; calls = []; denyWorkers = false; denyRoutes = false; };
const ENV = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "ACCT", CF_ZONE_ID: "ZONE", CF_WORKER_NAME: "opendecodesk" };

(async () => {
  console.log("=== Worker mode configuration ===");
  console.log("Worker mode when CF_WORKER_NAME is set:", dom.customDomainConfig(ENV).mode === "worker");
  console.log("Worker mode wins if both names are set:", dom.customDomainConfig({ ...ENV, CF_PAGES_PROJECT: "opendecodesk" }).mode === "worker");
  console.log("Pages mode when only CF_PAGES_PROJECT is set:", dom.customDomainConfig({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "A", CF_ZONE_ID: "Z", CF_PAGES_PROJECT: "p" }).mode === "pages");
  console.log("off without a token / account / zone:", dom.customDomainConfig({ CF_WORKER_NAME: "w" }) === null && dom.customDomainConfig({ ...ENV, CF_ZONE_ID: "" }) === null);

  console.log("\n=== Attaching a shop's domain ===");
  reset();
  let d = await dom.ensureOrgDomain(ENV, "Club404");
  const put = calls.find(c => c.method === "PUT");
  console.log("PUTs the Workers custom domain for the shop's hostname:", !!put && put.body.hostname === "club404.example.com" && put.body.service === "opendecodesk" && put.body.zone_id === "ZONE");
  console.log("creates no DNS record itself (Cloudflare does):", !calls.some(c => c.method === "POST"));
  console.log("reports it as added:", d.configured && d.exists && d.status === "active" && /custom domain added/.test(d.steps.join("|")));

  console.log("\n=== Idempotent ===");
  calls = [];
  d = await dom.ensureOrgDomain(ENV, "club404");
  console.log("a second run changes nothing:", !calls.some(c => c.method === "PUT") && /already added/.test(d.steps.join("|")));

  console.log("\n=== Never overwrites an existing DNS record (e.g. a Pages CNAME) ===");
  reset(); dns = [{ type: "CNAME", name: "rec.example.com", content: "opendecodesk.pages.dev" }];
  let msg = ""; try { await dom.ensureOrgDomain(ENV, "rec"); } catch (e) { msg = e.message; }
  console.log("refuses with a clear message:", /already has a DNS record \(CNAME → opendecodesk\.pages\.dev\)/.test(msg));
  console.log("and attaches nothing:", !calls.some(c => c.method === "PUT"));

  console.log("\n=== A domain attached to a different Worker ===");
  reset(); workerDomains = [{ hostname: "rec.example.com", service: "opendecodesk-staging" }];
  const st = await dom.getOrgDomainStatus(ENV, "rec");
  console.log("status flags the mismatch:", st.exists && st.status === "error" && /different Worker/.test(st.error));
  d = await dom.ensureOrgDomain(ENV, "rec");
  console.log("ensure moves it to this Worker:", workerDomains[0].service === "opendecodesk" && /moved/.test(d.steps.join("|")));

  console.log("\n=== Status without changing anything ===");
  reset();
  console.log("not attached → exists:false:", (await dom.getOrgDomainStatus(ENV, "newshop")).exists === false && !calls.some(c => c.method === "PUT"));
  console.log("invalid names rejected before any call:", await dom.getOrgDomainStatus(ENV, "bad sub!").then(() => false, e => /valid subdomain/.test(e.message)));
  console.log("\n=== Hosts served by a Worker ROUTE (a route in front of an existing DNS record) ===");
  reset(); routes = [{ pattern: "league101.example.com/*", script: "opendecodesk" }, { pattern: "other.example.com/*", script: "someone-else" }];
  let st2 = await dom.getOrgDomainStatus(ENV, "league101");
  console.log("a routed host reports as set up, via the route:", st2.exists && st2.status === "active" && st2.via === "Worker route");
  console.log("a route for a DIFFERENT Worker doesn't count:", (await dom.getOrgDomainStatus(ENV, "other")).exists === false);
  calls = []; d = await dom.ensureOrgDomain(ENV, "league101");
  console.log("ensure leaves a routed host alone (no PUT, no DNS write):", !calls.some(c => c.method === "PUT" || c.method === "POST") && /Worker route/.test(d.steps.join("|")));
  reset(); routes = [{ pattern: "*.example.com/*", script: "opendecodesk" }];
  console.log("a wildcard route covers any shop:", (await dom.getOrgDomainStatus(ENV, "newshop")).via === "Worker route");

  console.log("\n=== Missing API permission ===");
  reset(); denyWorkers = true; routes = [{ pattern: "league101.example.com/*", script: "opendecodesk" }];
  console.log("a token that can read routes but not custom domains still shows a routed host:", (await dom.getOrgDomainStatus(ENV, "league101")).exists === true);
  let em = ""; try { await dom.getOrgDomainStatus(ENV, "unrouted"); } catch (e) { em = e.message; }
  console.log("nothing found + a lookup failed → the Cloudflare error is reported (not 'not set up'):", /Authentication error/.test(em));
  reset(); denyWorkers = true; denyRoutes = true;
  em = ""; try { await dom.getOrgDomainStatus(ENV, "league101"); } catch (e) { em = e.message; }
  console.log("both lookups denied → error:", /Authentication error/.test(em));
  console.log("a refusal names the permissions the token needs:", /Workers Scripts: Edit/.test(em) && /Workers Routes: Edit/.test(em));
})().catch((e) => { console.log("test85 crashed:", false); console.error(e); process.exit(1); });
