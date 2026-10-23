-- Sales tax (tax-inclusive, backed out per line item).
-- ===========================================================================
-- Prices are tax-INCLUSIVE: a $16.00 line is $15.09 of product + $0.91 of 6%
-- sales tax. Tax is backed out once per LINE (3 x $16 = $48 line ->
-- $45.28 + $2.72), never per unit. The customer-facing totals never change;
-- this only records how much of each sale was tax.
--
--   net = round(gross * 10000 / (10000 + rateBps)),  tax = gross - net
--
-- The same formula lives in functions/_lib/db.js (splitTaxInclusive); test34
-- checks the SQL backfill and the JS helper agree on every line.
--
-- ADDITIVE ONLY (new columns + a settings row + backfill), so code already
-- deployed keeps working: apply this BEFORE deploying the code that uses it.
-- ===========================================================================

-- Per line: the rate in effect when the order was placed (basis points, 600 =
-- 6%), and the tax backed out of that line's total.
ALTER TABLE order_items ADD COLUMN taxRateBps INTEGER NOT NULL DEFAULT 0 CHECK (taxRateBps BETWEEN 0 AND 1500);
ALTER TABLE order_items ADD COLUMN taxCents   INTEGER NOT NULL DEFAULT 0 CHECK (taxCents >= 0);

-- Per order: whether it was tax-exempt at the time (snapshot of the org's
-- status), the rate used, and the tax portion of any order-level discount
-- (a discount on a tax-inclusive price reduces tax collected too).
ALTER TABLE orders ADD COLUMN taxExempt        INTEGER NOT NULL DEFAULT 0 CHECK (taxExempt IN (0, 1));
ALTER TABLE orders ADD COLUMN taxRateBps       INTEGER NOT NULL DEFAULT 0 CHECK (taxRateBps BETWEEN 0 AND 1500);
ALTER TABLE orders ADD COLUMN discountTaxCents INTEGER NOT NULL DEFAULT 0 CHECK (discountTaxCents >= 0);

-- Per org: tax-exempt purchaser (e.g. a government/nonprofit buyer with a
-- state exemption certificate). Default: taxable.
ALTER TABLE orgs ADD COLUMN taxExempt            INTEGER NOT NULL DEFAULT 0 CHECK (taxExempt IN (0, 1));
ALTER TABLE orgs ADD COLUMN taxExemptCertificate TEXT NOT NULL DEFAULT '';
ALTER TABLE orgs ADD COLUMN taxExemptExpires     TEXT;

-- Store-wide setting (editable in the admin panel).
INSERT OR IGNORE INTO global_settings (key, value)
VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":""}');

-- ---- Backfill every existing order at 6% --------------------------------
-- No org is exempt yet, so every existing order is taxable.
UPDATE orders SET taxRateBps = 600;
UPDATE order_items SET
  taxRateBps = 600,
  taxCents   = lineTotalCents - CAST(round(lineTotalCents * 10000.0 / 10600) AS INTEGER);
UPDATE orders SET
  discountTaxCents = discountCents - CAST(round(discountCents * 10000.0 / 10600) AS INTEGER)
WHERE discountCents > 0;

-- Reports group by month; payments by receivedAt already has an index (0006).
CREATE INDEX IF NOT EXISTS idx_orders_tax_exempt ON orders(taxExempt);
