const fs = require("fs");

// Cloudflare Email Service transport (functions/_lib/email.js): REST API with from/reply-to the
// owner's inbox, BCC to the receipts inbox
// (no BCC on mail already addressed to it), the EMAIL binding preferred when present, every failure
// recorded as an `email_failed` system issue (and reported as a failure — nothing is retried through
// another route), and a permanent bounce reported as a failure.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
global.__issues = [];
// The Business profile the transport reads (name, the owner's inbox, the receipts inbox).
global.__biz = { name: "Example Stitch Co", ownerEmail: "owner@stitch.example", receiptsEmail: "receipts@stitch.example" };
const send_ = new Function("const getBusinessProfile = async () => global.__biz; const addOwnerNotice = async () => {}; const recordSystemIssue = async (db, kind, sample) => { global.__issues.push({ kind, sample }); };\n" + strip(read("functions/_lib/email.js")) + "\nreturn send_;")();

const OWNER = "owner@stitch.example";
const RECEIPTS = "receipts@stitch.example";
let calls = [];
let cfReply = () => ({ status: 200, body: { success: true, errors: [], result: { delivered: ["c@example.com"], permanent_bounces: [], queued: [] } } });
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url, body, headers: opts.headers });
  if (url.startsWith("https://api.cloudflare.com/")) {
    const r = cfReply(body);
    if (r.throw) throw new Error("network down");
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  }
  return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
};
const cf = { CF_EMAIL_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct123" };
const msg = { to: "c@example.com", subject: "Order received", html: "<p>hi</p>", text: "hi" };
const isCf = (c) => c.url.startsWith("https://api.cloudflare.com/");

(async () => {
  console.log("\n=== Cloudflare Email Service (REST) ===");
  calls = [];
  let ok = await send_(cf, msg);
  const c = calls[0];
  console.log("sends through Cloudflare, one request:", ok === true && calls.length === 1 && isCf(c));
  console.log("to the account's send endpoint with the API token:",
    c.url === "https://api.cloudflare.com/client/v4/accounts/acct123/email/sending/send" && c.headers.Authorization === "Bearer tok");
  console.log("from orders@<root domain> under the business name:", c.body.from.address === "orders@example.com" && c.body.from.name === "Example Stitch Co");
  console.log("reply-to is the owner's inbox:", c.body.reply_to === OWNER);
  console.log("the receipts inbox is BCC'd, not the owner's:", JSON.stringify(c.body.bcc) === JSON.stringify([RECEIPTS]));
  console.log("subject/html/text carried through:", c.body.subject === "Order received" && c.body.html === "<p>hi</p>" && c.body.text === "hi");

  calls = [];
  await send_({ ...cf, EMAIL_FROM: "shop@testmail.example.com", EMAIL_BCC: "archive@example.com" }, msg);
  console.log("EMAIL_FROM / EMAIL_BCC override the defaults:", calls[0].body.from.address === "shop@testmail.example.com" && calls[0].body.bcc[0] === "archive@example.com");

  calls = [];
  await send_(cf, { ...msg, to: "Owner@Stitch.Example" });
  console.log("the owner's roll-up is BCC'd to the receipts inbox too:", calls.length === 1 && calls[0].body.bcc[0] === RECEIPTS);
  calls = [];
  await send_(cf, { ...msg, to: "Receipts@Stitch.Example" });
  console.log("mail already TO the receipts inbox isn't BCC'd a second copy:", calls.length === 1 && calls[0].body.bcc === undefined);

  console.log("\n=== a Cloudflare failure is a failure (no other route), and is recorded ===");
  for (const [label, reply] of [
    ["an API error (e.g. sender domain not verified)", () => ({ status: 400, body: { success: false, errors: [{ code: 1000, message: "Sender domain not verified" }] } })],
    ["a rate limit", () => ({ status: 429, body: { success: false, errors: [{ code: 429, message: "Too many" }] } })],
    ["a network error", () => ({ throw: true })],
  ]) {
    cfReply = reply; calls = [];
    ok = await send_(cf, msg);
    console.log(label + " → reported as not sent, one attempt:", ok === false && calls.length === 1 && isCf(calls[0]));
  }
  console.log("each failure is recorded for the 6 AM roll-up (email_failed, with the subject):",
    global.__issues.filter(x => x.kind === "email_failed").length === 3 && global.__issues[0].sample === "Order received");
  calls = [];
  ok = await send_({}, msg);
  console.log("not configured at all → false, no network call, recorded:", ok === false && calls.length === 0 && global.__issues.length === 4);

  cfReply = () => ({ status: 200, body: { success: true, result: { delivered: [], permanent_bounces: ["c@example.com"], queued: [] } } });
  calls = [];
  ok = await send_(cf, msg);
  console.log("a permanent bounce is a failure, not retried:", ok === false && calls.length === 1);
  cfReply = () => ({ status: 200, body: { success: true, result: { delivered: [], permanent_bounces: [], queued: ["c@example.com"] } } });
  console.log("queued counts as sent:", (await send_(cf, msg)) === true);

  console.log("\n=== EMAIL binding preferred when configured ===");
  const bound = [];
  calls = [];
  ok = await send_({ ...cf, EMAIL: { send: async (m) => { bound.push(m); } } }, msg);
  console.log("uses env.EMAIL.send, no REST call:", ok === true && bound.length === 1 && calls.length === 0);
  console.log("binding gets from/replyTo/bcc in its own field names:",
    bound[0].from.email === "orders@example.com" && bound[0].replyTo === OWNER && bound[0].bcc[0] === RECEIPTS);
  calls = [];
  ok = await send_({ ...cf, EMAIL: { send: async () => { throw new Error("E_SENDER_NOT_VERIFIED"); } } }, msg);
  console.log("a binding error is reported as a failure (no REST retry):", ok === false && calls.length === 0);

  console.log("\n=== Resend instead of Cloudflare (RESEND_API_KEY) ===");
  calls = [];
  const realFetch = global.fetch;
  let resendReply = () => ({ ok: true, status: 200, json: async () => ({ id: "re_123" }) });
  global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers }); return url.startsWith("https://api.resend.com/") ? resendReply() : { ok: true, status: 200, json: async () => ({ success: true, result: {} }) }; };
  const rs = { ...cf, RESEND_API_KEY: "re_key" };
  ok = await send_(rs, msg);
  const rc = calls[0];
  console.log("with the key set, the email goes to Resend only — one request, none to Cloudflare:", ok === true && calls.length === 1 && rc.url === "https://api.resend.com/emails" && rc.headers.Authorization === "Bearer re_key");
  console.log("same sender, reply-to and hidden copy as the Cloudflare route:", rc.body.from === "Example Stitch Co <orders@example.com>" && JSON.stringify(rc.body.to) === '["c@example.com"]' &&
    rc.body.reply_to === OWNER && JSON.stringify(rc.body.bcc) === JSON.stringify([RECEIPTS]) && rc.body.subject === "Order received" && rc.body.html === "<p>hi</p>" && rc.body.text === "hi");
  calls = []; global.__biz = { ...global.__biz, name: 'Bad "Name" <x>' };
  await send_(rs, msg);
  console.log("a business name can't break the From header:", calls[0].body.from === "Bad Name x <orders@example.com>");
  global.__biz = { name: "Example Stitch Co", ownerEmail: OWNER, receiptsEmail: RECEIPTS };
  calls = []; global.__issues = [];
  resendReply = () => ({ ok: false, status: 403, json: async () => ({ name: "validation_error", message: "domain is not verified" }) });
  ok = await send_(rs, msg);
  console.log("a Resend error is a failure, recorded, and NOT retried through Cloudflare:", ok === false && calls.length === 1 && global.__issues.length === 1 && global.__issues[0].kind === "email_failed");
  calls = [];
  resendReply = () => { throw new Error("network down"); };
  console.log("a network error is a failure too:", (await send_(rs, msg)) === false && calls.length === 1);
  global.fetch = realFetch;

  console.log("\n=== guards ===");
  calls = [];
  console.log("no address → false, nothing sent:", (await send_(cf, { ...msg, to: "" })) === false && calls.length === 0);
})().catch((e) => { console.log("test63 crashed:", false); console.error(e); process.exit(1); });
