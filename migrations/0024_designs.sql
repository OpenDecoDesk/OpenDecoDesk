-- Production run management: embroidery designs — files, version history, a required
-- hoop, a thread-color map, one design per product, and per-line-item customization uploads.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

-- One design per product (the product-facing record). stabilizer/hoopId live here, not per
-- version, since they're properties of the design's placement, not of one file revision.
CREATE TABLE IF NOT EXISTS designs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId       TEXT NOT NULL REFERENCES orgs(orgId),
  name        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  stabilizer  TEXT NOT NULL DEFAULT '',
  hoopId      INTEGER REFERENCES hoops(id),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_designs_org ON designs(orgId);

-- Append-only file history for a design. The "current" version is just the newest row
-- (MAX(uploadedAt) per designId) — nothing needs updating in place on a new upload.
-- threadColorsJson: an ORDERED array of {needle, threadId} — needle position is this design's
-- own color-change sequence (1-based), referencing threads.id; matched against a machine's
-- live needle state (machines: migrations/0025).
CREATE TABLE IF NOT EXISTS design_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  designId         INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  fileKey          TEXT NOT NULL DEFAULT '',
  fileName         TEXT NOT NULL DEFAULT '',
  fileExt          TEXT NOT NULL DEFAULT '',
  threadColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(threadColorsJson)),
  notes            TEXT NOT NULL DEFAULT '',
  uploadedAt       TEXT NOT NULL,
  createdAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_versions_design ON design_versions(designId, uploadedAt);

-- One design per product — nullable, additive.
ALTER TABLE products ADD COLUMN designId INTEGER REFERENCES designs(id);

-- Per-line-item customization uploads (images or embroidery files) — deliberately separate from
-- design_verifications (that flow is one admin-mockup/customer-reply exchange per whole order,
-- expires after 60 days; this is per line item and persists for the life of the order).
CREATE TABLE IF NOT EXISTS order_item_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  itemId      INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  fileKey     TEXT NOT NULL DEFAULT '',
  fileName    TEXT NOT NULL DEFAULT '',
  fileExt     TEXT NOT NULL DEFAULT '',
  uploadedBy  TEXT NOT NULL DEFAULT 'admin' CHECK (uploadedBy IN ('admin', 'customer')),
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_item_files_item ON order_item_files(itemId);
