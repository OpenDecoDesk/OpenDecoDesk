-- A Venmo payment can be cashed out in PARTS (an order paid 50% down / 50% at
-- the end reaches the bank in two cash-outs).
-- ===========================================================================
-- payment_cashouts: how much of a payment each Venmo -> bank transfer covers
-- (gross payment cents). A payment stays available for the next cash-out until
-- its allocations add up to its amount; allocations to a deleted transfer don't
-- count. Replaces the one-to-one order_payments.cashoutTransferId from 0017,
-- which is backfilled here and no longer written or read (SQLite can't cheaply
-- drop it; leave it).
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS payment_cashouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paymentId   INTEGER NOT NULL REFERENCES order_payments(id) ON DELETE CASCADE,
  transferId  INTEGER NOT NULL REFERENCES account_transfers(id),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_cashouts_payment  ON payment_cashouts(paymentId);
CREATE INDEX IF NOT EXISTS idx_payment_cashouts_transfer ON payment_cashouts(transferId);

INSERT INTO payment_cashouts (paymentId, transferId, amountCents, createdAt)
  SELECT id, cashoutTransferId, amountCents, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM order_payments WHERE cashoutTransferId IS NOT NULL AND amountCents > 0;
