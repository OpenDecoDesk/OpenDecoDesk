-- Business expenses (Schedule C Part II + Form 4562 asset facts).
-- ===========================================================================
-- Every expense has a date, description, category and amount, plus optional
-- vendor, business-use % and a receipt (private R2 bucket RECEIPTS). Each
-- category carries how it's deducted:
--   deductionType  depreciation (capital equipment → Form 4562 / line 13),
--                  deductible (ordinary expense), none (not deductible)
--   scheduleCLine  the Schedule C Part II line its total goes on ('8'…'27a')
--   deductiblePct  share that's deductible (100; meals 50 — IRC §274(n))
-- Depreciation expenses also record placedInService + depMethod; the CPA
-- makes the election and computes depreciation — the site records facts.
-- Deleting a category is refused while any expense (even a deleted one)
-- uses it. Expenses are soft-deleted (deletedAt) and audited.
--
-- NOT tracked here (already automatic — don't enter them as expenses):
-- Stripe fees (order_payments.feeCents), Shippo postage (shipping_labels),
-- blank purchases (inventory_movements → COGS, Schedule C Part III).
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS expense_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  deductionType TEXT NOT NULL CHECK (deductionType IN ('depreciation', 'deductible', 'none')),
  scheduleCLine TEXT NOT NULL DEFAULT '',
  deductiblePct INTEGER NOT NULL DEFAULT 100 CHECK (deductiblePct BETWEEN 0 AND 100),
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  expenseDate     TEXT NOT NULL CHECK (expenseDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description     TEXT NOT NULL CHECK (length(trim(description)) > 0),
  categoryId      INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amountCents     INTEGER NOT NULL CHECK (amountCents > 0),
  vendor          TEXT NOT NULL DEFAULT '',
  businessUsePct  INTEGER NOT NULL DEFAULT 100 CHECK (businessUsePct BETWEEN 1 AND 100),
  receiptKey      TEXT NOT NULL DEFAULT '',
  receiptName     TEXT NOT NULL DEFAULT '',
  placedInService TEXT,
  depMethod       TEXT CHECK (depMethod IS NULL OR depMethod IN ('section179', 'bonus', 'macrs5', 'macrs7', 'ask_cpa')),
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  deletedAt       TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(deletedAt, expenseDate);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(categoryId);

-- Starting categories (all editable / deletable while unused).
INSERT OR IGNORE INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt) VALUES
  ('Equipment & machines',                   'depreciation', '13',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Supplies (thread, stabilizer, needles)', 'deductible',   '22',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Software & subscriptions',               'deductible',   '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Advertising',                            'deductible',   '8',   100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Meals (50%)',                            'deductible',   '24b', 50,  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Office expense',                         'deductible',   '18',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Repairs & maintenance',                  'deductible',   '21',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Insurance',                              'deductible',   '15',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Legal & professional',                   'deductible',   '17',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Taxes & licenses',                       'deductible',   '23',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Travel',                                 'deductible',   '24a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Utilities & phone',                      'deductible',   '25',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Contract labor',                         'deductible',   '11',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Rent / lease',                           'deductible',   '20b', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Bank & other fees',                      'deductible',   '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Personal / non-deductible',              'none',         '',    0,   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
