-- MAP — the vendor's minimum advertised price — per blank color + size (2026-10). Vendor files carry it: S&S's
-- Products sheet as MAPPrice (0.01 = no MAP), SanMar's SDL file as MAP_PRICING (blank = no MAP); it can also be typed
-- on the blank. PromoStandards' pricing service has no MAP, so a refresh from a connected vendor leaves it alone.
-- A product's price for a size may not be below the MAP of the blank sizes it's linked to (enforced when a product is
-- saved and when a blank is linked; products that fall below after a MAP change are flagged). NULL = no MAP. ADDITIVE.
ALTER TABLE blank_sizes ADD COLUMN mapPriceCents INTEGER CHECK (mapPriceCents IS NULL OR mapPriceCents >= 0);
