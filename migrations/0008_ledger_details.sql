-- Complete payments ledger.
-- ===========================================================================
-- Every order_payments row says HOW the money moved (method + reference,
-- e.g. a check number or Venmo transaction id), WHAT kind of movement it is
-- (a payment, a refund, a lost dispute), and what the processor kept (fee).
-- Refunds and lost disputes are NEGATIVE rows (amountCents < 0), so the sum
-- of the ledger is net cash actually kept. Shipping labels bought through
-- Shippo are recorded as an expense in shipping_labels.
--
-- ADDITIVE ONLY: apply before deploying the code that writes these columns.
-- ===========================================================================

ALTER TABLE order_payments ADD COLUMN method TEXT NOT NULL DEFAULT 'other'
  CHECK (method IN ('card', 'venmo', 'zelle', 'check', 'cash', 'other'));
ALTER TABLE order_payments ADD COLUMN reference TEXT NOT NULL DEFAULT '';
ALTER TABLE order_payments ADD COLUMN feeCents INTEGER NOT NULL DEFAULT 0 CHECK (feeCents >= 0);
ALTER TABLE order_payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'payment'
  CHECK (kind IN ('payment', 'refund', 'dispute'));

-- Backfill method: from the payment's note when it names one, otherwise the
-- order's chosen payment method.
UPDATE order_payments SET method = CASE
    WHEN lower(note) LIKE '%stripe%' OR lower(note) LIKE '%card%' THEN 'card'
    WHEN lower(note) LIKE '%venmo%' THEN 'venmo'
    WHEN lower(note) LIKE '%zelle%' THEN 'zelle'
    WHEN lower(note) LIKE '%check%' THEN 'check'
    WHEN lower(note) LIKE '%cash%'  THEN 'cash'
    ELSE COALESCE((SELECT CASE lower(o.paymentMethod)
                            WHEN 'card' THEN 'card' WHEN 'venmo' THEN 'venmo' WHEN 'zelle' THEN 'zelle'
                            WHEN 'check' THEN 'check' WHEN 'cash' THEN 'cash' ELSE 'other' END
                   FROM orders o WHERE o.orderId = order_payments.orderId), 'other')
  END;

CREATE INDEX IF NOT EXISTS idx_payments_kind_received ON order_payments(kind, receivedAt);

-- Postage bought through Shippo: an expense to set against shipping income.
CREATE TABLE IF NOT EXISTS shipping_labels (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId             TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  shippoTransactionId TEXT NOT NULL UNIQUE,
  carrier             TEXT NOT NULL DEFAULT '',
  service             TEXT NOT NULL DEFAULT '',
  amountCents         INTEGER NOT NULL CHECK (amountCents >= 0),
  trackingNumber      TEXT NOT NULL DEFAULT '',
  labelUrl            TEXT NOT NULL DEFAULT '',
  purchasedAt         TEXT NOT NULL,
  voidedAt            TEXT
);
CREATE INDEX IF NOT EXISTS idx_labels_order     ON shipping_labels(orderId);
CREATE INDEX IF NOT EXISTS idx_labels_purchased ON shipping_labels(purchasedAt);
