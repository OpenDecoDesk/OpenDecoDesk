// Test helper: captures mail sent through Cloudflare Email Service (the default email transport).
//
//   const { MAIL_ENV, captureMail } = require("./testlib/mail-mock");
//   const env = { DB, ...MAIL_ENV };                       // email "configured" via the REST path
//   // inside a fetch mock:  if (captureMail(url, init, emails)) return MAIL_OK;
//
// Each captured message is normalised to { action:"sendEmail", to, subject, body, htmlBody, bcc,
// replyTo, from } — body = the plain-text part, htmlBody = the HTML part — the shape the tests
// assert on.

const MAIL_ENV = { CF_EMAIL_API_TOKEN: "test-token", CF_ACCOUNT_ID: "ACCT" };
const MAIL_URL = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/email\/sending\/send$/;
const MAIL_OK = { ok: true, status: 200, json: async () => ({ success: true, result: { permanent_bounces: [] } }) };

function captureMail(url, init, sink) {
  if (!MAIL_URL.test(String(url))) return false;
  const b = JSON.parse(init.body);
  sink.push({ action: "sendEmail", to: b.to, subject: b.subject, body: b.text || "", htmlBody: b.html || "",
    bcc: b.bcc, replyTo: b.reply_to, from: b.from });
  return true;
}

module.exports = { MAIL_ENV, MAIL_URL, MAIL_OK, captureMail };
