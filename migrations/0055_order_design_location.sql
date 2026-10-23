-- A line's order-specific designs (order_item_designs, migrations/0032) can be one per LOCATION: a
-- configurable item can carry the customer's own stitched design at several locations (migrations/0054),
-- and each is digitized into its own stitch file. `location` is the location key in the line's copy of
-- its options (configJson); '' is the line's one design as before (a typed-in name, or the customer's
-- design on an ordinary product uploaded before this column). Newest upload per location wins.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
ALTER TABLE order_item_designs ADD COLUMN location TEXT NOT NULL DEFAULT '';
