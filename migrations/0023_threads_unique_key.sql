-- Production run management: the thread catalog's uniqueness was (brand, code)
-- only, but a thread code is only unique WITHIN a given type+weight line (e.g. Madeira PolyNeon
-- 40 code 1538 and Madeira Rayon 40 code 1538 are different, real threads) -- so two distinct
-- threads with the same code but different type/weight collided under the old constraint.
-- Widen the unique key to (brand, type, weight, code).
--
-- SQLite can't ALTER a UNIQUE constraint in place -- rebuild the table (no FKs reference
-- `threads` yet, so this is a plain rename/recreate/copy/drop, no cascade ordering to worry
-- about, same as every other rebuild migration in this repo -- see 0006's header).
-- ===========================================================================

ALTER TABLE threads RENAME TO threads_old_0023;

CREATE TABLE threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brand       TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  weight      TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  colorHex    TEXT NOT NULL DEFAULT '' CHECK (colorHex = '' OR (length(colorHex) = 6)),
  sourceFlag  TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  UNIQUE (brand, type, weight, code)
);

INSERT INTO threads (id, brand, type, weight, code, name, colorHex, sourceFlag, notes, createdAt, updatedAt)
  SELECT id, brand, type, weight, code, name, colorHex, sourceFlag, notes, createdAt, updatedAt FROM threads_old_0023;

DROP TABLE threads_old_0023;

CREATE INDEX IF NOT EXISTS idx_threads_brand_type_weight ON threads(brand, type, weight);
