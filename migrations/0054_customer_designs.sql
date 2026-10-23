-- Customers upload their own design (functions/api/customer-design.js).
--   products.customDesign            — '' (off), 'embroidery' (the shop digitizes the customer's
--                                      image and uploads the stitch file before Digitizing complete)
--                                      or 'transfer' (printed from the customer's image).
--   products.customDesignPriceCents  — the per-piece add-on for it; NULL = free.
--   customer_design_uploads          — one row per image a customer uploaded from the shop page,
--                                      before it is on an order. The file is in the private DESIGNS
--                                      bucket under order-files/pending/. Placing an order records it
--                                      on the line as an order_item_files row (uploadedBy 'customer');
--                                      the daily clean-up deletes uploads older than 48 hours that no
--                                      order points to.
-- No order_items column: the line's copy of its options (configJson) carries the custom entry.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
ALTER TABLE products ADD COLUMN customDesign TEXT NOT NULL DEFAULT '' CHECK (customDesign IN ('', 'embroidery', 'transfer'));
ALTER TABLE products ADD COLUMN customDesignPriceCents INTEGER CHECK (customDesignPriceCents IS NULL OR customDesignPriceCents >= 0);
CREATE TABLE IF NOT EXISTS customer_design_uploads (
  id          TEXT    PRIMARY KEY,
  orgId       TEXT    NOT NULL,
  productId   TEXT    NOT NULL,
  fileKey     TEXT    NOT NULL UNIQUE,
  fileName    TEXT    NOT NULL DEFAULT '',
  fileExt     TEXT    NOT NULL CHECK (fileExt IN ('png', 'jpg', 'webp')),
  contentType TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  createdAt   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_design_uploads_created ON customer_design_uploads(createdAt);
CREATE INDEX IF NOT EXISTS idx_order_item_files_key ON order_item_files(fileKey);
