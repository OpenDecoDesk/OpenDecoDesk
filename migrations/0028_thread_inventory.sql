-- Thread inventory: spool-size catalog + per-thread stock.
--
-- spool_sizes is a small shared catalog (like blanks' sizes): a description and a length in
-- whole metres (e.g. "King spool" 1000, "Cone" 5000). thread_inventory is per-thread stock —
-- each thread (a specific brand/type/weight/code) can have several inventory items, each a
-- spool size and how many are on hand, so one thread can stock multiple spool sizes at once.
-- Both are global (no orgId), matching the thread catalog itself.

CREATE TABLE IF NOT EXISTS spool_sizes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL DEFAULT '',
  meters      INTEGER NOT NULL DEFAULT 0 CHECK (meters >= 0),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_inventory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  threadId    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  spoolSizeId INTEGER REFERENCES spool_sizes(id),
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_inventory_thread ON thread_inventory(threadId);
CREATE INDEX IF NOT EXISTS idx_thread_inventory_spool ON thread_inventory(spoolSizeId);
