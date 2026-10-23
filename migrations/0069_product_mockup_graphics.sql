-- Embroidered graphics for mockups. A product's embroidery is planned from its designs (product_designs),
-- which have no garment location, so a plain product had nothing to build a mockup of its embroidery from. This
-- list names, per location, the shop's EMBROIDERY graphic (its picture) shown there — for the product form's mockup
-- table and the shop page only. It never reaches an order line, Run Order or the price:
--   [{locationId, graphicId}]  — locationId → the Locations lookup (0041), graphicId → one of the shop's embroidery graphics
-- ADDITIVE ONLY.
ALTER TABLE products ADD COLUMN mockupGraphicsJson TEXT NOT NULL DEFAULT '[]';
