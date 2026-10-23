-- Sales tax can be ADDED to the listed prices ("exclusive") instead of being included in them
-- ("inclusive", how every order so far was priced). The choice is a store setting
-- (global_settings.salesTax.taxMode); each order keeps the mode it was placed under, like its rate,
-- so changing the setting never re-prices an existing order and reports can mix both.
--   inclusive: lineTotalCents INCLUDES taxCents      -> the customer owes items + shipping - discount
--   exclusive: taxCents is ON TOP of lineTotalCents  -> ... + (items' tax - the discount's tax)
-- ADDITIVE ONLY: apply before deploying the code that uses it.
ALTER TABLE orders ADD COLUMN taxMode TEXT NOT NULL DEFAULT 'inclusive' CHECK (taxMode IN ('inclusive', 'exclusive'));
