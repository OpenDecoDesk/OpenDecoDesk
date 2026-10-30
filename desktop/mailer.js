// Email from the desktop program, through the owner's own mailbox (SMTP): Gmail, iCloud, Fastmail,
// the web host's mail… The Worker never sees the mailbox or its password. It calls its MAILER
// binding (server.js) with the message, and this answers it here in Node, sending with nodemailer.
//
//   settings = { host, port, security: "starttls" | "tls", user, from }
//   the password is kept with the program's other secrets (desktop.json, SMTP_PASSWORD)
//
// Only sending: nothing here reads the mailbox.

const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

// The settings as they will be saved, or an error saying what's wrong with them.
function cleanSmtpSettings(s) {
  s = s && typeof s === "object" ? s : {};
  const host = String(s.host || "").trim().toLowerCase();
  const port = Number(s.port);
  const security = s.security === "tls" ? "tls" : "starttls";
  const from = String(s.from || "").trim();
  const user = String(s.user || "").trim() || from;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) throw new Error("Enter the mail server's name, like smtp.gmail.com.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The port is a number, usually 587 or 465.");
  if (port === 25) throw new Error("Port 25 is for servers passing mail between them, and most internet providers block it. Use 587 or 465.");
  if (!EMAIL_RE.test(from)) throw new Error("Enter the mailbox's email address.");
  if (user.length > 200) throw new Error("That username is too long.");
  return { host, port, security, user, from };
}

function transportFor(settings, password) {
  // Loaded here rather than at the top, so the rest of this file (and server.js) works where the
  // desktop's own packages aren't installed, as in the project's tests.
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    // "tls": encrypted from the start (port 465). "starttls": plain at first, then encrypted before
    // signing in — and never sent unencrypted if the server doesn't offer it (requireTLS).
    secure: settings.security === "tls",
    requireTLS: settings.security !== "tls",
    auth: { user: settings.user, pass: password },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}

// A failure, in words the owner can act on, with the server's own answer after it.
function explain(e, settings) {
  const code = String((e && e.code) || ""), said = String((e && (e.response || e.message)) || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const where = settings.host + ":" + settings.port;
  let what;
  if (code === "EAUTH") what = "The mailbox refused the sign-in. Gmail and iCloud need an app password (made in the account's security settings), not the normal password.";
  else if (/ENOTFOUND|EAI_AGAIN/.test(said + code)) what = "There's no mail server called " + settings.host + ". Check the name, and that this computer is online.";
  else if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ECONNECTION|EHOSTUNREACH/.test(code + said)) what = "Couldn't connect to " + where + ". Check the server and port, and that this computer is online.";
  else if (code === "ETLS" || /wrong version number|ssl|tls/i.test(said)) what = "The secure connection to " + where + " failed. Port 465 is usually \"SSL/TLS\" and 587 \"STARTTLS\"; check the one chosen matches the port.";
  else if (code === "EENVELOPE") what = "The mail server didn't accept the address it was sent to.";
  else what = "The mail server didn't take the email.";
  return said && !what.includes(said) ? what + " (" + said + ")" : what;
}

class Mailer {
  // `transport` is for tests: anything with sendMail(message) and verify().
  constructor(settings, password, { log = () => {}, transport } = {}) {
    this.settings = cleanSmtpSettings(settings);
    this.transport = transport || transportFor(this.settings, password);
    this.log = log;
  }

  // Signs in to the server without sending anything. { ok, message }.
  async verify() {
    try { await this.transport.verify(); return { ok: true, message: "Signed in to " + this.settings.host + "." }; }
    catch (e) { return { ok: false, message: explain(e, this.settings) }; }
  }

  // One message, from the mailbox's own address (a mailbox rewrites or refuses any other) under
  // the business's name. { ok, message }.
  async send({ to, fromName, replyTo, bcc, subject, html, text } = {}) {
    to = String(to || "").trim();
    if (!EMAIL_RE.test(to)) return { ok: false, message: "That isn't an email address: " + to.slice(0, 100) };
    const name = String(fromName || "").replace(/[<>"\r\n]/g, "").trim().slice(0, 100);
    const bccList = (Array.isArray(bcc) ? bcc : bcc ? [bcc] : []).map(String).filter(a => EMAIL_RE.test(a));
    const reply = EMAIL_RE.test(String(replyTo || "")) && String(replyTo).toLowerCase() !== this.settings.from.toLowerCase() ? String(replyTo) : undefined;
    const message = {
      from: name ? { name, address: this.settings.from } : this.settings.from,
      to, ...(bccList.length ? { bcc: bccList } : {}), ...(reply ? { replyTo: reply } : {}),
      subject: String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 300),
      text: text || "(no plain-text body)", ...(html ? { html } : {}),
    };
    try {
      const info = await this.transport.sendMail(message);
      // The log gets the subject and the server's answer, never addresses or the password.
      this.log("Email sent: " + message.subject + (info && info.response ? " (" + String(info.response).slice(0, 120) + ")" : ""));
      return { ok: true, message: info && info.response ? String(info.response).slice(0, 300) : "Sent." };
    } catch (e) {
      const why = explain(e, this.settings);
      this.log("Email not sent: " + message.subject + " — " + why);
      return { ok: false, message: why };
    }
  }

  // The Worker's MAILER binding: POST a JSON message, get { ok, message } back.
  async handle(request) {
    let body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    if (!body || typeof body !== "object") return Response.json({ ok: false, message: "Not a message." }, { status: 400 });
    const r = await this.send(body);
    return Response.json(r, { status: r.ok ? 200 : 502 });
  }
}

module.exports = { Mailer, cleanSmtpSettings };
