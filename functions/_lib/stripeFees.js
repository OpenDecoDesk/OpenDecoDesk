/**
 * Fills in Stripe's processing fee on card payments that were recorded without one.
 *
 * Why it's needed: the webhook records a card payment the moment Stripe reports it, but Stripe often
 * hasn't created the charge's balance transaction (which carries the fee) yet, so the fee reads as 0.
 * The webhook retries a few seconds later in the background; this is the safety net the daily
 * scheduled run uses for anything still at 0 (a retry that failed, a Stripe hiccup). Safe to repeat:
 * it only touches payments whose fee is still 0, and only for recent ones.
 */

import { getRecentCardPaymentsMissingFee, setCardFeeByRef } from "./db.js";

// Fee in cents, or null when Stripe can't give it yet (no key, an error, or no balance transaction).
export async function readStripeFeeCents(env, paymentIntentId) {
  if (!env.STRIPE_SECRET_KEY || !String(paymentIntentId || "").startsWith("pi_")) return null;
  try {
    const res = await fetch("https://api.stripe.com/v1/payment_intents/" + encodeURIComponent(paymentIntentId) +
      "?expand[]=latest_charge.balance_transaction", { headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
    const pi = await res.json();
    const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
    return bt && typeof bt.fee === "number" ? bt.fee : null;
  } catch (e) {
    console.error("Could not read Stripe fee for", paymentIntentId, e);
    return null;
  }
}

export async function fillMissingCardFees(env, { days = 14, limit = 20 } = {}) {
  if (!env || !env.DB || !env.STRIPE_SECRET_KEY) return { checked: 0, filled: 0 };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const missing = await getRecentCardPaymentsMissingFee(env.DB, since, limit);
  let filled = 0;
  for (const p of missing) {
    const fee = await readStripeFeeCents(env, p.externalRef);
    if (fee && fee > 0) filled += await setCardFeeByRef(env.DB, p.externalRef, fee);
  }
  return { checked: missing.length, filled };
}
