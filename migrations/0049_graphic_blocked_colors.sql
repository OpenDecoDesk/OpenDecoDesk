-- A graphic can be switched off for single garment colors ("don't offer the white logo on White"),
-- set from a product's mockup table. Separate from allowedGarmentColorsJson, which is an allow-list
-- (empty = any color): a deny-list keeps working when a product later gains new colors.
ALTER TABLE graphics ADD COLUMN blockedGarmentColorsJson TEXT NOT NULL DEFAULT '[]';
