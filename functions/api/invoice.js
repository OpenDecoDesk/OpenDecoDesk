/**
 * Public invoice endpoint — no admin sign-in; the token in the emailed link is the credential.
 * ========================================================================
 * File location: functions/api/invoice.js  →  https://<shop>.<domain>/api/invoice
 *
 * The admin emails a customer a link to their invoice (admin → Orders → Send invoice…, or the
 * "Email an invoice" box on a local sale): /?invoice=<token> on the shop's own address. That page
 * calls this endpoint:
 *
 *   GET  /api/invoice?token=…            → what they owe, how they can get it, how they can pay
 *   POST /api/invoice {token, action:"setDelivery", …} → the customer's delivery choice, written to
 *                                          the order (fee, method, ship-to address, sales tax)
 *
 * Paying by card goes through the existing /api/checkout (it charges the order's balance due and
 * takes `invoiceToken` only to bring the customer back to this page afterwards).
 *
 * ---- WHAT THE CUSTOMER CAN CHANGE ----
 * Only how the order reaches them, and only while that still makes sense: the admin left delivery
 * open on this invoice, the order isn't paid in full, shipped, delivered, completed or cancelled,
 * has no shipping label, and its month isn't closed. Nothing money-related is taken from the
 * request: a shop's own option brings the fee from the shop's list, and a carrier rate is accepted
 * only as a signed quote (functions/_lib/quoteToken.js) for this shop, these items and this ZIP —
 * the same rules as placing an order on the storefront.
 *
 * ---- WHAT IT SHOWS ----
 * One order: its lines, totals, what's been paid, and the ship-to address the customer entered.
 * Never anything about another order or another shop. The token is 122 random bits and stops
 * working 60 days after the invoice was last sent (INVOICE_LINK_TTL_DAYS).
 */

import { getOrderInvoice, invoiceExpired, markInvoiceViewed, markInvoiceDeliveryChosen, getOrderById, getOrgById,
  getGlobalSettings, getProductsByOrg, productShipWeightOz, cleanShippingAddress, updateOrderShipping, isMonthClosed, insertAuditLog,
  getLocaleSettings, getFeatures, getSalesTaxSettings, getBoxPresets, getCategoryPackMap } from "../_lib/db.js";
import { selectBox } from "../_lib/boxSize.js";
import { sendInvoiceDeliveryNotification, lineDetailText } from "../_lib/email.js";
import { verifyQuote, canonicalItems } from "../_lib/quoteToken.js";
import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { jsonResponse } from "../_lib/http.js";

const TOKEN_RE = /^[a-z0-9]{16,64}$/;

// The payment methods this shop accepts — the same rule /api/catalog applies (a method is offered
// unless it's switched off globally or for the shop; Card also needs Stripe to be configured).
function paymentMethods_(org, globalSettings, stripeConfigured) {
  const g = (globalSettings && globalSettings.enabledPayments) || {}, o = (org && org.enabledPayments) || {};
  const on = (k) => g[k] !== false && o[k] !== false;
  return [on("card") && stripeConfigured ? "Card" : "", on("venmo") ? "Venmo" : "", on("zelle") ? "Zelle" : "", on("check") ? "Check" : ""].filter(Boolean);
}

// What the shop offers: its saved list, or — for a shop that never saved one — local pickup, plus
// shipping when it ships (the same fallback order submission uses). Carrier shipping is quoted by US
// ZIP, so it's only offered on a US install with the Shipping feature on (Global settings → Region,
// → Features) — the same rule as placing an order.
async function deliveryOptions_(db, org) {
  const list = Array.isArray(org.deliveryOptions) && org.deliveryOptions.length ? org.deliveryOptions
    : [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }].concat(org.shippingEnabled ? [{ id: "shipping", type: "shipping", label: "Shipping", fee: null }] : []);
  const [locale, features] = await Promise.all([getLocaleSettings(db).catch(() => ({ country: "US" })), getFeatures(db).catch(() => ({}))]);
  const carrier = (locale.country || "US") === "US" && features.shipping !== false;
  return list.filter(o => carrier || o.type !== "shipping");
}

// Why the customer can't change delivery on this invoice any more ("" = they can).
async function deliveryLock_(db, inv, order) {
  if (!inv.allowDelivery) return "fixed";
  if (order.completedAt || order.deliveredAt) return "delivered";
  if (order.shippedAt || (order.labels || []).some(l => !l.voidedAt)) return "shipped";
  if (order.paid && Number(order.balanceDue) <= 0) return "paid";
  if (order.placedAt && await isMonthClosed(db, String(order.placedAt).slice(0, 7))) return "closed";
  return "";
}

// The page's whole picture of the order. Money is what's on the books (effectiveTotal / balanceDue).
async function invoiceView_(env, inv, order, org) {
  const items = (order.items || []).filter(it => !it.cancelDate);
  const options = await deliveryOptions_(env.DB, org);
  const lock = await deliveryLock_(env.DB, inv, order);
  const choice = inv.deliveryChoice || "";
  const addr = order.shippingAddress || null;
  // What's on the order now, in the customer's words.
  let current = null;
  if (choice === "shipping-quote") current = { kind: "shipping-quote", label: "Shipping — cost to follow", fee: null };
  else if (Number(order.shippingCost) > 0 && addr && addr.zip) current = { kind: "shipping", label: "Shipping" + (order.shippingMethod ? " (" + order.shippingMethod + ")" : ""), fee: Number(order.shippingCost) };
  else if (order.shippingMethod && !(addr && addr.zip)) current = { kind: "option", label: order.shippingMethod, fee: Number(order.shippingCost) || 0 };
  else if (choice === "pickup") current = { kind: "pickup", label: (options.find(o => o.type === "pickup") || { label: "Local pickup" }).label, fee: 0 };
  // A carrier rate can only be quoted from catalog weights, so every line has to be a product the
  // shop still lists; otherwise shipping is offered as "cost to follow".
  let quotable = false;
  if (options.some(o => o.type === "shipping")) {
    try {
      const visible = new Set((await getProductsByOrg(env.DB, order.orgId, true)).map(p => p.productId));
      quotable = items.length > 0 && items.every(it => visible.has(it.productId));
    } catch (e) { quotable = false; }
  }
  const settings = await getGlobalSettings(env.DB).catch(() => ({}));
  const tax = await getSalesTaxSettings(env.DB).catch(() => ({}));
  return {
    orderId: order.orderId, orgId: order.orgId, orgName: org.name || order.orgId, orgAccent: org.accent || "#1d4ed8",
    customerName: order.customerName === "Local Sale" ? "" : (order.customerName || ""), placedAt: order.placedAt || "",
    message: inv.message || "",
    items: items.map(it => ({ productId: it.productId, name: it.name, size: it.size && it.size !== "OSFA" ? it.size : "", qty: it.qty,
      detail: lineDetailText(it), unitPrice: it.unitPrice, lineTotal: it.lineTotal })),
    subtotal: Number(order.itemsSubtotal) || 0, discount: Number(order.discountAmount) || 0, discountNote: order.discountNote || "",
    shipping: Number(order.shippingCost) || 0, total: Number(order.effectiveTotal) || 0,
    received: Number(order.amountReceived) || 0, balanceDue: Number(order.balanceDue) || 0, paid: !!order.paid && Number(order.balanceDue) <= 0,
    salesTax: Number(order.salesTax) || 0, taxRate: Number(order.taxRate) || 0, taxExempt: !!order.taxExempt,
    // Tax in the listed prices or added on top (migrations/0052) — the page shows a tax line for the latter.
    taxMode: order.taxMode === "exclusive" ? "exclusive" : "inclusive", taxJurisdiction: tax.jurisdiction || "",
    delivery: {
      // Offered only when there's a real choice to make: more than local pickup alone.
      options: options.length === 1 && options[0].type === "pickup" ? [] : options.map(o => ({ id: o.id, type: o.type, label: o.label, fee: o.fee })),
      current, chosen: !!inv.deliveryChosenAt, locked: lock, quotable,
      address: addr && addr.zip ? { name: addr.name || "", line1: addr.line1 || "", line2: addr.line2 || "", city: addr.city || "", state: addr.state || "", zip: addr.zip || "" } : null,
    },
    payments: paymentMethods_(org, settings, !!env.STRIPE_SECRET_KEY),
  };
}

// Loads the invoice + its order + its shop, or answers why it can't be shown.
async function loadInvoice_(env, token) {
  if (!TOKEN_RE.test(token)) return { error: jsonResponse({ status: "error", message: "This invoice link isn't valid." }, 404) };
  const inv = await getOrderInvoice(env.DB, token);
  if (!inv) return { error: jsonResponse({ status: "error", message: "This invoice link isn't valid." }, 404) };
  if (invoiceExpired(inv)) return { error: jsonResponse({ status: "error", message: "This invoice link has expired — contact us for a new one." }, 410) };
  const order = await getOrderById(env.DB, inv.orderId);
  if (!order) return { error: jsonResponse({ status: "error", message: "This invoice link isn't valid." }, 404) };
  if (order.voidedAt || !(order.items || []).some(it => !it.cancelDate)) {
    return { error: jsonResponse({ status: "error", message: "This order was cancelled — there's nothing to pay." }, 410) };
  }
  const org = await getOrgById(env.DB, order.orgId);
  if (!org) return { error: jsonResponse({ status: "error", message: "This invoice link isn't valid." }, 404) };
  return { inv, order, org };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
  const rl = await rateLimited(env, "invoice", request, 60);
  if (rl.blocked) return rateLimitResponse(rl.retryAfter);
  const token = String(new URL(request.url).searchParams.get("token") || "").trim();
  const got = await loadInvoice_(env, token);
  if (got.error) return got.error;
  if (!got.inv.viewedAt) await markInvoiceViewed(env.DB, token).catch(() => {});
  return jsonResponse({ status: "ok", invoice: await invoiceView_(env, got.inv, got.order, got.org) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
  const rl = await rateLimited(env, "invoice", request, 30);
  if (rl.blocked) return rateLimitResponse(rl.retryAfter);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ status: "error", message: "Invalid JSON" }, 400); }
  const token = String((body && body.token) || "").trim();
  const got = await loadInvoice_(env, token);
  if (got.error) return got.error;
  const { inv, order, org } = got;
  if (body.action !== "setDelivery") return jsonResponse({ status: "error", message: "Unknown action" }, 400);

  const lock = await deliveryLock_(env.DB, inv, order);
  if (lock) {
    const why = { fixed: "The delivery method for this order is already set.", delivered: "This order has already been delivered.",
      shipped: "This order has already shipped.", paid: "This order is already paid — contact us to change how you'll get it.",
      closed: "This order can no longer be changed online — contact us." }[lock];
    return jsonResponse({ status: "error", message: why }, 409);
  }

  const options = await deliveryOptions_(env.DB, org);
  const offersShipping = options.some(o => o.type === "shipping");
  const items = (order.items || []).filter(it => !it.cancelDate);
  const quoteToken = body.quoteToken ? String(body.quoteToken) : "";
  const wantsQuoteLater = !!body.manualShipping;
  let cost = 0, method = "", address = null, choice = "", label = "";

  if (quoteToken || wantsQuoteLater) {
    if (!offersShipping) return jsonResponse({ status: "error", message: "This shop doesn't offer shipping — please choose another option." }, 400);
    // Same whitelist + state-vs-ZIP check as a storefront order (the state decides the sales tax).
    const { country } = await getLocaleSettings(env.DB);
    const ac = cleanShippingAddress(body.shippingAddress, country);
    if (ac.error) return jsonResponse({ status: "error", message: ac.error }, 400);
    address = ac.address;
    if (!address || !address.line1 || !address.city || !address.zip) return jsonResponse({ status: "error", message: "Enter the full address to ship to." }, 400);
    if (quoteToken) {
      const q = await verifyQuote(env, quoteToken);
      if (!q.ok) return jsonResponse({ status: "error", message: q.reason }, 400);
      if (q.orgId !== order.orgId || q.items !== canonicalItems(items.map(it => ({ productId: it.productId, qty: it.qty })))) {
        return jsonResponse({ status: "error", message: "This order changed since shipping was quoted — please get the shipping rates again." }, 400);
      }
      if (address.zip !== q.zip) return jsonResponse({ status: "error", message: "The ZIP doesn't match the one the rate was quoted for — please get the shipping rates again." }, 400);
      cost = q.amountCents / 100; method = String(q.method || "").slice(0, 100);
      choice = "shipping"; label = `Shipping (${method}) — $${cost.toFixed(2)}`;
    } else {
      // "Cost to follow" is the server's call, as on the storefront (orders.js): only an order no box
      // fits may skip a carrier rate — otherwise asking for it would be a way to ship with no charge.
      let fitsABox = true;
      try {
        const products = await getProductsByOrg(env.DB, order.orgId, false);
        const weightOf = new Map(products.map(p => [String(p.productId), p.weightOz]));
        let presets = null, packAs = null;
        try { presets = await getBoxPresets(env.DB); } catch (_) {}
        try { packAs = await getCategoryPackMap(env.DB); } catch (_) {}
        fitsABox = !!selectBox(items.map(it => ({ type: it.type, qty: Number(it.qty) || 1,
          weightOz: typeof weightOf.get(it.productId) === "number" ? weightOf.get(it.productId) : 0 })), presets, packAs);
      } catch (e) { console.error("Could not check the box for an invoice's cost-to-follow:", e); }
      if (fitsABox) return jsonResponse({ status: "error", message: "Shipping for this order can be quoted now — tap “Show shipping options” and choose a rate." }, 400);
      choice = "shipping-quote"; label = "Shipping — cost to follow";
    }
  } else {
    const wanted = String(body.deliveryOptionId == null ? "" : body.deliveryOptionId);
    const pick = options.filter(o => o.type !== "shipping").find(o => o.id === wanted);
    if (!pick) return jsonResponse({ status: "error", message: wanted ? "That option is no longer offered — please reload the page and choose again." : "Please choose how you'd like to get your order." }, 400);
    if (pick.type === "custom") { cost = Number(pick.fee) || 0; method = pick.label; choice = "option:" + pick.id; label = `${pick.label} — ${cost > 0 ? "$" + cost.toFixed(2) : "Free"}`; }
    else { choice = "pickup"; label = pick.label || "Local pickup"; }
  }

  // Weight from the catalog (used later to buy a label), as order submission does.
  let weightOz = Number(order.totalWeightOz) || 0;
  try {
    const byId = Object.fromEntries((await getProductsByOrg(env.DB, order.orgId, false)).map(p => [p.productId, p]));
    weightOz = items.reduce((sum, it) => { const w = productShipWeightOz(byId[it.productId], it.size); return sum + (w > 0 ? w : 8) * (Number(it.qty) || 1); }, 0);
  } catch (e) {}

  const before = { shippingCost: order.shippingCost, shippingMethod: order.shippingMethod, hasAddress: !!(order.shippingAddress && order.shippingAddress.zip) };
  await updateOrderShipping(env.DB, order.orderId, { shippingAddress: address, totalWeightOz: weightOz, shippingCost: cost, shippingMethod: method,
    parcelLength: order.parcelLength, parcelWidth: order.parcelWidth, parcelHeight: order.parcelHeight });
  await markInvoiceDeliveryChosen(env.DB, token, choice);

  // On the record: who changed the order's delivery (the customer, through their invoice link), from where.
  const where = address ? [address.name, address.line1, address.line2, `${address.city}, ${address.state} ${address.zip}`].filter(Boolean).join(", ") : "";
  const record = Promise.all([
    insertAuditLog(env.DB, { orgId: order.orgId, orderId: order.orderId, action: "order.invoice_delivery_chosen",
      detail: { choice, label, from: before, shipTo: where || undefined }, actor: "customer-invoice", ip: request.headers.get("CF-Connecting-IP") || null }),
    sendInvoiceDeliveryNotification(env, { orderId: order.orderId, orgId: order.orgId, customerName: order.customerName, choice: label, detail: where ? "Ship to: " + where : "" }),
  ]).catch((e) => console.error("Invoice delivery choice saved, but recording it failed:", order.orderId, e));
  if (typeof context.waitUntil === "function") context.waitUntil(record); else await record;

  const fresh = await getOrderById(env.DB, order.orderId);
  const freshInv = await getOrderInvoice(env.DB, token);
  return jsonResponse({ status: "ok", invoice: await invoiceView_(env, freshInv, fresh, org) });
}
