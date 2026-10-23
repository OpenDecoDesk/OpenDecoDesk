/**
 * Creates a Stripe Checkout Session.
 * ========================================================================
 * File location: functions/api/checkout.js
 * Route served:  https://yourdomain.com/api/checkout
 *
 * ---- WHAT THIS DOES ----
 * When a customer selects "Credit / Debit Card" and places an order,
 * the client POSTs {orderId, orgId} here (NOT a total, name or email — see
 * below). This Function creates a Stripe Checkout Session (server-side, so
 * your secret key never touches the browser) and returns the hosted
 * checkout URL. The client then redirects the customer to that URL where
 * Stripe handles the actual card input and PCI compliance entirely.
 *
 * After payment Stripe fires a webhook to /api/stripe-webhook, which
 * records the card payment in the D1 payments ledger (marking the order
 * paid once the ledger covers what's owed).
 *
 * ---- WHERE THE CHARGE AMOUNT COMES FROM ----
 * Never from the request body. getOrderCheckoutState reads the order from
 * D1 and returns the BALANCE still due (active items + shipping − discount
 * − payments already received), and that is exactly what's charged — so a
 * part-paid order (e.g. 50% by Venmo) is charged only the rest. Voided and
 * already-paid orders are refused (409). The customer name/email sent to
 * Stripe also come from the order row. Trusting a client-supplied total
 * here would let anyone pay far less than an order cost while it still got
 * marked "Paid". The order (real, or the admin's
 * "Create test transaction") must already be written before calling this.
 *
 * ---- SETUP ----
 * Add as a Worker secret (see docs/configuration.md):
 *   STRIPE_SECRET_KEY  — Stripe Dashboard → Developers → API keys
 *                        Use sk_test_... while testing, sk_live_... for real
 *
 * ---- STRIPE DASHBOARD SETUP ----
 * No Products or Prices needed — this builds a one-time line item on
 * the fly from the server-verified total, so you never have to
 * maintain a product catalog in two places.
 */

import { classifyHost } from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { jsonResponse, verifyOrderToken } from "../_lib/http.js";
import { getOrderCheckoutState, getOrderInvoice, invoiceExpired } from "../_lib/db.js";

export async function onRequestPost(context){
  const { request, env } = context;

  if(!env.STRIPE_SECRET_KEY){
    return jsonResponse({status:"error", message:"Stripe not configured."}, 500);
  }
  if(!env.DB){
    return jsonResponse({status:"error", message:"Server misconfigured — DB binding not set."}, 500);
  }

  // Own bucket, separate from orders.js's admin_auth/order_submit — a
  // burst of checkout attempts (each triggering a database lookup + a
  // Stripe API call) shouldn't share budget with either.
  const rl = await rateLimited(env, "checkout", request, 20);
  if(rl.blocked) return rateLimitResponse(rl.retryAfter);

  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({status:"error", message:"Invalid JSON"}, 400); }

  const { orderId, orgId } = body;
  if(!orderId || !orgId){
    return jsonResponse({status:"error", message:"Invalid order data"}, 400);
  }

  // Enforce subdomain/org consistency — same guard as orders.js
  let catalogData;
  try{
    catalogData = await getCatalogData(env);
  }catch(err){
    return jsonResponse({status:"error", message:"Server misconfigured — catalog data unavailable."}, 500);
  }
  const host = classifyHost(new URL(request.url).hostname, catalogData.subdomainMap, env);
  if(host.kind === "locked" && host.orgId !== orgId){
    return jsonResponse({status:"error", message:"Org mismatch"}, 403);
  }
  if(host.kind === "unknown"){
    return jsonResponse({status:"error", message:"Unrecognized host"}, 404);
  }
  // Who is asking? Stripe's payment page shows the customer's name and email, so an order number on
  // its own must not open one. Accepted: the token the order endpoint gave whoever placed this order
  // (`checkoutToken`), or the order's own, unexpired invoice link (the emailed /?invoice=<token>).
  const invoiceToken = /^[a-z0-9]{16,64}$/.test(String(body.invoiceToken || "")) ? String(body.invoiceToken) : "";
  let viaInvoice = false;
  if(invoiceToken){
    const inv = await getOrderInvoice(env.DB, invoiceToken).catch(() => null);
    viaInvoice = !!(inv && inv.orderId === String(orderId) && !invoiceExpired(inv));
  }
  const viaOrder = !viaInvoice && await verifyOrderToken(env, String(orderId), body.checkoutToken);
  // Storefront switched off (Global settings → Features): this endpoint is the storefront's own
  // "pay by card" step right after an order is placed, so it is closed with it. Payment links the
  // admin emails a customer are Stripe links made in orders.js and don't come through here — and an
  // invoice the shop sent (functions/api/invoice.js) still opens the card checkout for its order.
  if((catalogData.features || {}).storefront === false && host.kind !== "admin" && !viaInvoice){
    return jsonResponse({status:"error", feature:"storefront", message:"Online ordering isn't available here."}, 403);
  }
  if(!viaInvoice && !viaOrder){
    return jsonResponse({status:"error", message:"This payment link is no longer valid. Please place the order again, or use the link in your email."}, 403);
  }

  // Look up the REAL total from D1 — never trust a client-supplied amount.
  // Both real orders and the admin "Create test transaction" button write
  // the order row BEFORE calling this endpoint, so this lookup covers both.
  const state = await getOrderCheckoutState(env.DB, String(orderId));
  // A voided order can't be paid (it would have to be refunded straight back).
  if(state && state.voided){
    return jsonResponse({status:"error", message:"This order was cancelled."}, 409);
  }
  if(state && state.paid){
    return jsonResponse({status:"error", message:"This order is already paid."}, 409);
  }
  // A cart no box fits is placed with its shipping still to be quoted (orders.js). Paying it by card
  // now would charge the items alone and leave the order reading Paid with the postage still owed,
  // so it waits until the shop has set the shipping.
  if(state && state.shippingPending){
    return jsonResponse({status:"error", message:"Shipping for this order hasn't been quoted yet — we'll email you the total and how to pay."}, 409);
  }
  // state.total is the balance still DUE (after discounts and any Venmo/Zelle/check payments),
  // so a part-paid order is charged only what's left.
  if(!state || !(state.total > 0)){
    console.error("Could not verify order total for Stripe checkout — orderId:", orderId);
    return jsonResponse({status:"error", message:"Could not verify order total."}, 400);
  }
  // (Already-paid orders were refused above, so a reload, a back-button or a replayed request
  // can't charge twice.)
  // The order's own org is authoritative — not the one in the request body —
  // so Stripe metadata (and therefore webhook bookkeeping) can't be mislabeled.
  if(host.kind === "locked" && host.orgId !== state.orgId){
    return jsonResponse({status:"error", message:"Org mismatch"}, 403);
  }
  const total = state.total;
  const orderOrgId = state.orgId;
  // Name/email come from the order row, not the request — Stripe metadata and the receipt email
  // can't be relabeled by whoever calls this endpoint.
  const orderName = state.customerName || "";
  const orderContact = state.contact || "";

  // Return URLs — Stripe sends the customer back here after payment/cancel
  const origin = new URL(request.url).origin;
  // Paying from an invoice page (/?invoice=<token>, functions/api/invoice.js) returns the customer
  // to that page (its token was checked against this order above).
  const successUrl = viaInvoice ? origin + "/?invoice=" + invoiceToken + "&paid=1"
    : origin + "/?stripe=success&orderId=" + encodeURIComponent(orderId) + "&org=" + encodeURIComponent(orderOrgId);
  const cancelUrl  = viaInvoice ? origin + "/?invoice=" + invoiceToken
    : origin + "/?stripe=cancel&orderId=" + encodeURIComponent(orderId) + "&org=" + encodeURIComponent(orderOrgId);

  // Stripe uses integer minor units (cents)
  const amountCents = Math.round(total * 100);

  const params = {
    "payment_method_types[]": "card",
    "mode": "payment",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": "Order — " + orderOrgId,
    // One line for the whole balance; when sales tax was added on top of the prices, say how much of it is tax.
    "line_items[0][price_data][product_data][description]": "Order " + orderId + (orderName ? " for " + orderName : "")
      + (state.taxAdded > 0 ? " — includes $" + Number(state.taxAdded).toFixed(2) + " sales tax" : ""),
    "line_items[0][quantity]": "1",
    // Metadata is echoed back in the webhook so it can find the right
    // order to update without a separate lookup.
    "metadata[orderId]": orderId,
    "metadata[orgId]": orderOrgId,
    "metadata[customerName]": orderName,
    "metadata[contact]": orderContact,
    // Session metadata above only comes back on checkout.session.* events.
    // Refunds and disputes reference the Charge/PaymentIntent instead, whose
    // metadata Stripe does NOT populate from the session — so also stamp the
    // order identifiers onto the PaymentIntent (Stripe copies PaymentIntent
    // metadata onto the Charge it creates). Without this, charge.refunded /
    // charge.dispute.* events arrive with empty metadata and the webhook
    // can never map them back to an order row.
    "payment_intent_data[metadata][orderId]": orderId,
    "payment_intent_data[metadata][orgId]": orderOrgId,
    "success_url": successUrl,
    "cancel_url": cancelUrl
  };
  // Only include customer_email when there's an actual valid one — Stripe
  // rejects an explicitly-blank value with "Invalid email address" (it
  // treats an empty string as "supplied but invalid," not "omitted").
  // The admin's test-transaction flow has a blank contact, and an older
  // order may carry a phone number instead of an email.
  if(orderContact && orderContact.includes("@")){
    params["customer_email"] = orderContact;
  }

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params).toString()
  });

  const session = await stripeRes.json();
  if(!session.url){
    // Stripe's error responses look like {error: {message, type, code}} —
    // surface that real message instead of a generic "something went wrong,"
    // so a bad/expired key, wrong mode, or account issue is visible without
    // digging through the Worker's logs. Stripe designs .error.message to be
    // developer/API-caller-facing (it even redacts key material itself, as
    // in "Invalid API Key provided: sk_live_***"), so it's safe to return
    // as-is — to a real customer's browser AND to the admin's own "Create
    // test transaction" diagnostic. The ONLY thing that's NOT safe to echo
    // back is the raw session object when Stripe's response has no
    // .error.message at all — that's an unbounded internal object dump, not
    // a crafted user-facing string. Full detail (including the raw session)
    // always still reaches the Worker's log.
    const stripeErrorDetail = (session.error && session.error.message) ? session.error.message : "Unknown Stripe error (see server logs).";
    console.error("Stripe session creation failed:", session.error ? session.error.message : JSON.stringify(session));
    return jsonResponse({status:"error", message:"Could not create payment session: " + stripeErrorDetail}, 500);
  }

  return jsonResponse({status:"ok", url: session.url});
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
