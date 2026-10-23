-- Orders placed with a supplier from Blanks to Order through PromoStandards Purchase Order 1.0.0 sendPO
-- (2026-10). One row per purchase order; written as 'sending' BEFORE the call, so the UNIQUE poNumber stops a
-- double click from ordering twice, then 'placed' (the supplier answered with a transaction id), 'failed' (the
-- supplier refused it) or 'unknown' (no answer — check the supplier's site before retrying with the same PO
-- number). Additive.
CREATE TABLE IF NOT EXISTS supplier_orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  connectionId        INTEGER NOT NULL,
  vendor              TEXT    NOT NULL DEFAULT '',
  environment         TEXT    NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'test')),
  poNumber            TEXT    NOT NULL UNIQUE,
  status              TEXT    NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'placed', 'failed', 'unknown')),
  transactionId       TEXT    NOT NULL DEFAULT '',
  error               TEXT    NOT NULL DEFAULT '',
  carrier             TEXT    NOT NULL DEFAULT '',
  service             TEXT    NOT NULL DEFAULT '',
  shipToJson          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(shipToJson)),
  totalCents          INTEGER NOT NULL DEFAULT 0 CHECK (totalCents >= 0),
  -- [{blankId, blank, color, size, style, productId, partId, qty, unitCents}]
  linesJson           TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(linesJson)),
  -- the order lines it was bought for (marked "blanks ordered" with this PO number once placed)
  itemIdsJson         TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(itemIdsJson)),
  createdAt           TEXT    NOT NULL,
  createdBy           TEXT    NOT NULL DEFAULT '',
  placedAt            TEXT,
  lastShipmentCheckAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_created ON supplier_orders(createdAt);
-- A blank shipment found through the supplier's shipment notices says which of its orders it belongs to.
ALTER TABLE blank_shipments ADD COLUMN supplierPoNumber TEXT NOT NULL DEFAULT '';
