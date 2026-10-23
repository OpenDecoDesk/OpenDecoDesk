-- Statement import & monthly reconciliation (reconciliation Part B).
-- ===========================================================================
-- statement_lines    — lines imported from an account's statement CSV (date,
--                      description, signed amount: + = money into the
--                      account). fingerprint makes re-importing the same or an
--                      overlapping file a no-op. Long digit runs in
--                      descriptions (card/account numbers) are masked before
--                      they're stored.
-- statement_matches  — which recorded money movement(s) (src + srcId, the
--                      same keys as MONEY_MOVE_SOURCES in db.js) a line is.
--                      One line can match several movements (a deposit of
--                      several checks; a Stripe charge's payment + fee), but
--                      a movement matches at most one line.
-- reconciliations    — an account's month signed off: the statement's ending
--                      balance and the book balance it was checked against.
-- accounts.csvMapping — the column mapping remembered per account.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

ALTER TABLE accounts ADD COLUMN csvMapping TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS statement_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId    INTEGER NOT NULL REFERENCES accounts(id),
  lineDate     TEXT NOT NULL CHECK (lineDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description  TEXT NOT NULL DEFAULT '',
  amountCents  INTEGER NOT NULL CHECK (amountCents <> 0),
  fingerprint  TEXT NOT NULL,
  importBatch  TEXT NOT NULL DEFAULT '',
  importedAt   TEXT NOT NULL,
  ignoredAt    TEXT,
  ignoreReason TEXT NOT NULL DEFAULT '',
  UNIQUE (accountId, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_statement_lines_account_date ON statement_lines(accountId, lineDate);

CREATE TABLE IF NOT EXISTS statement_matches (
  lineId    INTEGER NOT NULL REFERENCES statement_lines(id) ON DELETE CASCADE,
  src       TEXT NOT NULL,
  srcId     INTEGER NOT NULL,
  matchedAt TEXT NOT NULL,
  auto      INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
  PRIMARY KEY (src, srcId)
);
CREATE INDEX IF NOT EXISTS idx_statement_matches_line ON statement_matches(lineId);

CREATE TABLE IF NOT EXISTS reconciliations (
  accountId                  INTEGER NOT NULL REFERENCES accounts(id),
  month                      TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  statementEndingBalanceCents INTEGER NOT NULL,
  bookBalanceCents           INTEGER NOT NULL,
  reconciledAt               TEXT NOT NULL,
  reconciledBy               TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (accountId, month)
);
