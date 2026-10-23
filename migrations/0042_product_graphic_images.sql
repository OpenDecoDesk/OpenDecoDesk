-- Per-location graphic × garment-color mockups for configurable products (the storefront preview).
-- ============================================================================================
-- For a configurable product, each
-- (location, graphic, garment color) can have a mockup image — a transparent graphic composited
-- over the blank's color photo at an admin-chosen size/placement. The storefront shows the matching
-- mockup live as the customer picks a color and each location's graphic. placementJson stores the
-- overlay params (base/graphic url + x/y/width %) so the editor can reopen a saved mockup to tweak.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS product_graphic_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId         TEXT NOT NULL,
  productId     TEXT NOT NULL,
  locationId    INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  graphicId     INTEGER NOT NULL REFERENCES graphics(id) ON DELETE CASCADE,
  garmentColor  TEXT NOT NULL DEFAULT '',
  imageUrl      TEXT NOT NULL DEFAULT '',
  thumbUrl      TEXT NOT NULL DEFAULT '',
  placementJson TEXT NOT NULL DEFAULT '{}',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  FOREIGN KEY (orgId, productId) REFERENCES products(orgId, productId) ON DELETE CASCADE,
  UNIQUE (orgId, productId, locationId, graphicId, garmentColor)
);
CREATE INDEX IF NOT EXISTS idx_pgi_product ON product_graphic_images(orgId, productId);
