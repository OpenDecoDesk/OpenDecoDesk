-- Audit log table — tracks admin changes to orders

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT    NOT NULL,
  orgId     TEXT,
  orderId   TEXT,
  action    TEXT    NOT NULL,
  detail    TEXT                    -- JSON blob; human-readable summary of what changed
);

CREATE INDEX IF NOT EXISTS idx_audit_log_createdAt ON audit_log(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_orgId     ON audit_log(orgId);
CREATE INDEX IF NOT EXISTS idx_audit_log_orderId   ON audit_log(orderId);
