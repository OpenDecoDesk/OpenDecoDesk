-- Reorder QR code: link straight to a transfer, not to a graphic.
-- ===========================================================================================
-- The reorder QR is a transfer that's applied to the garment automatically — it isn't an option a
-- customer picks, and it needs no picture or mockup. It used to be chosen as a GRAPHIC (which in
-- turn pointed at a transfer); that extra layer is gone:
--   * orgs.reorderQrTransferId  — the shop's default reorder-QR transfer (NULL = none).
--   * products.reorderQr        — 'default' | 'none' | 't<transferId>' (was: a graphic id).
-- Existing choices are carried over to the transfer their graphic used, and the old graphic
-- pointers are cleared so those graphics can be deleted. A choice whose graphic had no transfer
-- (an embroidery graphic) is left as it was and still works the old way.
--
-- ADDITIVE (one new column) + a data carry-over: apply before deploying the code that uses it.
-- ===========================================================================================
ALTER TABLE orgs ADD COLUMN reorderQrTransferId INTEGER REFERENCES transfers(id);

UPDATE orgs
   SET reorderQrTransferId = (SELECT g.transferId FROM graphics g WHERE g.id = orgs.reorderQrGraphicId),
       reorderQrGraphicId = NULL
 WHERE reorderQrGraphicId IS NOT NULL
   AND (SELECT g.transferId FROM graphics g WHERE g.id = orgs.reorderQrGraphicId) IS NOT NULL;

UPDATE products
   SET reorderQr = 't' || (SELECT g.transferId FROM graphics g WHERE g.id = CAST(products.reorderQr AS INTEGER))
 WHERE reorderQr GLOB '[0-9]*' AND reorderQr NOT GLOB '*[^0-9]*'
   AND (SELECT g.transferId FROM graphics g WHERE g.id = CAST(products.reorderQr AS INTEGER)) IS NOT NULL;
