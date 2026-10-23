-- Completed orders + the daily delivery check.
-- ===========================================================================
-- 1. orders.completedAt — when an order was closed out (NULL = still open).
--    An order can be completed once it's delivered and paid in full. The
--    orders screen hides completed orders unless "Include completed" is
--    ticked. Existing orders that are already delivered AND paid are
--    backfilled as completed on their delivery date (they satisfy exactly the
--    rule that would let you complete them; "Reopen" undoes any of them).
-- 2. owner_notices.kind gains 'delivered' — the 6 AM roll-up checks tracking
--    for shipped orders, marks the delivered ones and queues a notice for
--    the email + Communications page. kind has a CHECK, which SQLite can't
--    alter in place, so the table is rebuilt (rename the old one first, copy,
--    drop it — nothing references owner_notices).
--
-- Apply before deploying the code that uses it.
-- ===========================================================================

ALTER TABLE orders ADD COLUMN completedAt TEXT;

UPDATE orders SET completedAt = deliveredAt
 WHERE deliveredAt IS NOT NULL AND paid = 1 AND voidedAt IS NULL AND isTest = 0
   AND EXISTS (SELECT 1 FROM order_items i WHERE i.orderId = orders.orderId AND i.cancelDate IS NULL);

CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completedAt);

DROP INDEX IF EXISTS idx_owner_notices_unsent;
ALTER TABLE owner_notices RENAME TO owner_notices_old;

CREATE TABLE owner_notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'design', 'delivered')),
  orderId   TEXT NOT NULL DEFAULT '',
  orgId     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  imageUrls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imageUrls)),
  urgent    INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  createdAt TEXT NOT NULL,
  sentAt    TEXT
);
INSERT INTO owner_notices (id, kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt, sentAt)
  SELECT id, kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt, sentAt FROM owner_notices_old;
DROP TABLE owner_notices_old;
CREATE INDEX idx_owner_notices_unsent ON owner_notices(sentAt, id);
