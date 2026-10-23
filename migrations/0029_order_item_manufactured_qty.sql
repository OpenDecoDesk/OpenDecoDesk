-- 0029_order_item_manufactured_qty.sql
-- Per-piece manufacture tracking: how many of a line item's `qty` pieces have been run.
-- Lets the Run Order screen split a qty>1 line into one card per physical piece and mark
-- each manufactured independently (consuming one blank at a time), instead of the old
-- all-or-nothing per-order manufacture. The order-level orders.manufacturedAt stays the
-- "fully made" signal — it is stamped only once every active line's manufacturedQty
-- reaches its qty, so every report/screen that keys off manufacturedAt is unchanged.
ALTER TABLE order_items ADD COLUMN manufacturedQty INTEGER NOT NULL DEFAULT 0 CHECK (manufacturedQty >= 0);

-- Backfill: every line of an already-manufactured order is fully made.
UPDATE order_items
   SET manufacturedQty = qty
 WHERE orderId IN (SELECT orderId FROM orders WHERE manufacturedAt IS NOT NULL);
