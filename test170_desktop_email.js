const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { readSources, migrate } = require("./desktop/migrate.js");
const { Mailer, cleanSmtpSettings } = require("./desktop/mailer.js");
const server = require("./desktop/server.js");

// Email in the desktop version, through the owner's own mailbox (SMTP) — off until they set it up
// under Global settings → Email:
//   A. desktop/mailer.js: the settings it accepts, the message it sends, what it says when it can't.
//   B. desktop/server.js: where the settings and the password are kept (never in the Worker's env).
//   C. email.js and orders.js: the email actions come back with a mailbox; invoices are the email
//      itself; with no mailbox nothing is sent and nothing is reported as a failure.
//   D. The morning roll-up, from the program's scheduled run.
//   D2. Design approval: the proof emailed with its pictures attached, approved by reply.
//   D3. The invoice as a PDF: attached to the invoice email, and Save invoice PDF….
//   E. The admin: Global settings → Email, the buttons and Communications.
// The mail server itself is stood in for here; the real program was tried against a local SMTP
// server (desktop/mailer.js with nodemailer).
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const ok = (d, c) => { console.log(d + ":", !!c); };

(async () => {
  console.log("=== A. desktop/mailer.js ===");
  const gmail = { host: "smtp.gmail.com", port: 587, security: "starttls", from: "pat@example.com" };
  const clean = cleanSmtpSettings({ ...gmail, host: " SMTP.Gmail.com " });
  ok("settings are tidied, and the username is the address unless given", clean.host === "smtp.gmail.com" && clean.user === "pat@example.com" && clean.security === "starttls");
  const refuses = (s, re) => { try { cleanSmtpSettings(s); return false; } catch (e) { return re.test(e.message); } };
  ok("a server name that isn't one, port 25, or no address is refused, saying what to fix", refuses({ ...gmail, host: "smtp gmail" }, /mail server's name/) &&
    refuses({ ...gmail, port: 25 }, /Use 587 or 465/) && refuses({ ...gmail, port: 70000 }, /usually 587 or 465/) && refuses({ ...gmail, from: "pat" }, /email address/));
  const sent = [], logged = [];
  let fail = null;
  const transport = { sendMail: async (m) => { if (fail) throw fail; sent.push(m); return { response: "250 2.0.0 OK queued" }; }, verify: async () => { if (fail) throw fail; return true; } };
  const mailer = new Mailer(gmail, "app password here", { transport, log: (t) => logged.push(t) });
  let r = await mailer.send({ to: "cust@example.net", fromName: "Stitch <Co>", replyTo: "owner@stitch.example", bcc: ["books@stitch.example", "not an address"], subject: "Your order\r\nBcc: x@y.z", html: "<p>Hi</p>", text: "Hi" });
  const m = sent[0] || {};
  ok("a message goes from the mailbox's own address, under the business's name", r.ok && m.from && m.from.address === "pat@example.com" && m.from.name === "Stitch Co");
  ok("…to the customer, with the receipts copy and replies to the owner", m.to === "cust@example.net" && m.bcc.join() === "books@stitch.example" && m.replyTo === "owner@stitch.example");
  ok("…and a subject that can't add headers", m.subject === "Your order Bcc: x@y.z" && m.html === "<p>Hi</p>" && m.text === "Hi");
  await mailer.send({ to: "cust@example.net", replyTo: "PAT@example.com", subject: "s" });
  ok("replies go to the mailbox itself without a Reply-To of its own address", !("replyTo" in sent[1]) && sent[1].text === "(no plain-text body)");
  r = await mailer.send({ to: "not-an-address", subject: "s" });
  ok("a message to something that isn't an address isn't sent", !r.ok && sent.length === 2);
  fail = Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", response: "535-5.7.8 Username and Password not accepted" });
  r = await mailer.send({ to: "cust@example.net", subject: "Payment confirmed — X1" });
  ok("a refused sign-in says to use an app password, with the server's own answer", !r.ok && /app password/.test(r.message) && /535-5\.7\.8/.test(r.message));
  const v = await mailer.verify();
  ok("…and so does checking the settings before they are saved", !v.ok && /app password/.test(v.message));
  fail = Object.assign(new Error("getaddrinfo ENOTFOUND smtp.gmial.com"), { code: "EDNS" });
  ok("a server that doesn't exist is named", /no mail server called smtp\.gmail\.com/.test((await mailer.send({ to: "a@b.co", subject: "s" })).message));
  fail = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
  ok("…and one that doesn't answer says to check the server, port and connection", /Couldn't connect to smtp\.gmail\.com:587/.test((await mailer.send({ to: "a@b.co", subject: "s" })).message));
  ok("the log has the subjects and the server's answers, never an address or the password", logged.length === 5 && /^Email sent: Your order/.test(logged[0]) && /250 2\.0\.0 OK/.test(logged[0]) &&
    /Email not sent: Payment confirmed — X1/.test(logged[2]) && !logged.join("\n").includes("cust@example.net") && !logged.join("\n").includes("app password here"));
  fail = null;
  let res = await mailer.handle(new Request("https://mailer.desktop.invalid/send", { method: "POST", body: JSON.stringify({ to: "c@d.co", subject: "Hello", text: "t" }) }));
  ok("the Worker's MAILER binding: a JSON message in, { ok, message } out", res.status === 200 && (await res.json()).ok === true && sent[sent.length - 1].subject === "Hello");
  res = await mailer.handle(new Request("https://mailer.desktop.invalid/send", { method: "POST", body: "nope" }));
  ok("…and anything else is refused", res.status === 400);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  r = await mailer.send({ to: "c@d.co", subject: "Proof", html: '<img src="cid:proof1">', attachments: [{ filename: "proof 1.png", contentType: "image/png", contentBase64: png.toString("base64"), cid: "proof1" }] });
  const att = (sent[sent.length - 1].attachments || [])[0] || {};
  ok("a picture can be attached, shown in the email by its cid", r.ok && Buffer.isBuffer(att.content) && att.content.equals(png) && att.cid === "proof1" && att.filename === "proof_1.png" && att.contentType === "image/png");
  const before = sent.length;
  r = await mailer.send({ to: "c@d.co", subject: "x", attachments: [{ filename: "a.exe", contentType: "application/x-msdownload", contentBase64: "TVo=" }] });
  const tooMany = await mailer.send({ to: "c@d.co", subject: "x", attachments: Array.from({ length: 6 }, () => ({ filename: "p.png", contentType: "image/png", contentBase64: png.toString("base64") })) });
  ok("…but only pictures, and at most five", !r.ok && /Only pictures/.test(r.message) && !tooMany.ok && /At most 5/.test(tooMany.message) && sent.length === before);
  const rendered = [], pdfBytes = Buffer.from("%PDF-1.4 fake");
  const pdfMailer = new Mailer(gmail, "pw", { transport, log: (t) => logged.push(t), renderPdf: async (html, size) => { rendered.push({ html, size }); return pdfBytes; } });
  r = await pdfMailer.send({ to: "c@d.co", subject: "Invoice for your order — X9", text: "t", pdf: { filename: "Invoice X9.pdf", html: "<p>Invoice</p>", pageSize: "A4" } });
  const pdfAtt = (sent[sent.length - 1].attachments || []).find(a => a.contentType === "application/pdf") || {};
  ok("an email that asks for a PDF gets one, made by the program from the page", r.ok && rendered.length === 1 && rendered[0].html === "<p>Invoice</p>" && rendered[0].size === "A4" &&
    pdfAtt.filename === "Invoice X9.pdf" && pdfAtt.content === pdfBytes);
  logged.length = 0;
  r = await mailer.send({ to: "c@d.co", subject: "Invoice for your order — X10", text: "t", pdf: { filename: "Invoice X10.pdf", html: "<p>x</p>" } });
  ok("without the program's renderer (node desktop/server.js) the email still goes, and the log says the PDF couldn't be made", r.ok && !(sent[sent.length - 1].attachments || []).length &&
    /PDF not attached to: Invoice for your order — X10/.test(logged.join("\n")));
  const badPdf = new Mailer(gmail, "pw", { transport, log: (t) => logged.push(t), renderPdf: async () => { throw new Error("printing failed"); } });
  r = await badPdf.send({ to: "c@d.co", subject: "Invoice X11", text: "t", pdf: { filename: "../../evil.exe", html: "<p>x</p>" } });
  ok("…and so does one whose PDF fails to print", r.ok && /printing failed/.test(logged.join("\n")));
  const { cleanPdf } = require("./desktop/mailer.js");
  ok("a PDF's name is kept to plain characters and ends .pdf; Letter unless A4; no page, or a huge one, is no PDF", cleanPdf({ filename: "../../evil.exe", html: "x" }).filename === ".._.._evil.exe.pdf" &&
    cleanPdf({ html: "x", pageSize: "Tabloid" }).pageSize === "Letter" && cleanPdf({ filename: "a.pdf" }) === null && cleanPdf({ html: "x".repeat(1024 * 1024 + 1) }) === null);
  const mailerSrc = read("desktop/mailer.js");
  ok("it never sends without encryption: TLS from the start on 465, else STARTTLS required", /secure: settings\.security === "tls"/.test(mailerSrc) && /requireTLS: settings\.security !== "tls"/.test(mailerSrc));

  console.log("\n=== B. Where the settings are kept (desktop/server.js) ===");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-email-"));
  server.resetSignIn(tmp);   // a data folder with its secrets, as after a first start
  const cfgOf = () => JSON.parse(fs.readFileSync(path.join(tmp, "desktop.json"), "utf8"));
  let thrown = null;
  try { server.setSmtp(tmp, gmail, ""); } catch (e) { thrown = e; }
  ok("turning email on needs the password", thrown && /password/.test(thrown.message) && !cfgOf().smtp);
  server.setSmtp(tmp, gmail, "secret app pw");
  let cfg = cfgOf();
  ok("the server settings are kept beside the port, the password with the secrets", cfg.smtp.host === "smtp.gmail.com" && cfg.smtp.from === "pat@example.com" && !("password" in cfg.smtp) &&
    cfg.secrets.SMTP_PASSWORD === "secret app pw" && server.savedSmtpPassword(tmp) === "secret app pw");
  server.setSmtp(tmp, { ...gmail, host: "smtp.mail.me.com" }, "");
  ok("saving without a password keeps the saved one", cfgOf().smtp.host === "smtp.mail.me.com" && cfgOf().secrets.SMTP_PASSWORD === "secret app pw");
  const protect = (t) => "P:" + Buffer.from(t).toString("base64"), unprotect = (t) => Buffer.from(t.slice(2), "base64").toString();
  server.setSmtp(tmp, gmail, "secret app pw", { protect, unprotect });
  ok("where the system has a keychain the password is encrypted with the other secrets", !JSON.stringify(cfgOf()).includes("secret app pw") && server.savedSmtpPassword(tmp, { unprotect }) === "secret app pw");
  server.setEmailOn(tmp, false, { protect, unprotect });
  ok("turning email off keeps the mailbox for next time, unused", cfgOf().emailOff === true && cfgOf().smtp.host === "smtp.gmail.com" && server.savedSmtpPassword(tmp, { unprotect }) === "secret app pw");
  server.setEmailOn(tmp, true, { protect, unprotect });
  ok("…and on again uses it", !("emailOff" in cfgOf()) && cfgOf().smtp.host === "smtp.gmail.com");
  server.setSmtp(tmp, null, null, { protect, unprotect });
  cfg = cfgOf();
  ok("forgetting the mailbox forgets both", !cfg.smtp && server.savedSmtpPassword(tmp, { unprotect }) === "");
  fs.rmSync(tmp, { recursive: true, force: true });
  const serverSrc = read("desktop/server.js");
  ok("the Worker gets DESKTOP_EMAIL, the address and the MAILER binding — never the password — and only while email is on", /&& !cfg\.emailOff \? new Mailer/.test(serverSrc) && /\.\.\.withoutMailbox_\(secrets\)/.test(serverSrc) && /delete out\.SMTP_PASSWORD/.test(serverSrc) &&
    /DESKTOP_EMAIL: "on", EMAIL_FROM: mailer\.settings\.from/.test(serverSrc) && /serviceBindings: \{ MAILER: \(request\) => mailer\.handle\(request\) \}/.test(serverSrc));
  const mainSrc = read("desktop/main.js");
  ok("the program tries a mailbox before Global settings saves anything (signs in, saves nothing)", /ipcMain\.handle\("odd:check-email"[\s\S]{0,600}const tried = await new Mailer\(clean, pass\)\.verify\(\);/.test(mainSrc));
  ok("…and takes its part of a save — key, mailbox, supplier switch — in one call, with one restart and no reload", /ipcMain\.handle\("odd:apply-settings"/.test(mainSrc) &&
    /if \(key !== undefined\) setShippoKey[\s\S]{0,300}if \(mail\) setEmailOn[\s\S]{0,200}setSupplierConnections[\s\S]{0,40}\}, null, \{ reload: false \}\)/.test(mainSrc) && !/odd:set-email|odd:set-shippo-key|odd:set-suppliers-on/.test(mainSrc));
  const preload = read("desktop/preload.js");
  ok("its preload gives the page those calls and the reads, never a key or password", /checkEmail: \(settings, password\) => ipcRenderer\.invoke\("odd:check-email", settings, password\)/.test(preload) &&
    /applySettings: \(s\) => ipcRenderer\.invoke\("odd:apply-settings", s\)/.test(preload) && /emailSettings: \(\) => ipcRenderer\.invoke\("odd:email-settings"\)/.test(preload) && !/setEmail|setShippoKey|setSuppliersOn/.test(preload));
  ok("the packaged program carries mailer.js and nodemailer", JSON.parse(read("desktop/package.json")).build.files.includes("mailer.js") && /^\d+\.\d+\.\d+$/.test(JSON.parse(read("desktop/package.json")).dependencies.nodemailer));

  console.log("\n=== C. Sending from the back office ===");
  const src = readSources(__dirname);
  const d1 = await createD1();
  await migrate(d1, src);
  d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('business', ?)", [JSON.stringify({ name: "Stitch Co", ownerEmail: "owner@stitch.example", venmo: "stitchco", mailingAddress: "1 Main St\nColumbus OH 43215" })]);
  const lib = new Function(strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/desktop.js")) + "\nreturn { ensureDesktopReady, getSystemIssues };")();
  await lib.ensureDesktopReady({ DB: d1 });
  const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
    "const requireAdmin = async (env, host, key) => host.kind === 'admin' && key === 'x' ? null : jsonResponse({ status: 'error', message: 'Unauthorized' }, 401); const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async (env) => ({ subdomainMap: {}, ...(await getPublicCatalogData(env.DB)) });\n" +
    "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
    strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  const pending = [];
  const post = async (env, body) => {
    const res = await api({ env, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), request: { url: "http://localhost:47123/api/orders", json: async () => body, headers: { get: () => null } } });
    await Promise.all(pending.splice(0));
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const mail = [];
  let mailerAnswer = { ok: true, message: "250 OK" };
  const MAILER = { fetch: async (url, init) => { mail.push(JSON.parse(init.body)); return new Response(JSON.stringify(mailerAnswer), { status: mailerAnswer.ok ? 200 : 502 }); } };
  const off = { DB: d1, EDITION: "desktop" };
  const on = { DB: d1, EDITION: "desktop", DESKTOP_EMAIL: "on", EMAIL_FROM: "pat@example.com", MAILER };
  r = await post(off, { action: "createLocalSale", key: "x", org: "shop", paymentMethod: "Venmo", customerName: "Sam", contact: "sam@example.net",
    items: [{ productId: "__custom__", name: "Club tee", qty: 2, customUnitPrice: 20, type: "shirt" }] });
  const orderId = r.body.orderId;
  r = await post(off, { action: "markPaidManual", key: "x", org: "shop", orderId });
  const issuesOff = (await lib.getSystemIssues(d1).catch(() => [])) || [];
  ok("with no mailbox, marking an order paid sends nothing and reports no failed email", r.status === 200 && mail.length === 0 && !issuesOff.some(x => /email/i.test(x.kind || x.label || "")));
  r = await post(on, { action: "sendTestEmail", key: "x", to: "pat@example.com" });
  const t = mail[0] || {};
  ok("with one, the test email goes through the program's mailer, and the report says so", r.status === 200 && r.body.report.provider === "mailbox" && r.body.report.ok && r.body.report.from === "pat@example.com" && /Your mail server accepted it/.test(r.body.report.hints.join(" ")));
  ok("…from the business, replies to the owner, naming no web address", t.fromName === "Stitch Co" && t.replyTo === "owner@stitch.example" && /the OpenDecoDesk program/.test(t.text) && !/example\.com/.test(t.text + t.html));
  mail.length = 0;
  r = await post(on, { action: "resendEmail", key: "x", org: "shop", orderId });
  ok("Resend confirmation works, and the email ends at the business's name (no site)", r.status === 200 && r.body.resent === "confirmed" && mail.length === 1 &&
    mail[0].to === "sam@example.net" && /Stitch Co<\/p>/.test(mail[0].html) && !/%%|example\.com/.test(mail[0].html + mail[0].text));
  // An invoice: a second order that still owes.
  r = await post(on, { action: "createLocalSale", key: "x", org: "shop", paymentMethod: "Venmo", customerName: "Sam", contact: "sam@example.net",
    items: [{ productId: "__custom__", name: "Cap", qty: 1, customUnitPrice: 30, type: "cap" }] });
  const owing = r.body.orderId;
  mail.length = 0;
  r = await post(on, { action: "sendInvoice", key: "x", org: "shop", orderId: owing, message: "Thanks!", allowDelivery: true });
  const inv = mail[0] || {};
  ok("an invoice is sent with no link (there is no page to open), and no delivery choice", r.status === 200 && r.body.emailSent && r.body.url === "" && !/View &amp; pay|https?:\/\/[^"\s]*invoice/.test(inv.html) && r.body.invoice && r.body.invoice.allowDelivery !== true);
  ok("…it is the invoice itself: the lines, the total, and how to pay from the Business profile", /Here is your invoice/.test(inv.html) && /Cap/.test(inv.html) && /How to pay \$30\.00/.test(inv.html) &&
    /venmo\.com\/u\/stitchco\?txn=pay&amp;amount=30\.00/.test(inv.html) && /A check made out to Stitch Co, mailed to 1 Main St, Columbus OH 43215/.test(inv.html) && /How to pay \$30\.00:/.test(inv.text) && new RegExp(owing).test(inv.text));
  ok("…and asks the program to attach it as a PDF, saying so in the email", inv.pdf && inv.pdf.filename === `Invoice ${owing}.pdf` && inv.pdf.pageSize === "Letter" &&
    /It's also attached as a PDF/.test(inv.html + inv.text) && /<!doctype html>/.test(inv.pdf.html));

  console.log("\n=== D3. The invoice as a PDF ===");
  {
    const doc = inv.pdf.html;
    ok("the PDF's page: who it's from, INVOICE with its number and dates", /class="biz">Stitch Co</.test(doc) && /1 Main St<br>Columbus OH 43215/.test(doc) && />INVOICE</.test(doc) &&
      new RegExp(`Invoice no\\.</td><td>${owing}<`).test(doc) && /Order date/.test(doc));
    ok("…who it's to, the lines and totals, the balance due and how to pay", /Bill to/.test(doc) && /<div>Sam<\/div>/.test(doc) && /sam@example\.net/.test(doc) && /Cap/.test(doc) &&
      /Balance due<\/strong><strong>\$30\.00/.test(doc) && /How to pay \$30\.00/.test(doc) && /venmo\.com\/u\/stitchco/.test(doc) && /Thanks!/.test(doc));
    ok("…in words that suit paper (no 'reply to this email'), loading nothing from anywhere", !/Reply to this email/.test(doc) && !/<(img|link|script)\b|src=|url\(/i.test(doc) && !/%%/.test(doc));
    ok("a cloud install's invoice email has no PDF (it links to its page)", /const pdf = invoiceUrl \? null : await invoiceDocument/.test(read("functions/_lib/email.js")));
    r = await post(on, { action: "getInvoiceDocument", key: "x", org: "shop", orderId: owing });
    ok("Save invoice PDF… gets the same page from the server", r.status === 200 && r.body.document.filename === `Invoice ${owing}.pdf` && /Balance due/.test(r.body.document.html));
    r = await post(on, { action: "getInvoiceDocument", key: "x", org: "shop", orderId });
    ok("…and for a paid order it says Paid in full, with no how-to-pay", r.status === 200 && /Paid in full — thank you/.test(r.body.document.html) && !/How to pay/.test(r.body.document.html));
    r = await post(on, { action: "createLocalSale", key: "x", org: "shop", paymentMethod: "Cash", customerName: "<b>Bold</b> & Co", contact: "",
      items: [{ productId: "__custom__", name: "Tee <script>", qty: 1, customUnitPrice: 10, type: "shirt" }] });
    const odd = r.body.orderId;
    r = await post(on, { action: "getInvoiceDocument", key: "x", org: "shop", orderId: odd });
    ok("names and lines are escaped", r.status === 200 && /&lt;b&gt;Bold&lt;\/b&gt; &amp; Co/.test(r.body.document.html) && /Tee &lt;script&gt;/.test(r.body.document.html) && !/<script>|<b>Bold/.test(r.body.document.html));
    d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('locale', ?)", [JSON.stringify({ country: "OTHER" })]);
    r = await post(on, { action: "getInvoiceDocument", key: "x", org: "shop", orderId: odd });
    ok("outside the US the paper is A4", r.body.document.pageSize === "A4");
    d1._raw.run("DELETE FROM global_settings WHERE key = 'locale'");
    r = await post(on, { action: "voidOrder", key: "x", org: "shop", orderId: odd, reason: "test" });
    r = await post(on, { action: "getInvoiceDocument", key: "x", org: "shop", orderId: odd });
    ok("a voided order has no invoice", r.status === 400 && /voided/.test(r.body.message));
    r = await post({ DB: d1 }, { action: "getInvoiceDocument", key: "x", org: "shop", orderId: owing });
    ok("a cloud install doesn't offer it", r.status !== 200);
    const main = read("desktop/main.js");
    ok("the program draws the page with JavaScript off, on a session of its own, refusing every request but the page", /partition: "odd-pdf", javascript: false, sandbox: true/.test(main) &&
      /onBeforeRequest\(\(details, cb\) => cb\(\{ cancel: !details\.url\.startsWith\("data:text\/html"\) \}\)\)/.test(main) && /printToPDF\(/.test(main) && /page\.destroy\(\)/.test(main));
    ok("…and hands it to the mailer and to Save invoice PDF… (asking where to save)", /logFile\.write\(t, "worker"\), renderPdf \}\)/.test(main) && /odd:save-invoice-pdf/.test(main) && /showSaveDialog/.test(main) &&
      /saveInvoicePdf: \(doc\) => ipcRenderer\.invoke\("odd:save-invoice-pdf", doc\)/.test(read("desktop/preload.js")));
  }

  mailerAnswer = { ok: false, message: "The mailbox refused the sign-in. (535 bad)" };
  mail.length = 0;
  r = await post(on, { action: "sendTestEmail", key: "x", to: "pat@example.com" });
  ok("a refused test email shows the mail server's answer", r.status === 200 && !r.body.report.ok && /535 bad/.test(r.body.report.providerMessage) && /Global settings → Email/.test(r.body.report.hints.join(" ")));
  r = await post(on, { action: "resendEmail", key: "x", org: "shop", orderId });
  const issuesOn = (await lib.getSystemIssues(d1).catch(() => [])) || [];
  ok("…and with email on, a failed order email is a problem the roll-up reports", issuesOn.some(x => /email/i.test(JSON.stringify(x))));
  mailerAnswer = { ok: true, message: "250 OK" };
  const emailSrc = read("functions/_lib/email.js");
  ok("one provider per install: the mailbox in the desktop program, before Resend or Cloudflare", /const via = desktopEmail_\(env\) === "on" \? "mailbox" : env && env\.RESEND_API_KEY \? "resend" : "cloudflare";/.test(emailSrc));

  console.log("\n=== D2. Design approval by email ===");
  {
    const host = new Function(strip(read("functions/_lib/hostConfig.js")) + "\nreturn { desktopLockedFeatures };")();
    ok("design approval is locked off without email, and unlocked with it", host.desktopLockedFeatures(off).includes("designVerification") && !host.desktopLockedFeatures(on).includes("designVerification") &&
      host.desktopLockedFeatures({ ...on, SHIPPO_API_KEY: "k" }).join() === "storefront");
    r = await post(off, { action: "updateFeatures", key: "x", features: { designVerification: true } });
    ok("…turning it on without email says to set up the mailbox", r.status === 400 && /Design approval needs email — set up your mailbox under Global settings → Email/.test(r.body.message));
    const stored = { "uploads/verify/abc123.png": png };
    const IMAGES = { get: async (k) => stored[k] ? { arrayBuffer: async () => stored[k].buffer.slice(stored[k].byteOffset, stored[k].byteOffset + stored[k].length), httpMetadata: { contentType: "image/png" } } : null };
    const withImages = { ...on, IMAGES, R2_PUBLIC_BASE: "https://images.desktop.invalid" };
    r = await post(withImages, { action: "updateFeatures", key: "x", features: { designVerification: true } });
    ok("…and with email it turns on", r.status === 200 && r.body.features.designVerification === true);
    await lib.ensureDesktopReady(withImages);
    ok("the start-up step leaves it as the owner set it while email is on", (await new Function(strip(read("functions/_lib/db.js")) + "\nreturn getFeatures;")()(d1)).designVerification === true);
    r = await post(withImages, { action: "createLocalSale", key: "x", org: "shop", paymentMethod: "Venmo", customerName: "Sam", contact: "sam@example.net",
      items: [{ productId: "__custom__", name: "Polo", qty: 1, customUnitPrice: 30, type: "shirt" }] });
    const proofOrder = r.body.orderId;
    mail.length = 0;
    r = await post(withImages, { action: "sendDesignVerification", key: "x", org: "shop", orderIds: [proofOrder], message: "Here is your logo on the polo.",
      imageUrls: ["https://images.desktop.invalid/uploads/verify/abc123.png", "https://cdn.example.org/mockup.png"] });
    const dv = mail[0] || {};
    ok("the proof is emailed with the picture stored here attached, shown in the email by its cid", r.status === 200 && r.body.sent === 1 && (dv.attachments || []).length === 1 &&
      dv.attachments[0].contentBase64 === png.toString("base64") && dv.attachments[0].contentType === "image/png" && dv.attachments[0].cid === "proof1" && /src="cid:proof1"/.test(dv.html));
    ok("…a picture on another site stays a link, and nothing points at this computer", /src="https:\/\/cdn\.example\.org\/mockup\.png"/.test(dv.html) && !/images\.desktop\.invalid|\?verify=|localhost/.test(dv.html + dv.text));
    ok("…and asks the customer to reply to approve it or say what to change", /Please reply to this email: say “approved” if it's right/.test(dv.html) && /The design is attached \(proof-1\.png\)/.test(dv.text) && !/Review &amp; Respond/.test(dv.html));
    r = await post(withImages, { action: "sendDesignVerification", key: "x", org: "shop", orderIds: [proofOrder], message: "Again", imageUrls: ["https://images.desktop.invalid/uploads/verify/gone.png"] });
    ok("a picture that isn't stored any more is reported, and nothing is sent", r.status === 400 && /isn't stored any more/.test(r.body.message) && mail.length === 1);
    const verif = async () => ((await post(withImages, { action: "listDesignVerifications", key: "x", org: "shop" })).body.verifications || []).find(v => v.orderId === proofOrder) || {};
    ok("the proof is waiting for the customer's answer", (await verif()).status === "pending");
    await post(withImages, { action: "markPaidManual", key: "x", org: "shop", orderId: proofOrder });
    await post(withImages, { action: "setFulfillmentStage", key: "x", org: "shop", orderId: proofOrder, stage: "digitizingComplete" });
    r = await post(withImages, { action: "setFulfillmentStage", key: "x", org: "shop", orderId: proofOrder, stage: "designApproved" });
    const v2 = await verif();
    ok("marking the order Design approved records their approval on the proof", r.status === 200 && v2.status === "approved" && /Approved by reply/.test(v2.customerNote) && !!v2.respondedAt);
    ok("a cloud install's proof still links to its page", /Review &amp; Respond/.test(read("functions/_lib/email.js")) && /verifyUrl: desktop \? "" : verifyUrl/.test(read("functions/api/orders.js")));
    await lib.ensureDesktopReady(off);
    ok("once email is turned off, the next start switches design approval off again", (await new Function(strip(read("functions/_lib/db.js")) + "\nreturn getFeatures;")()(d1)).designVerification === false);
  }

  console.log("\n=== D. The morning roll-up ===");
  const worker = await import("./src/worker.js");
  const realFetch = global.fetch, looked = [];
  global.fetch = async (u) => { looked.push(String(u)); throw new Error("no network in this test"); };
  mail.length = 0;
  // Times on today's date (UTC, the time zone with none set): the roll-up records when it ran by the clock.
  const today = new Date().toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const at = (day, hm) => ({ scheduledTime: Date.parse(`${day}T${hm}:00Z`) });
  let out = await worker.handleScheduled(at(today, "05:30"), { ...on });
  ok("before the roll-up's hour (6 AM in the business's time zone) nothing is sent", out.ran === true && !out.rollUp && mail.length === 0);
  out = await worker.handleScheduled(at(today, "09:10"), { ...on });
  ok("the first run on or after it sends the roll-up to the owner", out.rollUp && mail.length === 1 && mail[0].to === "owner@stitch.example" && /^Daily roll-up/.test(mail[0].subject));
  ok("…with no link to an admin address nobody else can open", !/https?:\/\/admin\./.test(mail[0].html + mail[0].text) && !/%%/.test(mail[0].html));
  out = await worker.handleScheduled(at(today, "11:10"), { ...on });
  ok("later runs that day send no second one", !out.rollUp && mail.length === 1);
  out = await worker.handleScheduled(at(tomorrow, "07:00"), { ...on });
  ok("the next morning's first run sends again (a quiet day gets the short 'nothing new' note)", out.rollUp && mail.length === 2 && /nothing new/.test(mail[1].subject) && /Tools → Communications in the program/.test(mail[1].text));
  ok("…and nothing went to a supplier or anywhere else (supplier connections are off)", looked.length === 0);
  out = await worker.handleScheduled(at(tomorrow, "08:00"), { ...off });
  ok("without email set up the desktop's scheduled run sends nothing", out.ran === false && mail.length === 2);
  global.fetch = realFetch;

  console.log("\n=== E. The admin ===");
  const catalog = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
    "const getCatalogData = async (env) => ({ subdomainMap: {}, ...(await getPublicCatalogData(env.DB)) });\n" + strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
  const adminAnswer = async (env) => JSON.parse(await (await catalog({ request: { url: "http://localhost:47830/api/catalog" }, env })).text());
  ok("the admin is told when email is set up, and not otherwise", (await adminAnswer(on)).desktopEmail === true && !("desktopEmail" in (await adminAnswer(off))));
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const saved = [], asked = [], pdfSaves = [], applied = [], sentFetch = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "http://localhost:47830/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && !/getInvoiceDocument/.test(opts.body)) sentFetch.push(JSON.parse(opts.body).action);
        if (String(url).includes("/api/catalog")) { const body = await adminAnswer(on); return { ok: true, status: 200, json: async () => body }; }
        if (String(url).includes("/api/orders") && opts && /getInvoiceDocument/.test(opts.body)) { asked.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ status: "ok", document: { filename: "Invoice X1.pdf", html: "<p>x</p>", pageSize: "Letter" } }) }; }
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      win.oddDesktop = { edition: "desktop", firstRunKey: async () => null,
        checkEmail: async (settings, password) => { saved.push({ settings, password }); return password === "wrong" ? { ok: false, message: "The mailbox refused the sign-in." } : { ok: true }; },
        applySettings: async (s) => { applied.push(s); return { ok: true }; },
        saveInvoicePdf: async (doc) => { pdfSaves.push(doc); return { ok: true, path: "/home/pat/Documents/Invoice X1.pdf" }; } };
      win.confirm = () => true;
    } });
  const w = dom.window, doc = w.document;
  const tick = (ms) => new Promise(res => setTimeout(res, ms || 40));
  await tick(200);
  await w.loadAdminScript();
  await tick(100);
  ok("the page learns email is set up", w.eval("siteDesktopEmail") === true && w.adminDesktopEmail_() === true);
  ok("…so Communications is back (its test send, the roll-up preview, failed emails)", w.adminDesktopHides_("comms") === false && w.adminDesktopHides_("vendors") === true);
  const cell = w.adminActionCell({ orgId: "shop" }, { orderId: "X1", paid: false, items: [{}], balanceDue: 20 });
  ok("…and the order buttons that send email", /resendEmail/.test(cell) && /showSendInvoiceModal/.test(cell) && /Email the customer the invoice \(with a PDF of it\) and how to pay/.test(cell));
  ok("a sent invoice says when, not whether it was opened (there is no page to open)", !/opened/.test(w.invoiceCell_({ orgId: "shop" }, { orderId: "X1", balanceDue: 20, invoice: { sentAt: "2026-11-02T10:00:00Z" } })));
  w.eval("siteDesktopEmail = false");
  ok("without email, Communications and those buttons are gone", w.adminDesktopHides_("comms") === true && !/resendEmail|showSendInvoiceModal/.test(w.adminActionCell({ orgId: "shop" }, { orderId: "X1", paid: false, items: [{}], balanceDue: 20 })));
  w.eval("siteDesktopEmail = true");
  // Global settings → Features, as the desktop version draws it.
  const FEATURES_LIST = [["storefront", "Storefront"], ["production", "Production"], ["bookkeeping", "Bookkeeping"], ["shipping", "Shipping"], ["designVerification", "Design approval"]]
    .map(([key, label]) => ({ key, label, description: label + " does things." }));
  const ctxFor = (over) => ({ desktop: true, featureList: FEATURES_LIST, features: { storefront: false, shipping: false, designVerification: false }, lockedFeatures: ["storefront", "shipping", "designVerification"],
    shipFrom: {}, us: true, machineSettings: { showDeleteButton: false }, machineLoaded: true, keySet: false, cloudKey: null, emailSaved: null, suppliersOn: false, ...over });
  const draw = (over) => {
    const ctx = w.eval("window")._gSettingsCtx = ctxFor(over);
    const old = doc.getElementById("gTestForm"); if (old) old.remove();
    const box = doc.createElement("div"); box.id = "gTestForm";
    box.innerHTML = w.globalFeaturesHtml_(ctx) + '<input type="checkbox" id="gPayCard"><input type="checkbox" id="gPayVenmo"><input type="checkbox" id="gPayZelle"><input type="checkbox" id="gPayCheck"><div id="globalSettingsError"></div>';
    doc.body.appendChild(box);
    w.wireGlobalFeatures_(ctx);
    return ctx;
  };
  const $ = (id) => doc.getElementById(id);
  const tick_ = (id, on) => { const b = doc.querySelector(`#gFeatRow-${id} .g-feat-head input`); b.checked = on; b.dispatchEvent(new w.Event("change")); return b; };
  draw();
  const rows = [...doc.querySelectorAll("#gFeatures .g-feat")].filter(r => r.style.display !== "none").map(r => r.id.replace("gFeatRow-", ""));
  ok("the desktop Features: Production, Bookkeeping, Shipping, Email with Design approval under it, Supplier connections — no Storefront", rows.join() === "production,bookkeeping,shipping,email,designVerification,suppliers" &&
    $("gFeatRow-designVerification").classList.contains("g-feat-sub"));
  ok("nothing on yet: the panels are closed, and Design approval waits for Email", $("gPanel-shipping").hidden && $("gPanel-email").hidden && $("gPanel-suppliers").hidden &&
    doc.querySelector("#gFeatRow-designVerification .gFeature").disabled && /needs Email/.test($("gFeatRow-designVerification").textContent));
  ok("…and Shipping can be ticked without a key yet (the key goes in its panel)", !doc.querySelector("#gFeatRow-shipping .gFeature").disabled);
  tick_("email", true);
  ok("ticking Email opens its panel: required fields marked, Gmail first, the password hidden as typed", !$("gPanel-email").hidden && /Every field marked \* is required while Email is on/.test($("gPanel-email").textContent) &&
    $("gEmailPreset").value === "gmail" && $("gEmailPass").type === "password" && /No mailbox yet/.test($("gPanel-email").textContent) && /Microsoft 365 and Outlook\.com mailboxes aren't supported yet/.test($("gPanel-email").textContent));
  ok("…and lets Design approval be ticked", !doc.querySelector("#gFeatRow-designVerification .gFeature").disabled);
  $("gEmailPreset").value = "icloud"; $("gEmailPreset").onchange();
  ok("choosing a mailbox fills in its server and says what password it needs", $("gEmailHost").value === "smtp.mail.me.com" && $("gEmailPort").value === "587" && /app-specific password/.test($("gEmailPresetNote").textContent));
  tick_("designVerification", true);
  tick_("email", false);
  ok("unticking Email closes it and unticks Design approval", $("gPanel-email").hidden && !doc.querySelector("#gFeatRow-designVerification .gFeature").checked && doc.querySelector("#gFeatRow-designVerification .gFeature").disabled);
  tick_("email", true);
  $("gEmailPreset").value = "other"; $("gEmailPreset").onchange();
  $("gEmailFrom").value = "orders@stitch.example";
  let problem = w.globalSettingsProblem_();
  ok("Save checks Email first: another provider needs its server and the password, and the server settings open", /Email needs the outgoing \(SMTP\) server, the password/.test(problem) && $("gEmailServer").open && /Nothing was saved/.test(problem));
  $("gEmailHost").value = "mail.stitch.example"; $("gEmailPort").value = "465"; $("gEmailPort").onchange(); $("gEmailPass").value = "wrong";
  ok("…complete, nothing is wrong", w.globalSettingsProblem_() === "");
  let ch = w.globalProgramChanges_();
  ok("the program's part: the mailbox, on, with its password", ch.email && ch.email.on === true && ch.email.settings.host === "mail.stitch.example" && ch.email.settings.port === 465 &&
    ch.email.settings.security === "tls" && ch.email.settings.user === "orders@stitch.example" && ch.email.password === "wrong" && !("shippoKey" in ch) && !("suppliers" in ch));
  saved.length = 0; applied.length = 0; sentFetch.length = 0;
  await w.submitGlobalSettings(); await tick(40);
  ok("a mailbox that won't sign in stops the save before anything is sent or applied", saved.length === 1 && applied.length === 0 && sentFetch.length === 0 &&
    /Nothing was saved\. The mailbox didn't sign in: The mailbox refused the sign-in/.test($("globalSettingsError").textContent));
  tick_("shipping", true);
  ok("ticking Shipping opens the Shippo key and the ship-from address, all required", !$("gPanel-shipping").hidden && !!$("gShippoKey") && !!$("gShipName") && /All fields below are required while Shipping is on/.test($("gPanel-shipping").textContent));
  problem = w.globalSettingsProblem_();
  ok("…and Save says what it needs: the key and every address field, name included", /Shipping needs a Shippo key, the ship-from name, the ship-from street address/.test(problem) && $("gShippoKey").style.outline.includes("solid") && $("gShipName").style.outline.includes("solid"));
  $("gShipName").value = "Stitch Co"; $("gShipName").dispatchEvent(new w.Event("input"));
  ok("…an outlined field clears as soon as it's filled in", !$("gShipName").style.outline && $("gShipCity").style.outline.includes("solid"));
  $("gShippoKey").value = "shippo_test_xyz";
  ch = w.globalProgramChanges_();
  ok("a typed key goes to the program with the rest", ch.shippoKey === "shippo_test_xyz");
  tick_("shipping", false); tick_("suppliers", true);
  ok("Supplier connections: ticking says Save turns them on, then the vendors are here", !$("gPanel-suppliers").hidden && /Save<\/strong> with this ticked to turn supplier connections on/.test($("gPanel-suppliers").innerHTML) && w.globalProgramChanges_().suppliers === true);
  draw({ emailSaved: { host: "smtp.fastmail.com", port: 465, security: "tls", user: "pat@fastmail.com", from: "pat@fastmail.com", on: true }, keySet: true, features: { shipping: true, designVerification: true } });
  ok("with a mailbox in use: Email ticked and open, saying from where, with a test send; Design approval ticked", !$("gPanel-email").hidden && /Email is on: sending from pat@fastmail\.com through smtp\.fastmail\.com/.test($("gPanel-email").textContent) &&
    !!$("gEmailTest") && $("gEmailPreset").value === "fastmail" && $("gEmailPass").placeholder === "Leave empty to keep the saved one" && doc.querySelector("#gFeatRow-designVerification .gFeature").checked);
  ok("…unchanged, the program is asked for nothing", Object.keys(w.globalProgramChanges_()).length === 0);
  ok("a saved Shippo key: never shown, with Remove key", /✓ A key is saved \(never shown\)/.test($("gPanel-shipping").textContent) && !!$("gShippoRemove") && $("gShippoKey").value === "");
  $("gShippoRemove").onclick();
  ok("…Remove key with Shipping still ticked can't be saved", /Shipping needs a Shippo key/.test(w.globalSettingsProblem_()) && w.globalProgramChanges_().shippoKey === null);
  tick_("email", false);
  ok("unticking Email turns it off and keeps the mailbox", JSON.stringify(w.globalProgramChanges_().email) === JSON.stringify({ on: false }));
  draw({ emailSaved: { host: "smtp.fastmail.com", port: 465, security: "tls", user: "pat@fastmail.com", from: "pat@fastmail.com", on: false } });
  ok("a mailbox saved but off says so", /A mailbox is saved \(pat@fastmail\.com\), not in use while Email is off/.test($("gPanel-email").textContent) && $("gPanel-email").hidden);
  doc.getElementById("gTestForm").remove();
  ok("an order has Save invoice PDF… — paid or not, but not once voided", /saveInvoicePdf_/.test(w.invoiceCell_({ orgId: "shop" }, { orderId: "X1", balanceDue: 20 })) &&
    /Save invoice PDF/.test(w.invoiceCell_({ orgId: "shop" }, { orderId: "X1", balanceDue: 0, paid: true })) && !/Save invoice PDF/.test(w.invoiceCell_({ orgId: "shop" }, { orderId: "X1", balanceDue: 0, voidedAt: "2026-11-01" })));
  w.eval('adminKey = "x"');
  await w.saveInvoicePdf_("shop", "X1");
  ok("…which gets the invoice page from the server and has the program save it as a PDF", asked.length === 1 && asked[0].orderId === "X1" && pdfSaves.length === 1 && pdfSaves[0].filename === "Invoice X1.pdf" &&
    /Saved Invoice X1\.pdf/.test(doc.body.textContent));
  const proofModal = w.showDesignVerifModal();
  await tick(20);
  ok("the proof window says the pictures are attached and the customer replies", /attached to the email, and the customer replies/.test(doc.body.textContent) && /Design approved/.test(doc.body.textContent));
  doc.getElementById("dvCancel").click();
  ok("…and closes with nothing sent", (await proofModal) === null);
  ok("a proof waiting for an answer reads Awaiting reply", /Awaiting reply/.test(w.verifSentCell({ sentAt: "2026-11-02T10:00:00Z", status: "pending" }, 1)));
  ok("#vendors opens Global settings at Supplier connections in the desktop version", /if \(adminDesktop_\(\) && String\(raw\)\.split\("\/"\)\[0\] === "vendors"\) \{ window\._gScrollTo = "gFeatRow-suppliers"; renderGlobalSettings\(app\); return; \}/.test(adminJs));
  w.close();
})().catch(e => { console.error(e); process.exit(1); });
