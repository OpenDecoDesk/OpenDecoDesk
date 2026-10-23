-- Sales-tax scope (what's taxed) and use tax (what's owed on purchases).
-- ===========================================================================
-- * products.taxable / order_items.taxable — a product (or a local-sale custom
--   line) can be non-taxable, e.g. embroidery on a garment the customer
--   supplied (a service where that applies; ask your accountant). The line keeps a snapshot.
-- * Out-of-state shipments are not home-state sales: a line is taxed only when
--   it's taxable, the order isn't tax-exempt, and the order doesn't ship to a
--   state other than the configured jurisdiction (orders.shipState; pickup /
--   hand delivery = in state). Applied in db.js (recomputeOrderTax_), no
--   schema change needed.
-- * Use tax: expense_categories.useTaxable marks purchases that owe
--   use tax when the vendor didn't charge sales tax (goods used by the
--   business); expenses.vendorChargedTax records whether they did (default
--   yes). inventory_movements.vendorChargedTax flags blanks bought for resale
--   that were taxed anyway (they should be bought exempt with a resale certificate).
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

ALTER TABLE products            ADD COLUMN taxable          INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1));
ALTER TABLE order_items         ADD COLUMN taxable          INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1));
ALTER TABLE expense_categories  ADD COLUMN useTaxable       INTEGER NOT NULL DEFAULT 0 CHECK (useTaxable IN (0, 1));
ALTER TABLE expenses            ADD COLUMN vendorChargedTax INTEGER NOT NULL DEFAULT 1 CHECK (vendorChargedTax IN (0, 1));
ALTER TABLE inventory_movements ADD COLUMN vendorChargedTax INTEGER NOT NULL DEFAULT 0 CHECK (vendorChargedTax IN (0, 1));

-- Goods the business buys and uses (taxable when no sales tax was charged).
-- Services, fees, insurance, meals, travel, rent, labor, online advertising
-- and software subscriptions start unmarked; mark whatever owes use tax where you are.
UPDATE expense_categories SET useTaxable = 1
WHERE name IN ('Equipment & machines', 'Supplies (thread, stabilizer, needles)', 'Office expense', 'Repairs & maintenance');
