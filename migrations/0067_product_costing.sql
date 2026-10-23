-- Pricing awareness. The product form shows what each item costs the shop under its price — blank, card
-- processing, sales tax, DTF / transfer, shop supplies — and what's left (income), plus the effective hourly rate
-- when a run time is given. Three optional per-product numbers feed it:
--   runMinutes        — how long one item takes to make, in minutes (blank = unknown; the form also shows the
--                       average of its timed runs when there is one)
--   transferCostCents — DTF / transfer cost per item ON TOP of the transfers already linked (reorder QR, graphics),
--                       for a plain DTF product whose transfer isn't linked
--   suppliesCostCents — overrides the global shop-supplies cost per item (Global settings → Pricing) for a product
--                       that uses more or less
-- The fee rate, supplies default and targets live in global_settings key 'pricing'. ADDITIVE ONLY.
ALTER TABLE products ADD COLUMN runMinutes REAL;
ALTER TABLE products ADD COLUMN transferCostCents INTEGER;
ALTER TABLE products ADD COLUMN suppliesCostCents INTEGER;
