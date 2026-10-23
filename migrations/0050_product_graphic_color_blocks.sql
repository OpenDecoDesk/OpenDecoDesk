-- "Don't offer this graphic on this color" belongs to the PRODUCT, not the graphic: a color name is
-- the blank vendor's label, and one vendor's "Red" can suit a graphic that another's doesn't. Each
-- entry is {graphicId, color}. Replaces 0049's per-graphic list, which never held anything.
ALTER TABLE products ADD COLUMN blockedGraphicColorsJson TEXT NOT NULL DEFAULT '[]';
ALTER TABLE graphics DROP COLUMN blockedGarmentColorsJson;
