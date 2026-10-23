-- Reorder points and manual restock orders (2026-10). ADDITIVE.
-- blank_sizes.reorderPoint — "keep at least N" of this blank color + size free for new orders. When free stock (on
-- hand − set aside for orders − needed by unordered order lines + restock already on order) drops below it, Blanks to
-- Order suggests ordering back up to N. NULL = no reorder point.
ALTER TABLE blank_sizes ADD COLUMN reorderPoint INTEGER CHECK (reorderPoint IS NULL OR reorderPoint >= 0);
-- A restock order placed by hand (on the vendor's site, by phone or email — no Purchase Order connection), recorded
-- from Blanks to Order's "Get me to free shipping" window so the same restock isn't suggested again while it's on its
-- way. A line counts as on order until a purchase of that blank / color / size is recorded after it, or for 45 days.
CREATE TABLE IF NOT EXISTS blank_restock_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor     TEXT NOT NULL DEFAULT '',
  reference  TEXT NOT NULL DEFAULT '',
  -- [{blankId, color, size, qty}]
  linesJson  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(linesJson)),
  createdAt  TEXT NOT NULL,
  createdBy  TEXT NOT NULL DEFAULT '',
  voidedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_blank_restock_orders_created ON blank_restock_orders(createdAt);
