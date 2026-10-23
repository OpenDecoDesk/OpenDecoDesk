-- Vendor prices for blanks. Additive only.
--
-- blank_sizes.purchasePriceCents is the running weighted-average cost of the pieces ON HAND (shipping
-- and fees landed in) — what cost of goods is charged at. It isn't the vendor's list price, and typing
-- a list price into it rewrote the average. The vendor price is now its own value, per blank + color +
-- size, entered by hand (or from a price-list CSV) and kept with its history. It starts empty: nothing
-- counts as a vendor price until someone enters one.
ALTER TABLE blank_sizes ADD COLUMN vendorPriceCents INTEGER CHECK (vendorPriceCents IS NULL OR vendorPriceCents >= 0);
ALTER TABLE blank_sizes ADD COLUMN vendorPriceAt TEXT;

-- When the blank's vendor prices were last checked against the vendor (entering or changing one counts,
-- or "Prices are current"). The daily roll-up reminds every 30 days about blanks for sale on visible
-- products that haven't been checked in 30 days.
ALTER TABLE blanks ADD COLUMN pricesCheckedAt TEXT;

-- When the product's prices were last set or confirmed against its blanks' vendor prices. A linked
-- blank's vendor price that changed since then flags the product for re-pricing. NULL = since it was
-- created.
ALTER TABLE products ADD COLUMN pricesReviewedAt TEXT;

-- Every vendor price entered: append-only (priceCents NULL = the price was cleared). blankId isn't an
-- FK, so deleting a blank keeps its history, like inventory_movements.
CREATE TABLE IF NOT EXISTS blank_vendor_prices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId       INTEGER NOT NULL,
  color         TEXT    NOT NULL DEFAULT '',
  size          TEXT    NOT NULL DEFAULT '',
  priceCents    INTEGER CHECK (priceCents IS NULL OR priceCents >= 0),
  previousCents INTEGER,
  enteredAt     TEXT    NOT NULL,
  actor         TEXT    NOT NULL DEFAULT '',
  note          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bvp_size ON blank_vendor_prices (blankId, color, size, enteredAt);
