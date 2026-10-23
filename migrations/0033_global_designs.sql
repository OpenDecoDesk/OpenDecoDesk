-- 0033_global_designs.sql
-- A GLOBAL design can be used by every shop — e.g. a set of cap-closure designs every shop shares ("COACH",
-- "CAPTAIN", …) that every shop's cap maps its pick list to — so it's kept (and updated) in
-- one place instead of being copied into each shop. It keeps its home shop (designs.orgId, still
-- required); isGlobal = 1 makes it show up in every shop's Designs list, product design pickers and
-- pick-list mapping. Additive.
ALTER TABLE designs ADD COLUMN isGlobal INTEGER NOT NULL DEFAULT 0 CHECK (isGlobal IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_designs_global ON designs(isGlobal);
