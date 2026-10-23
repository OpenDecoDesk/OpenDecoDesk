-- Stitch counts on runs, machine counters and maintenance (2026-10). ADDITIVE.
-- A design version's (and an order-specific design's) stitch count, read from its machine file when it's uploaded, or
-- later from the DESIGNS bucket, or typed in for a format that can't be read. NULL = not known yet.
ALTER TABLE design_versions ADD COLUMN stitchCount INTEGER CHECK (stitchCount IS NULL OR stitchCount >= 0);
ALTER TABLE order_item_designs ADD COLUMN stitchCount INTEGER CHECK (stitchCount IS NULL OR stitchCount >= 0);

-- Each run: the hooping's design stitches (snapshot), and what it added to its machine's counters once it finished or
-- was aborted (NULL = not counted yet / no machine). estimated = 1 when the seconds are a guess (an untimed run).
ALTER TABLE production_runs ADD COLUMN stitchCount INTEGER;
ALTER TABLE production_runs ADD COLUMN stitchesCounted INTEGER;
ALTER TABLE production_runs ADD COLUMN secondsCounted INTEGER;
ALTER TABLE production_runs ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1));

-- A machine's counters: the stitch counter (as the machine's own display would show it, kept in step by entered
-- readings) and its cumulative run time. A cache of machine_counter_events.
ALTER TABLE machines ADD COLUMN stitchCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE machines ADD COLUMN runSeconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE machines ADD COLUMN counterUpdatedAt TEXT;

-- Every change to a machine's counters: a run (done / untimed), an aborted run, or a reading typed from the machine.
-- No FK on machineId, like production_runs: the history outlives a deleted machine.
CREATE TABLE IF NOT EXISTS machine_counter_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machineId         INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('run', 'abort', 'reading')),
  runId             INTEGER,
  stitchesDelta     INTEGER NOT NULL DEFAULT 0,
  secondsDelta      INTEGER NOT NULL DEFAULT 0,
  stitchTotalAfter  INTEGER NOT NULL DEFAULT 0,
  secondsTotalAfter INTEGER NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  note              TEXT NOT NULL DEFAULT '',
  actor             TEXT NOT NULL DEFAULT '',
  at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_counter_events_machine ON machine_counter_events(machineId, at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_events_one_per_run ON machine_counter_events(runId) WHERE runId IS NOT NULL;

-- Per-machine maintenance tasks: due every N seconds of run time and/or every N stitches (whichever comes first),
-- counted from when it was last done (seeded with the counters when the task is created).
CREATE TABLE IF NOT EXISTS machine_maintenance_tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  machineId        INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  everySeconds     INTEGER CHECK (everySeconds IS NULL OR everySeconds > 0),
  everyStitches    INTEGER CHECK (everyStitches IS NULL OR everyStitches > 0),
  notes            TEXT NOT NULL DEFAULT '',
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sortOrder        INTEGER NOT NULL DEFAULT 0,
  lastDoneAt       TEXT,
  lastDoneStitches INTEGER NOT NULL DEFAULT 0,
  lastDoneSeconds  INTEGER NOT NULL DEFAULT 0,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL,
  CHECK (everySeconds IS NOT NULL OR everyStitches IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_maint_tasks_machine ON machine_maintenance_tasks(machineId, sortOrder);

-- What was done and when, with the counters at that moment. taskId NULL = other work, not a listed task.
CREATE TABLE IF NOT EXISTS machine_maintenance_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machineId     INTEGER NOT NULL,
  machineName   TEXT NOT NULL DEFAULT '',
  taskId        INTEGER,
  taskName      TEXT NOT NULL DEFAULT '',
  doneAt        TEXT NOT NULL,
  stitchCountAt INTEGER NOT NULL DEFAULT 0,
  runSecondsAt  INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maint_log_machine ON machine_maintenance_log(machineId, doneAt);
