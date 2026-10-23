const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Opening a shop for orders (the setOrgReady action: its role and audit), and where "Shop setup" leads now: the New shop
// setup wizard (#wizard/<shop>) — the old step-list page at #setup/<shop> and the New shop form's address both lead
// there. The wizard itself is test149.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getPublicCatalogData, priceItem, getPublishState, getPublishedOrg, publishShop, getCatalogIssues, signPreviewToken, verifyPreviewToken };`)();
const common = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/setupStatus.js")) + "\n";
const api = new Function(common +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const catalogGet = new Function(common + dbSrc +
  "\nconst getCatalogData = async (env) => getPublicCatalogData(env.DB);\n" + strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',0), ('northside','northside','Northside','t','t',1);`);
  const ENV = { DB: d1, SIGNING_SECRET: "a-signing-secret-for-tests-0123456789abcdef" };
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: ENV, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const shopPage = async (org, query = "") => JSON.parse(await (await catalogGet({ request: new Request(shopOrigin(org) + "/api/catalog" + query), env: ENV })).text());

  console.log("=== Opening a shop for orders (setOrgReady) ===");
  let r = await call({ action: "setOrgReady", orgId: "acme", ready: true }, { role: "staff" });
  ok("a worker can't open a shop", r.status === 403);
  r = await call({ action: "setOrgReady", orgId: "acme", ready: true });
  ok("a manager opens it: only Ready changes, and it's audited as a shop change", r.status === 200 && d1.q("SELECT ready FROM orgs WHERE orgId='acme'")[0].ready === 1 &&
    /"ready":\{"from":false,"to":true\}/.test(d1.q("SELECT detail FROM audit_log WHERE action='org.updated' ORDER BY id DESC LIMIT 1")[0].detail));
  r = await call({ action: "setOrgReady", orgId: "nope", ready: true });
  ok("…an unknown shop is refused", r.status === 404);
  await call({ action: "setOrgReady", orgId: "acme", ready: false });

  console.log("\n=== Shop setup is the wizard ===");
  const adminJs = read("public/admin.js");
  ok("the old step-list page is gone", !/function renderShopSetup\b/.test(adminJs) && !/function shopSetupSteps_\b/.test(adminJs));
  ok("#setup/<shop>, #catalog/new-org and #wizard/… all open the wizard", /if \(setupMatch\) \{\s*const sOrgId = routeId_\(setupMatch\[1\]\);\s*if \(sOrgId\) await renderShopWizard\(app, sOrgId\)/.test(adminJs) &&   // (OpenDecoDesk checks the id: routeId_)
    /raw === "catalog\/new-org" \|\| raw === "wizard\/new"\) \{ await renderShopWizard\(app, null\)/.test(adminJs) && /wizardMatch = raw\.match\(\/\^wizard/.test(adminJs));
  ok("Manage catalog: '＋ New shop setup' at the top, 'Shop setup' on each row opening that shop's wizard", /onclick="location\.hash='#wizard\/new'">＋ New shop setup</.test(adminJs) &&
    /onclick="location\.hash='#wizard\/'\+encodeURIComponent\(this\.dataset\.org\)"[^>]*>Shop setup/.test(adminJs));
  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test148 crashed: false"); process.exit(1); });
