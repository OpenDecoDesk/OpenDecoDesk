-- Venmo cash-outs mapped to orders, and refunds of expenses.
-- ===========================================================================
-- 1. order_payments.cashoutTransferId — the Venmo → bank transfer that moved a
--    Venmo payment to the bank. Set when a bank-statement deposit is recorded
--    as a "Venmo cash-out" covering specific orders (Reconcile → Create…); a
--    cashed-out payment isn't offered again. NULL = still sitting in Venmo.
--    (A payment whose transfer was later deleted is offered again.)
-- 2. expenses can be REFUNDS: amountCents may now be negative (a returned
--    item, a reversed fee — money coming back for something you bought), the
--    same way order_payments already uses negative rows for refunds. A refund
--    stays in the ORIGINAL category so it reduces that line of Schedule C
--    instead of showing up as income; refundOfId optionally links it to the
--    purchase it reverses. amountCents can't be zero. The CHECK can't be
--    altered in place, so the table is rebuilt (old one renamed first; nothing
--    references expenses).
--
-- Apply before deploying the code that uses it.
-- ===========================================================================

ALTER TABLE order_payments ADD COLUMN cashoutTransferId INTEGER REFERENCES account_transfers(id);
CREATE INDEX IF NOT EXISTS idx_payments_cashout ON order_payments(cashoutTransferId);

DROP INDEX IF EXISTS idx_expenses_date;
DROP INDEX IF EXISTS idx_expenses_category;
ALTER TABLE expenses RENAME TO expenses_old;

CREATE TABLE expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  expenseDate     TEXT NOT NULL CHECK (expenseDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description     TEXT NOT NULL CHECK (length(trim(description)) > 0),
  categoryId      INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amountCents     INTEGER NOT NULL CHECK (amountCents <> 0),
  vendor          TEXT NOT NULL DEFAULT '',
  businessUsePct  INTEGER NOT NULL DEFAULT 100 CHECK (businessUsePct BETWEEN 1 AND 100),
  receiptKey      TEXT NOT NULL DEFAULT '',
  receiptName     TEXT NOT NULL DEFAULT '',
  placedInService TEXT,
  depMethod       TEXT CHECK (depMethod IS NULL OR depMethod IN ('section179', 'bonus', 'macrs5', 'macrs7', 'ask_cpa')),
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  deletedAt       TEXT,
  vendorChargedTax INTEGER NOT NULL DEFAULT 1 CHECK (vendorChargedTax IN (0, 1)),
  accountId       INTEGER REFERENCES accounts(id),
  paidPersonally  INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),
  refundOfId      INTEGER REFERENCES expenses(id) ON DELETE SET NULL
);
INSERT INTO expenses (id, expenseDate, description, categoryId, amountCents, vendor, businessUsePct, receiptKey, receiptName,
                      placedInService, depMethod, createdAt, updatedAt, deletedAt, vendorChargedTax, accountId, paidPersonally)
  SELECT id, expenseDate, description, categoryId, amountCents, vendor, businessUsePct, receiptKey, receiptName,
         placedInService, depMethod, createdAt, updatedAt, deletedAt, vendorChargedTax, accountId, paidPersonally FROM expenses_old;
DROP TABLE expenses_old;
CREATE INDEX idx_expenses_date     ON expenses(deletedAt, expenseDate);
CREATE INDEX idx_expenses_category ON expenses(categoryId);
