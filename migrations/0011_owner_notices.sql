-- Owner notices queued for the 6 AM daily roll-up (instead of one email each).
-- ===========================================================================
-- Stripe payment / refund / dispute notices and customer design responses
-- are queued here rather than emailed to the owner one by one, and listed in
-- the daily roll-up (functions/api/daily-digest.js), which marks them sent.
-- Only customer-facing emails go out immediately.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS owner_notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'design')),
  orderId   TEXT NOT NULL DEFAULT '',
  orgId     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  imageUrls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imageUrls)),
  urgent    INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  createdAt TEXT NOT NULL,
  sentAt    TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_notices_unsent ON owner_notices(sentAt, id);
