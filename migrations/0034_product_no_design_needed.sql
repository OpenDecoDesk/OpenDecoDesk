-- 0034_product_no_design_needed.sql
-- A product that never needs an embroidery design (DTF-pressed, blank resale, …) says so, so the
-- catalog health check (getCatalogIssues) doesn't flag it as "no design linked" forever. Additive.
ALTER TABLE products ADD COLUMN noDesignNeeded INTEGER NOT NULL DEFAULT 0 CHECK (noDesignNeeded IN (0, 1));
