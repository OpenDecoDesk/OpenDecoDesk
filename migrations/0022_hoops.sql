-- Production run management: a global hoop catalog — so a design's required hoop and
-- a machine's supported hoops both reference one shared list, not free text.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS hoops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  widthMm     REAL,
  heightMm    REAL,
  isCapFrame  INTEGER NOT NULL DEFAULT 0 CHECK (isCapFrame IN (0, 1)),
  notes       TEXT NOT NULL DEFAULT '',
  sortOrder   INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
