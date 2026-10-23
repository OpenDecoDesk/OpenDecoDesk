// Daily order roll-up for the owner — one email a day instead of one per order.
//
// Runs at ~6 AM local time from the Worker's `scheduled` handler (src/worker.js), which calls
// runDailyDigest(env) directly. The POST endpoint below is the manual / external trigger: it takes
// {key} and checks it against CRON_SECRET. Lists new orders and every queued owner notice (owner_notices: Stripe
// payments/refunds/disputes, design responses). Sends nothing when no new orders were placed since
// the last roll-up. Progress is only saved after the email goes out, so a failed send is retried by
// the next run.

import { jsonResponse } from "../_lib/http.js";
import { timingSafeEqual } from "../_lib/adminAuth.js";
import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { getDigestState, setDigestState, setDigestRun, getOrdersForDigest, getAllOrgs, getUnsentOwnerNotices, markOwnerNoticesSent,
  getFailedAdminLogins, clearFailedAdminLogins, getSystemIssues, clearSystemIssues, getOrdersAwaitingBlanks, localToday,
  getBlankPriceReminder, setBlankPriceReminderSent, getNewPricingAlerts, listMaintenanceTasks, getFeatures } from "../_lib/db.js";
import { sendDailyDigestEmail, sendDigestHeartbeatEmail } from "../_lib/email.js";
import { checkShippedDeliveries, checkBlankShipments } from "../_lib/deliveryCheck.js";
import { checkSupplierShipments } from "../_lib/supplierOrders.js";

const SECURITY_ALERT_THRESHOLD = 5;

export async function onRequestPost({ request, env }) {
  const rl = await rateLimited(env, "daily_digest", request, 10);
  if (rl.blocked) return rateLimitResponse(rl.retryAfter);
  if (!env.CRON_SECRET || !env.DB) {
    return jsonResponse({ status: "error", message: "Not configured" }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ status: "error", message: "Invalid JSON" }, 400); }
  if (!timingSafeEqual(String((body && body.key) || ""), env.CRON_SECRET)) {
    return jsonResponse({ status: "error", message: "Unauthorized" }, 401);
  }
  return runDailyDigest(env, "manual");
}

// The roll-up, minus authentication, with a record of the run left behind (see setDigestRun) — also
// when it found nothing or failed, so Communications can say "last checked 6:00 AM — nothing new".
// `trigger`: "scheduled" (the Worker's cron) or "manual" (the POST above). Returns the JSON Response.
export async function runDailyDigest(env, trigger = "manual") {
  const record = async (fields) => {
    try { await setDigestRun(env.DB, { at: new Date().toISOString(), trigger, ...fields }); }
    catch (e) { console.error("Could not record the roll-up run:", e); }
  };
  let res;
  try { res = await runDailyDigestInner_(env, trigger); }
  catch (e) { await record({ ok: false, sent: false, message: String((e && e.message) || e).slice(0, 300) }); throw e; }
  const body = await res.clone().json().catch(() => ({}));
  await record({ ok: res.ok, sent: !!body.sent, heartbeat: body.heartbeat || "", orders: Number(body.orders) || 0, notices: Number(body.notices) || 0,
    delivered: Number(body.delivered) || 0, pickedUp: Number(body.pickedUp) || 0, message: res.ok ? "" : String(body.message || "HTTP " + res.status).slice(0, 300) });
  console.log("Daily roll-up", trigger, res.ok ? (body.sent ? "sent" : "nothing new" + (body.heartbeat ? " — heartbeat email " + body.heartbeat : " — no email")) : "FAILED", JSON.stringify(body).slice(0, 200));
  return res;
}

async function runDailyDigestInner_(env, trigger) {

  // Check tracking for shipped orders first: delivered ones are marked delivered
  // and queued as "delivered" notices, so they land in THIS email. In-transit
  // orders are passed through to the email directly (not queued as notices —
  // they'll be checked again tomorrow). Never lets a Shippo hiccup stop the
  // roll-up — anything missed is checked again tomorrow.
  //
  // The customer-shipment and blank-shipment checks SHARE one Shippo-lookup budget
  // (`TRACKING_LOOKUP_BUDGET`) so their combined per-invocation subrequest count (each lookup is a
  // fetch, and each hit then does several D1 writes + maybe an email) stays well under the Workers
  // limit — capping each independently (say 40 + 20) could sum past the Free
  // plan's 50. Customer deliveries go first; blanks get whatever lookups are left. Both are
  // oldest-first and idempotent, so anything skipped today is simply picked up tomorrow.
  //
  // Features (Global settings → Features): with Shipping switched off both checks return at once
  // without a single lookup (deliveryCheck.js), so the picked-up / in-transit / awaiting-pickup
  // sections below are simply empty; with Design approval off no approval notices are ever queued.
  const TRACKING_LOOKUP_BUDGET = 60;
  let deliveries = { delivered: [], inTransit: [], pickedUp: [], awaitingPickup: [], checked: 0 };
  try { deliveries = await checkShippedDeliveries(env, { limit: TRACKING_LOOKUP_BUDGET }); }
  catch (e) { console.error("Delivery check failed — sending the roll-up without it:", e); }
  // Poll blank (garment) shipments with the remaining budget (migrations/0039): stores scan history
  // + updates each shipment's status, which the "Blanks ordered, not yet received" section then
  // shows live. A delivered one queues an owner notice (so it rides the roll-up); never auto-receives.
  // First, orders placed with a supplier from Blanks to Order (migrations/0072): its shipment notices turn into
  // blank shipments (one supplier call per order, from the same budget, at most 10), so the Shippo check below
  // follows them the same morning.
  let afterDeliveries = Math.max(0, TRACKING_LOOKUP_BUDGET - (deliveries.checked || 0));
  if (afterDeliveries > 0) {
    try { const r = await checkSupplierShipments(env, { limit: Math.min(10, afterDeliveries) }); afterDeliveries -= (r.checked || 0) + (r.errors || []).length; }
    catch (e) { console.error("Supplier-shipment check failed — sending the roll-up without it:", e); }
  }
  const blankBudget = Math.max(0, afterDeliveries);
  if (blankBudget > 0) {
    try { await checkBlankShipments(env, { limit: blankBudget }); }
    catch (e) { console.error("Blank-shipment check failed — sending the roll-up without it:", e); }
  }

  const state = await getDigestState(env.DB);
  const { orders, cursor } = await getOrdersForDigest(env.DB, state);
  const notices = await getUnsentOwnerNotices(env.DB);
  // Failed admin sign-ins ride along with any roll-up; 5+ send one on their own.
  const security = await getFailedAdminLogins(env.DB);
  const securityAlert = !!security && security.count >= SECURITY_ALERT_THRESHOLD;
  // Email/webhook failures since the last roll-up: always worth an email.
  const issues = (await getSystemIssues(env.DB).catch(() => null)) || [];
  // Blanks ordered from a vendor but not yet received — so a lost or late vendor order
  // surfaces every morning with its status instead of being silently forgotten. Overdue ones
  // (past the expected date) are a reason to send the roll-up on their own.
  const today = await localToday(env);   // the business's own calendar day (Region time zone)
  const awaitingBlanks = ((await getOrdersAwaitingBlanks(env.DB).catch(() => [])) || []).map(o => {
    const orderedDate = o.blankOrderedAt ? String(o.blankOrderedAt).slice(0, 10) : "";
    const expected = o.blankEstDelivery ? String(o.blankEstDelivery).slice(0, 10) : "";
    const overdue = !!expected && expected < today;
    const daysWaiting = orderedDate ? Math.max(0, Math.round((Date.parse(today) - Date.parse(orderedDate)) / 86400000)) : null;
    const daysLate = overdue ? Math.round((Date.parse(today) - Date.parse(expected)) / 86400000) : 0;
    const statusLabel = overdue ? `Overdue — expected ${expected} (${daysLate} day${daysLate === 1 ? "" : "s"} late)`
      : expected ? `Expected ${expected}`
      : `No ETA${daysWaiting != null ? ` — ordered ${daysWaiting} day${daysWaiting === 1 ? "" : "s"} ago` : ""}`;
    return { ...o, orderedDate, expected, overdue, daysWaiting, daysLate, statusLabel };
  });
  const blanksOverdue = awaitingBlanks.filter(o => o.overdue);
  // Every 30 days (migrations/0062): blanks for sale on visible products whose vendor prices haven't
  // been checked in 30 days, and products priced on blank prices that have since changed. A reason to
  // send on its own when due; once sent, the next one is 30 days later.
  const reminder = await getBlankPriceReminder(env.DB).catch((e) => { console.error("getBlankPriceReminder failed:", e); return null; });
  const priceReminder = reminder && reminder.due && (reminder.blanks.length || reminder.products.length) ? reminder : null;
  // Products that slipped below a pricing target since the last roll-up (migrations/0067) — a blank's cost, a fee
  // or a target changed. Each is reported once; a reason to send on its own.
  const alerts = await getNewPricingAlerts(env.DB).catch((e) => { console.error("getNewPricingAlerts failed:", e); return { products: [], commit: async () => {} }; });
  const belowTarget = alerts.products;
  // Machine maintenance that's due (migrations/0071): listed whenever an email goes out, never a reason on its own.
  // (Not while the production feature is switched off.)
  const maintenanceDue = (await getFeatures(env.DB).catch(() => ({ production: true }))).production
    ? (await listMaintenanceTasks(env.DB).catch(() => [])).filter(t => t.status === "due") : [];
  const inTransit = deliveries.inTransit || [];
  // Picked up by the carrier (marked shipped this run) is news; a label still waiting for a scan is
  // listed in the email for the record but never a reason to send one on its own.
  const pickedUp = deliveries.pickedUp || [], awaitingPickup = deliveries.awaitingPickup || [];
  // In transit alone isn't news: otherwise the email would go out every day while any package
  // was on its way, with nothing new in it. It's still listed whenever something else sends one.
  if (!orders.length && !notices.length && !securityAlert && !deliveries.delivered.length && !pickedUp.length && !issues.length && !blanksOverdue.length && !priceReminder && !belowTarget.length) {
    // Nothing to report; move the marker past any test/voided orders.
    await setDigestState(env.DB, { ...cursor, sentAt: state ? state.sentAt || "" : "" });
    await alerts.commit().catch(() => {});   // nothing new below target — remember the recoveries
    // A quiet morning still gets a short "nothing new" email from the SCHEDULED run, so silence can
    // never mean "it didn't run". (A manual run doesn't — it would send one every time it's pressed.)
    // It reports nothing, so the last-sent time above is left alone; a failed send is recorded as an
    // email problem by send_ and turns up in the next roll-up.
    let heartbeat = "";
    if (trigger === "scheduled") {
      const ok = await sendDigestHeartbeatEmail(env, { lastSentAt: state ? state.sentAt || "" : "", inTransit, awaitingPickup, awaitingBlanks, maintenanceDue });
      heartbeat = ok ? "sent" : "failed";
    }
    return jsonResponse({ status: "ok", sent: false, heartbeat, orders: 0, notices: 0, delivered: deliveries.delivered.length, inTransit: 0 });
  }
  const orgNames = Object.fromEntries((await getAllOrgs(env.DB)).map(o => [o.orgId, o.name]));
  const sent = await sendDailyDigestEmail(env, { orders, notices, orgNames, security, inTransit, pickedUp, awaitingPickup, issues, awaitingBlanks, priceReminder, belowTarget, maintenanceDue });
  if (!sent) return jsonResponse({ status: "error", message: "Email could not be sent — will retry next run" }, 502);
  if (priceReminder) await setBlankPriceReminderSent(env.DB).catch((e) => console.error("setBlankPriceReminderSent failed:", e));
  await alerts.commit().catch((e) => console.error("pricing alerts commit failed:", e));
  await setDigestState(env.DB, { ...cursor, sentAt: new Date().toISOString() });
  await markOwnerNoticesSent(env.DB, notices.map(x => x.id));
  if (security) await clearFailedAdminLogins(env.DB);
  if (issues.length) await clearSystemIssues(env.DB);
  return jsonResponse({ status: "ok", sent: true, orders: orders.length, notices: notices.length, delivered: deliveries.delivered.length, inTransit: inTransit.length, pickedUp: pickedUp.length });
}

export async function onRequestGet() {
  return jsonResponse({ status: "error", message: "Use POST." }, 405);
}
