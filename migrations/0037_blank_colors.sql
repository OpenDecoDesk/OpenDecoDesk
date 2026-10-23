-- Color as a dimension of a blank (multi-color blanks + per-color images).
-- ===========================================================================
-- Until now a "blank" was one garment style in ONE color, so the N colors of
-- the same shirt meant N blank rows. This makes color a dimension
-- like size: one blank (e.g. "Jerzees 63374") holds many colors x sizes, each
-- color carries images, and the stock/COGS spine keys on (blankId, color, size)
-- instead of (blankId, size).
--
-- NON-DESTRUCTIVE: every existing single-color blank is preserved exactly. Each
-- carries its old scalar blanks.color into the new color dimension (one color
-- per existing blank). A separate admin "Merge blanks" action folds the old
-- per-color rows together later, on the shop's schedule.
--
-- HOW: SQLite can't add a column to a UNIQUE key in place, so blank_sizes and
-- product_blank_links are rebuilt (rename -> recreate -> copy -> drop), the 0006
-- pattern. blanks is NOT renamed (it's the unchanged parent), so the rebuilt
-- children's FKs point at the live blanks and dropping the _old copies can't
-- cascade into the new ones. inventory_movements has no UNIQUE on (blankId,size)
-- so color is a plain additive column there. D1 runs the file in one
-- transaction; any error rolls it all back.
--
-- REHEARSE against a full export of the live database before applying (compare row counts
-- and, as cents, every blank_sizes quantity x cost). The color-aware code ships
-- in the same release.
-- ===========================================================================

PRAGMA defer_foreign_keys = true;

-- ---- blank_colors: authoritative per-color record (name + images + order) ---
CREATE TABLE IF NOT EXISTS blank_colors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId    INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  color      TEXT NOT NULL DEFAULT '',
  imagesJson TEXT NOT NULL DEFAULT '[]',   -- ordered image URLs for this color
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  UNIQUE (blankId, color)
);
CREATE INDEX IF NOT EXISTS idx_blank_colors ON blank_colors(blankId);
-- One color row per existing blank (its old scalar color; '' stays '').
INSERT INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt)
  SELECT id, color, '[]', 0, createdAt, updatedAt FROM blanks;

-- ---- blank_sizes: rebuild to key stock on (blankId, color, size) ------------
ALTER TABLE blank_sizes RENAME TO blank_sizes_old;
CREATE TABLE blank_sizes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId            INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  color              TEXT NOT NULL DEFAULT '',
  size               TEXT NOT NULL DEFAULT '',
  purchasePriceCents INTEGER NOT NULL DEFAULT 0 CHECK (purchasePriceCents >= 0),
  quantity           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (blankId, color, size)
);
INSERT INTO blank_sizes (id, blankId, color, size, purchasePriceCents, quantity)
  SELECT bs.id, bs.blankId,
         COALESCE((SELECT b.color FROM blanks b WHERE b.id = bs.blankId), ''),
         bs.size, bs.purchasePriceCents, bs.quantity
    FROM blank_sizes_old bs;
DROP TABLE blank_sizes_old;
CREATE INDEX IF NOT EXISTS idx_blank_sizes ON blank_sizes(blankId);

-- ---- inventory_movements: additive color column + backfill ------------------
ALTER TABLE inventory_movements ADD COLUMN color TEXT NOT NULL DEFAULT '';
UPDATE inventory_movements
   SET color = COALESCE((SELECT b.color FROM blanks b WHERE b.id = inventory_movements.blankId), '')
 WHERE color = '';
CREATE INDEX IF NOT EXISTS idx_movements_blank_color ON inventory_movements(blankId, color, size, occurredAt);

-- ---- product_blank_links: rebuild to map (productColor, productSize) --------
ALTER TABLE product_blank_links RENAME TO product_blank_links_old;
CREATE TABLE product_blank_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId       TEXT NOT NULL,
  productId   TEXT NOT NULL,
  productColor TEXT NOT NULL DEFAULT '',  -- '' = a classic (single-color) product
  productSize TEXT NOT NULL DEFAULT '',
  blankId     INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  blankColor  TEXT NOT NULL DEFAULT '',
  blankSize   TEXT NOT NULL DEFAULT '',
  UNIQUE (orgId, productId, productColor, productSize)
);
INSERT INTO product_blank_links (id, orgId, productId, productColor, productSize, blankId, blankColor, blankSize)
  SELECT l.id, l.orgId, l.productId, '', l.productSize, l.blankId,
         COALESCE((SELECT b.color FROM blanks b WHERE b.id = l.blankId), ''), l.blankSize
    FROM product_blank_links_old l;
DROP TABLE product_blank_links_old;
CREATE INDEX IF NOT EXISTS idx_prod_blank_link ON product_blank_links(orgId, productId);
