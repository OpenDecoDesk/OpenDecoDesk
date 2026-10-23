// Tools → Communications → Send a test email: one message through the same path as every other email,
// and a report of what happened — the provider, the From address, the provider's own status and
// message, and what to do about the usual Resend mistakes (an unverified domain, a bad key, a key
// saved with a line break, a From address still on example.com). The key itself never comes back.
// The real email.js, with the database stubbed; the action and the page are checked in their files.
const fs = require("fs");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const issues = [];
const STUBS = "const addOwnerNotice = async () => {}; const recordSystemIssue = async (db, kind, d) => issues.push(kind);\n" +
  "const getBusinessProfile = async () => ({ name: 'Acme Tees', ownerEmail: 'owner@acme.test' }); const resolveTimeZone = () => 'UTC';\n";
const E = new Function("issues", STUBS + strip(read("functions/_lib/email.js")) + "\nreturn { sendTestEmail, sendOrderReceivedEmail };")(issues);

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

let sent = [], answer = null;
global.fetch = async (url, init) => {
  if (/\n/.test(init.headers.Authorization)) throw new TypeError("Invalid header value");   // what workerd does
  sent.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
  return { ok: answer.status < 300, status: answer.status, json: async () => answer.json };
};

(async () => {
  const KEY = "re_AbCdEf123456";
  const env = { ROOT_DOMAIN: "acme.test", RESEND_API_KEY: KEY };

  console.log("=== Resend accepts it ===");
  answer = { status: 200, json: { id: "4ef9a417-02e9" } };
  let r = await E.sendTestEmail(env, "pat@acme.test");
  ok("it's sent once, to Resend, from the install's address under the business name", sent.length === 1 && sent[0].url === "https://api.resend.com/emails" &&
    sent[0].body.from === "Acme Tees <orders@acme.test>" && sent[0].body.to[0] === "pat@acme.test" && /Test email from Acme Tees/.test(sent[0].body.subject));
  ok("the report says so, with Resend's id for its Logs page", r.ok && r.provider === "resend" && r.httpStatus === 200 && r.providerId === "4ef9a417-02e9" && r.from === "orders@acme.test" && r.replyTo === "owner@acme.test");
  ok("the key is described, never returned", r.key.length === KEY.length && r.key.looksLikeResend && !JSON.stringify(r).includes(KEY));

  console.log("\n=== Resend refuses it ===");
  sent = []; issues.length = 0;
  answer = { status: 403, json: { statusCode: 403, name: "validation_error", message: "The acme.test domain is not verified. Please, add and verify your domain on https://resend.com/domains" } };
  r = await E.sendTestEmail(env, "pat@acme.test");
  ok("an unverified domain: not sent, Resend's own message shown, and what to do", !r.ok && r.httpStatus === 403 && /not verified/.test(r.providerMessage) &&
    r.hints.some(h => /Resend → Domains add acme\.test/.test(h)));
  ok("a test send is not recorded as a failed email", issues.length === 0);
  answer = { status: 403, json: { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (me@gmail.test). To send emails to other recipients, please verify a domain at resend.com/domains" } };
  r = await E.sendTestEmail(env, "pat@acme.test");
  ok("Resend's testing mode is explained", !r.ok && r.hints.some(h => /testing mode/.test(h)));
  answer = { status: 401, json: { statusCode: 401, name: "missing_api_key", message: "Missing API key in the authorization header." } };
  r = await E.sendTestEmail(env, "pat@acme.test");
  ok("a refused key: make a new one", !r.ok && r.hints.some(h => /refused the API key/.test(h)));
  answer = { status: 403, json: { statusCode: 403, name: "validation_error", message: "API key is invalid" } };
  r = await E.sendTestEmail(env, "pat@acme.test");
  ok("…and the same for an invalid one", !r.ok && r.hints.some(h => /refused the API key/.test(h)));
  answer = { status: 500, json: { message: "Something odd" } };
  r = await E.sendTestEmail(env, "pat@acme.test");
  ok("an answer it doesn't know still says where to look", !r.ok && r.providerMessage === "Something odd" && r.hints.some(h => /Logs page/.test(h)));

  console.log("\n=== The key and the address ===");
  sent = []; answer = { status: 200, json: { id: "x1" } };
  r = await E.sendTestEmail({ ...env, RESEND_API_KEY: KEY + "\n" }, "pat@acme.test");
  ok("a key saved with a line break at the end still sends (it's trimmed), and the report points it out", r.ok && sent[0].auth === "Bearer " + KEY && r.key.paddedEnds && r.hints.some(h => /at the end/.test(h)));
  sent = []; issues.length = 0;
  ok("…and so do the real emails", await E.sendOrderReceivedEmail({ ...env, RESEND_API_KEY: KEY + "\n" }, { orderId: "A-1", contact: "pat@acme.test", customerName: "Pat", items: [], total: 0 }) &&
    sent.length === 1 && sent[0].auth === "Bearer " + KEY && issues.length === 0);
  r = await E.sendTestEmail({ ...env, RESEND_API_KEY: "sk_live_wrong" }, "pat@acme.test");
  ok("a key that isn't a Resend key is pointed out", r.key && !r.key.looksLikeResend && r.hints.some(h => /start with re_/.test(h)));
  r = await E.sendTestEmail({ RESEND_API_KEY: KEY }, "pat@acme.test");
  ok("no ROOT_DOMAIN: the From address is example.com, and it says so", r.from === "orders@example.com" && r.hints.some(h => /ROOT_DOMAIN isn't set/.test(h)));
  r = await E.sendTestEmail({ RESEND_API_KEY: KEY, EMAIL_FROM: "hello@acme.test" }, "pat@acme.test");
  ok("…but not when EMAIL_FROM gives a real address", r.from === "hello@acme.test" && !r.hints.some(h => /ROOT_DOMAIN/.test(h)));
  sent = [];
  r = await E.sendTestEmail(env, "not an address");
  ok("a bad To address sends nothing", !r.ok && sent.length === 0 && /Enter an email address/.test(r.hints[0]));

  console.log("\n=== No Resend ===");
  sent = [];
  r = await E.sendTestEmail({ ROOT_DOMAIN: "acme.test" }, "pat@acme.test");
  ok("nothing set up: it says so and sends nothing", r.provider === "none" && !r.ok && sent.length === 0 && r.hints.some(h => /No email provider/.test(h)));
  answer = { status: 400, json: { success: false, errors: [{ code: 10001, message: "sender domain not verified" }] } };
  r = await E.sendTestEmail({ ROOT_DOMAIN: "acme.test", CF_EMAIL_API_TOKEN: "t", CF_ACCOUNT_ID: "A" }, "pat@acme.test");
  ok("Cloudflare's API: its status and error are reported", r.provider === "cloudflare-api" && !r.ok && r.httpStatus === 400 && /10001: sender domain not verified/.test(r.providerMessage));
  const bound = []; r = await E.sendTestEmail({ ROOT_DOMAIN: "acme.test", EMAIL: { send: async (m) => { bound.push(m); } } }, "pat@acme.test");
  ok("Cloudflare's Worker binding: sent through it", r.provider === "cloudflare-binding" && r.ok && bound.length === 1);
  r = await E.sendTestEmail({ ROOT_DOMAIN: "acme.test", EMAIL: { send: async () => { throw new Error("destination address not verified"); } } }, "pat@acme.test");
  ok("…and its error is shown", !r.ok && /destination address not verified/.test(r.providerMessage));

  console.log("\n=== Who can use it ===");
  const ordersJs = read("functions/api/orders.js"), adminJs = read("public/admin.js");
  ok("the action is admin-only, checks that, and is rate-limited", /const ADMIN_ONLY_ACTIONS = \[[^\]]*"sendTestEmail"/.test(ordersJs) &&
    /body\.action === "sendTestEmail"\) \{\s*const denied = await requireAdmin\([^)]*ACTION_ROLE\[body\.action\]\);\s*if \(denied\) return denied;\s*const rl = await rateLimited\(env, "email_test"/.test(ordersJs));
  ok("the Communications page shows the button only to an admin", /\$\{adminCan_\("admin"\) \? `<details id="commsTest"/.test(adminJs) && /action: "sendTestEmail", key: adminKey, to/.test(adminJs));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test125 ran to the end without crashing: false"); process.exitCode = 1; });
