-- 0031_order_inserted_at_one_run_per_machine.sql
--
-- 1. orders.insertedAt — when the row was written. The 6 AM roll-up tracks "what's new since the
--    last email" by it. It used SQLite's implicit rowid, which a VACUUM or a table-rebuild
--    migration (like 0006) can renumber, so the roll-up could skip or repeat orders. placedAt can't be
--    used instead: local sales and backdated orders are inserted with a past placedAt.
--    Set by a trigger, so every path that inserts an order gets it without code changes. Existing
--    rows are backfilled with placedAt (the digest's one-time switch-over doesn't rely on that — see
--    getOrdersForDigest). A future migration that REBUILDS orders must recreate this trigger.
ALTER TABLE orders ADD COLUMN insertedAt TEXT;
UPDATE orders SET insertedAt = placedAt WHERE insertedAt IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_inserted ON orders(insertedAt, orderId);
CREATE TRIGGER IF NOT EXISTS orders_set_inserted_at AFTER INSERT ON orders
  WHEN NEW.insertedAt IS NULL
BEGIN
  UPDATE orders SET insertedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE orderId = NEW.orderId;
END;

-- 2. At most one RUNNING job per machine. startProductionRun checks first, but two
--    Starts at the same moment could both pass the check; this makes the second INSERT fail.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_machine
  ON production_runs(machineId) WHERE status = 'running' AND machineId IS NOT NULL;
