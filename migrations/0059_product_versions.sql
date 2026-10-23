-- Versions of a product: a shirt in short and long sleeve, or any two named versions, are two
-- products linked as a pair. Each keeps everything per product — its own sizes and prices, blanks and
-- blank links, garment colors, images, overlay mockups, stock and weight — and the shop page shows the
-- pair as ONE card with a toggle between them.
--   versionGroup — products of one shop sharing a non-empty value are versions of each other ('' = none).
--   versionLabel — what the toggle and the order line call this version, e.g. "Long sleeve".
-- ADDITIVE ONLY: apply before deploying the code that uses it.
ALTER TABLE products ADD COLUMN versionGroup TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN versionLabel TEXT NOT NULL DEFAULT '';
