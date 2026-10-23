-- Invoices the customer can open, choose delivery on, and pay online.
-- ===========================================================================================
-- 1. order_invoices — one per order. The admin emails the customer a link (`/?invoice=<token>` on
--    the shop's own address) to a page that shows what they owe, lets them choose how they'll get
--    the order (the shop's delivery & pickup options, incl. carrier rates) and pay the balance.
--    Sending again keeps the same token (so an earlier email's link still works) and renews it.
--      allowDelivery     1 = the customer may choose / change the delivery option on the page
--      viewedAt          first time the page was opened
--      deliveryChosenAt  last time the customer saved a delivery choice
--      deliveryChoice    what they chose: 'pickup', 'option:<id>' (one of the shop's own), 'shipping'
--                        (a carrier rate) or 'shipping-quote' (ship it; the cost will follow)
-- 2. owner_notices.kind gains 'invoice' — a customer's delivery choice is reported in the 6 AM
--    roll-up. SQLite can't alter a CHECK, so the table is rebuilt (same as migrations/0016;
--    nothing references it).
-- Apply before deploying the code that uses it (`npm run deploy` does both).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS order_invoices (
  token            TEXT PRIMARY KEY,
  orderId          TEXT NOT NULL UNIQUE REFERENCES orders(orderId) ON DELETE CASCADE,
  orgId            TEXT NOT NULL,
  sentTo           TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  allowDelivery    INTEGER NOT NULL DEFAULT 1 CHECK (allowDelivery IN (0, 1)),
  sentAt           TEXT NOT NULL,
  sendCount        INTEGER NOT NULL DEFAULT 1 CHECK (sendCount >= 1),
  viewedAt         TEXT,
  deliveryChosenAt TEXT,
  deliveryChoice   TEXT NOT NULL DEFAULT ''
);

DROP INDEX IF EXISTS idx_owner_notices_unsent;
ALTER TABLE owner_notices RENAME TO owner_notices_old;

CREATE TABLE owner_notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'design', 'delivered', 'invoice')),
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
