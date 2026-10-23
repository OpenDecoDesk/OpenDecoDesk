-- Production run management: a shared thread-color catalog, imported from a thread
-- vendor's own Hatch (.tch) chart export or entered by hand. Global like `blanks` — one shared
-- thread inventory across every shop, not per-org.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS threads (
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
  UNIQUE (brand, code)
);
CREATE INDEX IF NOT EXISTS idx_threads_brand_type_weight ON threads(brand, type, weight);
