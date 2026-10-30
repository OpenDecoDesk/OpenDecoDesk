import { addOwnerNotice, recordSystemIssue, getBusinessProfile, resolveTimeZone, getLocaleSettings } from "./db.js";

/**
 * Transactional email, sent through Cloudflare Email Service. Sends from EMAIL_FROM (default
 * orders@<root domain>) under the business's name, with reply-to the owner's inbox, and BCCs a
 * receipts inbox when one is set (EMAIL_BCC, or Business profile → Receipts inbox) so there's a copy
 * of everything sent. Who the business is comes from the Business profile setting (db.js).
 * An install on the free Workers plan (no Cloudflare email) can send through Resend instead: set
 * RESEND_API_KEY and that provider is used for everything (sendViaResend_). The desktop program
 * sends through the owner's own mailbox instead (SMTP, its MAILER binding: sendViaMailer_), once
 * email is set up there; until then it sends nothing (desktopEmail_). Cloudflare sending uses the `EMAIL` send_email binding if one is configured, otherwise the REST API
 * with CF_EMAIL_API_TOKEN (encrypted; a token with Email Sending permission only) + CF_ACCOUNT_ID.
 *
 * There is no second transport: a send that fails (not configured, API error, network, or the
 * customer's address permanently bouncing) returns false and is recorded as an `email_failed`
 * system issue, which the 6 AM roll-up and the Communications page report.
 *
 * All functions return true on success, false on failure — never throw.
 * Templates say who they are from / to with placeholders (OWNER_, BUSINESS_, SITE_ below); send_ —
 * the one place every email goes through — fills them in from the Business profile.
 */

// Placeholders, filled in by send_ (fillTemplate_): the owner's inbox, the business name, the site.
const ORDER_NOTIFICATION_EMAIL = "%%OWNER_EMAIL%%";
const BUSINESS_ = "%%BUSINESS%%";
const SITE_ = "%%SITE%%";
// The install's root domain and admin address (ROOT_DOMAIN / ADMIN_SUBDOMAIN — the same rule as
// hostConfig.js, repeated here so this file has no import beyond db.js).
const siteRoot_ = (env) => String((env && env.ROOT_DOMAIN) || "example.com").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
// The desktop program (EDITION=desktop, hostConfig.js) has no site and no admin address anyone else
// can open: its emails name neither, and carry no links back to it.
const isDesktop_ = (env) => String((env && env.EDITION) || "").trim().toLowerCase() === "desktop";
const adminSiteUrl_ = (env) => isDesktop_(env) ? "" : "https://" + (String((env && env.ADMIN_SUBDOMAIN) || "admin").split(",")[0].trim() || "admin") + "." + siteRoot_(env);
// The desktop program sends only once email is set up there (Global settings → Email: the owner's
// mailbox, the MAILER binding). "off" until then: nothing is sent, and nothing is recorded as a
// failure — no email is the desktop's normal state, not a problem.
const desktopEmail_ = (env) => !isDesktop_(env) ? "" : (env.MAILER && typeof env.MAILER.fetch === "function" ? "on" : "off");

// Who this install is, for one message: the saved Business profile with its fallbacks.
//   owner inbox: the profile's, else OWNER_EMAIL, else owner@<root domain>
//   receipts BCC: EMAIL_BCC, else the profile's (none by default)
async function mailIdentity_(env) {
  let p = {};
  try { p = (await getBusinessProfile(env && env.DB)) || {}; } catch (e) { p = {}; }
  const site = isDesktop_(env) ? "" : siteRoot_(env);
  return { name: p.name || "Our shop", site,
    owner: p.ownerEmail || String((env && env.OWNER_EMAIL) || "").trim() || (site ? "owner@" + site : String((env && env.EMAIL_FROM) || "").trim()),
    bcc: String((env && env.EMAIL_BCC) || "").trim() || p.receiptsEmail || "" };
}
function fillTemplate_(msg, id) {
  // No site (the desktop program): "Business — site" footers end at the business's name.
  const noSite = (v) => id.site ? v : v.split(" — %%SITE%%").join("").split(", %%SITE%%").join("");
  const fill = (v, html) => v == null ? v : noSite(String(v)).split("%%OWNER_EMAIL%%").join(id.owner).split("%%BUSINESS%%").join(html ? escHtml(id.name) : id.name).split("%%SITE%%").join(id.site);
  return { ...msg, to: fill(msg.to), subject: fill(msg.subject), html: fill(msg.html, true), text: fill(msg.text) };
}

// Owner notices don't email immediately: they're queued for the 6 AM daily
// roll-up (see sendDailyDigestEmail). Only if queueing fails (no DB binding,
// table not migrated, D1 error) is the notice emailed right away instead, so
// nothing is ever lost.
async function queueOwnerNotice_(env, notice, fallbackEmail) {
  if (env && env.DB) {
    try { await addOwnerNotice(env.DB, notice); return true; }
    catch (e) { console.error("Could not queue owner notice — emailing it now instead:", e); }
  }
  return send_(env, fallbackEmail);
}

async function send_(env, msg) {
  if (!msg || !msg.to) return false;
  if (desktopEmail_(env) === "off") return false;
  const id = await mailIdentity_(env);
  msg = fillTemplate_(msg, id);
  if (!String(msg.to).includes("@")) return false;
  // A non-production install can mark every subject (EMAIL_SUBJECT_TAG, e.g. "[TEST]") so its emails
  // can't be mistaken for the real site's when both send to the same inboxes. Unset by default.
  const tag = env && env.EMAIL_SUBJECT_TAG ? String(env.EMAIL_SUBJECT_TAG).trim().slice(0, 30) : "";
  if (tag && !String(msg.subject || "").startsWith(tag)) msg = { ...msg, subject: `${tag} ${msg.subject || ""}`.trim() };
  // One provider per install: the owner's mailbox in the desktop program, else Resend when
  // RESEND_API_KEY is set, otherwise Cloudflare Email Service. Never two — a failed send is a
  // failure, not a reason to try somewhere else.
  const via = desktopEmail_(env) === "on" ? "mailbox" : env && env.RESEND_API_KEY ? "resend" : "cloudflare";
  const r = via === "mailbox" ? await sendViaMailer_(env, msg, id) : via === "resend" ? await sendViaResend_(env, msg, id) : await sendViaCloudflare_(env, msg, id);
  if (r === true) return true;
  if (r !== "bounced") console.error({ mailbox: "Mailbox (SMTP)", resend: "Resend", cloudflare: "Cloudflare Email Service" }[via] + " send failed for:", msg.subject);
  await recordSystemIssue(env && env.DB, "email_failed", msg.subject);
  return false;
}

// The desktop program's mailbox (desktop/mailer.js, over its MAILER binding): the program sends from
// the mailbox's own address (EMAIL_FROM) under the business's name. Returns true or false; `report`
// as for Resend, with the mail server's answer.
async function sendViaMailer_(env, { to, subject, html, text, attachments, pdf }, id, report) {
  const bcc = id.bcc && id.bcc.toLowerCase() !== String(to).trim().toLowerCase() ? [id.bcc] : [];
  try {
    const res = await env.MAILER.fetch("https://mailer.desktop.invalid/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, fromName: id.name, replyTo: id.owner, bcc, subject, html: html || undefined, text: text || "(no plain-text body)",
        ...((attachments || []).length ? { attachments } : {}), ...(pdf ? { pdf } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (report) Object.assign(report, { httpStatus: res.status, providerMessage: String(data.message || "").slice(0, 500) });
    if (!res.ok || !data.ok) { console.error("Mailbox send failed:", String(data.message || res.status).slice(0, 300)); return false; }
    return true;
  } catch (e) {
    console.error("Mailbox send error:", e);
    if (report) report.providerMessage = "Couldn't reach the program's mail sender: " + String((e && e.message) || e).slice(0, 300);
    return false;
  }
}

// Resend (https://resend.com) — an alternative for an install that can't use Cloudflare's email
// (it needs the paid Workers plan). Set RESEND_API_KEY and verify the sending domain with Resend;
// the sender is still EMAIL_FROM. Returns true (accepted) or false. Unlike Cloudflare's API, Resend
// reports a bounce later (by webhook), so a permanently bouncing address isn't detected here.
// `report` (optional, the test send on the Communications page): filled with what the provider said.
async function sendViaResend_(env, { to, subject, html, text }, id, report) {
  const from = String(env.EMAIL_FROM || ("orders@" + siteRoot_(env))).trim();
  const bcc = id.bcc && id.bcc.toLowerCase() !== String(to).trim().toLowerCase() ? [id.bcc] : [];
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${String(env.RESEND_API_KEY).trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${String(id.name).replace(/[<>"\r\n]/g, "")} <${from}>`, to: [to], reply_to: id.owner,
        ...(bcc.length ? { bcc } : {}), subject, html: html || undefined, text: text || "(no plain-text body)",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (report) Object.assign(report, { httpStatus: res.status, providerId: data.id || "",
      providerMessage: String(data.message || data.error || (data.name ? data.name : "") || "").slice(0, 500), providerName: data.name || "" });
    if (!res.ok || !data.id) {
      console.error(`Resend HTTP ${res.status}:`, JSON.stringify(data).slice(0, 500));
      return false;
    }
    return true;
  } catch (e) {
    console.error("Resend error:", e);
    if (report) report.providerMessage = "Couldn't reach Resend: " + String((e && e.message) || e).slice(0, 300);
    return false;
  }
}

// Cloudflare Email Service. Returns true (sent), "bounced" (the recipient's address permanently
// bounced), or false (not configured / failed).
async function sendViaCloudflare_(env, { to, subject, html, text }, id, report) {
  const from = String(env.EMAIL_FROM || ("orders@" + siteRoot_(env))).trim();
  const fromName = id.name;
  const bccAddr = id.bcc;
  // Mail already addressed TO the receipts inbox doesn't need a second, BCC'd copy.
  const bcc = bccAddr && bccAddr.toLowerCase() !== String(to).trim().toLowerCase() ? [bccAddr] : [];
  try {
    if (env.EMAIL && typeof env.EMAIL.send === "function") {
      await env.EMAIL.send({
        to, from: { email: from, name: fromName }, replyTo: id.owner,
        ...(bcc.length ? { bcc } : {}), subject, html: html || undefined, text: text || "(no plain-text body)",
      });
      return true;
    }
    if (!env.CF_EMAIL_API_TOKEN || !env.CF_ACCOUNT_ID) {
      console.error("Email is not configured: set an EMAIL binding, or CF_EMAIL_API_TOKEN + CF_ACCOUNT_ID");
      if (report) report.providerMessage = "No email provider is set up (no RESEND_API_KEY, no EMAIL binding, no CF_EMAIL_API_TOKEN + CF_ACCOUNT_ID).";
      return false;
    }
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/email/sending/send`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.CF_EMAIL_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to, from: { address: from, name: fromName }, reply_to: id.owner,
        ...(bcc.length ? { bcc } : {}), subject, html: html || undefined, text: text || "(no plain-text body)",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (report) Object.assign(report, { httpStatus: res.status,
      providerMessage: ((data.errors || []).map(e => (e.code ? e.code + ": " : "") + (e.message || "")).join("; ") || "").slice(0, 500) });
    if (!res.ok || !data.success) {
      console.error(`Cloudflare email HTTP ${res.status}:`, JSON.stringify(data.errors || data).slice(0, 500));
      return false;
    }
    const bounced = ((data.result && data.result.permanent_bounces) || []).map((a) => String(a).toLowerCase());
    if (bounced.includes(String(to).trim().toLowerCase())) {
      console.error("Cloudflare email: recipient permanently bounced:", to);
      return "bounced";
    }
    return true;
  } catch (e) {
    console.error("Cloudflare email error:", e);
    if (report) report.providerMessage = "Couldn't send through Cloudflare: " + String((e && e.message) || e).slice(0, 300);
    return false;
  }
}

// ---- The test send (Tools → Communications → Send a test email) ---------------------------------
// One short message to `to`, through exactly the path every other email takes, and a report of what
// happened that someone can act on: which provider, from which address, what it answered, and — for
// the usual mistakes — what to do. Never records an email_failed issue (it's a deliberate test).
// Secrets are never returned: a key is described (set or not, its length, whether it looks right).
export async function sendTestEmail(env, to) {
  const id = await mailIdentity_(env);
  const from = String((env && env.EMAIL_FROM) || ("orders@" + siteRoot_(env))).trim();
  const desktop = desktopEmail_(env);
  const key = !desktop && env && env.RESEND_API_KEY != null ? String(env.RESEND_API_KEY) : "";
  const provider = desktop === "on" ? "mailbox" : desktop === "off" ? "none" : key ? "resend" : (env && env.EMAIL && typeof env.EMAIL.send === "function") ? "cloudflare-binding"
    : (env && env.CF_EMAIL_API_TOKEN && env.CF_ACCOUNT_ID) ? "cloudflare-api" : "none";
  const report = { provider, from, fromDomain: from.split("@")[1] || "", to: String(to || ""), replyTo: id.owner, bcc: id.bcc || "",
    businessName: id.name, rootDomain: siteRoot_(env), subjectTag: env && env.EMAIL_SUBJECT_TAG ? String(env.EMAIL_SUBJECT_TAG).trim() : "",
    key: key ? { length: key.trim().length, looksLikeResend: /^re_[A-Za-z0-9_]+$/.test(key.trim()), spaceInside: /\s/.test(key.trim()), paddedEnds: key !== key.trim() } : null,
    httpStatus: null, providerMessage: "", providerId: "", ok: false, hints: [] };
  const hint = (t) => report.hints.push(t);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(report.to)) { hint("Enter an email address to send the test to."); return report; }
  if (report.fromDomain === "example.com" && !desktop) hint("ROOT_DOMAIN isn't set, so emails would come from an example.com address. Set ROOT_DOMAIN (or EMAIL_FROM) to your own domain.");
  if (key && report.key.spaceInside) hint("RESEND_API_KEY has a space or line break in the middle — copy it again (wrangler secret put RESEND_API_KEY) and redeploy.");
  else if (key && report.key.paddedEnds) hint("RESEND_API_KEY was saved with a space or line break at the end. Emails now ignore it, but it's worth setting the key again cleanly.");
  else if (key && !report.key.looksLikeResend) hint("RESEND_API_KEY doesn't look like a Resend key (they start with re_). Check you pasted the API key itself.");
  if (provider === "none") { hint(desktop ? "Email isn't set up. Add your mailbox under Global settings → Email." : "No email provider is set up. Set RESEND_API_KEY (a secret), or Cloudflare Email Service — see docs/email.md."); return report; }
  const tag = report.subjectTag;
  const where = desktop ? "the OpenDecoDesk program" : report.rootDomain;
  const msg = { to: report.to, subject: (tag ? tag + " " : "") + "Test email from " + id.name,
    html: `<div style="font-family:sans-serif"><p>This is a test email from <strong>${escHtml(id.name)}</strong> (${escHtml(where)}), sent from Tools → Communications.</p><p>If you can read this, email is working.</p></div>`,
    text: `This is a test email from ${id.name} (${where}), sent from Tools → Communications.\n\nIf you can read this, email is working.` };
  const r = provider === "mailbox" ? await sendViaMailer_(env, msg, id, report) : provider === "resend" ? await sendViaResend_(env, msg, id, report) : await sendViaCloudflare_(env, msg, id, report);
  report.ok = r === true;
  if (r === "bounced") hint("That address permanently bounced — try another one.");
  if (!report.ok && provider === "resend") {
    const m = report.providerMessage.toLowerCase(), st = report.httpStatus;
    if (st === 401 || (st === 403 && /api key/.test(m))) hint("Resend refused the API key. Make a new key in Resend (API Keys, with sending access), set it again with wrangler secret put RESEND_API_KEY, and redeploy.");
    if (/domain/.test(m) && /verif|not.*(found|added)/.test(m)) hint(`Resend hasn't verified the domain you send from (${report.fromDomain}). In Resend → Domains add ${report.fromDomain}, put its DNS records in Cloudflare DNS, and wait until it shows Verified. Or set EMAIL_FROM to an address on a domain that is verified.`);
    if (/only send testing emails to your own email/.test(m)) hint("Resend is in testing mode: without a verified domain it only sends to your own Resend account's address. Verify your domain in Resend → Domains.");
    if (st === 422 && /from/.test(m)) hint(`Resend didn't accept the From address (${report.from}). Set EMAIL_FROM to a plain address on your verified domain, like orders@${report.rootDomain}.`);
    if (st === 429) hint("Resend's rate limit — wait a minute and try again.");
    if (!report.hints.length || report.hints.every(h => /ROOT_DOMAIN/.test(h))) hint("See Resend's message above; the Logs page in your Resend account shows the same attempt.");
  }
  if (!report.ok && provider === "mailbox") hint("See the mail server's answer above. Global settings → Email has the mailbox's settings.");
  if (report.ok) hint(provider === "mailbox" ? "Your mail server accepted it. If it doesn't arrive, check spam; it is also in the mailbox's Sent folder with Gmail, iCloud and most others." : provider === "resend"
    ? "Resend accepted it. If it doesn't arrive, check spam, and the Logs page in your Resend account for this email's id (above)."
    : "Accepted for sending. If it doesn't arrive, check spam.");
  return report;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt$(n) {
  return "$" + Number(n).toFixed(2);
}

// Raw Shippo status (stored on a blank shipment) → a readable label for the roll-up.
function blankStatusLabel_(s) {
  return { TRANSIT: "In transit", DELIVERED: "Delivered", RETURNED: "Returned to sender",
    FAILURE: "Carrier issue", UNKNOWN: "Unknown", PRE_TRANSIT: "Pre-transit" }[String(s || "").toUpperCase()] || s || "";
}
// The carrier's own wording (e.g. UPS "Loaded on Delivery Vehicle") preferred over the coarse
// normalized status, so the roll-up isn't vaguely "In transit" when the carrier knows more.
function blankStatusText_(shipment) {
  const detail = String((shipment && shipment.statusDetail) || "").trim();
  const label = blankStatusLabel_(shipment && shipment.status);
  if (detail && label && detail.toLowerCase() !== label.toLowerCase()) return detail;
  return detail || label;
}

// A configurable line's picks as plain text — "Navy · Front: Lockup (White) · Back: Capital".
// The invisible reorder-QR application and any auto-added entries are left out. Mirrors
// cfgSummary_ in admin.js so receipts read the same as the admin order view. Returns "".
function configSummary_(it) {
  const c = it && it.config;
  if (!c || !Array.isArray(c.locations)) return "";
  const parts = c.locations
    .filter((l) => !l.auto && !l.fixed && l.location !== "reorderqr")
    .map((l) => `${l.label || l.location}: ${l.graphicName}${l.ink ? " (" + l.ink + ")" : ""}`);
  return [c.garmentColor, ...parts].filter(Boolean).join(" · ");
}

// What to print after a line's name: a configurable line's picks, plus the personalization (typed name or
// preset word) when there is one — both can apply to the same line.
export function lineDetailText(it) { return lineDetail_(it); }   // for the invoice page
function lineDetail_(it) {
  const cfg = configSummary_(it);
  const pers = it && it.personalized ? `“${it.persName || ""}”` : "";
  return [cfg, pers].filter(Boolean).join(" · ");
}

function itemsTable(items) {
  const rows = items
    .map(
      (it) =>
        `<tr>
      <td style="padding:4px 8px">${escHtml(it.name)}${lineDetail_(it) ? ` — <em>${escHtml(lineDetail_(it))}</em>` : ""}</td>
      <td style="padding:4px 8px;text-align:center">${escHtml(it.size || "One Size")}</td>
      <td style="padding:4px 8px;text-align:center">${it.qty}</td>
      <td style="padding:4px 8px;text-align:right">${fmt$(it.lineTotal)}</td>
    </tr>`
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:#f5f5f5">
      <th style="padding:4px 8px;text-align:left">Item</th>
      <th style="padding:4px 8px">Size</th>
      <th style="padding:4px 8px">Qty</th>
      <th style="padding:4px 8px;text-align:right">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// The money lines under a receipt's item list, so it adds up: Subtotal (the items shown), Shipping
// (or "TBD" for a custom quote), Discount, Total — then the sales-tax note. When the order's tax
// is added on top of its prices (order.taxMode "exclusive") the tax is a row of its own between
// the discount and the Total instead, because it's part of what the Total adds up to. Works for a new order
// (subtotal / shippingCost / total from submission) and a saved one (itemsSubtotal / shippingCost /
// discountAmount / effectiveTotal from parseOrder_, which stay right after edits and cancellations).
function receiptTotals_(order) {
  const active = (order.items || []).filter(it => !it.cancelDate);
  const subtotal = order.itemsSubtotal != null ? Number(order.itemsSubtotal) : active.reduce((t, it) => t + Number(it.lineTotal || 0), 0);
  const shipping = Number(order.shippingCost) || 0;
  const discount = Number(order.discountAmount) || 0;
  const taxAdded = order.taxMode === "exclusive" && !order.taxExempt ? Math.max(0, Number(order.salesTax) || 0) : 0;
  const total = order.effectiveTotal != null ? Number(order.effectiveTotal) : subtotal + shipping - discount + taxAdded;
  return { subtotal, shipping, discount, total, taxAdded, tbd: !!order.manualShipping };
}
// The delivery line's label. A shop's own option ("Delivery at practice" — migrations/0045) has a
// method name but no ship-to address, and reads as itself; a carrier reads "Shipping (USPS Priority)".
// (No address alone isn't proof — an old or hand-built order can carry "USPS Ground Advantage" without
// one — so a method that starts with a carrier's name is always shipping.)
const CARRIER_NAME_RE_ = /^(usps|ups|fedex|dhl|ontrac|lasership|carrier)\b/i;
function deliveryIsCustom_(order) {
  return !!(order && order.shippingMethod && !order.shippingAddress && !order.manualShipping && !CARRIER_NAME_RE_.test(String(order.shippingMethod).trim()));
}
function deliveryLabel_(order) {
  if (deliveryIsCustom_(order)) return String(order.shippingMethod);
  return `Shipping${order.shippingMethod ? " (" + order.shippingMethod + ")" : ""}`;
}
function receiptTotalsHtml_(order) {
  const t = receiptTotals_(order);
  const row = (label, amount, style = "") => `<tr><td style="${style}">${label}</td><td style="text-align:right;${style}">${amount}</td></tr>`;
  return `<table style="width:100%;font-size:14px;margin-top:8px">
      ${row("Subtotal", fmt$(t.subtotal))}
      ${t.tbd ? row("Shipping", "TBD", "color:#888") : t.shipping > 0 ? row(escHtml(deliveryLabel_(order)), fmt$(t.shipping)) : (deliveryIsCustom_(order) ? row(escHtml(deliveryLabel_(order)), "Free") : "")}
      ${t.discount > 0 ? row(`Discount${order.discountNote ? " (" + escHtml(order.discountNote) + ")" : ""}`, "−" + fmt$(t.discount), "color:#166534") : ""}
      ${t.taxAdded > 0 ? row(escHtml(taxAddedLabel_(order)), fmt$(t.taxAdded)) : ""}
      ${t.tbd ? "" : row("<strong>Total</strong>", `<strong>${fmt$(t.total)}</strong>`, "border-top:1px solid #ddd;padding-top:4px")}
      ${taxRow_(order)}
    </table>`;
}
function receiptTotalsText_(order) {
  const t = receiptTotals_(order);
  return `Subtotal: ${fmt$(t.subtotal)}` +
    (t.tbd ? "\nShipping: TBD — a follow-up email will include the shipping cost, total, and payment options."
      : (t.shipping > 0 ? `\n${deliveryLabel_(order)}: ${fmt$(t.shipping)}` : (deliveryIsCustom_(order) ? `\n${deliveryLabel_(order)}: Free` : "")) +
        (t.discount > 0 ? `\nDiscount: −${fmt$(t.discount)}` : "") +
        (t.taxAdded > 0 ? `\n${taxAddedLabel_(order)}: ${fmt$(t.taxAdded)}` : "") + `\nTotal: ${fmt$(t.total)}${taxText_(order)}`);
}

// Sent to customer immediately after a new order is placed.
export async function sendOrderReceivedEmail(env, order) {
  const subject = `Your order has been received — ${order.orderId}`;
  const itemsHtml = itemsTable((order.items || []).filter(it => !it.cancelDate));
  const manualShippingNote = order.manualShipping
    ? `<p style="background:#fef9c3;border:1px solid #fde047;border-radius:4px;padding:10px 14px;font-size:14px;margin-top:12px;">
        <strong>Shipping quote pending:</strong> Your order requires a custom shipping quote.
        We'll follow up with a separate email that includes the shipping cost, updated total, and payment options.
       </p>`
    : "";
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Order Received</h2>
    <p>Hi ${escHtml(order.customerName)}, we received your order and will be in touch to confirm payment.</p>
    <p><strong>Order ID:</strong> ${escHtml(order.orderId)}</p>
    ${itemsHtml}
    ${receiptTotalsHtml_(order)}
    ${manualShippingNote}
    <p style="margin-top:16px"><strong>Payment method:</strong> ${escHtml(order.paymentMethod || "")}</p>
    <hr/>
    <p style="font-size:12px;color:#666">%%BUSINESS%% — %%SITE%%</p>
  </div>`;
  const text = `Order Received — ${order.orderId}\n\nHi ${order.customerName},\nWe received your order.\n${receiptTotalsText_(order)}\nPayment: ${order.paymentMethod}\n\n%%BUSINESS%%`;
  return send_(env, { to: order.contact, subject, html, text });
}

// The install's one time zone — Global settings → Region, else the TIMEZONE variable, else UTC
// (resolveTimeZone in db.js). Every date and time an email prints is in it.
async function timeZone_(env) {
  try { return await resolveTimeZone(env); } catch (e) { return "UTC"; }
}

// The "nothing new" note the SCHEDULED roll-up sends on a quiet morning — an email goes out every
// day so that silence can't mean "it didn't run". Short on purpose: when it checked, since when
// nothing is new, and what is still being watched (packages on the way, labels not yet picked up,
// blanks on order). Lists no orders and moves no progress markers.
// "Machine 1: Oil the rotary hook (5.2 h of run time since it was last done)" — machine maintenance that's due
// (migrations/0071), for the roll-up and the quiet-morning email.
function maintenanceText_(tasks) {
  return (tasks || []).map(t => {
    const parts = [];
    if (t.everySeconds) parts.push(`${Math.round((Number(t.usedSeconds) || 0) / 360) / 10} h of run time`);
    if (t.everyStitches) parts.push(`${(Number(t.usedStitches) || 0).toLocaleString("en-US")} stitches`);
    return `${t.machineName || "Machine"}: ${t.name}${parts.length ? ` (${parts.join(", ")} since it was last done)` : ""}`;
  });
}

export async function sendDigestHeartbeatEmail(env, { lastSentAt = "", inTransit = [], awaitingPickup = [], awaitingBlanks = [], maintenanceDue = [], adminUrl = adminSiteUrl_(env) } = {}) {
  const tz = await timeZone_(env);   // Region setting, else TIMEZONE, else UTC
  const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const watching = [
    inTransit.length ? n(inTransit.length, "package in transit", "packages in transit") : "",
    awaitingPickup.length ? n(awaitingPickup.length, "label waiting for the carrier", "labels waiting for the carrier") : "",
    awaitingBlanks.length ? n(awaitingBlanks.length, "blank order not yet received", "blank orders not yet received") : "",
  ].filter(Boolean);
  const since = lastSentAt ? `since the last roll-up on ${when(lastSentAt)}` : "yet";
  const lines = [
    `The morning check ran at ${when(new Date().toISOString())} and found nothing new ${since}: no new orders, payments, refunds, deliveries or problems.`,
    watching.length ? `Still being watched: ${watching.join(", ")}.` : "",
    maintenanceDue.length ? `Machine maintenance due: ${maintenanceText_(maintenanceDue).join("; ")}.` : "",
    adminUrl ? `Details: ${adminUrl}/#comms` : "Details: Tools → Communications in the program.",
  ].filter(Boolean);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222;line-height:1.5;">` +
    lines.slice(0, -1).map(l => `<p style="margin:0 0 8px;">${escHtml(l)}</p>`).join("") +
    (adminUrl ? `<p style="margin:0;"><a href="${escHtml(adminUrl)}/#comms">Open Communications</a></p>` : `<p style="margin:0;">${escHtml(lines[lines.length - 1])}</p>`) + `</div>`;
  return send_(env, { to: ORDER_NOTIFICATION_EMAIL, subject: "Daily roll-up — nothing new", html, text: lines.join("\n\n") });
}

// Sent to owner once a day (about 6 AM local time, from the Worker's scheduled handler —
// see src/worker.js): every order placed since the last roll-up plus
// every queued owner notice (Stripe payments/refunds/disputes, design
// responses) — in place of one email each. Not sent when there's nothing new (the scheduled run then
// sends sendDigestHeartbeatEmail instead, so a quiet morning still proves the roll-up ran).
// pickedUp = orders the tracking check just marked shipped (carrier's first scan); awaitingPickup =
// orders with a label the carrier hasn't scanned yet (listed for the record, never a reason to send).
export async function sendDailyDigestEmail(env, { orders = [], notices = [], orgNames = {}, security = null, inTransit = [], pickedUp = [], awaitingPickup = [], issues = [], awaitingBlanks = [], priceReminder = null, belowTarget = [], maintenanceDue = [], adminUrl = adminSiteUrl_(env) }) {
  issues = issues || [];
  belowTarget = belowTarget || [];
  const pr = priceReminder && ((priceReminder.blanks || []).length || (priceReminder.products || []).length) ? priceReminder : null;
  awaitingBlanks = awaitingBlanks || [];
  const blanksOverdue = awaitingBlanks.filter(x => x.overdue);
  if (!orders.length && !notices.length && !(security && security.count) && !pickedUp.length && !issues.length && !blanksOverdue.length && !pr && !belowTarget.length) return false;
  const orgName = (id) => orgNames[id] || id || "";
  const tz = await timeZone_(env);   // Region setting, else TIMEZONE, else UTC
  const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const total = orders.reduce((s, o) => s + Math.round(Number(o.total) * 100), 0) / 100;
  const byOrg = {};
  for (const o of orders) {
    const g = (byOrg[o.orgId] = byOrg[o.orgId] || { name: orgName(o.orgId), orders: [], total: 0 });
    g.orders.push(o); g.total += Math.round(Number(o.total) * 100);
  }
  const groups = Object.values(byOrg).sort((a, b) => a.name.localeCompare(b.name));
  const urgent = notices.filter(x => x.urgent);
  const delivered = notices.filter(x => x.kind === "delivered" && !x.urgent);
  const activity = notices.filter(x => !x.urgent && x.kind !== "delivered");
  const n = orders.length;
  const plural = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const kindCount = (kind, word) => { const k = notices.filter(x => x.kind === kind).length; return k ? plural(k, word) : ""; };
  const sec = security && security.count ? security : null;
  const issueCount = issues.reduce((s, x) => s + (Number(x.count) || 0), 0);
  const subjectParts = [
    issueCount ? `⚠️ ${plural(issueCount, "problem")}` : "",
    blanksOverdue.length ? `⚠️ ${plural(blanksOverdue.length, "blank order")} overdue` : "",
    sec ? `🔒 ${plural(sec.count, "failed admin sign-in")}` : "",
    urgent.length ? `⚠️ ${plural(urgent.length, "dispute")} filed` : "",
    n ? `${plural(n, "new order")} (${fmt$(total)})` : "",
    kindCount("payment", "payment"), kindCount("refund", "refund"),
    (k => k ? plural(k, "dispute update") : "")(activity.filter(x => x.kind === "dispute").length),
    kindCount("design", "design response"),
    delivered.length ? `${delivered.length} ${delivered.length === 1 ? "delivery" : "deliveries"}` : "",
    pickedUp.length ? `${pickedUp.length} picked up by carrier` : "",
    inTransit.length ? `${inTransit.length} in transit` : "",
    pr ? "💲 blank prices to check" : "",
    belowTarget.length ? `📉 ${plural(belowTarget.length, "product")} below price target` : "",
  ].filter(Boolean);
  const subject = `Daily roll-up — ${subjectParts.join(", ")}`;

  const itemLine = (it) => `${it.qty}× ${it.name}${it.size ? ` (${it.size})` : ""}${lineDetail_(it) ? ` [${lineDetail_(it)}]` : ""}${it.cancelDate ? " — cancelled" : ""}`;
  const orderHtml = (o) => `
    <tr style="border-top:1px solid #e5e7eb">
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(o.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(when(o.placedAt))}</span></td>
      <td style="padding:6px 8px;vertical-align:top">${escHtml(o.customerName)}<br><span style="color:#666;font-size:12px">${escHtml(o.contact || "")}</span></td>
      <td style="padding:6px 8px;vertical-align:top;font-size:13px">${(o.items || []).map(it => escHtml(itemLine(it))).join("<br>")}</td>
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(o.paymentMethod || "")}<br><span style="font-size:12px;color:${o.paid ? "#15803d" : "#b45309"}">${o.paid ? "Paid" : "Unpaid"}</span></td>
      <td style="padding:6px 8px;vertical-align:top;text-align:right;white-space:nowrap">${fmt$(o.total)}</td>
    </tr>`;
  const KIND = { payment: "Payment", refund: "Refund", dispute: "Dispute", design: "Design", delivered: "Delivered", invoice: "Invoice" };
  const noticeHtml = (x) => `
    <tr style="border-top:1px solid #e5e7eb">
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;color:#666;font-size:12px">${escHtml(when(x.createdAt))}</td>
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(KIND[x.kind] || x.kind)}</td>
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(orgName(x.orgId))}</span></td>
      <td style="padding:6px 8px;vertical-align:top">${escHtml(x.summary)}${x.detail ? `<br><span style="color:#555;font-size:13px">${escHtml(x.detail).replace(/\n/g, "<br>")}</span>` : ""}${(x.imageUrls || []).length ? "<br>" + x.imageUrls.map((u, i) => `<a href="${escHtml(u)}" style="font-size:12px">image ${i + 1}</a>`).join(" · ") : ""}</td>
    </tr>`;
  const noticeTable = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">When</th><th style="padding:4px 8px">Type</th><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Details</th></tr></thead>
      <tbody>${rows.map(noticeHtml).join("")}</tbody></table>`;

  const html = `<div style="font-family:sans-serif;max-width:760px;margin:auto">
    <h2 style="margin:0 0 4px">Daily roll-up</h2>
    <p style="color:#555;margin:0 0 16px">Everything since the last roll-up.${adminUrl ? ` <a href="${escHtml(adminUrl)}">Open the admin panel</a>` : ""}</p>
    ${sec ? `<div style="border:2px solid #b45309;border-radius:6px;padding:10px 12px;margin-bottom:18px;background:#fffbeb">
      <h3 style="margin:0 0 6px;color:#92400e;font-size:16px">🔒 ${plural(sec.count, "failed admin sign-in")}</h3>
      <p style="margin:0;font-size:14px">${Number(sec.passphrase || 0)} wrong password, ${Number(sec.code || 0)} wrong 2FA code, between ${escHtml(when(sec.first))} and ${escHtml(when(sec.last))}, from ${escHtml((sec.ips || []).join(", ") || "unknown IPs")}.
      ${Number(sec.code || 0) > 0 ? "<br><strong>A wrong 2FA code means the password was right — change it if that wasn't you.</strong>" : ""}</p></div>` : ""}
    ${issues.length ? `<div style="border:2px solid #b45309;border-radius:6px;padding:10px 12px;margin-bottom:18px;background:#fffbeb">
      <h3 style="margin:0 0 6px;color:#92400e;font-size:16px">⚠️ Problems since the last roll-up</h3>
      <ul style="margin:0;padding-left:18px;font-size:14px">${issues.map(x => `<li><strong>${escHtml(x.label)}: ${Number(x.count)}</strong>
        <span style="color:#666;font-size:12px">(${escHtml(when(x.first))}${x.count > 1 ? " – " + escHtml(when(x.last)) : ""})</span>
        ${(x.samples || []).length ? `<br><span style="color:#555;font-size:12px">e.g. ${x.samples.map(escHtml).join(" · ")}</span>` : ""}</li>`).join("")}</ul>
      <p style="margin:6px 0 0;font-size:12px;color:#555">Details are in ${isDesktop_(env) ? "the program's log (Help → Open the log)" : "the Cloudflare logs"} for those times.</p></div>` : ""}
    ${urgent.length ? `<div style="border:2px solid #b91c1c;border-radius:6px;padding:10px 12px;margin-bottom:18px;background:#fef2f2">
      <h3 style="margin:0 0 6px;color:#b91c1c;font-size:16px">⚠️ Needs attention</h3>${noticeTable(urgent)}</div>` : ""}
    ${n ? `<h3 style="margin:0 0 4px;font-size:17px">${plural(n, "new order")} — ${fmt$(total)}</h3>` + groups.map(g => `
      <h4 style="margin:14px 0 6px;font-size:15px">${escHtml(g.name)} — ${plural(g.orders.length, "order")}, ${fmt$(g.total / 100)}</h4>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Customer</th><th style="padding:4px 8px">Items</th><th style="padding:4px 8px">Payment</th><th style="padding:4px 8px;text-align:right">Total</th></tr></thead>
        <tbody>${g.orders.map(orderHtml).join("")}</tbody>
      </table>`).join("") : ""}
    ${delivered.length ? `<h3 style="margin:22px 0 6px;font-size:17px">📦 Delivered — ${delivered.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Tracking shows these arrived; they're marked delivered. Mark them completed on the orders screen once paid in full.</p>${noticeTable(delivered)}` : ""}
    ${pickedUp.length ? `<h3 style="margin:22px 0 6px;font-size:17px">📮 Picked up by the carrier — ${pickedUp.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Tracking shows the carrier has these, so they're now marked shipped (dated by the first scan) and each customer was emailed their tracking.</p>
      ${shipmentTable_(pickedUp, orgName, (x) => `Shipped ${escHtml(x.shippedAtLabel || "")}${x.customerEmailed === false ? `<br><span style="color:#b45309;font-size:12px">customer email not sent</span>` : ""}`)}` : ""}
    ${inTransit.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🚚 In transit — ${inTransit.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Shipped but not yet delivered. Status as of this morning's check.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Customer</th><th style="padding:4px 8px">Tracking</th><th style="padding:4px 8px">Status</th></tr></thead>
        <tbody>${inTransit.map(x => `
          <tr style="border-top:1px solid #e5e7eb">
            <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(orgName(x.orgId))}</span></td>
            <td style="padding:6px 8px;vertical-align:top">${escHtml(x.customerName)}</td>
            <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;font-size:13px">${escHtml(x.carrier)} ${escHtml(x.tracking)}</td>
            <td style="padding:6px 8px;vertical-align:top;font-size:13px">${escHtml(x.status)}${x.statusDate ? `<br><span style="color:#666;font-size:12px">${escHtml(x.statusDate)}</span>` : ""}${x.statusDetail ? `<br><span style="color:#888;font-size:12px">${escHtml(x.statusDetail)}</span>` : ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : ""}
    ${awaitingPickup.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🏷 Label created, not shipped yet — ${awaitingPickup.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">These have a label, but the carrier hasn't scanned them yet. They'll be marked shipped automatically once tracking shows a scan.</p>
      ${shipmentTable_(awaitingPickup, orgName, (x) => `Label ${escHtml(x.labelAtLabel || "")}`)}` : ""}
    ${awaitingBlanks.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🧵 Blanks ordered, not yet received — ${awaitingBlanks.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Ordered from a vendor but not marked received. Overdue ones (past the expected date) are flagged — chase the vendor so an order can't be lost.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Vendor</th><th style="padding:4px 8px">Ordered</th><th style="padding:4px 8px">Status</th></tr></thead>
        <tbody>${awaitingBlanks.map(x => `<tr style="border-top:1px solid #e5e7eb">
          <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(x.customerName || "")} · ${escHtml(orgName(x.orgId))}</span></td>
          <td style="padding:6px 8px;vertical-align:top">${escHtml([x.blankVendor, x.blankVendorOrderId && "#" + x.blankVendorOrderId].filter(Boolean).join(" "))}</td>
          <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;color:#666">${escHtml(x.orderedDate || "")}</td>
          <td style="padding:6px 8px;vertical-align:top;${x.overdue ? "color:#b03a2e;font-weight:600" : "color:#555"}">${escHtml(x.statusLabel || "")}${(x.shipments || []).map(s => `<div style="font-size:12px;color:#555;margin-top:2px;font-weight:400">📦 ${escHtml(s.carrier || "")} ${(u => u ? `<a href="${escHtml(u)}">${escHtml(s.trackingNumber)}</a>` : escHtml(s.trackingNumber))(trackingUrl(s.carrier, s.trackingNumber))}${s.status ? ` — ${escHtml(blankStatusText_(s))}` : ""}${s.statusDate ? " (" + escHtml(when(s.statusDate)) + ")" : ""}</div>`).join("")}</td>
        </tr>`).join("")}</tbody></table>` : ""}
    ${activity.length ? `<h3 style="margin:22px 0 6px;font-size:17px">Payments, refunds &amp; customer responses</h3>${noticeTable(activity)}` : ""}
    ${pr ? priceReminderHtml_(pr, orgName, tz) : ""}
    ${belowTarget.length ? `<h3 style="margin:22px 0 6px;font-size:17px">📉 Products now below your price targets — ${belowTarget.length}</h3>
    <p style="margin:0 0 6px;color:#555;font-size:13px">A blank's cost, a fee or a target changed since the last roll-up. The product's Pricing panel shows what each item costs and leaves.</p>
    <ul style="margin:0;padding-left:18px;font-size:14px">${belowTarget.map(p => `<li><strong>${escHtml(p.name)}</strong> <span style="color:#666">(${escHtml(orgName(p.orgId))})</span><br><span style="font-size:13px;color:#555">${(p.problems || []).map(escHtml).join("<br>")}</span></li>`).join("")}</ul>` : ""}
    ${maintenanceDue.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🔧 Machine maintenance due — ${maintenanceDue.length}</h3>
    <ul style="margin:0;padding-left:18px;font-size:14px">${maintenanceText_(maintenanceDue).map(x => `<li>${escHtml(x)}</li>`).join("")}</ul>
    ${adminUrl ? `<p style="margin:6px 0 0;font-size:13px"><a href="${escHtml(adminUrl)}/#maintenance">Machine maintenance</a></p>` : ""}` : ""}
    <hr/><p style="font-size:12px;color:#666">%%BUSINESS%% — daily roll-up</p>
  </div>`;
  const noticeText = (x) => `  ${when(x.createdAt)}  ${KIND[x.kind] || x.kind}  ${x.orderId} (${orgName(x.orgId)})  ${x.summary}${x.detail ? " — " + x.detail : ""}`;
  const text = [
    issues.length ? "PROBLEMS SINCE THE LAST ROLL-UP\n" + issues.map(x => `  ${x.label}: ${x.count}${(x.samples || []).length ? " — e.g. " + x.samples.join(" · ") : ""}`).join("\n") : "",
    sec ? `SECURITY: ${plural(sec.count, "failed admin sign-in")} (${Number(sec.passphrase || 0)} wrong password, ${Number(sec.code || 0)} wrong 2FA code) from ${(sec.ips || []).join(", ") || "unknown IPs"}` +
      (Number(sec.code || 0) > 0 ? " — a wrong 2FA code means the passphrase was right; change it if that wasn't you." : "") : "",
    urgent.length ? "NEEDS ATTENTION\n" + urgent.map(noticeText).join("\n") : "",
    n ? `${plural(n, "new order")} — ${fmt$(total)}\n\n` + groups.map(g =>
      `${g.name} — ${plural(g.orders.length, "order")}, ${fmt$(g.total / 100)}\n` + g.orders.map(o =>
        `  ${o.orderId}  ${o.customerName} <${o.contact || ""}>  ${o.paymentMethod || ""} ${o.paid ? "(paid)" : "(unpaid)"}  ${fmt$(o.total)}\n` +
        (o.items || []).map(it => "    " + itemLine(it)).join("\n")).join("\n")).join("\n\n") : "",
    delivered.length ? `DELIVERED — ${delivered.length}\n` + delivered.map(noticeText).join("\n") : "",
    pickedUp.length ? `PICKED UP BY THE CARRIER (now marked shipped) — ${pickedUp.length}\n` + pickedUp.map(x =>
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName}  ${x.carrier} ${x.tracking}  shipped ${x.shippedAtLabel || ""}${x.customerEmailed === false ? "  (customer email not sent)" : ""}`).join("\n") : "",
    awaitingPickup.length ? `LABEL CREATED, NOT SHIPPED YET — ${awaitingPickup.length}\n` + awaitingPickup.map(x =>
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName}  ${x.carrier} ${x.tracking}  label ${x.labelAtLabel || ""}`).join("\n") : "",
    inTransit.length ? `IN TRANSIT — ${inTransit.length}\n` + inTransit.map(x =>
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName}  ${x.carrier} ${x.tracking}  ${x.status}${x.statusDate ? " — " + x.statusDate : ""}${x.statusDetail ? " — " + x.statusDetail : ""}`).join("\n") : "",
    awaitingBlanks.length ? `BLANKS ORDERED, NOT YET RECEIVED — ${awaitingBlanks.length}\n` + awaitingBlanks.map(x =>
      ((main) => main + (x.shipments || []).map(s => `\n      📦 ${s.carrier || ""} ${s.trackingNumber}${s.status ? " — " + blankStatusText_(s) : ""} ${trackingUrl(s.carrier, s.trackingNumber)}`).join(""))(
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName || ""}  ${[x.blankVendor, x.blankVendorOrderId && "#" + x.blankVendorOrderId].filter(Boolean).join(" ")}  ordered ${x.orderedDate || "?"}  — ${x.statusLabel || ""}`)).join("\n") : "",
    activity.length ? "Payments, refunds & customer responses\n" + activity.map(noticeText).join("\n") : "",
    pr ? priceReminderText_(pr, orgName, tz) : "",
    belowTarget.length ? `PRODUCTS NOW BELOW YOUR PRICE TARGETS — ${belowTarget.length}\n` + belowTarget.map(p => `  ${p.name} (${orgName(p.orgId)})\n` + (p.problems || []).map(x => "    " + x).join("\n")).join("\n") : "",
    maintenanceDue.length ? `MACHINE MAINTENANCE DUE — ${maintenanceDue.length}\n` + maintenanceText_(maintenanceDue).map(x => "  " + x).join("\n") : "",
    adminUrl,
  ].filter(Boolean).join("\n\n");
  return send_(env, { to: ORDER_NOTIFICATION_EMAIL, subject, html, text });
}

// The 30-day vendor-price reminder (migrations/0062): blanks for sale on visible products whose vendor
// prices haven't been checked in 30 days, then products priced on blank prices that have changed.
const money_ = (v) => v == null ? "not entered" : fmt$(v);
const priceChecked_ = (b, tz) => b.checkedAt ? "last checked " + new Date(b.checkedAt).toLocaleDateString("en-US", { timeZone: tz || "UTC", month: "short", day: "numeric", year: "numeric" }) : "never checked";
const priceChange_ = (c) => `${c.blankName}${c.color ? " " + c.color : ""}${c.size ? " " + c.size : ""}: ${money_(c.from)} → ${money_(c.to)}`;
function priceReminderHtml_(pr, orgName, tz) {
  const blanks = pr.blanks || [], products = pr.products || [];
  return `<h3 style="margin:22px 0 6px;font-size:17px">💲 Blank prices to check (every 30 days)</h3>
    ${blanks.length ? `<p style="margin:0 0 6px;color:#555;font-size:13px">These blanks are used by products on sale. Check each one's prices with the vendor and enter any change on the blank (Blanks → Edit), or click “Prices are current” there.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Blank</th><th style="padding:4px 8px">Prices</th><th style="padding:4px 8px">Used by</th></tr></thead>
      <tbody>${blanks.map(b => `<tr style="border-top:1px solid #e5e7eb">
        <td style="padding:6px 8px;vertical-align:top">${escHtml(b.name)}${b.vendor ? `<br><span style="color:#666;font-size:12px">${escHtml(b.vendor)}</span>` : ""}</td>
        <td style="padding:6px 8px;vertical-align:top;font-size:13px;color:#555">${escHtml(priceChecked_(b, tz))}<br>${Number(b.sizesWithPrice) || 0} of ${Number(b.sizes) || 0} sizes have a vendor price</td>
        <td style="padding:6px 8px;vertical-align:top;font-size:13px">${(b.products || []).slice(0, 8).map(p => escHtml(p.name) + ` <span style="color:#666">(${escHtml(orgName(p.orgId))})</span>`).join("<br>")}${(b.products || []).length > 8 ? `<br>+${b.products.length - 8} more` : ""}</td>
      </tr>`).join("")}</tbody></table>` : ""}
    ${products.length ? `<h4 style="margin:14px 0 6px;font-size:15px">Products to re-price — ${products.length}</h4>
    <p style="margin:0 0 6px;color:#555;font-size:13px">Their prices were set when these blanks cost something else. Update the product's prices, or open it and click “Prices still OK”.</p>
    <ul style="margin:0;padding-left:18px;font-size:14px">${products.map(p => `<li><strong>${escHtml(p.name)}</strong> <span style="color:#666">(${escHtml(orgName(p.orgId))})</span><br><span style="font-size:13px;color:#555">${p.changes.map(c => escHtml(priceChange_(c))).join("<br>")}</span></li>`).join("")}</ul>` : ""}`;
}
function priceReminderText_(pr, orgName, tz) {
  const blanks = pr.blanks || [], products = pr.products || [];
  return [
    blanks.length ? `BLANK PRICES TO CHECK (every 30 days) — ${blanks.length}\n` + blanks.map(b =>
      `  ${b.name}${b.vendor ? " (" + b.vendor + ")" : ""} — ${priceChecked_(b, tz)}, ${Number(b.sizesWithPrice) || 0} of ${Number(b.sizes) || 0} sizes priced — used by ${(b.products || []).map(p => p.name + " (" + orgName(p.orgId) + ")").join(", ")}`).join("\n") : "",
    products.length ? `PRODUCTS TO RE-PRICE — ${products.length}\n` + products.map(p =>
      `  ${p.name} (${orgName(p.orgId)})\n` + p.changes.map(c => "    " + priceChange_(c)).join("\n")).join("\n") : "",
  ].filter(Boolean).join("\n\n");
}

// Order / customer / tracking / status table shared by the roll-up's shipment sections.
function shipmentTable_(rows, orgName, statusHtml) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Customer</th><th style="padding:4px 8px">Tracking</th><th style="padding:4px 8px">Status</th></tr></thead>
    <tbody>${rows.map(x => `
      <tr style="border-top:1px solid #e5e7eb">
        <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(orgName(x.orgId))}</span></td>
        <td style="padding:6px 8px;vertical-align:top">${escHtml(x.customerName)}</td>
        <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;font-size:13px">${escHtml(x.carrier)} ${escHtml(x.tracking)}</td>
        <td style="padding:6px 8px;vertical-align:top;font-size:13px">${statusHtml(x)}</td>
      </tr>`).join("")}</tbody></table>`;
}

// "Includes $X.XX sales tax (6%)" under the total: with tax-inclusive prices the
// tax is shown as part of the total, never added to it (tax added on top gets a
// "Sales tax (6%)" row above the Total instead — receiptTotalsHtml_). Omitted when
// the order carries no tax figures or is tax-exempt.
function taxAddedLabel_(order) {
  return `Sales tax${order.taxRate ? ` (${order.taxRate}%)` : ""}`;
}
function taxRow_(order) {
  if (order.taxExempt) return `<tr><td style="color:#666;font-size:13px">Tax-exempt order</td><td></td></tr>`;
  if (order.taxMode === "exclusive") return "";   // shown as its own row above the Total
  if (!(Number(order.salesTax) > 0)) return "";
  return `<tr><td style="color:#666;font-size:13px">Includes sales tax${order.taxRate ? ` (${escHtml(String(order.taxRate))}%)` : ""}</td><td style="text-align:right;color:#666;font-size:13px">${fmt$(order.salesTax)}</td></tr>`;
}
function taxText_(order) {
  if (order.taxExempt) return " (tax-exempt)";
  if (order.taxMode === "exclusive") return "";
  return Number(order.salesTax) > 0 ? ` (includes ${fmt$(order.salesTax)} sales tax)` : "";
}

// Sent to customer when an admin marks an order paid (manual or resend).
export async function sendPaymentConfirmedEmail(env, order, paidAt) {
  const subject = `Your order is confirmed — ${order.orderId}`;
  const paidDate = paidAt ? new Date(paidAt).toLocaleDateString("en-US", { timeZone: await timeZone_(env), month: "long", day: "numeric", year: "numeric" }) : "";
  const itemsHtml = itemsTable((order.items || []).filter(it => !it.cancelDate));
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#15803d">Payment Confirmed</h2>
    <p>Hi ${escHtml(order.customerName)}, your payment has been confirmed${paidDate ? ` (${escHtml(paidDate)})` : ""}. Thank you!</p>
    <p><strong>Order ID:</strong> ${escHtml(order.orderId)}</p>
    ${itemsHtml}
    ${receiptTotalsHtml_(order)}
    <hr/>
    <p style="font-size:12px;color:#666">%%BUSINESS%% — %%SITE%%</p>
  </div>`;
  const text = `Payment Confirmed — ${order.orderId}\n\nHi ${order.customerName},\nPayment confirmed.\n${receiptTotalsText_(order)}\n\n%%BUSINESS%%`;
  return send_(env, { to: order.contact, subject, html, text });
}

// The carrier's public tracking page for a tracking number. carrier is a label carrier / shipping
// method / Shippo token ("USPS Ground Advantage", "ups", "dhl_express"…); unknown → USPS.
export function trackingUrl(carrier, tracking) {
  const t = String(carrier || "").toLowerCase(), n = encodeURIComponent(String(tracking || "").trim());
  if (!n) return "";
  if (/\bups\b/.test(t) && !/usps/.test(t)) return "https://www.ups.com/track?tracknum=" + n;
  if (/fedex/.test(t)) return "https://www.fedex.com/fedextrack/?trknbr=" + n;
  if (/dhl/.test(t)) return "https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=" + n;
  return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + n;
}

// Sent to the customer ONCE, when an order first becomes shipped — the daily tracking check saw the
// carrier's first scan, or the admin marked it shipped. Never when a label is merely bought.
// shipment = { carrier, tracking, shippedAt }. Returns true/false like every send here.
export async function sendShippedEmail(env, order, shipment = {}) {
  if (!order || !order.contact || !String(order.contact).includes("@")) return false;
  const tracking = String(shipment.tracking || "").trim();
  const carrierName = String(shipment.carrier || "").trim();
  const url = trackingUrl(carrierName || order.shippingMethod, tracking);
  const subject = `Your order has shipped — ${order.orderId}`;
  const active = (order.items || []).filter(it => !it.cancelDate);
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#15803d">Your order is on its way</h2>
    <p>Hi ${escHtml(order.customerName)}, your order has been handed to the carrier.</p>
    <p><strong>Order ID:</strong> ${escHtml(order.orderId)}</p>
    ${tracking ? `<p><strong>Tracking${carrierName ? ` (${escHtml(carrierName)})` : ""}:</strong> ${url ? `<a href="${escHtml(url)}">${escHtml(tracking)}</a>` : escHtml(tracking)}</p>` : ""}
    ${itemsTable(active)}
    <hr/>
    <p style="font-size:12px;color:#666">Questions? Reply to this email. — %%BUSINESS%%, %%SITE%%</p>
  </div>`;
  const text = `Your order has shipped — ${order.orderId}\n\nHi ${order.customerName},\nYour order has been handed to the carrier.` +
    (tracking ? `\nTracking${carrierName ? ` (${carrierName})` : ""}: ${tracking}${url ? `\n${url}` : ""}` : "") +
    `\n\nQuestions? Reply to this email.\n%%BUSINESS%%`;
  return send_(env, { to: order.contact, subject, html, text });
}

// Sent to owner when Stripe auto-confirms a payment (webhook path).
export async function sendStripePaymentNotification(env, orderId, orgId, amountPaid) {
  const subject = `Payment confirmed (Stripe) — ${orgId} — ${orderId}`;
  const text = `Stripe confirmed payment of ${fmt$(amountPaid || 0)} for order ${orderId} (org: ${orgId}).`;
  return queueOwnerNotice_(env, { kind: "payment", orderId, orgId, summary: `Stripe payment ${fmt$(amountPaid || 0)}` },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html: `<p>${escHtml(text)}</p>`, text });
}

// Sent to owner when a refund is processed by Stripe.
export async function sendRefundNotification(env, orderId, orgId, amountRefunded) {
  const subject = `Refund processed — ${orgId} — ${orderId}`;
  const text = `Stripe refund of ${fmt$(amountRefunded || 0)} processed for order ${orderId} (org: ${orgId}).`;
  return queueOwnerNotice_(env, { kind: "refund", orderId, orgId, summary: `Stripe refund ${fmt$(amountRefunded || 0)}` },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html: `<p>${escHtml(text)}</p>`, text });
}

// Sent to owner urgently when a dispute is filed.
export async function sendDisputeNotification(env, orderId, orgId, status, reason, amount) {
  const isNew = status === "warning_needs_response";
  const subject = isNew
    ? `⚠️ DISPUTE FILED — ${orgId} — ${orderId}`
    : `Dispute ${status} — ${orgId} — ${orderId}`;
  const text = isNew
    ? `URGENT: A chargeback has been filed for order ${orderId} (org: ${orgId}). Reason: ${reason}. Amount: ${fmt$(amount || 0)}. You typically have 7–21 days to respond.`
    : `Dispute for order ${orderId} (org: ${orgId}) closed with status: ${status}. Amount: ${fmt$(amount || 0)}.`;
  return queueOwnerNotice_(env, { kind: "dispute", orderId, orgId, urgent: isNew,
      summary: isNew ? `DISPUTE FILED — ${fmt$(amount || 0)}` : `Dispute ${status} — ${fmt$(amount || 0)}`,
      detail: isNew ? `Reason: ${reason || "not given"}. Respond in the Stripe Dashboard — you typically have 7–21 days.` : "" },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html: `<p>${escHtml(text)}</p>`, text });
}

// Sent to customer when a line item is cancelled.
export async function sendCancellationEmail(env, order, cancelledItems, reason, lateCancel) {
  const subject = `Order update — ${order.orderId}`;
  const itemList = cancelledItems.map((it) => `  • ${it.name} (${it.size || "One Size"})`).join("\n");
  const lateCancelNote = lateCancel ? "\n\nNote: Blank garments had already been ordered for this item. Please contact us regarding any restocking fees." : "";
  const text = `Hi ${order.customerName},\n\nThe following item(s) in order ${order.orderId} have been cancelled:\n${itemList}\nReason: ${reason}${lateCancelNote}\n\n%%BUSINESS%%`;
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2>Order Update — Item Cancelled</h2>
    <p>Hi ${escHtml(order.customerName)},</p>
    <p>The following item(s) in order <strong>${escHtml(order.orderId)}</strong> have been cancelled:</p>
    <ul>${cancelledItems.map((it) => `<li>${escHtml(it.name)} (${escHtml(it.size || "One Size")})</li>`).join("")}</ul>
    <p><strong>Reason:</strong> ${escHtml(reason)}</p>
    ${lateCancel ? "<p><em>Note: Blank garments had already been ordered. Please contact us regarding any restocking fees.</em></p>" : ""}
    <hr/><p style="font-size:12px;color:#666">%%BUSINESS%% — %%SITE%%</p>
  </div>`;
  return send_(env, { to: order.contact, subject, html, text });
}

// Sent to customer with a link to review and approve/request changes on their design.
// With no verifyUrl (the desktop program: no page to open), the customer replies to the email instead,
// and `attachments` ({ filename, contentType, contentBase64, cid }) are the proof pictures, shown in
// the email by their cid.
export async function sendDesignVerificationEmail(env, { customerName, customerEmail, orderId, orgName, message, imageUrls, verifyUrl, attachments }) {
  const subject = `Design verification — ${orderId}`;
  const img = (src) => `<div style="margin:12px 0"><img src="${escHtml(src)}" alt="Design image" style="max-width:100%;border:1px solid #e5e7eb;border-radius:4px"></div>`;
  const imagesHtml = (attachments || []).map(a => img("cid:" + a.cid)).join("") + (imageUrls || []).filter(Boolean).map(img).join("");
  if (!verifyUrl) {
    const reply = "Please reply to this email: say “approved” if it's right, or tell us what you'd like changed.";
    const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Design Verification — ${escHtml(orderId)}</h2>
    <p>Hi ${escHtml(customerName)},</p>
    <p>${escHtml(message).replace(/\n/g, "<br>")}</p>
    ${imagesHtml}
    <p style="background:#f0fdf4;border-left:3px solid #15803d;padding:10px 14px">${escHtml(reply)}</p>
    <p style="font-size:13px;color:#555">We won't start on your order until you've approved the design.</p>
    <hr/>
    <p style="font-size:12px;color:#666">%%BUSINESS%% — %%SITE%%</p>
  </div>`;
    const text = `Design Verification — ${orderId}\n\nHi ${customerName},\n\n${message}\n\n` +
      ((attachments || []).length ? `The design is attached (${attachments.map(a => a.filename).join(", ")}).\n\n` : "") +
      ((imageUrls || []).length ? imageUrls.join("\n") + "\n\n" : "") + `${reply}\n\n%%BUSINESS%%`;
    return send_(env, { to: customerEmail, subject, html, text, attachments: attachments || [] });
  }
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Design Verification — ${escHtml(orderId)}</h2>
    <p>Hi ${escHtml(customerName)},</p>
    <p>${escHtml(message).replace(/\n/g, "<br>")}</p>
    ${imagesHtml}
    <div style="margin:24px 0;text-align:center">
      <a href="${escHtml(verifyUrl)}" style="display:inline-block;background:#15803d;color:#fff;font-size:16px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">Review &amp; Respond →</a>
    </div>
    <p style="font-size:13px;color:#555">Use the button above to approve the design or request changes. If the button doesn't work, copy this link: ${escHtml(verifyUrl)}</p>
    <hr/>
    <p style="font-size:12px;color:#666">%%BUSINESS%% — %%SITE%%</p>
  </div>`;
  const text = `Design Verification — ${orderId}\n\nHi ${customerName},\n\n${message}\n\nReview and respond here: ${verifyUrl}\n\n%%BUSINESS%%`;
  return send_(env, { to: customerEmail, subject, html, text });
}

// Sent to customer with a Stripe link to pay for shipping separately.
export async function sendShippingPaymentEmail(env, { customerName, customerEmail, orderId, shippingCost, shippingMethod, paymentUrl, customBody }) {
  const subject = `Shipping payment for order ${orderId}`;
  const methodLabel = shippingMethod ? ` (${shippingMethod})` : "";
  const bodyText = customBody || `Hi ${customerName},\n\nYour order ${orderId} is ready to ship! Please pay the shipping fee of $${Number(shippingCost).toFixed(2)}${methodLabel} using the secure link below.`;
  const bodyHtml = escHtml(bodyText).replace(/\n/g, "<br>");
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Shipping Payment</h2>
    <p>${bodyHtml}</p>
    <div style="margin:24px 0;text-align:center">
      <a href="${escHtml(paymentUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;font-size:16px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">Pay Shipping &rarr;</a>
    </div>
    <p style="font-size:13px;color:#555">If the button doesn't work, copy this link: ${escHtml(paymentUrl)}</p>
    <hr/>
    <p style="font-size:12px;color:#666">%%BUSINESS%% — %%SITE%%</p>
  </div>`;
  const text = `Shipping Payment for Order ${orderId}\n\n${bodyText}\n\n${paymentUrl}\n\n%%BUSINESS%%`;
  return send_(env, { to: customerEmail, subject, html, text });
}

// Sent to the customer with a link to their invoice page (/?invoice=<token>), where they choose how
// they'll get the order and pay what's owed. `order` is the saved order (so the totals are the ones on
// the books); `message` is the shop's optional note.
export async function sendInvoiceEmail(env, { order, orgName, invoiceUrl, message, allowDelivery }) {
  const subject = `Invoice for your order — ${order.orderId}`;
  const name = String(order.customerName || "").trim();
  const hello = name && name !== "Local Sale" ? `Hi ${name},` : "Hello,";
  // No invoice page to link to (the desktop program: it isn't on the web): the email is the invoice,
  // with how to pay from the Business profile.
  const pay = invoiceUrl ? null : await howToPay_(env, order);
  const lead = !invoiceUrl ? "Here is your invoice." : allowDelivery
    ? "Your invoice is ready. Use the button below to choose how you'd like to get your order and to pay online."
    : "Your invoice is ready. Use the button below to see the details and pay online.";
  const note = String(message || "").trim();
  const items = (order.items || []).filter(it => !it.cancelDate);
  const due = Number(order.balanceDue) || 0;
  // …and a PDF of it, which the desktop program makes (desktop/mailer.js) and attaches.
  const pdf = invoiceUrl ? null : await invoiceDocument(env, order, { orgName, message: note });
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Invoice${orgName ? " — " + escHtml(orgName) : ""}</h2>
    <p>${escHtml(hello)} ${escHtml(lead)}${pdf ? " It's also attached as a PDF." : ""}</p>
    ${note ? `<p style="background:#f8fafc;border-left:3px solid #1d4ed8;padding:10px 14px;white-space:pre-wrap">${escHtml(note)}</p>` : ""}
    <p><strong>Order ID:</strong> ${escHtml(order.orderId)}</p>
    ${itemsTable(items)}
    ${receiptTotalsHtml_(order)}
    ${Number(order.amountReceived) > 0 ? `<p style="font-size:14px">Paid so far: ${fmt$(order.amountReceived)} &nbsp;·&nbsp; <strong>Balance due: ${fmt$(due)}</strong></p>` : ""}
    ${invoiceUrl ? `<div style="margin:24px 0;text-align:center">
      <a href="${escHtml(invoiceUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;font-size:16px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">View &amp; pay invoice &rarr;</a>
    </div>
    <p style="font-size:13px;color:#555">If the button doesn't work, copy this link: ${escHtml(invoiceUrl)}</p>` : pay.html}
    <hr/>
    <p style="font-size:12px;color:#666">%%BUSINESS%% — %%SITE%%</p>
  </div>`;
  const text = `Invoice for order ${order.orderId}\n\n${hello} ${lead}${pdf ? " It's also attached as a PDF." : ""}\n${note ? "\n" + note + "\n" : ""}\n${receiptTotalsText_(order)}\n` +
    (Number(order.amountReceived) > 0 ? `Paid so far: ${fmt$(order.amountReceived)} · Balance due: ${fmt$(due)}\n` : "") +
    (invoiceUrl ? `\nView and pay: ${invoiceUrl}\n\n%%BUSINESS%%` : `\n${pay.text}\n\n%%BUSINESS%%`);
  return send_(env, { to: order.contact, subject, html, text, ...(pdf ? { pdf } : {}) });
}

// An order's invoice as a printable page, for the desktop program to make into a PDF (attached to
// the invoice email, or saved from the admin — orders.js getInvoiceDocument). Self-contained: its own
// styles, system fonts, nothing loaded from anywhere. Who it's from comes from the Business profile;
// the paper is Letter in the US and A4 elsewhere (Global settings → Region).
// Returns { filename, html, pageSize }.
export async function invoiceDocument(env, order, { orgName = "", message = "" } = {}) {
  let p = {}, country = "US";
  try { p = (await getBusinessProfile(env && env.DB)) || {}; } catch (e) { p = {}; }
  try { country = ((await getLocaleSettings(env && env.DB)) || {}).country === "OTHER" ? "OTHER" : "US"; } catch (e) { country = "US"; }
  const tz = await timeZone_(env);
  const day = (d) => { const t = new Date(d || Date.now()); return isNaN(t) ? "" : t.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric", year: "numeric" }); };
  const items = (order.items || []).filter(it => !it.cancelDate);
  const due = Math.max(0, Number(order.balanceDue) || 0), received = Number(order.amountReceived) || 0;
  const pay = due > 0 ? await howToPay_(env, order, { inEmail: false }) : null;
  const lines = (v) => escHtml(String(v || "").trim()).replace(/\s*\n\s*/g, "<br>");
  const name = String(order.customerName || "").trim();
  const customer = name && name !== "Local Sale" ? name : "";
  const contact = String(order.contact || "").includes("@") ? String(order.contact) : "";
  const a = order.shippingAddress && order.shippingAddress.line1 ? order.shippingAddress : null;
  const shipTo = a ? [a.name, a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", ") + (a.zip ? " " + a.zip : "")].filter(s => String(s || "").trim()) : [];
  const business = p.name || "Our shop";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${escHtml(order.orderId)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c2430;font-size:13px;line-height:1.45;margin:0}
  .head{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #1f5f8b;padding-bottom:14px;margin-bottom:18px}
  .biz{font-size:20px;font-weight:700;margin:0 0 4px}
  .muted{color:#5a6573}
  .title{font-size:28px;font-weight:700;letter-spacing:.06em;color:#1f5f8b;margin:0;text-align:right}
  .meta td{padding:1px 0 1px 14px;text-align:right}
  .parties{display:flex;gap:40px;margin-bottom:18px}
  .label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5a6573;margin:0 0 4px}
  .due{margin:18px 0 0;padding:12px 14px;border:2px solid #1f5f8b;border-radius:6px;display:flex;justify-content:space-between;font-size:16px}
  .paid{margin:18px 0 0;padding:12px 14px;border:2px solid #15803d;border-radius:6px;color:#15803d;font-size:16px;font-weight:700;text-align:center}
  .note{margin:16px 0 0;padding:10px 14px;background:#f7f6f2;border-left:3px solid #1f5f8b;white-space:pre-wrap}
  .foot{margin-top:28px;padding-top:10px;border-top:1px solid #e1ddd3;font-size:11px;color:#5a6573}
  table{page-break-inside:auto} tr{page-break-inside:avoid}
</style></head><body>
  <div class="head">
    <div>
      <p class="biz">${escHtml(business)}</p>
      ${p.legalName && p.legalName !== business ? `<div class="muted">${escHtml(p.legalName)}</div>` : ""}
      ${p.mailingAddress ? `<div>${lines(p.mailingAddress)}</div>` : ""}
      ${p.supportEmail ? `<div>${escHtml(p.supportEmail)}</div>` : ""}
    </div>
    <div>
      <p class="title">INVOICE</p>
      <table class="meta"><tr><td class="muted">Invoice no.</td><td>${escHtml(order.orderId)}</td></tr>
        <tr><td class="muted">Date</td><td>${escHtml(day())}</td></tr>
        ${order.placedAt ? `<tr><td class="muted">Order date</td><td>${escHtml(day(order.placedAt))}</td></tr>` : ""}
        ${orgName ? `<tr><td class="muted">Shop</td><td>${escHtml(orgName)}</td></tr>` : ""}</table>
    </div>
  </div>
  <div class="parties">
    ${customer || contact ? `<div><p class="label">Bill to</p>${customer ? `<div>${escHtml(customer)}</div>` : ""}${contact ? `<div>${escHtml(contact)}</div>` : ""}</div>` : ""}
    ${shipTo.length ? `<div><p class="label">Ship to</p>${shipTo.map(s => `<div>${escHtml(s)}</div>`).join("")}</div>` : ""}
  </div>
  ${itemsTable(items)}
  ${receiptTotalsHtml_(order)}
  ${received > 0 ? `<table style="width:100%;font-size:14px;margin-top:4px"><tr><td>Paid so far</td><td style="text-align:right">−${fmt$(received)}</td></tr></table>` : ""}
  ${due > 0 ? `<div class="due"><strong>Balance due</strong><strong>${fmt$(due)}</strong></div>` : `<div class="paid">Paid in full — thank you</div>`}
  ${message ? `<div class="note">${escHtml(message)}</div>` : ""}
  ${pay ? pay.html : ""}
  <div class="foot">${[p.footer, business + (p.supportEmail ? " · " + p.supportEmail : "")].filter(Boolean).map(escHtml).join("<br>")}</div>
</body></html>`;
  return { filename: `Invoice ${order.orderId}.pdf`, html, pageSize: country === "US" ? "Letter" : "A4" };
}

// How to pay an invoice that has no page to pay on (the desktop program's): the ways the Business
// profile lists — Venmo (a link with the amount), Zelle, a cheque by mail — and replying to the email.
// `inEmail` false (the PDF): questions go to the support email, not "reply to this email".
async function howToPay_(env, order, { inEmail = true } = {}) {
  let p = {};
  try { p = (await getBusinessProfile(env && env.DB)) || {}; } catch (e) { p = {}; }
  const due = Number(order.balanceDue) || 0;
  const ways = [];
  if (p.venmo) ways.push({ text: `Venmo: @${p.venmo}`, href: `https://venmo.com/u/${encodeURIComponent(p.venmo)}?txn=pay&amount=${due.toFixed(2)}&note=${encodeURIComponent("Order " + order.orderId)}` });
  if (p.zelle) ways.push({ text: `Zelle: ${p.zelle}` });
  if (p.mailingAddress) ways.push({ text: `A check made out to ${p.legalName || p.name || "us"}, mailed to ${String(p.mailingAddress).replace(/\s*\n\s*/g, ", ")}` });
  const close = inEmail ? "Questions? Reply to this email." : p.supportEmail ? `Questions? Email ${p.supportEmail}.` : "";
  return {
    html: `<h3 style="margin:20px 0 6px;font-size:16px">How to pay${due > 0 ? " " + fmt$(due) : ""}</h3>` +
      (ways.length ? `<ul style="margin:0 0 8px;padding-left:20px">${ways.map(w => `<li>${w.href ? `<a href="${escHtml(w.href)}">${escHtml(w.text)}</a>` : escHtml(w.text)}</li>`).join("")}</ul>` : "") +
      `<p style="font-size:13px;color:#555">Please put the order number, ${escHtml(order.orderId)}, with your payment. ${escHtml(close)}</p>`,
    text: `How to pay${due > 0 ? " " + fmt$(due) : ""}:\n` + ways.map(w => "  " + w.text + (w.href ? "\n    " + w.href : "")).join("\n") +
      `\nPlease put the order number, ${order.orderId}, with your payment. ${close}`,
  };
}

// Queued for the owner's 6 AM roll-up when a customer chooses how they'll get their order on its
// invoice page (emailed at once only if it can't be queued).
export async function sendInvoiceDeliveryNotification(env, { orderId, orgId, customerName, choice, detail }) {
  const summary = `${customerName || "The customer"} chose ${choice} on their invoice`;
  const text = `${summary}\nOrder: ${orderId} (${orgId})${detail ? "\n" + detail : ""}`;
  return queueOwnerNotice_(env, { kind: "invoice", orderId, orgId, summary, detail: detail || "" },
    { to: ORDER_NOTIFICATION_EMAIL, subject: `Invoice — delivery chosen — ${orgId} — ${orderId}`,
      html: `<div style="font-family:sans-serif"><p>${escHtml(summary)}</p><p>Order ${escHtml(orderId)} (${escHtml(orgId)})</p>${detail ? `<p>${escHtml(detail)}</p>` : ""}</div>`, text });
}

// Sent to admin when a customer responds to a design verification.
export async function sendDesignVerificationResponseNotification(env, { orderId, orgId, customerName, action, note, imageUrls }) {
  const label = action === "approved" ? "✓ APPROVED" : "⚠ REVISION REQUESTED";
  const subject = `Design ${action === "approved" ? "approved" : "revision requested"} — ${orgId} — ${orderId}`;
  const imagesHtml = (imageUrls || []).filter(Boolean).map(
    u => `<div style="margin:8px 0"><img src="${escHtml(u)}" alt="Customer image" style="max-width:400px;border:1px solid #e5e7eb"></div>`
  ).join("");
  const noteHtml = note ? `<p><strong>Customer note:</strong> ${escHtml(note).replace(/\n/g, "<br>")}</p>${imagesHtml}` : "";
  const text = `${label}\nOrder: ${orderId} (${orgId})\nCustomer: ${customerName}${note ? `\nNote: ${note}` : ""}`;
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2>${escHtml(label)}</h2>
    <p><strong>Order:</strong> ${escHtml(orderId)} (${escHtml(orgId)})</p>
    <p><strong>Customer:</strong> ${escHtml(customerName)}</p>
    ${noteHtml}
    <hr/><p style="font-size:12px;color:#666">%%BUSINESS%% admin notification</p>
  </div>`;
  return queueOwnerNotice_(env, { kind: "design", orderId, orgId,
      summary: `Design ${action === "approved" ? "approved" : "revision requested"} by ${customerName}`,
      detail: note || "", imageUrls },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html, text });
}
