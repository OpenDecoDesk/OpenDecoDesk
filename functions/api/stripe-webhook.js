/**
 * Stripe webhook receiver.
 * ========================================================================
 * File location: functions/api/stripe-webhook.js
 * Route served:  https://yourdomain.com/api/stripe-webhook
 *
 * ---- WHAT THIS DOES ----
 * Stripe calls this endpoint the instant a payment succeeds, is refunded,
 * or is disputed, or a payout is paid. This handler:
 *   1. Verifies the request actually came from Stripe (HMAC signature
 *      check using your webhook signing secret — rejects anything else)
 *   2. Resolves the orderId and orgId from the object's metadata
 *   3. Records the payment / refund / lost dispute / payout in the D1
 *      payments ledger and queues the owner's notice
 *   4. Returns 200 to Stripe ONLY when every attempted update actually
 *      landed. If a write failed, this returns 500 on purpose — Stripe
 *      retries non-2xx responses (with backoff, for up to ~3 days), so a
 *      transient outage self-heals instead of permanently losing the
 *      paid/refunded/disputed status. Safe to retry because every write
 *      is idempotent (see "Idempotency" below).
 *
 * ---- SETUP ----
 * 1. In Stripe: Developers → Workbench → Webhooks → add a destination (a "Webhook endpoint",
 *    payload format Snapshot — the handlers read event.data.object). Step by step:
 *    docs/accounts-and-keys.md.
 *    URL: https://admin.example.com/api/stripe-webhook
 *    Events to listen for:
 *      checkout.session.completed           — payment succeeded
 *      checkout.session.async_payment_succeeded — delayed payment succeeded
 *      checkout.session.async_payment_failed — delayed payment failed
 *      charge.refunded                      — you issued a refund
 *      charge.dispute.created               — chargeback filed ⚠️ time-sensitive
 *      charge.dispute.closed                — bank made final decision (won/lost)
 *      payout.paid                          — Stripe paid out to your bank
 * 2. Copy the "Signing secret" Stripe shows you (whsec_...)
 * 3. Add as a Worker secret (see docs/configuration.md):
 *    STRIPE_WEBHOOK_SECRET  — the whsec_... signing secret from step 2
 *
 * ---- LOCAL TESTING WITH THE STRIPE CLI (before deploying) ----
 *
 * Stripe's CLI lets you forward real test-mode webhook events to your
 * local wrangler dev server, so you can test the full flow end-to-end
 * without deploying anything first.
 *
 * STEP 1 — Install the Stripe CLI (one-time):
 *   brew install stripe/stripe-cli/stripe
 *
 * STEP 2 — Log in to your Stripe account:
 *   stripe login
 *
 * STEP 3 — Start your local dev server in one terminal:
 *   npx wrangler dev
 *   (note the port — usually 8787)
 *
 * STEP 4 — In a second terminal, start the webhook forwarder:
 *   stripe listen --forward-to localhost:8787/api/stripe-webhook
 *
 *   Stripe prints: "Ready! Your webhook signing secret is whsec_test_..."
 *   IMPORTANT: this is a DIFFERENT secret from your Dashboard webhook
 *   secret — the CLI generates its own per-session. Use this whsec_test_
 *   value as STRIPE_WEBHOOK_SECRET in a local .dev.vars file (gitignored):
 *     STRIPE_WEBHOOK_SECRET=whsec_test_...
 *   (The real Dashboard secret is the deployed Worker's secret.)
 *
 * STEP 5 — Place a test order in your browser at localhost:8787,
 *   select "Credit / Debit Card", and use these test card numbers:
 *
 *   SUCCESSFUL PAYMENT:
 *     4242 4242 4242 4242  — any future expiry, any CVC, any zip
 *
 *   DECLINES (to test graceful failure UI):
 *     4000 0000 0000 0002  — generic decline
 *     4000 0000 0000 9995  — insufficient funds
 *     4000 0000 0000 0069  — expired card
 *     4000 0000 0000 0127  — incorrect CVC
 *
 *   3D SECURE (extra authentication step):
 *     4000 0025 0000 3155  — requires 3DS, then succeeds
 *
 *   TRIGGERS A DISPUTE automatically after payment:
 *     4000 0000 0000 0259  — payment succeeds, then a dispute ("fraudulent") is created
 *     4000 0000 0000 2685  — payment succeeds, then a dispute ("product not received") is created
 *
 * STEP 6 — Watch both terminals:
 *   - The stripe listen terminal shows each event as it fires and whether
 *     the handler returned 200 or an error
 *   - The wrangler terminal shows any console.error() output from the
 *     handler itself
 *
 * TESTING REFUNDS:
 *   After a successful test payment, go to Stripe Dashboard (make sure
 *   you're in the sandbox, formerly "test mode") → Payments → find the
 *   charge → click Refund. The charge.refunded webhook fires immediately
 *   and the CLI forwards it to your local server.
 *
 * TESTING DISPUTE OUTCOMES MANUALLY:
 *   Stripe Dashboard (sandbox) → Disputes → find the dispute → submit evidence. In test mode
 *   the text of the evidence decides the outcome: "winning_evidence" closes it as won,
 *   "losing_evidence" as lost (see Stripe's "Testing disputes" page).
 *
 * ---- SECURITY ----
 * Every request is verified against Stripe's HMAC-SHA256 signature
 * before anything happens. An unverified request returns 401 immediately
 * and nothing in the database is touched. The webhook also rejects
 * events older than 5 minutes to prevent replay attacks.
 */

import { jsonResponse } from "../_lib/http.js";
import {
  setOrderRefunded, setOrderDisputeStatus, addShippingPayment, addOrderPayment, reduceShippingPaidForRefund, recordStripePayout,
  getOrderCheckoutState, hasProcessedStripeEvent, recordStripeEvent, recordSystemIssue,
  setCardFeeByRef
} from "../_lib/db.js";
import { sendStripePaymentNotification, sendRefundNotification, sendDisputeNotification } from "../_lib/email.js";

// Stripe's webhook signature verification — pure Web Crypto, no SDK needed.
// Spec: https://stripe.com/docs/webhooks/signatures
async function verifyStripeSignature(rawBody, sigHeader, secret){
  if(!sigHeader) return false;

  // Stripe sends: t=timestamp,v1=signature[,v1=signature...]
  // Multiple v1= entries appear during key rotation — any match is valid.
  const parts = sigHeader.split(",");
  const tPart = parts.find(p => p.startsWith("t="));
  const v1Parts = parts.filter(p => p.startsWith("v1="));
  if(!tPart || v1Parts.length === 0) return false;

  const timestamp = tPart.slice(2);
  const receivedSigs = v1Parts.map(p => p.slice(3));

  // Reject malformed timestamps (parseInt("x") = NaN; NaN > 300 is false,
  // which would accidentally pass the guard below if not caught here).
  const ageSeconds = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  // Within 5 minutes either way (Stripe's own tolerance): too old is a replay,
  // far in the future is forged or a broken clock.
  if(!Number.isFinite(ageSeconds) || Math.abs(ageSeconds) > 300) return false;

  // Signed payload = timestamp + "." + raw request body
  const signedPayload = timestamp + "." + rawBody;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
  const expectedSig = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  // Constant-time comparison against every v1= signature Stripe sent —
  // any match is valid (multiple entries appear during key rotation).
  return receivedSigs.some(sig => {
    if(expectedSig.length !== sig.length) return false;
    let diff = 0;
    for(let i = 0; i < expectedSig.length; i++){
      diff |= expectedSig.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return diff === 0;
  });
}

async function stripeGet(env, path){
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY }
  });
  return res.json();
}

// Stripe's processing fee for a PaymentIntent, in cents (0 if it can't be
// read yet — the admin "backfill Stripe fees" action fills it in later).
async function stripeFeeCents(env, paymentIntentId){
  if(!paymentIntentId || !String(paymentIntentId).startsWith("pi_") || !env.STRIPE_SECRET_KEY) return 0;
  try{
    const pi = await stripeGet(env, "payment_intents/" + encodeURIComponent(paymentIntentId) + "?expand[]=latest_charge.balance_transaction");
    const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
    if(bt && typeof bt.fee === "number") return bt.fee;
    // Say WHY it's 0: an error from Stripe (e.g. a restricted key without read access), or the
    // charge's balance transaction not existing yet. "Backfill Stripe fees" can fill it in later.
    console.error("Stripe fee not available yet for", paymentIntentId, "-",
      (pi && pi.error && pi.error.message) || (pi && pi.latest_charge ? "no balance_transaction on the charge" : "no latest_charge on the PaymentIntent"));
    return 0;
  }catch(err){
    console.error("Could not read Stripe fee for", paymentIntentId, err);
    return 0;
  }
}

// Re-reads the fee a few seconds after the payment was recorded with none, and stores it once Stripe
// has it. Stops at the first success; fails quietly (the daily run retries anything still at 0).
async function fillFeeLater_(env, paymentIntentId){
  for(const waitMs of [3000, 10000]){
    await new Promise(resolve => setTimeout(resolve, waitMs));
    try{
      const fee = await stripeFeeCents(env, paymentIntentId);
      if(fee > 0){ await setCardFeeByRef(env.DB, paymentIntentId, fee); return; }
    }catch(e){ console.error("Fee follow-up failed for", paymentIntentId, e); }
  }
}

// Resolves {orderId, orgId} for any Stripe object this webhook handles.
// Checkout Sessions carry our metadata directly, but the objects that
// refund/dispute events deliver (Charge, Dispute) have their OWN metadata,
// which Stripe does NOT populate from the session. checkout.js therefore
// stamps the identifiers onto the PaymentIntent too
// (payment_intent_data[metadata], copied by Stripe onto the Charge), and for
// anything still missing metadata (a Dispute object, or a Charge whose
// PaymentIntent wasn't stamped) this falls back to fetching the object's
// PaymentIntent and reading the metadata there.
// Returns { orderId, orgId } — both null when the object isn't one of this install's orders — and
// lookupFailed: true when that couldn't be established (Stripe unreachable or refusing). A Dispute
// never carries the order's metadata itself, so for a dispute everything rests on this lookup: the
// caller answers a failed one with 500 so Stripe sends the event again, rather than 200 and lose it.
async function resolveOrderRef(obj, env){
  const meta = (obj && obj.metadata) || {};
  if(meta.orderId && meta.orgId) return { orderId: meta.orderId, orgId: meta.orgId };

  const piId = obj && (typeof obj.payment_intent === "string"
    ? obj.payment_intent
    : (obj.payment_intent && obj.payment_intent.id));
  if(!piId || !env.STRIPE_SECRET_KEY) return { orderId: null, orgId: null };
  try{
    const res = await fetch("https://api.stripe.com/v1/payment_intents/" + encodeURIComponent(piId), {
      headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY }
    });
    const pi = await res.json();
    if(lookupFailed_(res, pi)) return { orderId: null, orgId: null, lookupFailed: true };
    const piMeta = (pi && pi.metadata) || {};
    if(piMeta.orderId && piMeta.orgId) return { orderId: piMeta.orderId, orgId: piMeta.orgId };
    // Last resort: the Checkout Session that created this PaymentIntent
    // (for a session that didn't stamp its PaymentIntent).
    const sres = await fetch("https://api.stripe.com/v1/checkout/sessions?limit=1&payment_intent=" + encodeURIComponent(piId), {
      headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY }
    });
    const sessions = await sres.json();
    if(lookupFailed_(sres, sessions)) return { orderId: null, orgId: null, lookupFailed: true };
    const csMeta = (sessions && Array.isArray(sessions.data) && sessions.data[0] && sessions.data[0].metadata) || {};
    return { orderId: csMeta.orderId || null, orgId: csMeta.orgId || null };
  }catch(err){
    console.error("Could not fetch PaymentIntent " + piId + " to resolve order metadata:", err);
    return { orderId: null, orgId: null, lookupFailed: true };
  }
}

// Stripe answered, but not with the object: a rate limit, an outage, a key that may not read it.
// (An object that simply doesn't exist is an answer — "not one of ours" — not a failure.)
function lookupFailed_(res, body){
  const err = body && body.error;
  if(err) return err.code !== "resource_missing";
  return !!res && res.ok === false;
}


export async function onRequestPost(context){
  const { request, env } = context;

  if(!env.STRIPE_WEBHOOK_SECRET){
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return jsonResponse({status:"error", message:"Webhook not configured."}, 500);
  }

  // Read the raw body BEFORE parsing — signature verification needs
  // the raw bytes exactly as Stripe sent them.
  const rawBody = await request.text();
  const sigHeader = request.headers.get("stripe-signature");

  // Verify signature first — reject invalid requests before touching DB.
  const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if(!valid){
    console.error("Stripe webhook signature verification failed");
    return jsonResponse({status:"error", message:"Invalid signature."}, 401);
  }

  if(!env.DB){
    console.error("DB binding not configured");
    return jsonResponse({status:"error", message:"Server misconfigured."}, 500);
  }

  let event;
  try{ event = JSON.parse(rawBody); }
  catch(e){ return jsonResponse({status:"error", message:"Invalid JSON"}, 400); }

  // ---- Idempotency ----
  // Stripe delivers at-least-once and retries on any non-2xx, so the same
  // event can arrive more than once, and a naive retry would re-run
  // addOrderPayment() and double-count revenue in order_payments. Two
  // layers: (1) a processed-events table short-circuits whole-event
  // replays (no duplicate emails either), and (2) payment rows carry the
  // Stripe object id as a UNIQUE externalRef, so even a crash between the
  // payment insert and recording the event can't insert the payment twice.
  // eventConfirmedNew gates the NON-idempotent notices (the dispute emails below): they're only sent
  // once we've confirmed this delivery isn't a replay. Payment/refund notices are already guarded by
  // their own "row was newly inserted" flags. If the lookup is unavailable (D1 hiccup) we can't
  // confirm, so we skip those notices and return 500 at the end — Stripe retries when D1 is healthy,
  // so each notice fires exactly once (no duplicate, no miss).
  const eventId = typeof event.id === "string" ? event.id : "";
  let eventConfirmedNew = !eventId;        // no id → can't dedup; process normally
  let idempotencyCheckUnavailable = false;
  if(eventId){
    try{
      if(await hasProcessedStripeEvent(env.DB, eventId)){
        return jsonResponse({status:"ok", duplicate:true});
      }
      eventConfirmedNew = true;            // lookup succeeded and this event is new
    }catch(err){
      console.error("stripe_events lookup failed (will retry — payment insert is still idempotent):", err);
      idempotencyCheckUnavailable = true;
    }
  }

  // When the event happened (a resent/retried event keeps its original time),
  // so a payment is dated when it was made, not when it was delivered.
  const eventTime = (typeof event.created === "number" ? new Date(event.created * 1000) : new Date()).toISOString();

  // downstreamFailed = true → return 500 → Stripe retries (idempotent operations).
  let downstreamFailed = false;
  let eventOrderId = null;

  // checkout.session.async_payment_succeeded is the "completed" equivalent
  // for delayed payment methods; handled identically.
  if(event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded"){
    const session = event.data.object;
    const { orderId, orgId } = await resolveOrderRef(session, env);
    eventOrderId = orderId;
    const amountPaid = session.amount_total ? session.amount_total / 100 : null;
    const sessionType = (session.metadata || {}).type;
    // A completed session is NOT necessarily paid (delayed methods complete
    // with payment_status "unpaid" and settle later). Only record money that
    // has actually been received.
    const isPaid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
    const paymentRef = session.payment_intent
      ? (typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id)
      : (session.id || "");
    if(!isPaid){
      console.log("checkout session completed but not yet paid (payment_status=" + session.payment_status + ") for", orderId);
    }else if(orderId && orgId){
      try{
        if(sessionType === "shipping_payment"){
          // Payment row + shippingPaidAmount increment in ONE atomic batch,
          // so a retry can neither double-add nor skip the increment.
          if(amountPaid) await addShippingPayment(env.DB, orderId, amountPaid, "Shipping — Stripe", paymentRef,
            await stripeFeeCents(env, paymentRef), eventTime);
        }else{
          // Compare what Stripe collected with the balance that was due
          // (checkout.js charges the balance — items + shipping − discount −
          // payments already received — not orders.totalCents). The money is
          // recorded either way (it WAS received), but the order is only
          // marked fully paid when the ledger covers what's owed. On a retry
          // the payment is already recorded, the balance is 0, and it matches.
          const due = await getOrderCheckoutState(env.DB, orderId);
          const expected = due ? due.total : null;
          const amountMatches = expected !== null && amountPaid !== null &&
            Math.round(amountPaid * 100) >= Math.round(expected * 100);
          const note = amountMatches ? "Stripe"
            : "Stripe — AMOUNT MISMATCH (balance due " + (expected === null ? "unknown" : "$" + expected.toFixed(2)) + ")";
          // Recording the payment is what marks the order paid: addOrderPayment
          // refreshes orders.paid from the ledger, so a short payment leaves
          // the order unpaid on its own.
          if(!amountMatches) console.error("Stripe amount mismatch for", orderId, "paid", amountPaid, "expected", expected);
          const feeCents = await stripeFeeCents(env, paymentRef);
          const inserted = amountPaid ? await addOrderPayment(env.DB, orderId, amountPaid, note, paymentRef, { method: "card", feeCents, receivedAt: eventTime }) : 0;
          // Only notify on the first delivery of this payment.
          if(inserted) await sendStripePaymentNotification(env, orderId, orgId, amountPaid);
          // Stripe often hasn't created the fee record yet when this fires; look again shortly, after
          // the response has gone out. (The daily scheduled run is the safety net if this misses.)
          if(inserted && feeCents === 0 && typeof context.waitUntil === "function"){
            context.waitUntil(fillFeeLater_(env, paymentRef));
          }
        }
      }catch(err){
        console.error("markPaid D1 error for", orderId, err);
        downstreamFailed = true;
      }
    }
  }

  if(event.type === "charge.refunded"){
    const charge = event.data.object;
    const ref = await resolveOrderRef(charge, env);
    const { orderId, orgId } = ref;
    eventOrderId = orderId;
    const amountRefunded = charge.amount_refunded ? charge.amount_refunded / 100 : null;
    if(orderId && orgId){
      try{
        // One NEGATIVE ledger row per Stripe refund, keyed by the refund id
        // (re_…) so replays and later partial refunds are each counted once.
        // A charge can carry several refunds; list them rather than trust the
        // event payload (newer API versions don't embed charge.refunds).
        const list = await stripeGet(env, "refunds?limit=100&charge=" + encodeURIComponent(charge.id));
        if(!list || !Array.isArray(list.data)) throw new Error("Could not list refunds for " + charge.id);
        let newRefund = false;
        for(const re of list.data){
          if(re.status === "failed" || re.status === "canceled") continue;
          const id = await addOrderPayment(env.DB, orderId, -(re.amount / 100), "Stripe refund", re.id, {
            method: "card", kind: "refund", receivedAt: new Date(re.created * 1000).toISOString(),
          });
          if(id){
            newRefund = true;
            const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent && charge.payment_intent.id);
            await reduceShippingPaidForRefund(env.DB, orderId, piId, re.amount);
          }
        }
        await setOrderRefunded(env.DB, orderId, new Date().toISOString());
        if(newRefund) await sendRefundNotification(env, orderId, orgId, amountRefunded);
      }catch(err){
        console.error("markRefunded D1 error for", orderId, err);
        downstreamFailed = true;
      }
    }else{
      console.error("charge.refunded: could not resolve orderId/orgId for charge " + (charge.id || "?"));
      if(ref.lookupFailed) downstreamFailed = true;
    }
  }

  if(event.type === "charge.dispute.created"){
    const dispute = event.data.object;
    const ref = await resolveOrderRef(dispute, env);
    const { orderId, orgId } = ref;
    eventOrderId = orderId;
    const amountDisputed = dispute.amount ? dispute.amount / 100 : null;
    if(orderId && orgId){
      try{
        await setOrderDisputeStatus(env.DB, orderId, "warning_needs_response");
        if(eventConfirmedNew) await sendDisputeNotification(env, orderId, orgId, "warning_needs_response", dispute.reason || "", amountDisputed);
      }catch(err){
        console.error("markDispute D1 error for", orderId, err);
        downstreamFailed = true;
      }
    }else{
      console.error("charge.dispute.created: could not resolve orderId/orgId for dispute " + (dispute.id || "?"));
      if(ref.lookupFailed) downstreamFailed = true;
    }
  }

  if(event.type === "charge.dispute.closed"){
    const dispute = event.data.object;
    const ref = await resolveOrderRef(dispute, env);
    const { orderId, orgId } = ref;
    eventOrderId = orderId;
    const amountDisputed = dispute.amount ? dispute.amount / 100 : null;
    const status = dispute.status || "closed";
    if(orderId && orgId){
      try{
        // A LOST dispute is money permanently taken back (plus Stripe's
        // dispute fee): record it as a negative ledger row, keyed by dispute id.
        if(status === "lost" && dispute.amount){
          const feeCents = (dispute.balance_transactions || []).reduce((s, bt) => s + (Number(bt.fee) || 0), 0);
          await addOrderPayment(env.DB, orderId, -(dispute.amount / 100),
            "Stripe dispute lost" + (dispute.reason ? " (" + dispute.reason + ")" : ""), dispute.id,
            { method: "card", kind: "dispute", feeCents, receivedAt: eventTime });
        }
        await setOrderDisputeStatus(env.DB, orderId, status);
        if(eventConfirmedNew) await sendDisputeNotification(env, orderId, orgId, status, dispute.reason || "", amountDisputed);
      }catch(err){
        console.error("markDispute(closed) D1 error for", orderId, err);
        downstreamFailed = true;
      }
    }else{
      console.error("charge.dispute.closed: could not resolve orderId/orgId for dispute " + (dispute.id || "?"));
      if(ref.lookupFailed) downstreamFailed = true;
    }
  }

  // Stripe paid out to the bank: record it as a transfer Stripe balance →
  // payout account (Accounts & money), idempotent on the payout id.
  if(event.type === "payout.paid"){
    const po = event.data.object || {};
    try{
      await recordStripePayout(env.DB, { payoutId: po.id, amountCents: Number(po.amount) || 0,
        arrivalDate: new Date((po.arrival_date || event.created || Date.now() / 1000) * 1000).toISOString().slice(0, 10) });
    }catch(err){
      console.error("payout.paid D1 error for", po.id, err);
      downstreamFailed = true;
    }
  }

  if(event.type === "checkout.session.async_payment_failed"){
    const session = event.data.object;
    console.log("Async payment failed for order:", session.metadata && session.metadata.orderId);
  }

  if(downstreamFailed){
    // Reported in the next 6 AM roll-up, not just the Cloudflare log.
    await recordSystemIssue(env.DB, "webhook_failed", (event.type || "event") + " " + (eventId || "") + (eventOrderId ? " (order " + eventOrderId + ")" : ""));
    return jsonResponse({status:"error", message:"Downstream update failed — Stripe will retry."}, 500);
  }
  if(idempotencyCheckUnavailable){
    // Couldn't confirm this isn't a replay, so the dispute notices were skipped above. Don't record
    // or ack — let Stripe redeliver when D1 is healthy, so each notice fires exactly once.
    return jsonResponse({status:"error", message:"Idempotency check unavailable — Stripe will retry."}, 500);
  }
  if(eventId){
    try{ await recordStripeEvent(env.DB, eventId, event.type || "", eventOrderId); }
    catch(err){ console.error("Could not record stripe event", eventId, err); }
  }
  return jsonResponse({status:"ok"});
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
