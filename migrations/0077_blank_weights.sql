-- migrations/0077 — blank_sizes.weightOz: how much one piece of this blank color + size weighs, in ounces
-- (NULL = not known). Shipping quotes and package weights use it for every product linked to the size;
-- products.weightOz stays as an optional override. Filled from the blank form, vendor product files (S&S
-- unitWeight, SanMar PIECE_WEIGHT — both in pounds) and PromoStandards Product Data (part dimension weight).
ALTER TABLE blank_sizes ADD COLUMN weightOz REAL CHECK (weightOz IS NULL OR weightOz >= 0);
