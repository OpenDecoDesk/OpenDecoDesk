-- Reporting integrity.
-- ===========================================================================
-- * Orders are VOIDED, never deleted: they stay on record (with who/why in
--   the audit log) and drop out of every sales / tax / revenue report.
-- * Payment entries made by mistake are VOIDED, not deleted: excluded from
--   every total, still visible in the order's history.
-- * Test orders are flagged explicitly (isTest), not recognised by a TEST-
--   prefix in each query.
-- * closed_periods: a month that has been filed is locked — changes that
--   would alter its numbers are refused until it's reopened (audited).
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

ALTER TABLE orders ADD COLUMN voidedAt   TEXT;
ALTER TABLE orders ADD COLUMN voidReason TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN isTest     INTEGER NOT NULL DEFAULT 0 CHECK (isTest IN (0, 1));
UPDATE orders SET isTest = 1 WHERE orderId LIKE 'TEST-%';

ALTER TABLE order_payments ADD COLUMN voidedAt   TEXT;
ALTER TABLE order_payments ADD COLUMN voidReason TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS closed_periods (
  month    TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  closedAt TEXT NOT NULL,
  closedBy TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_orders_reportable ON orders(isTest, voidedAt, placedAt);
