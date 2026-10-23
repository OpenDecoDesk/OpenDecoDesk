-- Receipts on every money record, and a link between the records one receipt wrote. Additive only.
--
-- 1. receiptKey / receiptName on every record that moves money in an account, so the Account viewer can
--    show or add a receipt on any row. (expenses, inventory_movements and transfer_movements already have
--    them.) Same shape as those: the private RECEIPTS bucket key + the file's name, '' when none.
ALTER TABLE order_payments     ADD COLUMN receiptKey  TEXT NOT NULL DEFAULT '';
ALTER TABLE order_payments     ADD COLUMN receiptName TEXT NOT NULL DEFAULT '';
ALTER TABLE other_income       ADD COLUMN receiptKey  TEXT NOT NULL DEFAULT '';
ALTER TABLE other_income       ADD COLUMN receiptName TEXT NOT NULL DEFAULT '';
ALTER TABLE owner_transactions ADD COLUMN receiptKey  TEXT NOT NULL DEFAULT '';
ALTER TABLE owner_transactions ADD COLUMN receiptName TEXT NOT NULL DEFAULT '';
ALTER TABLE account_transfers  ADD COLUMN receiptKey  TEXT NOT NULL DEFAULT '';
ALTER TABLE account_transfers  ADD COLUMN receiptName TEXT NOT NULL DEFAULT '';
ALTER TABLE shipping_labels    ADD COLUMN receiptKey  TEXT NOT NULL DEFAULT '';
ALTER TABLE shipping_labels    ADD COLUMN receiptName TEXT NOT NULL DEFAULT '';

-- 2. receiptGroup: one random id stamped on everything ONE receive wrote — the stock rows for every blank
--    (or transfer sheet) on it, its R&D / written-off expense and its personal-use owner draw — so the
--    paying account (or the receipt file) can be corrected for the whole receipt at once. NULL on records
--    made before this; those are found by matching date, vendor, invoice, payer and receipt instead.
ALTER TABLE inventory_movements ADD COLUMN receiptGroup TEXT;
ALTER TABLE transfer_movements  ADD COLUMN receiptGroup TEXT;
ALTER TABLE expenses            ADD COLUMN receiptGroup TEXT;
ALTER TABLE owner_transactions  ADD COLUMN receiptGroup TEXT;
CREATE INDEX IF NOT EXISTS idx_inventory_movements_receiptGroup ON inventory_movements(receiptGroup) WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_movements_receiptGroup  ON transfer_movements(receiptGroup)  WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_receiptGroup            ON expenses(receiptGroup)            WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_owner_transactions_receiptGroup  ON owner_transactions(receiptGroup)  WHERE receiptGroup IS NOT NULL;
