-- Global garment-location lookup (Front / Back / Left Chest / Right Chest, admin-editable).
-- ===========================================================================================
-- Configurable products embed locations as free-text {key,label} in products.locationsJson, and
-- graphics.allowedLocationsJson repeats the keys — there's no shared list to pick from. This adds a
-- global catalog (mirrors the hoops/threads pattern, no orgId) that the product config picker and
-- blank color-image tags reference. Referenced by id from products.locationsJson[].locationId and
-- blank_colors.imagesJson[].locationId.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

-- Default list; the shop can add/edit/delete more from admin → Tools → Locations.
INSERT INTO locations (name, sortOrder, createdAt, updatedAt) VALUES
  ('Front',       1, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z'),
  ('Back',        2, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z'),
  ('Left Chest',  3, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z'),
  ('Right Chest', 4, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
