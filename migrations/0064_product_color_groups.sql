-- Products priced by COLOR PRICE GROUP. Some colors of a blank cost the shop more (heathers) or
-- less (white), so a product's colors can be grouped, each group with its own price per size:
-- [{key, label, colors: [...], sizePricingCents: {size: cents}} | {…, flatPriceCents}]. A color in no group is
-- priced by the product's own sizePricingCents / flatPriceCents (the "Standard" group). Empty = one price
-- per size for every color, as before. Only products with garment colors (configurable) use it. Additive.
ALTER TABLE products ADD COLUMN colorGroupsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(colorGroupsJson));
