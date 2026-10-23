-- 0030_production_runs.sql
-- Run tracking for the Run Order screen: a row per physical piece actually run on a machine, with
-- start/finish times, plus a small managed list of abort reasons. A running row (status='running',
-- finishedAt IS NULL) is the single source of truth for both "this piece is in progress" and "this
-- machine is busy" — there's no busy flag on machines. machineName/designName/abortReasonLabel are
-- snapshots so the run-time report survives a machine/design/reason later renamed or deleted, which
-- is why machineId/abortReasonId carry no FK.

CREATE TABLE IF NOT EXISTS run_abort_reasons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  label     TEXT NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS production_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId            TEXT NOT NULL,
  orderId          TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  itemId           INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  machineId        INTEGER,
  machineName      TEXT NOT NULL DEFAULT '',
  designId         INTEGER,
  designVersionId  INTEGER,
  designName       TEXT NOT NULL DEFAULT '',
  startedAt        TEXT NOT NULL,
  finishedAt       TEXT,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'aborted')),
  abortReasonId    INTEGER,
  abortReasonLabel TEXT NOT NULL DEFAULT '',
  abortNote        TEXT NOT NULL DEFAULT '',
  createdAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON production_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_machine ON production_runs(machineId, status);
CREATE INDEX IF NOT EXISTS idx_runs_item    ON production_runs(itemId);
CREATE INDEX IF NOT EXISTS idx_runs_design  ON production_runs(designId);

-- Seed the starter abort reasons; "Machine problem" is the default (sortOrder 0).
INSERT INTO run_abort_reasons (label, sortOrder, createdAt, updatedAt) VALUES
  ('Machine problem',      0, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z'),
  ('Thread break',         1, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z'),
  ('Design issue',         2, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z'),
  ('Blank/garment defect', 3, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z'),
  ('Operator error',       4, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z'),
  ('Other',                5, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z');
