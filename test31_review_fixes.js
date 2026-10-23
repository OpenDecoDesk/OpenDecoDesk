const fs = require("fs");

// Regression tests for security behaviour that isn't already
// covered by test8 (order submission / Turnstile) or test19 (webhook
// idempotency): admin auth failing CLOSED on storage errors, no
// TOTP-leaking GET, the per-token verification upload cap, design approval
// landing in D1, and /api/shipping signing quotes with catalog weights.

const { makePlatformDb, platformGlobals, brokenDb, seedSession } = require("./testlib/platform-db");
Object.assign(global, platformGlobals());

const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");

function jsonReq(url, body, headers = {}){
  return {
    url,
    json: async () => body,
    headers: { get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null },
  };
}

(async () => {
  // ---------------------------------------------------------------------
  // adminAuth.js — fails CLOSED (sessions are HttpOnly cookies)
  // ---------------------------------------------------------------------
  {
    global.rateLimited = async () => ({ blocked: false, retryAfter: 0 });
global.rateLimitCheck = async () => ({ blocked: false, retryAfter: 0 });
global.rateLimitHit = async () => {};
global.rateLimitCheckGlobal = async () => ({ blocked: false, retryAfter: 0 }); global.rateLimitHitGlobal = async () => {};
    global.rateLimitResponse = () => new Response("", { status: 429 });
    const ns = {};
    new Function("ns", strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/access.js")) + "\n" +
      strip(read("functions/_lib/adminAuth.js")) +
      "\nns.requireAdmin = requireAdmin; ns.getActiveSecret = getActiveSecret;")(ns);
    const ADMIN = { kind: "admin" };
    const validToken = "sess_" + "a".repeat(48);
    const ADMIN_URL = "https://admin.example.com/api/orders";
    const req = (cookieToken) => ({ url: ADMIN_URL, headers: { get: (h) => ({
      "CF-Connecting-IP": "1.2.3.4",
      "Origin": "https://admin.example.com",
      "Cookie": cookieToken ? "__Host-odd_admin=" + cookieToken : null,
    })[h] ?? null } });
    const broken = { DB: brokenDb("D1 daily read limit exceeded"), PROXY_ADMIN_PASSPHRASE: "pw" };

    console.log("\n=== adminAuth: storage outage + session cookie → 503, NOT admitted (was: fail open) ===");
    let r = await ns.requireAdmin(broken, ADMIN, "cookie", req(validToken));
    console.log("Refused with 503:", r !== null && r.status === 503);
    r = await ns.requireAdmin(broken, ADMIN, "cookie", req("sess_anything"));
    console.log("Malformed session cookie refused (401):", r !== null && r.status === 401);

    console.log("\n=== adminAuth: storage outage on the passphrase path → 503, NOT a silent 2FA downgrade ===");
    r = await ns.requireAdmin(broken, ADMIN, "pw", req(null));
    console.log("Correct passphrase still refused with 503 while TOTP state is unknown:", r !== null && r.status === 503);

    console.log("\n=== adminAuth: healthy storage still works normally ===");
    const DB = await makePlatformDb();
    await seedSession(DB, validToken, new Date(Date.now() + 3600e3).toISOString());
    const okEnv = { DB, PROXY_ADMIN_PASSPHRASE: "pw" };
    r = await ns.requireAdmin(okEnv, ADMIN, "cookie", req(validToken));
    console.log("Valid session cookie admitted:", r === null);
    r = await ns.requireAdmin(okEnv, ADMIN, "cookie", req("sess_" + "b".repeat(48)));
    console.log("Unknown session → 401:", r !== null && r.status === 401);
    const expiredTok = "sess_" + "e".repeat(48);
    await seedSession(DB, expiredTok, new Date(Date.now() - 1000).toISOString());
    r = await ns.requireAdmin(okEnv, ADMIN, "cookie", req(expiredTok));
    console.log("Expired session → 401:", r !== null && r.status === 401);
    console.log("The raw token is never stored (only its hash):", DB.q("SELECT tokenHash FROM admin_sessions").every(x => x.tokenHash !== validToken && /^[0-9a-f]{64}$/.test(x.tokenHash)));
    r = await ns.requireAdmin(okEnv, ADMIN, "pw", req(null));
    console.log("Passphrase accepted when TOTP is genuinely off:", r === null);
    // Two-step sign-in belongs to the admin the passphrase would sign in as.
    await DB.prepare("UPDATE users SET totpSecret = ? WHERE role = 'admin'").bind("JBSWY3DPEHPK3PXP").run();
    r = await ns.requireAdmin(okEnv, ADMIN, "pw", req(null));
    console.log("Bare passphrase refused when TOTP is on (403):", r !== null && r.status === 403);
  }

  // ---------------------------------------------------------------------
  // admin-session.js — no GET that leaks the TOTP secret
  // ---------------------------------------------------------------------
  {
    console.log("\n=== admin-session: GET no longer returns the otpauth URI ===");
    const src = read("functions/api/admin-session.js");
    const ns = {};
    global.classifyHost = () => ({ kind: "admin" });
    global.getCatalogData = async () => ({ subdomainMap: {} });
    new Function("ns", strip(read("functions/_lib/http.js")) + "\n" + strip(src) + "\nns.get = onRequestGet;")(ns);
    const res = await ns.get({ request: { url: "https://admin.example.com/api/admin-session?key=pw" },
      env: { PROXY_ADMIN_PASSPHRASE: "pw", TOTP_SECRET: "JBSWY3DPEHPK3PXP" } });
    const text = await res.text();
    console.log("GET → 405:", res.status === 405);
    console.log("Response contains no otpauth URI / secret:", !text.includes("otpauth") && !text.includes("JBSWY3DPEHPK3PXP"));
  }

  // ---------------------------------------------------------------------
  // upload-verify.js — per-token upload cap
  // ---------------------------------------------------------------------
  {
    console.log("\n=== upload-verify: uploads per verification token are capped ===");
    let count = 0, cap = null, puts = 0;
    global.getDesignVerification = async () => ({ token: "t", status: "pending" });
    global.reserveVerificationUpload = async (db, token, max) => { cap = max; if(count >= max) return false; count++; return true; };
    global.releaseVerificationUpload = async () => { count--; };
    const ns = {};
    new Function("ns", strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/verifyLinks.js")) + "\n" +
      strip(read("functions/api/upload-verify.js")) + "\nns.post = onRequestPost;")(ns);
    const env = { DB: {}, R2_PUBLIC_BASE: "https://img.example.com", IMAGES: { put: async () => { puts++; } } };
    const upload = () => ns.post({ env, request: {
      url: "https://x.example.com/api/upload-verify?token=t",
      headers: { get: (h) => h === "Content-Type" ? "image/png" : null },
      arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).buffer, // a real PNG header
    }});
    const statuses = [];
    for(let i = 0; i < 10; i++) statuses.push((await upload()).status);
    console.log("Cap is a small number (<= 6):", cap !== null && cap <= 6);
    console.log("First " + cap + " uploads succeed:", statuses.slice(0, cap).every(s => s === 200));
    console.log("Uploads past the cap → 429:", statuses.slice(cap).every(s => s === 429));
    console.log("Nothing past the cap reached R2:", puts === cap);

    console.log("\n=== upload-verify: a failed R2 write gives the slot back ===");
    count = 0; puts = 0;
    env.IMAGES = { put: async () => { throw new Error("R2 down"); } };
    const f = await upload();
    console.log("R2 failure → 502:", f.status === 502);
    console.log("Slot released (count back to 0):", count === 0);
  }

  // ---------------------------------------------------------------------
  // verify.js — approval sets designApproved in D1
  // ---------------------------------------------------------------------
  {
    console.log("\n=== verify.js: customer approval sets designApproved on the D1 order ===");
    let stageCall = null, externalFetch = false;
    global.getDesignVerification = async () => ({ token: "t", status: "pending", orderId: "O1", orgId: "org", customerName: "C" });
    global.respondToDesignVerification = async () => true;
    global.getOrgById = async () => null;
    global.setFulfillmentStage = async (db, orderId, stage) => { stageCall = { orderId, stage }; };
    global.sendDesignVerificationResponseNotification = async () => true;
    const realFetch = global.fetch;
    global.fetch = async () => { externalFetch = true; return { json: async () => ({}) }; };
    const ns = {};
    new Function("ns", strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/verifyLinks.js")) + "\n" + strip(read("functions/api/verify.js")) + "\nns.post = onRequestPost;")(ns);
    const res = await ns.post({ env: { DB: {}, GOOGLE_SCRIPT_URL: "https://script.google.com/x", GOOGLE_ADMIN_KEY: "k" },
      request: { json: async () => ({ token: "t", action: "approved" }) } });
    console.log("Responds ok:", res.status === 200);
    console.log("setFulfillmentStage(O1, designApproved) called:", !!stageCall && stageCall.orderId === "O1" && stageCall.stage === "designApproved");
    console.log("No outside request for the stage update:", externalFetch === false);
    global.fetch = realFetch;
  }

  // ---------------------------------------------------------------------
  // shipping.js — signs quotes, uses catalog weights (not client weights)
  // ---------------------------------------------------------------------
  {
    console.log("\n=== shipping.js: quotes are signed and weights come from the catalog ===");
    global.rateLimited = async () => ({ blocked: false, retryAfter: 0 });
    global.getBoxPresets = async () => null;
    global.selectBox = () => ({ box: { length: "12", width: "9", height: "4" }, packing: 1, boxWeightOz: 2 });
    global.getCatalogData = async () => ({ subdomainMap: { league101: "league-101" } });
    global.getProductsByOrg = async () => [{ productId: "hoodie", weightOz: 20, type: "sweatshirt" }];
    // The REAL quantity rule from db.js, not a mock.
    Object.assign(global, new Function(strip(read("functions/_lib/db.js")) + "\nreturn { lineQty, QTY_MESSAGE };")());
    // Ship-from address (incl. ZIP) lives in D1 (Global Settings) — see db.js.
    global.getShipFromAddress = async () => ({ name: "Example Stitch Co", street1: "1 Main St", city: "Columbus", state: "OH", zip: "43215", phone: "6145550100", email: "ship@example.com" });
    const ns = {};
    new Function("ns",
      strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
      strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/api/shipping.js")) +
      "\nns.post = onRequestPost; ns.verifyQuote = verifyQuote; ns.canonicalItems = canonicalItems;")(ns);
    let sentWeight = null;
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      sentWeight = JSON.parse(opts.body).parcels[0].weight;
      return { json: async () => ({ rates: [{ amount: "9.00", provider: "USPS", servicelevel: { name: "Ground" } }] }) };
    };
    const env = { SHIPPO_API_KEY: "k", DB: {}, QUOTE_SIGNING_SECRET: "s" };
    const items = [{ productId: "hoodie", qty: 2, weightOz: 0.1 }];
    const res = await ns.post({ env, request: jsonReq("https://league101.example.com/api/shipping", { zip: "15213", items }) });
    const data = JSON.parse(await res.text());
    console.log("Shippo weight uses catalog 20oz×2 + 2oz box = 42 (client sent 0.1oz):", sentWeight === "42");
    const rate = data.rates && data.rates[0];
    console.log("Rate carries a quoteToken:", !!(rate && rate.quoteToken));
    const v = rate && await ns.verifyQuote(env, rate.quoteToken);
    console.log("Token verifies and binds org/zip/cart/amount:", !!v && v.ok && v.orgId === "league-101" &&
      v.zip === "15213" && v.items === ns.canonicalItems(items) && v.amountCents === 1000);

    console.log("\n=== shipping.js: admin parcel-override quotes are NOT signed ===");
    const res2 = await ns.post({ env, request: jsonReq("https://league101.example.com/api/shipping",
      { zip: "15213", items, parcel: { length: 1, width: 1, height: 1 } }) });
    const d2 = JSON.parse(await res2.text());
    console.log("No quoteToken on override rates:", d2.rates.every(r => !r.quoteToken));
    global.fetch = realFetch;
  }
})();
