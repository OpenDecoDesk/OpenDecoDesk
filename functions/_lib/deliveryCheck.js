/**
 * Daily delivery check — part of the 6 AM roll-up (functions/api/daily-digest.js),
 * also run on demand from the Communications page.
 *
 * PICKUP: buying a label does NOT mean the carrier has the package. Orders with a label
 * or tracking number that aren't marked shipped are looked up first; once tracking shows a carrier
 * scan (anything past PRE_TRANSIT), the order is marked shipped — dated by the carrier's first scan,
 * not the label — the customer gets their one "your order has shipped" email, and it's listed in the
 * roll-up under "Picked up by the carrier". Already delivered by then → marked delivered too.
 * Still pre-transit → left alone ("label created, not shipped yet") and checked again next run.
 *
 * For every order that's been shipped but not yet marked delivered (and has a
 * tracking number — its own, else the site-bought label's), ask Shippo's
 * tracking API for the carrier's status. A DELIVERED one is marked delivered
 * (dated by the carrier's delivery time) and queued as an owner notice, which
 * the roll-up email lists under "Delivered" and the Communications page shows.
 * The order is then ready to be marked completed (paid in full) from the
 * orders screen.
 *
 * Bounded: at most `limit` lookups per run (Cloudflare caps subrequests per
 * invocation), oldest shipments first. Anything not delivered yet, unknown to
 * the carrier, or that errors is simply checked again tomorrow — a failure
 * here never stops the roll-up (the caller wraps it).
 */

import { getShippedAwaitingDelivery, getLabeledAwaitingShipment, markOrderShippedByCarrier, markOrderDelivered,
  addOwnerNotice, insertAuditLog, getOrderById,
  listActiveBlankShipments, recordBlankTrackingEvents, setBlankShipmentStatus, resolveTimeZone, getFeatures } from "./db.js";
import { sendShippedEmail } from "./email.js";

// Shippo's carrier token for a label's carrier / the order's shipping method
// ("USPS Ground Advantage", "UPS Ground Saver"…). "usps" first: it contains "ups".
// A tracking number starting "SHIPPO_" (SHIPPO_PRE_TRANSIT / _TRANSIT / _DELIVERED / _RETURNED /
// _FAILURE / _UNKNOWN) is one of Shippo's test-mode fake numbers: they're looked up under Shippo's
// own test carrier, "shippo", and return that status. Real tracking numbers never look like this,
// so real shipments are unaffected; it lets a test install walk an order through pickup → delivery.
export function carrierToken(labelCarrier, shippingMethod, tracking) {
  if (/^SHIPPO_/i.test(String(tracking || "").trim())) return "shippo";
  const t = String(labelCarrier || shippingMethod || "").toLowerCase();
  if (/usps|postal/.test(t)) return "usps";
  if (/\bups\b/.test(t)) return "ups";
  if (/fedex/.test(t)) return "fedex";
  if (/dhl/.test(t)) return "dhl_express";
  return "usps";
}

// "Oct 3" on the business's own calendar (Region setting, else TIMEZONE, else UTC — resolveTimeZone).
const localDateLabeler_ = async (env) => {
  let timeZone = "UTC";
  try { timeZone = await resolveTimeZone(env); } catch (e) { /* UTC */ }
  return (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
};

// Human-readable status labels from Shippo's enum
const STATUS_LABEL = {
  TRANSIT:    "In transit",
  DELIVERED:  "Delivered",
  RETURNED:   "Return to sender",
  FAILURE:    "Carrier issue",
  UNKNOWN:    "Unknown",
  PRE_TRANSIT: "Pre-transit",
};

// One Shippo tracking lookup → { status, statusDate, statusDetail, firstScanDate } or null on error.
// firstScanDate = the earliest history event showing the carrier has the package (not PRE_TRANSIT).
async function lookupTracking_(env, carrier, tracking) {
  const res = await fetch("https://api.goshippo.com/tracks/" + encodeURIComponent(carrier) + "/" + encodeURIComponent(tracking), {
    headers: { "Authorization": "ShippoToken " + env.SHIPPO_API_KEY },
  });
  const t = await res.json();
  const ts = t && t.tracking_status;
  const scans = (Array.isArray(t && t.tracking_history) ? t.tracking_history : [])
    .filter(h => h && CARRIER_HAS_IT.has(String(h.status || "").toUpperCase()) && h.status_date)
    .map(h => h.status_date).sort();
  // The full per-scan history (migrations/0039 blank tracking stores these): one event per scan.
  const loc = (h) => { const l = h && h.location; if (!l) return ""; return [l.city, l.state, l.zip, l.country].filter(Boolean).join(", "); };
  const events = (Array.isArray(t && t.tracking_history) ? t.tracking_history : [])
    .filter(h => h && (h.status || h.status_date))
    .map(h => ({ status: String(h.status || "").toUpperCase(), statusDetail: h.status_details || "", location: loc(h), occurredAt: h.status_date || "" }));
  return {
    status: String((ts && ts.status) || "").toUpperCase(),
    statusDate: (ts && ts.status_date) || "",
    statusDetail: (ts && ts.status_details) || "",
    firstScanDate: scans[0] || "",
    events,
  };
}
// Statuses that mean the carrier physically has (or had) the package.
const CARRIER_HAS_IT = new Set(["TRANSIT", "DELIVERED", "RETURNED", "FAILURE"]);
// A carrier timestamp as ISO, or `fallback` if it's missing, unparseable or in the future.
const isoOr_ = (d, fallback) => { const t = new Date(d); return d && !isNaN(t.getTime()) && t.getTime() <= Date.now() + 86400000 ? t.toISOString() : fallback; };

export async function checkShippedDeliveries(env, { limit = 40 } = {}) {
  const localDate = await localDateLabeler_(env);
  const out = { checked: 0, delivered: [], inTransit: [], pickedUp: [], awaitingPickup: [], unknown: 0, errors: 0 };
  if (!env || !env.DB || !env.SHIPPO_API_KEY) return { ...out, skipped: "Shippo isn't configured" };
  // Tracking lookups belong to the Shipping feature (Global settings → Features): off = nothing is looked up.
  if (!(await getFeatures(env.DB)).shipping) return { ...out, skipped: "Shipping is turned off" };

  // 1) Labeled but not shipped: has the carrier scanned it yet?
  const awaiting = await getLabeledAwaitingShipment(env.DB, limit);
  for (const c of awaiting) {
    out.checked++;
    const carrier = carrierToken(c.labelCarrier, c.shippingMethod, c.tracking);
    const label = carrier.toUpperCase().replace("_EXPRESS", "");
    let tr;
    try { tr = await lookupTracking_(env, carrier, c.tracking); }
    catch (e) { out.errors++; console.error("Pickup check: tracking lookup failed for", c.orderId, e); continue; }
    if (!CARRIER_HAS_IT.has(tr.status)) {
      out.awaitingPickup.push({ orderId: c.orderId, orgId: c.orgId, customerName: c.customerName, tracking: c.tracking, carrier: label,
        labelAt: c.labelAt, labelAtLabel: c.labelAt ? localDate(c.labelAt) : "", status: STATUS_LABEL[tr.status] || tr.status || "Awaiting scan" });
      continue;
    }
    const shippedIso = isoOr_(tr.firstScanDate || tr.statusDate, new Date().toISOString());
    if (!(await markOrderShippedByCarrier(env.DB, c.orderId, shippedIso))) continue; // a person got there first
    let customerEmailed = false;
    try {
      const order = await getOrderById(env.DB, c.orderId);
      customerEmailed = await sendShippedEmail(env, order, { carrier: label, tracking: c.tracking, shippedAt: shippedIso });
    } catch (e) { console.error("Pickup check: shipped email failed for", c.orderId, e); }
    try {
      await insertAuditLog(env.DB, { orgId: c.orgId, orderId: c.orderId, action: "order.shipped_auto", actor: "delivery-check",
        detail: { carrier, tracking: c.tracking, shippedAt: shippedIso, carrierStatus: tr.status, customerEmailed } });
    } catch (e) { console.error("Pickup check: could not audit", c.orderId, e); }
    out.pickedUp.push({ orderId: c.orderId, orgId: c.orgId, customerName: c.customerName, tracking: c.tracking, carrier: label,
      shippedAt: shippedIso, shippedAtLabel: localDate(shippedIso), customerEmailed });
    if (tr.status === "DELIVERED") {
      const iso = isoOr_(tr.statusDate, new Date().toISOString());
      if (await markOrderDelivered(env.DB, c.orderId, iso)) await deliveredFollowUp_(env, out, c, carrier, label, iso);
    }
  }

  // 2) Shipped, waiting on delivery (whatever lookups are left this run).
  // Orders step 1 just looked up (and maybe marked shipped) aren't looked up twice in one run.
  const seen = new Set(awaiting.map(c => c.orderId));
  const remaining = limit - out.checked;
  const candidates = remaining > 0 ? (await getShippedAwaitingDelivery(env.DB, remaining + seen.size)).filter(c => !seen.has(c.orderId)).slice(0, remaining) : [];
  for (const c of candidates) {
    out.checked++;
    const carrier = carrierToken(c.labelCarrier, c.shippingMethod, c.tracking);
    let tr;
    try { tr = await lookupTracking_(env, carrier, c.tracking); }
    catch (e) {
      out.errors++;
      console.error("Delivery check: tracking lookup failed for", c.orderId, e);
      continue;
    }
    const { status, statusDate, statusDetail } = tr;
    const label = carrier.toUpperCase().replace("_EXPRESS", "");

    if (status === "DELIVERED") {
      const iso = isoOr_(statusDate, new Date().toISOString());
      // Only if a person hasn't marked it delivered in the meantime.
      if (!(await markOrderDelivered(env.DB, c.orderId, iso))) continue;
      await deliveredFollowUp_(env, out, c, carrier, label, iso);
    } else {
      out.inTransit.push({
        orderId: c.orderId, orgId: c.orgId, customerName: c.customerName,
        tracking: c.tracking, carrier: label, shippedAt: c.shippedAt,
        status: STATUS_LABEL[status] || status || "Awaiting scan",
        statusDate: statusDate ? localDate(statusDate) : "",
        statusDetail: statusDetail || "",
      });
    }
  }
  return out;
}

// After the check marks an order delivered: queue the owner notice, audit it, record it in `out`.
async function deliveredFollowUp_(env, out, c, carrier, label, iso) {
  const localDate = await localDateLabeler_(env);
  const next = c.paid ? "Paid in full — ready to mark completed." : "A balance is still due, so it can't be completed yet.";
  try {
    await addOwnerNotice(env.DB, { kind: "delivered", orderId: c.orderId, orgId: c.orgId,
      summary: `${c.customerName} — ${label} ${c.tracking} delivered ${localDate(iso)}`, detail: next });
  } catch (e) { console.error("Delivery check: could not queue the notice for", c.orderId, e); }
  try {
    await insertAuditLog(env.DB, { orgId: c.orgId, orderId: c.orderId, action: "order.delivered_auto", actor: "delivery-check",
      detail: { carrier, tracking: c.tracking, deliveredAt: iso } });
  } catch (e) { console.error("Delivery check: could not audit", c.orderId, e); }
  out.delivered.push({ orderId: c.orderId, orgId: c.orgId, customerName: c.customerName, tracking: c.tracking, carrier: label, deliveredAt: iso, paid: c.paid });
}

// Polls each active blank (garment) shipment via Shippo (migrations/0039), stores every new scan
// event in blank_tracking_events (deduped), and updates the shipment's latest status. On DELIVERED
// it marks the shipment delivered and queues a "blanks delivered — mark received" owner notice, but
// NEVER auto-marks the line items received (receiving drives inventory/COGS — a person verifies the
// count). Returns { checked, delivered[], inTransit[] }. Shares the per-invocation subrequest budget.
export async function checkBlankShipments(env, { limit = 20 } = {}) {
  const localDate = await localDateLabeler_(env);
  const out = { checked: 0, delivered: [], inTransit: [], errors: 0 };
  if (!env || !env.DB || !env.SHIPPO_API_KEY) return { ...out, skipped: "Shippo isn't configured" };
  if (!(await getFeatures(env.DB)).shipping) return { ...out, skipped: "Shipping is turned off" };
  const shipments = await listActiveBlankShipments(env.DB, limit);
  for (const s of shipments) {
    out.checked++;
    const carrier = carrierToken(s.carrier, "", s.trackingNumber);
    let tr;
    try { tr = await lookupTracking_(env, carrier, s.trackingNumber); }
    catch (e) { out.errors++; console.error("Blank tracking lookup failed for shipment", s.id, e); continue; }
    try { await recordBlankTrackingEvents(env.DB, s.id, tr.events); } catch (e) { console.error("Blank events store failed", s.id, e); }
    const delivered = tr.status === "DELIVERED";
    await setBlankShipmentStatus(env.DB, s.id, { status: tr.status, statusDetail: tr.statusDetail, statusDate: tr.statusDate,
      deliveredAt: delivered ? isoOr_(tr.statusDate, new Date().toISOString()) : null });
    const row = { shipmentId: s.id, orderId: s.orderId, orgId: s.orgId, customerName: s.customerName,
      carrier: carrier.toUpperCase().replace("_EXPRESS", ""), tracking: s.trackingNumber,
      status: STATUS_LABEL[tr.status] || tr.status || "Unknown", statusDate: tr.statusDate ? localDate(tr.statusDate) : "", statusDetail: tr.statusDetail || "" };
    if (delivered) {
      try {
        await addOwnerNotice(env.DB, { kind: "delivered", orderId: s.orderId || "", orgId: s.orgId || "",
          summary: `Blanks delivered (${row.carrier} ${s.trackingNumber}) — mark them received when counted`,
          detail: row.statusDetail || "" });
        await insertAuditLog(env.DB, { orgId: s.orgId || null, orderId: s.orderId || null, action: "blank.shipment_delivered_auto", actor: "delivery-check",
          detail: { shipmentId: s.id, carrier: row.carrier, tracking: s.trackingNumber } });
      } catch (e) { console.error("Blank delivered notice failed", s.id, e); }
      out.delivered.push(row);
    } else {
      out.inTransit.push(row);
    }
  }
  return out;
}
