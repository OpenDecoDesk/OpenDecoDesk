-- Production run management: the machine catalog and each machine's LIVE state (its
-- current hoop, and what thread is physically on each needle right now).
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================

-- ipAddress/embDir are used only by the local send-agent (a separate program) to send a
-- design file to the machine -- a Worker can't reach a machine's private LAN IP, so
-- these are never read server-side, just stored for the agent.
CREATE TABLE IF NOT EXISTS machines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL DEFAULT '',
  needleCount    INTEGER NOT NULL DEFAULT 1 CHECK (needleCount > 0),
  ipAddress      TEXT NOT NULL DEFAULT '',
  embDir         TEXT NOT NULL DEFAULT '/EMB',
  currentHoopId  INTEGER REFERENCES hoops(id),
  notes          TEXT NOT NULL DEFAULT '',
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);

-- Which hoops a machine supports -- the Run Order screen only offers a machine a job whose
-- design's required hoop is in this set.
CREATE TABLE IF NOT EXISTS machine_hoops (
  machineId  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  hoopId     INTEGER NOT NULL REFERENCES hoops(id),
  PRIMARY KEY (machineId, hoopId)
);

-- The machine's LIVE state: what thread is physically loaded on each needle right now. Sparse --
-- a needle with nothing loaded just has no row (or threadId IS NULL). Kept up to date by hand
-- on the Machines screen.
CREATE TABLE IF NOT EXISTS machine_needles (
  machineId  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  needle     INTEGER NOT NULL CHECK (needle > 0),
  threadId   INTEGER REFERENCES threads(id),
  updatedAt  TEXT NOT NULL,
  PRIMARY KEY (machineId, needle)
);
