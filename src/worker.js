/**
 * Cloudflare Worker entry point.
 * ========================================================================
 * public/ is served as static assets; the API handlers live one per file in functions/api/*.js,
 * each exporting onRequestGet / onRequestPost / … (the Cloudflare Pages Functions convention).
 * This small router calls them, and a `scheduled` handler runs the daily roll-up.
 *
 *   - `[assets]` (wrangler.toml) serves public/ directly and only invokes this Worker for
 *     /api/* (run_worker_first), so page views cost no Worker invocation.
 *   - fetch(): /api/<name> → functions/api/<name>.js, calling onRequest<Method>(context) with the
 *     context shape Pages Functions use ({request, env, params, waitUntil, next, data}).
 *   - scheduled(): the daily roll-up, at the configured local hour (functions/_lib/schedule.js),
 *     after deleting customers' design uploads no order used (functions/api/customer-design.js).
 */

import * as adminTwoFa from "../functions/api/admin-2fa.js";
import * as adminPassword from "../functions/api/admin-password.js";
import * as adminSession from "../functions/api/admin-session.js";
import * as adminUsers from "../functions/api/admin-users.js";
import * as agent from "../functions/api/agent.js";
import * as catalog from "../functions/api/catalog.js";
import * as checkout from "../functions/api/checkout.js";
import * as customerDesign from "../functions/api/customer-design.js";
import * as dailyDigest from "../functions/api/daily-digest.js";
import * as design from "../functions/api/design.js";
import * as imageProxy from "../functions/api/image-proxy.js";
import * as invoice from "../functions/api/invoice.js";
import * as orders from "../functions/api/orders.js";
import * as receipt from "../functions/api/receipt.js";
import * as shipping from "../functions/api/shipping.js";
import * as shippoLabel from "../functions/api/shippo-label.js";
import * as stripeWebhook from "../functions/api/stripe-webhook.js";
import * as uploadVerify from "../functions/api/upload-verify.js";
import * as upload from "../functions/api/upload.js";
import * as verify from "../functions/api/verify.js";
import { recordSystemIssue, resolveTimeZone } from "../functions/_lib/db.js";
import { isDigestHour } from "../functions/_lib/schedule.js";
import { isDesktopEdition } from "../functions/_lib/hostConfig.js";
import { ensureDesktopReady } from "../functions/_lib/desktop.js";
import { fillMissingCardFees } from "../functions/_lib/stripeFees.js";
import { checkShippedDeliveries, checkBlankShipments } from "../functions/_lib/deliveryCheck.js";

// The send-agent relay's mailbox is a Durable Object (one globally consistent instance); the class must be
// exported from the Worker entry for the AGENT_MAILBOX binding in wrangler.toml.
export { AgentMailbox } from "../functions/_lib/agentMailbox.js";

export const ROUTES = {
  "admin-2fa": adminTwoFa,
  "admin-password": adminPassword,
  "admin-session": adminSession,
  "admin-users": adminUsers,
  "agent": agent,
  "catalog": catalog,
  "checkout": checkout,
  "customer-design": customerDesign,
  "daily-digest": dailyDigest,
  "design": design,
  "image-proxy": imageProxy,
  "invoice": invoice,
  "orders": orders,
  "receipt": receipt,
  "shipping": shipping,
  "shippo-label": shippoLabel,
  "stripe-webhook": stripeWebhook,
  "upload-verify": uploadVerify,
  "upload": upload,
  "verify": verify,
};

const text = (body, status, extra = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

// The handler for a method is named onRequestGet, onRequestPost, …; HEAD is served by the GET handler.
function handlerFor(mod, method) {
  const m = method === "HEAD" ? "Get" : method.charAt(0) + method.slice(1).toLowerCase();
  return mod["onRequest" + m] || mod.onRequest || null;
}

// The desktop edition's start-up step (functions/_lib/desktop.js), once per process: every request
// waits for the same promise, and a failure is retried by the next request.
let desktopReady_ = null;
function desktopReady(env) {
  if (!desktopReady_) desktopReady_ = ensureDesktopReady(env).catch((e) => { desktopReady_ = null; throw e; });
  return desktopReady_;
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (isDesktopEdition(env) && env.DB) {
    try { await desktopReady(env); }
    catch (e) { console.error("Desktop start-up step failed:", e); return text("The database isn't ready. Close the program and open it again.", 503); }
  }
  const match = /^\/api\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  const mod = match && Object.prototype.hasOwnProperty.call(ROUTES, match[1]) ? ROUTES[match[1]] : null;
  if (!mod) {
    // Not an API route. Static files are served by the assets layer before this Worker is called;
    // anything that still reaches us (an unknown /api/ path) is a 404.
    return text("Not found", 404);
  }
  const handler = handlerFor(mod, request.method);
  if (!handler) return text("Method not allowed", 405);
  return handler({
    request,
    env,
    params: {},
    data: {},
    waitUntil: (p) => ctx.waitUntil(p),
    passThroughOnException: () => ctx.passThroughOnException(),
    next: (req) => (env.ASSETS ? env.ASSETS.fetch(req || request) : text("Not found", 404)),
  });
}

// The scheduled roll-up. The cron wakes the Worker every hour (UTC); only the tick that lands on the
// configured local hour runs it, so it goes out once a day at the same local time all year. The
// time zone is the install's one zone: Global settings → Region, else TIMEZONE, else UTC.
export async function handleScheduled(event, env) {
  // The desktop program has no cron: desktop/main.js calls this while it is open. Of the jobs below
  // only the tracking checks apply there (no Stripe, no customer uploads, no email), and only with
  // a Shippo key — both check functions also skip themselves while Shipping is switched off.
  if (isDesktopEdition(env)) {
    if (!env.SHIPPO_API_KEY) return { ran: false, reason: "desktop edition, no Shippo key" };
    const out = { ran: true, desktop: true };
    try { out.deliveries = await checkShippedDeliveries(env); }
    catch (e) { console.error("Tracking check failed:", e); out.deliveries = { error: String(e && e.message) }; }
    try { out.blankShipments = await checkBlankShipments(env); }
    catch (e) { console.error("Blank shipment check failed:", e); out.blankShipments = { error: String(e && e.message) }; }
    return out;
  }
  const when = new Date(event && event.scheduledTime ? event.scheduledTime : Date.now());
  if (!isDigestHour(env, when, await resolveTimeZone(env))) return { ran: false, reason: "not the digest hour" };
  // Safety net: fill in Stripe fees the webhook couldn't read yet (see functions/_lib/stripeFees.js).
  try {
    const f = await fillMissingCardFees(env);
    if (f.filled) console.log("Filled Stripe fees on", f.filled, "of", f.checked, "card payments");
  } catch (e) { console.error("Filling missing Stripe fees failed (continuing with the roll-up):", e); }
  // Customers' design uploads that never made it onto an order are deleted after 48 hours.
  try {
    const c = await customerDesign.cleanUpCustomerDesigns(env);
    if (c.deleted) console.log("Deleted", c.deleted, "customer design upload(s) no order used");
  } catch (e) { console.error("Cleaning up customer design uploads failed (continuing with the roll-up):", e); }
  try {
    const res = await dailyDigest.runDailyDigest(env, "scheduled");
    const body = await res.clone().json().catch(() => ({}));
    if (!res.ok) {
      console.error("Daily roll-up did not complete:", res.status, JSON.stringify(body).slice(0, 300));
      await recordSystemIssue(env.DB, "digest_failed", (body && body.message) || ("HTTP " + res.status));
      return { ran: true, ok: false, body };
    }
    return { ran: true, ok: true, body };
  } catch (e) {
    console.error("Daily roll-up crashed:", e);
    await recordSystemIssue(env.DB, "digest_failed", e && e.message);
    return { ran: true, ok: false, error: String(e && e.message) };
  }
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  scheduled: (event, env, ctx) => { ctx.waitUntil(handleScheduled(event, env)); },
};
