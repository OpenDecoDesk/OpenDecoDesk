-- Add the missing FK on blank_shipment_items.itemId → order_items(id) ON DELETE CASCADE.
-- =====================================================================================
-- 0039 created blank_shipment_items with itemId as a bare INTEGER — the only child of
-- order_items that is NOT cleaned up when a line is removed (order_item_files,
-- production_runs, order_item_designs all cascade). Without it, deleting/removing a line
-- orphans its shipment-item rows and can leave a blank_shipments row covering zero live
-- items while the daily Shippo poller keeps hitting it. SQLite can't ALTER a column to add
-- a FK, so rebuild the table (rename / recreate-with-FK / copy / drop), the 0006/0037
-- pattern. defer_foreign_keys postpones FK checks to commit so the copy can't trip them.
--
-- Orphan hygiene: the copy keeps only rows whose itemId still references a real order_items
-- row (and whose shipment still exists), so any pre-existing orphans are dropped rather than
-- blocking the new FK.
-- =====================================================================================

PRAGMA defer_foreign_keys = true;

ALTER TABLE blank_shipment_items RENAME TO blank_shipment_items_old;

CREATE TABLE blank_shipment_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shipmentId INTEGER NOT NULL REFERENCES blank_shipments(id) ON DELETE CASCADE,
  itemId     INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  UNIQUE (shipmentId, itemId)
);

INSERT INTO blank_shipment_items (id, shipmentId, itemId)
  SELECT o.id, o.shipmentId, o.itemId
  FROM blank_shipment_items_old o
  WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = o.itemId)
    AND EXISTS (SELECT 1 FROM blank_shipments s WHERE s.id = o.shipmentId);

DROP TABLE blank_shipment_items_old;

CREATE INDEX IF NOT EXISTS idx_blank_shipment_items_item ON blank_shipment_items(itemId);
