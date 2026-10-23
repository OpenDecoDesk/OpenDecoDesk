-- Product categories: a managed list instead of three names written into the code.
-- ===========================================================================================
-- A product's `type` (and a blank's `productType`, and the `type` copied onto each order line) used
-- to be one of shirt / sweatshirt / cap, hardcoded in the storefront, the product form and the blank
-- form. This table is now the list those pick from; `key` is the value stored in those columns, so
-- nothing existing has to be rewritten.
--   name    what the admin sees ("T Shirt")
--   plural  the storefront's section heading ("T Shirts")
--   packAs  which package-size limit the category counts against when a box is chosen for shipping
--           (Max shirts / Max sweatshirts / Max caps); 'other' = no automatic box, quote by hand
-- Whether a product has sizes no longer depends on its category: it follows the product's own
-- pricing (by size, or one flat price).
--
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS product_categories (
  key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 40),
  name       TEXT NOT NULL,
  plural     TEXT NOT NULL DEFAULT '',
  packAs     TEXT NOT NULL DEFAULT 'other' CHECK (packAs IN ('shirt', 'sweatshirt', 'cap', 'other')),
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_name ON product_categories(name COLLATE NOCASE);

-- The three that existed (same keys, so every product, blank and order line keeps its category),
-- plus Patch, T Shirt, Hoodie and Other.
INSERT OR IGNORE INTO product_categories (key, name, plural, packAs, sortOrder, createdAt, updatedAt) VALUES
  ('shirt',      'Shirt',      'Shirts',      'shirt',      1, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('t-shirt',    'T Shirt',    'T Shirts',    'shirt',      2, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('sweatshirt', 'Sweatshirt', 'Sweatshirts', 'sweatshirt', 3, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('hoodie',     'Hoodie',     'Hoodies',     'sweatshirt', 4, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('cap',        'Cap',        'Caps',        'cap',        5, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('patch',      'Patch',      'Patches',     'other',      6, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('other',      'Other',      'Other',       'other',      7, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');
