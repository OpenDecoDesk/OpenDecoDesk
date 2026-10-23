-- Accounts: every dollar moves through one (reconciliation, Part A).
-- ===========================================================================
-- accounts           — Business checking, Credit card, Venmo, Cash on hand,
--                      Stripe balance (seeded with fixed ids 1–5), each with an
--                      opening balance as of an opening date. Balances are
--                      computed: opening + everything dated on/after it.
--                      A credit card's balance goes negative as it's charged
--                      (money owed) and back up when it's paid (a transfer).
-- accountId on order_payments / expenses / inventory purchases / shipping
--                      labels — which account the money moved through.
--                      Expenses and blank purchases can instead be paid from
--                      personal funds (paidPersonally = 1): that's money the
--                      owner put into the business.
-- other_income       — income outside orders: services (Schedule C line 1),
--                      other business income (line 6), interest (Schedule B).
-- owner_transactions — owner contributions (money in) and draws (money out).
-- account_transfers  — money between accounts: Stripe payouts (recorded from
--                      Stripe's payout.paid webhook, externalRef = po_…),
--                      Venmo → bank, paying the credit card.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  type                TEXT NOT NULL CHECK (type IN ('checking', 'credit_card', 'venmo', 'cash', 'stripe', 'other')),
  openingBalanceCents INTEGER NOT NULL DEFAULT 0,
  openingDate         TEXT NOT NULL DEFAULT '2026-01-01' CHECK (openingDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL
);
INSERT OR IGNORE INTO accounts (id, name, type, createdAt, updatedAt) VALUES
  (1, 'Business checking', 'checking',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (2, 'Credit card',       'credit_card', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (3, 'Venmo',             'venmo',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (4, 'Cash on hand',      'cash',        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (5, 'Stripe balance',    'stripe',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE order_payments      ADD COLUMN accountId      INTEGER REFERENCES accounts(id);
ALTER TABLE expenses            ADD COLUMN accountId      INTEGER REFERENCES accounts(id);
ALTER TABLE expenses            ADD COLUMN paidPersonally INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1));
ALTER TABLE inventory_movements ADD COLUMN accountId      INTEGER REFERENCES accounts(id);
ALTER TABLE inventory_movements ADD COLUMN paidPersonally INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1));
ALTER TABLE shipping_labels     ADD COLUMN accountId      INTEGER REFERENCES accounts(id);

-- Existing payments: the account their method implies.
UPDATE order_payments SET accountId = CASE method
  WHEN 'card' THEN 5 WHEN 'venmo' THEN 3 WHEN 'cash' THEN 4 ELSE 1 END
WHERE accountId IS NULL;
-- Existing labels: Shippo charges the card on file.
UPDATE shipping_labels SET accountId = 2 WHERE accountId IS NULL;

CREATE TABLE IF NOT EXISTS other_income (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incomeDate  TEXT NOT NULL CHECK (incomeDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  type        TEXT NOT NULL CHECK (type IN ('service', 'other', 'interest')),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  accountId   INTEGER NOT NULL REFERENCES accounts(id),
  reference   TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_other_income_date ON other_income(deletedAt, incomeDate);

CREATE TABLE IF NOT EXISTS owner_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  txDate      TEXT NOT NULL CHECK (txDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  kind        TEXT NOT NULL CHECK (kind IN ('contribution', 'draw')),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  accountId   INTEGER NOT NULL REFERENCES accounts(id),
  note        TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_tx_date ON owner_transactions(deletedAt, txDate);

CREATE TABLE IF NOT EXISTS account_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  transferDate  TEXT NOT NULL CHECK (transferDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  fromAccountId INTEGER NOT NULL REFERENCES accounts(id),
  toAccountId   INTEGER NOT NULL REFERENCES accounts(id),
  amountCents   INTEGER NOT NULL CHECK (amountCents > 0),
  note          TEXT NOT NULL DEFAULT '',
  externalRef   TEXT NOT NULL DEFAULT '',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  deletedAt     TEXT,
  CHECK (fromAccountId <> toAccountId)
);
CREATE INDEX IF NOT EXISTS idx_transfers_date ON account_transfers(deletedAt, transferDate);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_external_ref ON account_transfers(externalRef) WHERE externalRef <> '';
