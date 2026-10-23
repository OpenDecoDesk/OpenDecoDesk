-- Inventory history + cost of goods sold.
-- ===========================================================================
-- Every change to blank stock becomes a row in inventory_movements:
--   purchase  — blanks received from a vendor (qty > 0, at the price paid)
--   consume   — blanks used when an order is marked "manufactured" (qty < 0,
--               at the weighted-average cost at that moment) → that line's COGS
--   adjust    — corrections / counts (either sign), incl. the opening balance
--   writeoff  — damaged or lost blanks (qty < 0)
-- blank_sizes.quantity stays as a cache of SUM(qtyDelta), and
-- blank_sizes.purchasePriceCents becomes the running weighted-average cost.
-- The history is what Schedule C Part III needs (beginning/ending inventory,
-- purchases, COGS); it starts on the date this migration runs.
--
-- blankId is deliberately NOT a foreign key: deleting a blank must not erase
-- (or be blocked by) its cost history. blankName snapshots the name.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS inventory_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId       INTEGER NOT NULL,
  blankName     TEXT NOT NULL DEFAULT '',
  size          TEXT NOT NULL DEFAULT '',
  qtyDelta      INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('purchase', 'consume', 'adjust', 'writeoff')),
  orderId       TEXT,
  itemId        INTEGER,
  vendor        TEXT NOT NULL DEFAULT '',
  vendorRef     TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  occurredAt    TEXT NOT NULL,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_blank    ON inventory_movements(blankId, size, occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_occurred ON inventory_movements(occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_order    ON inventory_movements(orderId);

-- Per line: what the blanks cost ('consumed' = recorded when manufactured;
-- 'estimate' = backfilled below for orders manufactured before this existed).
ALTER TABLE order_items ADD COLUMN cogsCents  INTEGER CHECK (cogsCents IS NULL OR cogsCents >= 0);
ALTER TABLE order_items ADD COLUMN cogsSource TEXT    CHECK (cogsSource IS NULL OR cogsSource IN ('consumed', 'estimate'));

-- Opening balance: today's stock at today's recorded cost.
INSERT INTO inventory_movements (blankId, blankName, size, qtyDelta, unitCostCents, kind, note, occurredAt, createdAt)
SELECT bs.blankId,
       COALESCE(NULLIF(b.name, ''), trim(b.brand || ' ' || b.color)),
       bs.size, bs.quantity, bs.purchasePriceCents, 'adjust', 'Opening balance',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM blank_sizes bs LEFT JOIN blanks b ON b.id = bs.blankId
WHERE bs.quantity <> 0;

-- Recover productId on older lines that were recorded without one, by name
-- within the same org. Names there may use an em/en dash where the catalog
-- uses a hyphen ("Option C — …" vs "Option C - …"), so dashes are
-- normalized; only an unambiguous (single) match is applied.
UPDATE order_items
SET productId = (
      SELECT p.productId FROM products p
      WHERE p.orgId = order_items.orgId
        AND lower(trim(replace(replace(p.name, '—', '-'), '–', '-'))) =
            lower(trim(replace(replace(order_items.name, '—', '-'), '–', '-'))))
WHERE productId = ''
  AND (SELECT count(*) FROM products p
       WHERE p.orgId = order_items.orgId
         AND lower(trim(replace(replace(p.name, '—', '-'), '–', '-'))) =
             lower(trim(replace(replace(order_items.name, '—', '-'), '–', '-')))) = 1;

-- Estimated COGS for lines already manufactured: the linked blank's current
-- cost × qty. No stock movement — the counts already reflect that usage.
UPDATE order_items
SET cogsCents = qty * (
      SELECT bs.purchasePriceCents FROM product_blank_links l
      JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.size = l.blankSize
      WHERE l.orgId = order_items.orgId AND l.productId = order_items.productId AND l.productSize = order_items.size),
    cogsSource = 'estimate'
WHERE cancelDate IS NULL
  AND orderId IN (SELECT orderId FROM orders WHERE manufacturedAt IS NOT NULL)
  AND EXISTS (
      SELECT 1 FROM product_blank_links l
      JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.size = l.blankSize
      WHERE l.orgId = order_items.orgId AND l.productId = order_items.productId AND l.productSize = order_items.size);
