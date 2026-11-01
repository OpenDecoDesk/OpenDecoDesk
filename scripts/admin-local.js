#!/usr/bin/env node
// Open the ADMIN panel on this computer against a throwaway in-memory database — for looking at an
// admin screen while changing it. Nothing here touches Cloudflare or any real data.
//
//   node scripts/admin-local.js            → http://localhost:8790
//   node scripts/admin-local.js 8791       → another port
//
// Why this exists: the real site decides "am I the admin panel?" from the hostname, so localhost is
// treated as the bare root domain and `wrangler dev` only ever shows the generic page. This serves
// public/ as-is and answers the two calls the admin needs: /api/catalog says "admin", and
// /api/orders runs the REAL handler (functions/api/orders.js + db.js) on SQLite built from the real
// migrations, with sign-in stubbed out. Stripe, Shippo and email aren't wired; uploads to the private
// design bucket (/api/design, /api/customer-design) go to an in-memory stand-in for it.
// The database starts with one empty shop ("demo") and is gone when the process stops.
//
//   http://localhost:8790/?shop=demo      → the "demo" SHOP page instead (as on demo.<domain>): the
//                                           real catalog and order handlers on the live database (no
//                                           Publish needed here), Turnstile off.
//   http://localhost:8790/?invoice=<token>  → a customer's invoice page (the token from the link the
//                                           Send invoice window shows): the real /api/invoice; its
//                                           shipping rates are SAMPLE numbers and card checkout isn't wired.
//
//   node scripts/admin-local.js --sign-in  → the REAL sign-in, users and roles as well
// With --sign-in nothing is stubbed on the way in: the page asks for an email and password, the
// account, users and two-step endpoints and the role checks are the real ones, and the first
// sign-in is with the "installer's passphrase" this prints. For looking at the sign-in screens,
// the Users page, or the admin as a Back office user or a manager.
//
//   node scripts/admin-local.js --no-domain → the admin as a Deploy-button install sees it before its
//                                             Setup step: the site has no domain (shops wait for one). The admin
//                                             is "on" opendecodesk.someone.workers.dev, and Global settings →
//                                             Your domain talks to a stand-in Cloudflare that takes any key-shaped
//                                             text (nothing is sent to Cloudflare).
const fs = require("fs");
const http = require("http");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { createD1 } = require(path.join(ROOT, "testlib", "d1-shim.js"));
const SIGN_IN = process.argv.includes("--sign-in");
const PORT = Number(process.argv.slice(2).find(a => /^\d+$/.test(a))) || 8790;
const LOCAL_PASSPHRASE = "local-only-passphrase";   // what `npm run setup` would have printed; only this process knows it

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const NO_DOMAIN = process.argv.includes("--no-domain");
const ADMIN_HOST = NO_DOMAIN ? "opendecodesk.someone.workers.dev" : "admin.example.com";
if (NO_DOMAIN) {
  // A stand-in for Cloudflare's API, for the domain step: one active domain (example.com) on the account this
  // "Worker" runs on. Every other address is fetched as usual.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin !== "https://api.cloudflare.com") return realFetch(url, init);
    const p = u.pathname.replace(/^\/client\/v4/, "");
    const result = p === "/user/tokens/verify" ? { status: "active" }
      : p === "/zones" ? [{ id: "local-zone", name: "example.com", status: "active", account: { id: "local-account" } }]
      : /\/workers\/subdomain$/.test(p) ? { subdomain: "someone" }
      : /\/settings$/.test(p) ? { bindings: [] } : {};
    return new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { "Content-Type": "application/json" } });
  };
}
const SHOP_MAP = "{ demo: 'demo' }";   // demo.example.com is the demo shop
// Communications → Send a test email runs the real one (with no provider set locally, it says so).
const buildTestEmail = () => new Function(strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\nreturn sendTestEmail;")();
const buildHandler = () => new Function("sendTestEmail",
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'local';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async (env) => ({ subdomainMap: " + SHOP_MAP + ", orgs: {}, features: await getFeatures(env.DB) });\n" +
  "const sendInvoiceEmail = async () => false;\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false }), ensureWorkerHostname = async () => ({ steps: ['custom domain added'] });\n" +
  strip(read("functions/_lib/cloudflareSetup.js")) + "\n" +
  // Vendor blanks / connections: the image-fallback copy, the PromoStandards adapter, encrypted logins.
  strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" + strip(read("functions/_lib/orphanImages.js")) + "\n" +
  strip(read("functions/_lib/promostandards.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/vendorLog.js")) + "\n" + strip(read("functions/_lib/supplierOrders.js")) + "\n" +
  strip(read("functions/_lib/setupStatus.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")(buildTestEmail());
// The shop page's catalog (functions/api/catalog.js) on the published catalog, as demo.example.com sees it.
const buildCatalog = () => new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  "const getCatalogData = async (env) => ({ ...(await getPublicCatalogData(env.DB)), subdomainMap: " + SHOP_MAP + " });\n" +
  strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
// The customer's design upload (functions/api/customer-design.js), Turnstile and the rate limit off.
const buildCustomerDesign = () => new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" +
  strip(read("functions/_lib/imageInfo.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const getCatalogData = async (env) => ({ subdomainMap: " + SHOP_MAP + ", orgs: {}, features: await getFeatures(env.DB) });\n" +
  strip(read("functions/api/customer-design.js")) + "\nreturn onRequestPost;")();
// The admin's private-file endpoint (functions/api/design.js): uploads, signed links, downloads.
const buildDesign = () => new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" +
  "const requireAdmin = async () => null; const timingSafeEqual = (a, b) => a === b;\n" +
  strip(read("functions/api/design.js")) + "\nreturn { post: onRequestPost, get: onRequestGet };")();
// The customer's invoice page (functions/api/invoice.js), with the real db.js, email.js and quote signing.
const buildInvoice = () => new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const invoice = (function(){\n" + strip(read("functions/api/invoice.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { invoice, signQuote, canonicalItems };")();
// An in-memory stand-in for the private DESIGNS bucket.
const memoryBucket = () => {
  const m = new Map();
  return {
    put: async (key, bytes, opts = {}) => { m.set(key, { bytes: new Uint8Array(bytes), httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} }); },
    get: async (key) => { const o = m.get(key); return o ? { body: o.bytes, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null; },
    delete: async (key) => { m.delete(key); },
  };
};

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain" };
// The page finds a stored "cookie" session and skips the passphrase prompt (sign-in is stubbed anyway).
const SESSION = `<script>try{localStorage.setItem("oddAdminSession",JSON.stringify({token:"cookie",expires:new Date(Date.now()+864e5).toISOString()}))}catch(e){}</script>`;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const now = new Date().toISOString();
  await d1.prepare("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('demo', 'demo', 'Demo Shop', ?, ?, 1)").bind(now, now).run();
  const api = buildHandler(), catalogApi = buildCatalog(), customerDesignApi = buildCustomerDesign(), designApi = buildDesign(), invoiceApi = buildInvoice();
  const DESIGNS = memoryBucket(), SIGNING_SECRET = require("crypto").randomBytes(24).toString("hex");
  // A request made from the shop page (?shop=…) is answered as demo.example.com; anything else as the admin.
  const shopMode = (req) => /[?&]shop=/.test(String(req.headers.referer || ""));
  const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
  const reply = async (res, out) => {
    const headers = {}; out.headers.forEach((v, k) => { headers[k] = v; }); headers["cache-control"] = headers["cache-control"] || "no-store";
    res.writeHead(out.status, headers); res.end(Buffer.from(await out.arrayBuffer()));
  };
  // A Request-like object for the handlers: the body as bytes, the headers as sent.
  const fakeRequest = (req, url, host, buf) => ({ url: "https://" + host + url.pathname + url.search, method: req.method,
    headers: { get: (n) => { const v = req.headers[String(n).toLowerCase()]; return v == null ? null : String(v); } },
    body: null, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), json: async () => JSON.parse(buf.toString("utf8") || "{}") });
  // --sign-in: the real gate and account endpoints on the same database (testlib/auth-harness.js).
  const real = SIGN_IN ? (await require(path.join(ROOT, "testlib", "auth-harness.js")).makeAuth({ d1, passphrase: LOCAL_PASSPHRASE })) : null;
  const send = (res, status, body, type) => { res.writeHead(status, { "Content-Type": type || "application/json", "Cache-Control": "no-store" }); res.end(body); };

  http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/catalog" && shopMode(req)) {
        return reply(res, await catalogApi({ request: { url: "https://demo.example.com/api/catalog", headers: { get: () => null } }, env: { DB: d1 } }));
      }
      if (url.pathname === "/api/customer-design" && req.method === "POST") {
        const buf = await readBody(req);
        return reply(res, await customerDesignApi({ request: fakeRequest(req, url, "demo.example.com", buf), env: { DB: d1, DESIGNS } }));
      }
      if (url.pathname === "/api/design") {
        const buf = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
        const out = await designApi[req.method === "POST" ? "post" : "get"]({ request: fakeRequest(req, url, "admin.example.com", buf), env: { DB: d1, DESIGNS, SIGNING_SECRET } });
        return reply(res, out);
      }
      if (url.pathname === "/api/invoice") {
        const buf = await readBody(req);
        const ctx = { env: { DB: d1, SIGNING_SECRET }, waitUntil: (p) => { Promise.resolve(p).catch(() => {}); }, request: fakeRequest(req, url, "demo.example.com", buf) };
        return reply(res, await (req.method === "POST" ? invoiceApi.invoice.onRequestPost(ctx) : invoiceApi.invoice.onRequestGet(ctx)));
      }
      // Shipping rates for the invoice page: SAMPLE numbers, signed with this process's key so a
      // choice can be saved. (Shippo isn't wired here.)
      if (url.pathname === "/api/shipping" && req.method === "POST") {
        const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const rate = async (provider, service, amount, days) => ({ provider, service, amount, estimatedDays: days, quoteToken: await invoiceApi.signQuote({ SIGNING_SECRET },
          { orgId: b.org || "demo", zip: String(b.zip || ""), items: invoiceApi.canonicalItems(b.items), amountCents: Math.round(amount * 100), method: provider + " " + service }) });
        return send(res, 200, JSON.stringify({ status: "ok", manualShipping: false, rates: [await rate("USPS", "Ground Advantage (sample)", 8.42, 3), await rate("UPS", "Ground (sample)", 11.10, 2)] }));
      }
      if (url.pathname === "/api/catalog") {
        // The switches under Global settings → Features, as the real /api/catalog sends them.
        const row = await d1.prepare("SELECT value FROM global_settings WHERE key='features'").first();
        let features = {}; try { features = row ? JSON.parse(row.value) : {}; } catch (e) {}
        // site.rootDomain as on an install with a domain (--no-domain: as a Deploy-button install before its Setup step).
        return send(res, 200, JSON.stringify({ status: "admin", features, site: { rootDomain: NO_DOMAIN ? "" : "example.com" } }));
      }
      if (real && real.raw[url.pathname] && real.raw[url.pathname][req.method]) {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        // The app answers on admin.<domain> over https; here the page is on localhost. A request the
        // browser marks as coming from this same page is passed on as same-origin.
        const sameOrigin = !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host;
        const header = (name) => { const n = String(name).toLowerCase(); return n === "origin" ? (sameOrigin ? "https://admin.example.com" : req.headers.origin || null) : n === "cf-connecting-ip" ? "127.0.0.1" : req.headers[n] || null; };
        const out = await real.raw[url.pathname][req.method]({ env: real.env, waitUntil: (p) => { Promise.resolve(p).catch(() => {}); },
          request: { url: "https://admin.example.com" + url.pathname, method: req.method, json: async () => body, headers: { get: header } } });
        const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
        // Secure cookies are accepted from http://localhost by current browsers; the __Host- prefix is kept as is.
        if (out.headers.get("Set-Cookie")) headers["Set-Cookie"] = out.headers.get("Set-Cookie");
        res.writeHead(out.status, headers); return res.end(await out.text());
      }
      if (url.pathname === "/api/orders" && req.method === "POST") {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        // VENDOR_CREDENTIALS_KEY: a throwaway key so Vendor integrations can save a (test) login on this computer.
        const out = await api({ env: { DB: d1, DESIGNS, VENDOR_CREDENTIALS_KEY: "local-preview-only-vendor-key" }, waitUntil: (p) => { Promise.resolve(p).catch(() => {}); },
          request: { url: "https://" + (shopMode(req) ? "demo.example.com" : ADMIN_HOST) + "/api/orders", json: async () => body, headers: { get: () => null } } });
        return send(res, out.status, await out.text());
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, JSON.stringify({ status: "error", message: "Not wired in the local admin (" + url.pathname + ")" }));
      const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
      const file = path.join(ROOT, "public", rel);
      if (rel && file.startsWith(path.join(ROOT, "public") + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
      return send(res, 200, SIGN_IN || url.searchParams.has("shop") ? read("public/index.html") : read("public/index.html").replace("<head>", "<head>" + SESSION), TYPES[".html"]);
    } catch (e) { console.error(e); return send(res, 500, JSON.stringify({ status: "error", message: String((e && e.message) || e) })); }
  }).listen(PORT, "127.0.0.1", () => console.log(SIGN_IN
    ? `Local admin (in-memory database, REAL sign-in): http://localhost:${PORT}\n  First sign-in: leave the email empty, password: ${LOCAL_PASSPHRASE}`
    : `Local admin (in-memory database, sign-in stubbed): http://localhost:${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
