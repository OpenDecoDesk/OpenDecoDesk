-- Inventory in three groups: blanks for sale, blanks for testing / shop use (could still be
-- sold), and FINISHED stock — blanks already decorated for a shop's product and listed as in stock on
-- its site. Additive only.
--
-- 1. blanks.forTesting: a blank TYPE bought for testing / shop use. Still inventory (it could be sold);
--    the Inventory & COGS report shows it as its own group.
ALTER TABLE blanks ADD COLUMN forTesting INTEGER NOT NULL DEFAULT 0 CHECK (forTesting IN (0, 1));

-- 2. inventory_movements.reason: a write-off's reason (testing | damaged | lost | other), so testing use
--    is reported apart from damage; on a consume row, 'finished' = the blank went into finished stock
--    (made for stock — NOT cost of goods; it becomes COGS when that finished piece is sold).
ALTER TABLE inventory_movements ADD COLUMN reason TEXT NOT NULL DEFAULT '';

-- 3. Finished stock. ready_to_ship (shop + product + size → quantity) gets its running average cost, and
--    every change is a finished_goods_movements row: opening (the counts entered before this), make
--    (blanks decorated for stock), sell (pulled for an order), return (an order's pulled piece put back),
--    adjust (a count correction). ready_to_ship.quantity is the cache of their sum, like blank_sizes.
ALTER TABLE ready_to_ship ADD COLUMN avgCostCents INTEGER NOT NULL DEFAULT 0 CHECK (avgCostCents >= 0);

CREATE TABLE IF NOT EXISTS finished_goods_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId           TEXT    NOT NULL,
  productId       TEXT    NOT NULL,
  productName     TEXT    NOT NULL DEFAULT '',
  color           TEXT    NOT NULL DEFAULT '',
  size            TEXT    NOT NULL DEFAULT '',
  qtyDelta        INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents   INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind            TEXT    NOT NULL CHECK (kind IN ('opening', 'make', 'sell', 'return', 'adjust')),
  blankMovementId INTEGER,
  orderId         TEXT,
  itemId          INTEGER,
  note            TEXT    NOT NULL DEFAULT '',
  occurredAt      TEXT    NOT NULL,
  createdAt       TEXT    NOT NULL,
  voidedAt        TEXT,
  voidReason      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fgm_item ON finished_goods_movements (orgId, productId, size, occurredAt);
CREATE INDEX IF NOT EXISTS idx_fgm_occurred ON finished_goods_movements (occurredAt);

-- 4. order_items.fromStock: the line is filled from the shop's finished stock (set when the order is
--    placed, if enough is in stock) — no blank, design or making steps; its pieces are set aside until
--    the order is made, then leave finished stock with their cost.
ALTER TABLE order_items ADD COLUMN fromStock INTEGER NOT NULL DEFAULT 0 CHECK (fromStock IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_items_from_stock ON order_items (orgId, productId, size) WHERE fromStock = 1;

-- Backfill: the reason of every existing write-off, from the note the Write off window wrote
-- (exact labels first, then keywords).
UPDATE inventory_movements SET reason = CASE
    WHEN note LIKE 'Used for testing%' THEN 'testing'
    WHEN note = 'Damaged' THEN 'damaged'
    WHEN note LIKE 'Lost%' THEN 'lost'
    WHEN lower(note) LIKE '%test%' OR lower(note) LIKE '%sample%' OR lower(note) LIKE '%scrap%' THEN 'testing'
    WHEN lower(note) LIKE '%damage%' THEN 'damaged'
    WHEN lower(note) LIKE '%lost%' OR lower(note) LIKE '%miscount%' THEN 'lost'
    ELSE 'other' END
  WHERE kind = 'writeoff';

-- Backfill: the stock counts already entered become an opening balance of finished stock, valued at
-- the linked blank's current average cost (0 when the product isn't linked). Blank counts are NOT
-- touched. A flat-priced product's stock is under size '' while its blank link is under 'OSFA'.
UPDATE ready_to_ship SET avgCostCents = COALESCE(
    (SELECT bs.purchasePriceCents FROM product_blank_links l
       JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
      WHERE l.orgId = ready_to_ship.orgId AND l.productId = ready_to_ship.productId AND l.productColor = '' AND l.productSize = ready_to_ship.size
      LIMIT 1),
    (SELECT bs.purchasePriceCents FROM product_blank_links l
       JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
      WHERE l.orgId = ready_to_ship.orgId AND l.productId = ready_to_ship.productId AND l.productColor = '' AND ready_to_ship.size = '' AND l.productSize = 'OSFA'
      LIMIT 1),
    0)
  WHERE quantity > 0;

INSERT INTO finished_goods_movements (orgId, productId, productName, color, size, qtyDelta, unitCostCents, kind, note, occurredAt, createdAt)
  SELECT r.orgId, r.productId, COALESCE((SELECT p.name FROM products p WHERE p.orgId = r.orgId AND p.productId = r.productId), r.productId),
         '', r.size, r.quantity, r.avgCostCents, 'opening', 'Stock count on hand when finished stock started being tracked',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM ready_to_ship r WHERE r.quantity > 0;
