-- Needle settings: the recommended needle shown on Run Order.
-- ===========================================================================================
-- A needle recommendation has two halves that come from different places:
--   * SIZE follows the THREAD — needle_sizes maps a thread weight (threads.weight, e.g. '40') to a
--     needle size ('75/11'). Edited from admin → Threads → Needle settings.
--   * TYPE follows the GARMENT — needle_types is a small shared list (Sharp, Ballpoint, ...) and
--     each blank picks one (blanks.needleTypeId). Edited from the same window; picked on the blank.
-- All global (no orgId), like the thread and hoop catalogs.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS needle_sizes (
  weight      TEXT PRIMARY KEY,
  needleSize  TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

INSERT OR IGNORE INTO needle_sizes (weight, needleSize, createdAt, updatedAt) VALUES
  ('40', '75/11', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('60', '65/9',  '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS needle_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_needle_types_name ON needle_types(name COLLATE NOCASE);

INSERT OR IGNORE INTO needle_types (name, sortOrder, createdAt, updatedAt) VALUES
  ('Sharp',     1, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('Ballpoint', 2, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');

-- NULL = not set yet (Run Order says so). No ON DELETE action: a type in use can't be deleted.
ALTER TABLE blanks ADD COLUMN needleTypeId INTEGER REFERENCES needle_types(id);
