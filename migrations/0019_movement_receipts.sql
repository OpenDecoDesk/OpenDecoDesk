-- A vendor order's receipt/invoice (PDF or image) can be attached to the
-- purchase movements it created, so it can be pulled back up at tax time —
-- same private-storage model as expenses.receiptKey (migrations/0012), just
-- reused for inventory. Populated only on kind='purchase' rows (imported from
-- a PDF via Blanks -> Import from PDF, or attached by hand on Receive order /
-- Reconcile -> Create... -> Blank purchase); every other kind stays blank.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

ALTER TABLE inventory_movements ADD COLUMN receiptKey  TEXT NOT NULL DEFAULT '';
ALTER TABLE inventory_movements ADD COLUMN receiptName TEXT NOT NULL DEFAULT '';
