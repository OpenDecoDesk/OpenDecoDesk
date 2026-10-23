-- A mistaken inventory_movements row (a duplicate receive, a fat-fingered cost/date) can
-- now be VOIDED instead of living in history forever with no way to fix it — same pattern
-- as voiding an order or a payment (nothing financial is hard-deleted). A voided row stays
-- visible (struck through) but is excluded from stock, average cost and every COGS/
-- valuation report; blank_sizes for that blank+size is recomputed from the remaining
-- history so quantity and average cost are exactly what they'd have been without it.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

ALTER TABLE inventory_movements ADD COLUMN voidedAt   TEXT;
ALTER TABLE inventory_movements ADD COLUMN voidReason TEXT NOT NULL DEFAULT '';
