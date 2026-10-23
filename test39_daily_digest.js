const fs = require("fs");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { createD1 } = require("./testlib/d1-shim.js");

// Daily order roll-up (/api/daily-digest) — real SQL (sql.js), real db.js,
// real email.js (its send captured by a fetch mock).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, voidOrder };")();
const mail = new Function(dbSrc + "\n" + strip(read("functions/_lib/email.js")) +
  "\nreturn { sendStripePaymentNotification, sendRefundNotification, sendDisputeNotification, sendDesignVerificationResponseNotification };")();
const digest = new Function(strip(read("functions/_lib/http.js")) + "\n" +
  "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/daily-digest.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t'), ('rec','rec','REC','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));

  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const add = (orderId, orgId, placedAt, extra = {}) => lib.insertOrder(d1, Object.assign({ orderId, orgId, customerName: "Cust " + orderId,
    contact: orderId.toLowerCase() + "@x.com", paymentMethod: "Venmo", placedAt }, extra),
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 2, unitPrice: 23 }]);
  await add("OLD", "prime", hoursAgo(30));
  await add("A1", "prime", hoursAgo(5));
  await add("B1", "rec", hoursAgo(3));
  await add("TEST-9", "prime", hoursAgo(2), { isTest: true });

  let emails = [], mailOk = true;
  global.fetch = async (url, init) => {
    if (!captureMail(url, init, emails)) return { ok: true, json: async () => ({}) };
    return mailOk ? MAIL_OK : { ok: false, status: 429, json: async () => ({ success: false, errors: [{ message: "quota" }] }) };
  };
  const env = { DB: d1, CRON_SECRET: "cron-key", ...MAIL_ENV };
  const run = async (key = "cron-key") => {
    const res = await digest({ env, request: { json: async () => ({ key }), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== Auth ===");
  let r = await run("wrong");
  console.log("wrong key → 401, nothing sent:", r.status === 401 && emails.length === 0);

  console.log("\n=== First run: last 24 hours ===");
  r = await run();
  const e = emails[0];
  console.log("one email with the 2 real orders from the last 24h (not the 30h-old one, not the test order):",
    r.status === 200 && r.body.sent === true && r.body.orders === 2 && emails.length === 1 &&
    /A1/.test(e.body) && /B1/.test(e.body) && !/OLD/.test(e.body) && !/TEST-9/.test(e.body));
  console.log("sent to the owner inbox, subject has count and total:", e.to === "owner@example.com" && e.subject === "Daily roll-up — 2 new orders ($92.00)");
  console.log("grouped by org name, with customer, items and paid status:",
    /Example League — 1 order, \$46\.00/.test(e.htmlBody) && /REC — 1 order/.test(e.htmlBody) &&
    /Cust A1/.test(e.htmlBody) && /a1@x\.com/.test(e.htmlBody) && /2× Polo \(L\)/.test(e.htmlBody) && /Unpaid/.test(e.htmlBody));

  console.log("\n=== Nothing new → no email ===");
  r = await run();
  console.log("second run the same day sends nothing:", r.body.sent === false && emails.length === 1);
  // …but it leaves a record that it ran, so "no email" can be told from "it never ran".
  const runRec = () => JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='dailyDigestRun'")[0].value);
  const cursorBefore = d1.q("SELECT value FROM global_settings WHERE key='dailyDigest'")[0].value;
  console.log("a run that found nothing is still recorded (ok, not sent, when, how it was triggered):",
    runRec().ok === true && runRec().sent === false && runRec().trigger === "manual" && Date.now() - Date.parse(runRec().at) < 5000);
  console.log("recording the run doesn't move the roll-up's own progress or last-sent time:", d1.q("SELECT value FROM global_settings WHERE key='dailyDigest'")[0].value === cursorBefore);

  console.log("\n=== Only orders since the last roll-up ===");
  await add("C1", "prime", hoursAgo(0));
  await add("D1", "prime", hoursAgo(0));
  await lib.voidOrder(d1, "D1", "duplicate");
  await add("E1", "prime", "2026-01-01T00:00:00Z"); // backdated order entered today still counts
  r = await run();
  const e2 = emails[1];
  console.log("new + backdated orders reported once; voided left out; earlier ones not repeated:",
    r.body.orders === 2 && /C1/.test(e2.body) && /E1/.test(e2.body) && !/D1/.test(e2.body) && !/A1/.test(e2.body));

  console.log("\n=== A failed send is retried next run ===");
  await add("F1", "rec", hoursAgo(0));
  mailOk = false;
  r = await run();
  console.log("send failure → error, progress not saved:", r.status === 502);
  mailOk = true;
  r = await run();
  console.log("next run still includes that order:", r.body.sent === true && r.body.orders === 1 && /F1/.test(emails[emails.length - 1].body));

  console.log("\n=== Overdue blank order surfaces in the roll-up (migrations/0038) ===");
  // A1 was already reported; give it a vendor blank order that's overdue (expected date in the past).
  // Blank fulfillment is per line item now (migrations/0039), so stamp the item (what the roll-up reads).
  d1._raw.run("UPDATE order_items SET blankOrderedAt=?, blankEstDelivery=?, blankVendor=?, blankVendorOrderId=? WHERE orderId='A1'",
    [hoursAgo(240), "2020-01-01", "SanMar", "SO-123"]);
  const beforeBlanks = emails.length;
  r = await run();
  const eb = emails[emails.length - 1];
  console.log("an overdue blank order alone triggers a roll-up, flagged in the subject:",
    r.body.sent === true && emails.length === beforeBlanks + 1 && /blank order overdue/.test(eb.subject));
  console.log("it's listed with vendor, order # and an Overdue status:",
    /Blanks ordered, not yet received/.test(eb.htmlBody) && /A1/.test(eb.body) && /SanMar/.test(eb.body) && /SO-123/.test(eb.body) && /Overdue/.test(eb.body));
  // Restore so the following assertions (which expect quiet runs) aren't affected.
  d1._raw.run("UPDATE order_items SET blankOrderedAt=NULL, blankEstDelivery=NULL, blankVendor='', blankVendorOrderId='' WHERE orderId='A1'");

  console.log("\n=== Owner notices are queued, not emailed ===");
  const before = emails.length;
  await mail.sendStripePaymentNotification(env, "A1", "prime", 46);
  await mail.sendRefundNotification(env, "A1", "prime", 10);
  await mail.sendDisputeNotification(env, "B1", "rec", "warning_needs_response", "fraudulent", 46);
  await mail.sendDesignVerificationResponseNotification(env, { orderId: "C1", orgId: "prime", customerName: "Cust C1", action: "changes_requested",
    note: "Make the logo bigger", imageUrls: ["https://img.example/1.png"] });
  console.log("Stripe payment/refund/dispute and design responses send no email now:", emails.length === before);
  console.log("…they wait in owner_notices:", d1.q("SELECT count(*) n FROM owner_notices WHERE sentAt IS NULL")[0].n === 4);
  r = await run();
  const e3 = emails[emails.length - 1];
  console.log("roll-up goes out for notices alone (no new orders):", r.body.sent === true && r.body.orders === 0 && r.body.notices === 4);
  console.log("subject leads with the dispute, then counts:", e3.subject === "Daily roll-up — ⚠️ 1 dispute filed, 1 payment, 1 refund, 1 design response");
  console.log("dispute shown first under Needs attention, others listed with details:",
    e3.htmlBody.indexOf("Needs attention") < e3.htmlBody.indexOf("Payments, refunds") && /DISPUTE FILED — \$46\.00/.test(e3.htmlBody) &&
    /Stripe payment \$46\.00/.test(e3.htmlBody) && /Make the logo bigger/.test(e3.htmlBody) && /img\.example\/1\.png/.test(e3.htmlBody) && /REC/.test(e3.htmlBody));
  r = await run();
  console.log("notices are marked sent (not repeated next day):", r.body.sent === false && d1.q("SELECT count(*) n FROM owner_notices WHERE sentAt IS NULL")[0].n === 0);
  await mail.sendStripePaymentNotification(env, "A1", "prime", 5);
  mailOk = false; r = await run(); mailOk = true;
  console.log("failed send keeps notices queued:", r.status === 502 && d1.q("SELECT count(*) n FROM owner_notices WHERE sentAt IS NULL")[0].n === 1);
  await run();
  const n0 = emails.length;
  await mail.sendStripePaymentNotification({ ...MAIL_ENV }, "A1", "prime", 5);
  console.log("no database to queue into → emailed immediately instead (never lost):", emails.length === n0 + 1 && /Payment confirmed/.test(emails[emails.length - 1].subject));

  console.log("\n=== Admin Communications page data (getPendingCommunications) ===");
  const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  const pending = async () => {
    const res = await api({ env, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders",
      json: async () => ({ key: "x", action: "getPendingCommunications" }), headers: { get: () => null } } });
    return JSON.parse(await res.text());
  };
  let pc = await pending();
  console.log("nothing pending right after a roll-up, with the last-sent time:", pc.orders.length === 0 && pc.notices.length === 0 && !!pc.lastSentAt);
  console.log("Communications also gets the last RUN (when it last checked, and what happened):", !!pc.lastRun && typeof pc.lastRun.sent === "boolean" && pc.lastRun.ok === true && !!pc.lastRun.at);
  await add("G1", "rec", hoursAgo(0));
  await mail.sendDisputeNotification(env, "G1", "rec", "warning_needs_response", "fraudulent", 46);
  pc = await pending();
  console.log("shows the new order and queued notice with shop names, exactly what the next roll-up will send:",
    pc.orders.length === 1 && pc.orders[0].orderId === "G1" && pc.orders[0].orgName === "REC" && pc.orders[0].items[0].name === "Polo" &&
    pc.notices.length === 1 && pc.notices[0].urgent === true && pc.notices[0].orgName === "REC");
  r = await run();
  console.log("…and the roll-up sends exactly those:", r.body.orders === 1 && r.body.notices === 1);
  pc = await pending();
  console.log("page is empty again after it goes out:", pc.orders.length === 0 && pc.notices.length === 0);
  const adminSrc = read("public/admin.js");
  console.log("Communications tab is in the admin nav header:", /\["comms", "Communications"\]/.test(adminSrc));

  console.log("\n=== New orders no longer email the owner one by one ===");
  const ordersSrc = read("functions/api/orders.js"), emailSrc = read("functions/_lib/email.js");
  console.log("order submission sends only the customer's receipt:", !/sendOrderNotificationEmail/.test(ordersSrc) && !/sendOrderNotificationEmail/.test(emailSrc));
  console.log("the Worker's scheduled handler runs the roll-up:",
    !fs.existsSync(__dirname + "/Code.gs") && /scheduled:/.test(read("src/worker.js")) && /runDailyDigest/.test(read("src/worker.js")));
  await runRecordTests();
})().catch(e => { console.log("test39 crashed:", false); console.error(e); process.exit(1); });

// The run record on a send and on a failed send; the scheduled trigger; the subject tag.
// Called at the end of the block above (they share global.fetch, so they can't run side by side).
async function runRecordTests() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const mod = new Function(strip(read("functions/_lib/http.js")) + "\n" +
    "function timingSafeEqual(a, b){ return a === b; }\nconst rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/daily-digest.js")) + "\nreturn { runDailyDigest, getDigestRun };")();
  await lib.insertOrder(d1, { orderId: "R1", orgId: "prime", customerName: "C", contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date().toISOString() },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 23 }]);
  let emails = [], mailOk = false;
  global.fetch = async (url, init) => {
    if (!captureMail(url, init, emails)) return { ok: true, json: async () => ({}) };
    return mailOk ? MAIL_OK : { ok: false, status: 429, json: async () => ({ success: false, errors: [{ message: "quota" }] }) };
  };
  console.log("\n=== Every run is recorded ===");
  let res = await mod.runDailyDigest({ ...MAIL_ENV, DB: d1 }, "scheduled");
  let rec = await mod.getDigestRun(d1);
  console.log("a run whose email couldn't be sent is recorded as not completed, with the reason:", res.status === 502 && rec.ok === false && rec.sent === false && rec.trigger === "scheduled" && /could not be sent/i.test(rec.message));
  mailOk = true;
  res = await mod.runDailyDigest({ ...MAIL_ENV, DB: d1 }, "scheduled");
  rec = await mod.getDigestRun(d1);
  console.log("the next run sends it and records the send with its counts:", res.status === 200 && rec.ok === true && rec.sent === true && rec.orders === 1 && rec.message === "" && rec.trigger === "scheduled");
  console.log("without the setting, subjects carry no tag:", /^Daily roll-up — /.test(emails[emails.length - 1].subject) && /1 new order \(\$23\.00\)/.test(emails[emails.length - 1].subject));
  console.log("the Worker's cron passes \"scheduled\":", /runDailyDigest\(env, "scheduled"\)/.test(read("src/worker.js")));

  console.log("\n=== A quiet morning still gets an email (scheduled run only) ===");
  const sentAtBefore = JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='dailyDigest'")[0].value).sentAt;
  let before = emails.length;
  res = await mod.runDailyDigest({ ...MAIL_ENV, DB: d1 }, "manual");
  console.log("a manual run with nothing new sends nothing:", (await res.clone().json()).sent === false && emails.length === before && (await mod.getDigestRun(d1)).heartbeat === "");
  res = await mod.runDailyDigest({ ...MAIL_ENV, DB: d1 }, "scheduled");
  const hb = emails[emails.length - 1], hbBody = await res.clone().json();
  rec = await mod.getDigestRun(d1);
  console.log("the scheduled run with nothing new sends a short 'nothing new' email to the owner:", emails.length === before + 1 &&
    hb.subject === "Daily roll-up — nothing new" && hb.to === "owner@example.com" && /found nothing new since the last roll-up on/.test(hb.body) && /#comms/.test(hb.body));
  console.log("it isn't counted as a roll-up: sent stays false, the last-sent time doesn't move, the run records the heartbeat:",
    hbBody.sent === false && hbBody.heartbeat === "sent" && rec.sent === false && rec.heartbeat === "sent" && rec.ok === true &&
    JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='dailyDigest'")[0].value).sentAt === sentAtBefore);
  mailOk = false;
  res = await mod.runDailyDigest({ ...MAIL_ENV, DB: d1 }, "scheduled");
  rec = await mod.getDigestRun(d1);
  console.log("if that email can't be sent the run still completes, says so, and the failure is queued for the next roll-up:", res.status === 200 && rec.ok === true && rec.heartbeat === "failed" &&
    /email_failed/.test((d1.q("SELECT value FROM global_settings WHERE key='systemIssues'")[0] || {}).value || ""));
  mailOk = true;
  res = await mod.runDailyDigest({ ...MAIL_ENV, DB: d1 }, "scheduled");
  console.log("…and the next morning's email is a real roll-up reporting that problem, not a 'nothing new':", (await res.clone().json()).sent === true && /^Daily roll-up — /.test(emails[emails.length - 1].subject) && emails[emails.length - 1].subject !== "Daily roll-up — nothing new");
  console.log("Communications words all three outcomes:", /a short “nothing new” email was sent/.test(read("public/admin.js")) && /“nothing new” email could not be sent/.test(read("public/admin.js")));

  console.log("\n=== Staging marks its emails ===");
  await lib.insertOrder(d1, { orderId: "R2", orgId: "prime", customerName: "C", contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date().toISOString() },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 23 }]);
  await mod.runDailyDigest({ ...MAIL_ENV, DB: d1, EMAIL_SUBJECT_TAG: "[STAGING]" }, "manual");
  console.log("with EMAIL_SUBJECT_TAG set, the subject starts with it:", /^\[STAGING\] Daily roll-up — /.test(emails[emails.length - 1].subject));
  console.log("the shipped config sets no tag (it's for a second, non-production environment):", read("wrangler.toml").indexOf("EMAIL_SUBJECT_TAG") === -1);
  const adm = read("public/admin.js");
  console.log("Communications shows when it last checked and what happened:", /id="commsLastRun"/.test(adm) && /nothing new, so no email was sent/.test(adm) && /it did not complete/.test(adm));
}
