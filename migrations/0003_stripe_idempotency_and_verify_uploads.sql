-- Stripe webhook idempotency + per-token cap on customer verification uploads.
-- Apply BEFORE deploying the code that uses it.

-- External payment reference (Stripe PaymentIntent id, etc). UNIQUE when set,
-- so a webhook retry can never record the same Stripe payment twice.
ALTER TABLE order_payments ADD COLUMN externalRef TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_ref
  ON order_payments(externalRef) WHERE externalRef <> '';

-- Every Stripe event id that has been fully processed.
CREATE TABLE IF NOT EXISTS stripe_events (
  eventId     TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT '',
  orderId     TEXT,
  processedAt TEXT NOT NULL
);

-- Number of images a customer has uploaded against a verification token.
ALTER TABLE design_verifications ADD COLUMN uploadCount INTEGER NOT NULL DEFAULT 0;
