-- Line-item blank fulfillment + multi-shipment carrier tracking with full status history.
-- =====================================================================================
-- Blank (garment) procurement was tracked per WHOLE ORDER (orders.blankOrderedAt /
-- blankReceivedAt + vendor/order#/estDelivery). A real vendor order spans many line items,
-- arrives in several shipments with different tracking numbers over time, and can arrive
-- partially. This moves the blank ordered/shipped/received stamps to the LINE ITEM, adds a
-- "shipped" step, and introduces blank_shipments (one row per tracking number) linked to the
-- line items it covers, with per-scan carrier events stored in blank_tracking_events.
--
-- NON-DESTRUCTIVE: all additive. The order-level orders.blank* columns are KEPT and become
-- derived summaries (recomputeOrderBlankStatus_ in db.js) so every existing order-level reader
-- keeps working. Each existing order's stamps are backfilled onto its items so current orders
-- behave identically.
-- =====================================================================================

-- Per-line-item blank stamps (the new source of truth) + the vendor fields set at "ordered".
ALTER TABLE order_items ADD COLUMN blankOrderedAt      TEXT;
ALTER TABLE order_items ADD COLUMN blankShippedAt      TEXT;
ALTER TABLE order_items ADD COLUMN blankReceivedAt     TEXT;
ALTER TABLE order_items ADD COLUMN blankVendor         TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN blankVendorOrderId  TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN blankEstDelivery    TEXT;

-- Backfill each item from its order so existing orders behave exactly as before.
UPDATE order_items SET
  blankOrderedAt     = (SELECT o.blankOrderedAt     FROM orders o WHERE o.orderId = order_items.orderId),
  blankReceivedAt    = (SELECT o.blankReceivedAt    FROM orders o WHERE o.orderId = order_items.orderId),
  blankEstDelivery   = (SELECT o.blankEstDelivery   FROM orders o WHERE o.orderId = order_items.orderId),
  blankVendor        = COALESCE((SELECT o.blankVendor        FROM orders o WHERE o.orderId = order_items.orderId), ''),
  blankVendorOrderId = COALESCE((SELECT o.blankVendorOrderId FROM orders o WHERE o.orderId = order_items.orderId), '');

-- One row per blank shipment (a tracking number). Covers one or more line items via the join.
CREATE TABLE IF NOT EXISTS blank_shipments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier        TEXT NOT NULL DEFAULT '',
  trackingNumber TEXT NOT NULL DEFAULT '',
  vendor         TEXT NOT NULL DEFAULT '',
  shippedAt      TEXT,                               -- the ship date entered by the admin
  status         TEXT NOT NULL DEFAULT '',           -- latest carrier status (e.g. TRANSIT/DELIVERED)
  statusDetail   TEXT NOT NULL DEFAULT '',
  statusDate     TEXT,
  deliveredAt    TEXT,                               -- set when the carrier reports delivered
  lastCheckedAt  TEXT,                               -- last Shippo poll
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blank_shipments_tracking ON blank_shipments(trackingNumber);
CREATE INDEX IF NOT EXISTS idx_blank_shipments_active   ON blank_shipments(deliveredAt, lastCheckedAt);

-- Which line items each shipment covers.
CREATE TABLE IF NOT EXISTS blank_shipment_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shipmentId INTEGER NOT NULL REFERENCES blank_shipments(id) ON DELETE CASCADE,
  itemId     INTEGER NOT NULL,
  UNIQUE (shipmentId, itemId)
);
CREATE INDEX IF NOT EXISTS idx_blank_shipment_items_item ON blank_shipment_items(itemId);

-- Full per-scan carrier history. Unique key dedupes a scan re-seen on the next daily poll.
CREATE TABLE IF NOT EXISTS blank_tracking_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shipmentId   INTEGER NOT NULL REFERENCES blank_shipments(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT '',
  statusDetail TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  occurredAt   TEXT NOT NULL DEFAULT '',
  recordedAt   TEXT NOT NULL,
  UNIQUE (shipmentId, status, occurredAt)
);
CREATE INDEX IF NOT EXISTS idx_blank_tracking_events_shipment ON blank_tracking_events(shipmentId, occurredAt);
