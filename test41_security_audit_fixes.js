const fs = require("fs");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const crypto = require("crypto");
const { createD1 } = require("./testlib/d1-shim.js");

// Security behaviours (from an OWASP Top 10 pass):
//  audit-log summaries escaped; customer verify uploads: magic bytes;
//  customer response images must be our own uploads; CI hardening;
//  failed admin sign-ins counted + reported in the roll-up;
//  internal pricing errors not echoed; verification links expire;
//  webhook rejects future timestamps.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const emailSrc = strip(read("functions/_lib/email.js"));
const httpSrc = strip(read("functions/_lib/http.js"));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt) VALUES ('O1','prime','Ann','a@x.com',1000,1000,'2026-09-01T00:00:00Z');`);
  let emails = [];
  global.fetch = async (url, init) => { captureMail(url, init, emails); return MAIL_OK; };
  const env = { DB: d1, CRON_SECRET: "cron", ...MAIL_ENV, IMAGES: { put: async () => {} },
    R2_PUBLIC_BASE: "https://images.example.com", PROXY_ADMIN_PASSPHRASE: "correct horse" };

  console.log("=== #2 Audit log summaries are escaped ===");
  const adminSrc = read("public/admin.js");
  const grab = (name) => { const i = adminSrc.indexOf("function " + name); let d = 0; for (let k = adminSrc.indexOf("{", i); k < adminSrc.length; k++) {
    if (adminSrc[k] === "{") d++; else if (adminSrc[k] === "}" && --d === 0) return adminSrc.slice(i, k + 1); } };
  const summarize = new Function("function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}\n" +
    grab("auditDetailSummary") + "\nreturn auditDetailSummary;")();
  const evil = "<img src=x onerror=alert(1)>";
  const outs = [
    summarize("expense.created", { description: evil, amount: 5, category: evil }),
    summarize("expense_category.updated", { from: { name: evil }, to: { name: "x" } }),
    summarize("inventory.received", { blankName: evil, vendor: evil, qty: 3 }),
    summarize("some.future_action", { note: evil }),
  ];
  console.log("expense, category, inventory and unknown actions never emit raw HTML:", outs.every(o => !o.includes("<img") && o.includes("&lt;img")));

  console.log("\n=== #3 / #4 / #8 Customer design verification ===");
  const verify = new Function(httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/verifyLinks.js")) + "\n" +
    strip(read("functions/api/verify.js")).replace(/onRequestGet/g, "verifyGet").replace(/onRequestPost/g, "verifyPost") + "\n" +
    strip(read("functions/_lib/fileUpload.js")) + "\n" +
    strip(read("functions/api/upload-verify.js")).replace(/onRequestPost/g, "uploadPost").replace(/onRequestGet/g, "uploadGet") +
    "\nreturn { verifyGet, verifyPost, uploadPost };")();
  const mk = (token, sentAt) => d1._raw.exec(`INSERT INTO design_verifications (token, orgId, orderId, customerEmail, customerName, message, imagesJson, sentAt)
    VALUES ('${token}','prime','O1','a@x.com','Ann','Please check','[]','${sentAt}')`);
  mk("fresh", new Date().toISOString());
  mk("old", new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString());
  const up = (token, type, bytes) => verify.uploadPost({ env, request: { url: "https://prime.example.com/api/upload-verify?token=" + token,
    headers: { get: (h) => ({ "content-type": type, "content-length": String(bytes.length) })[h.toLowerCase()] || null },
    arrayBuffer: async () => new Uint8Array(bytes).buffer, body: null } });
  let res = await up("fresh", "image/png", Buffer.from("<html><script>alert(1)</script>"));
  console.log("#3 HTML disguised as image/png is refused (415):", res.status === 415);
  res = await up("fresh", "image/png", Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]));
  const upJson = JSON.parse(await res.text());
  console.log("…a real PNG is accepted:", res.status === 200 && upJson.url.startsWith("https://images.example.com/verify/"));
  res = await up("old", "image/png", Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  console.log("#8 an expired (61-day-old) link can't upload (410):", res.status === 410);
  res = await verify.verifyGet({ env, request: { url: "https://prime.example.com/api/verify?token=old" } });
  const resFresh = await verify.verifyGet({ env, request: { url: "https://prime.example.com/api/verify?token=fresh" } });
  console.log("#8 expired link can't be opened; a fresh one can:", res.status === 410 && resFresh.status === 200);
  res = await verify.verifyPost({ env, request: { json: async () => ({ token: "old", action: "approved" }) } });
  console.log("#8 expired link can't approve the design:", res.status === 410 && d1.q("SELECT status FROM design_verifications WHERE token='old'")[0].status === "pending");
  res = await verify.verifyPost({ env, request: { json: async () => ({ token: "fresh", action: "revision", note: "bigger",
    imageUrls: ["https://evil.example/track.png", "javascript:alert(1)", "https://images.example.com/uploads/prime/x.png", upJson.url] }) } });
  const saved = JSON.parse(d1.q("SELECT customerImagesJson j FROM design_verifications WHERE token='fresh'")[0].j);
  console.log("#4 only images uploaded through the verify page are kept:", res.status === 200 && saved.length === 1 && saved[0] === upJson.url);

  console.log("\n=== #6 Failed admin sign-ins ===");
  const digest = new Function(httpSrc + "\nfunction timingSafeEqual(a, b){ return a === b; }\nconst rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/api/daily-digest.js")) + "\nreturn onRequestPost;")();
  const runDigest = async () => { const r = await digest({ env, request: { json: async () => ({ key: "cron" }), headers: { get: () => null } } }); return JSON.parse(await r.text()); };
  await runDigest(); // send what's already queued (the design response above) so this section starts clean
  const accessSrc = strip(read("functions/_lib/access.js")), authSrc = strip(read("functions/_lib/adminAuth.js"));
  const session = new Function(httpSrc + "\n" + strip(read("functions/_lib/hostConfig.js")) + "\nconst getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });" +
    "\nconst rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;" +
    "\nconst rateLimitCheck = async () => ({ blocked: false }); const rateLimitHit = async () => {};\n" +
    "const rateLimitCheckGlobal = async () => ({ blocked: false }); const rateLimitHitGlobal = async () => {};\n" +
    accessSrc + "\n" + authSrc + "\n" + strip(read("functions/_lib/totp.js")) + "\n" + dbSrc + "\n" + strip(read("functions/api/admin-session.js")) + "\nreturn onRequestPost;")();
  const login = (body, ip = "198.51.100.7") => session({ env, request: { url: "https://admin.example.com/api/admin-session",
    headers: { get: (h) => ({ origin: "https://admin.example.com", "cf-connecting-ip": ip })[h.toLowerCase()] || null }, json: async () => body } });
  // 2FA on: base32 secret in D1
  await d1.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('totpSecret', 'JBSWY3DPEHPK3PXP')").run();
  await login({ key: "guess1" });
  await login({ key: "guess2" }, "203.0.113.9");
  res = await login({ key: "correct horse", totpCode: "000000" });
  const f = d1.q("SELECT value FROM global_settings WHERE key='failedAdminLogins'")[0];
  const fv = JSON.parse(f.value);
  console.log("wrong passphrase ×2 and wrong 2FA code counted with IPs:", res.status === 401 && fv.count === 3 && fv.passphrase === 2 && fv.code === 1 && fv.ips.length === 2);
  res = await login({ key: "correct horse" });
  console.log("correct passphrase (asked for code) isn't counted:", JSON.parse(await res.text()).status === "totp_required" &&
    JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='failedAdminLogins'")[0].value).count === 3);

  emails = [];
  let dg = await runDigest();
  console.log("3 failures alone (< 5) don't send an email:", dg.sent === false && emails.length === 0);
  await login({ key: "g4" }); await login({ key: "g5" });
  dg = await runDigest();
  const e = emails[0];
  console.log("5 failures send a roll-up on their own, flagged in the subject:", dg.sent === true && /🔒 5 failed admin sign-ins/.test(e.subject));
  console.log("…with the breakdown and the 'password was right' warning for wrong 2FA codes:",
    /4 wrong password, 1 wrong 2FA code/.test(e.htmlBody) && /198\.51\.100\.7/.test(e.htmlBody) && /password was right/.test(e.htmlBody));
  console.log("counter cleared after it's reported:", d1.q("SELECT count(*) n FROM global_settings WHERE key='failedAdminLogins'")[0].n === 0);

  console.log("\n=== #7 Internal pricing errors aren't echoed to customers ===");
  const lib = new Function(dbSrc + "\nreturn { priceItem };")();
  let userFacing = null;
  try { await lib.priceItem(d1, "prime", "nope", "", 1, false); } catch (err) { userFacing = err; }
  console.log("'Product not available' is marked safe to show:", !!userFacing && userFacing.userFacing === true && /not available/.test(userFacing.message));
  const ordersSrc = read("functions/api/orders.js");
  console.log("order submission returns e.message only for those, a generic message otherwise:",
    /e && e\.userFacing \? e\.message : "We couldn't price your order/.test(ordersSrc) && !/message: e\.message \|\| "Pricing error"/.test(ordersSrc));

  console.log("\n=== #9 Stripe webhook timestamps ===");
  const wh = new Function(httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/api/stripe-webhook.js")) + "\nreturn onRequestPost;")();
  const signedAt = (t) => { const body = JSON.stringify({ id: "evt_x" + t, type: "ping", data: { object: {} } });
    const sig = crypto.createHmac("sha256", "whsec").update(t + "." + body).digest("hex");
    return { text: async () => body, headers: { get: (h) => h === "stripe-signature" ? `t=${t},v1=${sig}` : null } }; };
  const now = Math.floor(Date.now() / 1000);
  const wenv = { DB: d1, STRIPE_WEBHOOK_SECRET: "whsec" };
  const past = await wh({ request: signedAt(now - 600), env: wenv }), future = await wh({ request: signedAt(now + 600), env: wenv }), ok = await wh({ request: signedAt(now), env: wenv });
  console.log("10 minutes old or 10 minutes in the future → rejected; current → accepted:", past.status === 401 && future.status === 401 && ok.status === 200);

  console.log("\n=== #5 / #11 CI and repo hygiene ===");
  const testYml = read(".github/workflows/test.yml");
  console.log("test workflow: read-only token, npm ci:", /permissions:\s*\n\s*contents: read/.test(testYml) && /run: npm ci/.test(testYml) && !/run: npm install/.test(testYml));
  console.log("backup script pins an exact wrangler version:", /wrangler@\d+\.\d+\.\d+/.test(read("scripts/d1-backup.sh")));
  console.log("stray 'boxSize 2.js' duplicate removed:", !fs.existsSync(__dirname + "/functions/_lib/boxSize 2.js"));
})().catch(e => { console.log("test41 crashed:", false); console.error(e); process.exit(1); });
