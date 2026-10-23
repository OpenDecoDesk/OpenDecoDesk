-- Printed transfers (DTF) that are part of a product. A product — configurable or not — can carry
-- DTFs at fixed locations that the customer doesn't pick and that are already in its price: e.g. a club crest
-- on the back of a shirt whose front is embroidered. Stored as a list on the product:
--   [{locationId, graphicId, ink}]  — locationId → the Locations lookup (0041), graphicId → one of the shop's
--                                     TRANSFER graphics (its picture + the transfer stock it uses), ink '' or one
--                                     of the graphic's ink colors
-- Every order line of the product gets one snapshot entry per item (kind 'transfer', fixed: true, $0 add-on), so
-- Run Transfer Sheets, transfer stock and COGS handle it like the reorder QR. ADDITIVE ONLY.
ALTER TABLE products ADD COLUMN fixedTransfersJson TEXT NOT NULL DEFAULT '[]';
