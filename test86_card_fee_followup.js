const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim");

// Stripe often hasn't created a charge's balance transaction (the fee) yet when the webhook fires, so a
// card payment is recorded with fee 0. functions/_lib/stripeFees.js fills it in later, and only while
// it is still 0, only for recent card payments recorded from a PaymentIntent.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");

(async () => {
  const lib = await import("./functions/_lib/stripeFees.js");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const now = new Date().toISOString(), old = new Date(Date.now() - 40 * 86400000).toISOString();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('prime','prime','PRIME',1,'t','t');`);
  const order = (id) => d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt) VALUES ('${id}','prime','C','c@x.com',1000,1000,'${now}')`);
  ["O1", "O2", "O3", "O4", "O5", "O6"].forEach(order);
  const pay = (order, ref, fee, extra = {}) => d1._raw.exec(
    `INSERT INTO order_payments (orderId, amountCents, method, kind, feeCents, externalRef, note, receivedAt${extra.voided ? ", voidedAt" : ""})
     VALUES ('${order}', 1000, '${extra.method || "card"}', 'payment', ${fee}, '${ref}', '${extra.note || "Stripe"}', '${extra.at || now}'${extra.voided ? ", '" + now + "'" : ""})`);
  pay("O1", "pi_ready", 0);                      // needs a fee, Stripe has it
  pay("O2", "pi_notyet", 0);                     // needs a fee, Stripe doesn't have it yet
  pay("O3", "pi_hasfee", 250);                   // already has one — must not change
  pay("O4", "pi_old", 0, { at: old });           // too old for the daily net (the admin Backfill handles those)
  pay("O5", "pi_local", 0, { note: "Local sale (Card)" }); // in-person sale: no Checkout Session
  pay("O6", "pi_venmo", 0, { method: "venmo" }); // not a card

  const stripe = { pi_ready: { latest_charge: { balance_transaction: { fee: 342 } } }, pi_notyet: { latest_charge: { balance_transaction: null } } };
  const calls = [];
  global.fetch = async (url, init) => {
    const m = String(url).match(/payment_intents\/([^?]+)/); calls.push(m && m[1]);
    return { json: async () => stripe[m && m[1]] || { error: { message: "No such payment_intent" } } };
  };
  const fee = async (ref) => d1.q("SELECT feeCents f FROM order_payments WHERE externalRef=?", ref)[0].f;
  const env = { DB: d1, STRIPE_SECRET_KEY: "sk_test" };

  console.log("=== the daily safety net ===");
  let r = await lib.fillMissingCardFees(env);
  console.log("fills the payment Stripe now has a fee for:", await fee("pi_ready") === 342 && r.filled === 1);
  console.log("leaves one Stripe can't give yet at 0 (retried tomorrow):", await fee("pi_notyet") === 0);
  console.log("never changes a payment that already has a fee:", await fee("pi_hasfee") === 250 && !calls.includes("pi_hasfee"));
  console.log("ignores payments older than 14 days, in-person sales and non-card payments:", !calls.includes("pi_old") && !calls.includes("pi_local") && !calls.includes("pi_venmo"));
  console.log("only asked Stripe about the two candidates:", calls.length === 2);
  stripe.pi_notyet = { latest_charge: { balance_transaction: { fee: 99 } } };
  r = await lib.fillMissingCardFees(env);
  console.log("a later run picks it up once Stripe has it:", await fee("pi_notyet") === 99 && r.filled === 1);
  calls.length = 0; r = await lib.fillMissingCardFees(env);
  console.log("idempotent: a run with nothing missing asks Stripe nothing:", r.checked === 0 && calls.length === 0);
  console.log("does nothing without a Stripe key or database:", (await lib.fillMissingCardFees({ DB: d1 })).checked === 0 && (await lib.fillMissingCardFees({})).checked === 0);

  console.log("\n=== reading a fee ===");
  console.log("null for a non-PaymentIntent id:", (await lib.readStripeFeeCents(env, "cs_123")) === null);
  console.log("null on a Stripe error:", (await lib.readStripeFeeCents(env, "pi_unknown")) === null);
  global.fetch = async () => { throw new Error("network"); };
  console.log("null (not a crash) on a network failure:", (await lib.readStripeFeeCents(env, "pi_ready")) === null);

  console.log("\n=== wiring ===");
  const hook = read("functions/api/stripe-webhook.js"), w = read("src/worker.js");
  console.log("the webhook retries the fee after responding (waitUntil):", /context\.waitUntil\(fillFeeLater_\(env, paymentRef\)\)/.test(hook) && /setCardFeeByRef\(env\.DB, paymentIntentId, fee\)/.test(hook));
  console.log("it only retries when the first read gave 0:", /inserted && feeCents === 0/.test(hook));
  // (The cloud path's roll-up is the last call in handleScheduled; the desktop program's, earlier, has no Stripe.)
  console.log("the scheduled run fills missing fees before the roll-up:", w.indexOf("fillMissingCardFees(env)") > 0 && w.indexOf("fillMissingCardFees(env)") < w.lastIndexOf("runDailyDigest(env"));
})().catch((e) => { console.log("test86 crashed:", false); console.error(e); process.exit(1); });
