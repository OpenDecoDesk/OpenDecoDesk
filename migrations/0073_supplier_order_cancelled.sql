-- An order placed with a supplier that was then cancelled with the supplier (2026-10): when, and why. Marking it
-- cancelled takes its PO number off the order lines that haven't shipped or arrived, and stops the shipment checks.
-- Additive.
ALTER TABLE supplier_orders ADD COLUMN cancelledAt TEXT;
ALTER TABLE supplier_orders ADD COLUMN cancelNote TEXT NOT NULL DEFAULT '';
