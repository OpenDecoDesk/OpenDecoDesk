-- 0035_refund_shipping_part.sql
-- How much of a refund (or lost dispute) was SHIPPING. Shipping isn't taxed, so that part carries
-- no sales tax: the Sales Tax report backs tax out of only the rest (getSalesTaxRefunds). 0 = all
-- goods, as before. Set when recording a refund, or afterwards on any refund — including card
-- refunds made in Stripe, which arrive through the webhook without it. Additive.
ALTER TABLE order_payments ADD COLUMN shippingCents INTEGER NOT NULL DEFAULT 0 CHECK (shippingCents >= 0);
