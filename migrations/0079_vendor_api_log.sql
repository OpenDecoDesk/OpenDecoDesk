-- Every call to a connected vendor's web services (2026-10): when, which connection, the SOAP action, what it was
-- about (product / PO), HTTP status, ok or the vendor's error, how long and how big. The full request (password
-- blanked) and response are kept in the private RECEIPTS bucket under vendor-logs/ (`payloadKey`), or inline in
-- `payload` when there's no bucket. Kept 30 days (cleanUpVendorApiLog, daily). ADDITIVE.
CREATE TABLE IF NOT EXISTS vendor_api_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connectionId  INTEGER NOT NULL,
  at            TEXT    NOT NULL,
  context       TEXT    NOT NULL DEFAULT '',
  action        TEXT    NOT NULL DEFAULT '',
  url           TEXT    NOT NULL DEFAULT '',
  subject       TEXT    NOT NULL DEFAULT '',
  httpStatus    INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),
  error         TEXT    NOT NULL DEFAULT '',
  durationMs    INTEGER NOT NULL DEFAULT 0,
  requestBytes  INTEGER NOT NULL DEFAULT 0,
  responseBytes INTEGER NOT NULL DEFAULT 0,
  payloadKey    TEXT    NOT NULL DEFAULT '',
  payload       TEXT    NOT NULL DEFAULT '',
  actor         TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_vendor_api_log_conn ON vendor_api_log(connectionId, id);
CREATE INDEX IF NOT EXISTS idx_vendor_api_log_at ON vendor_api_log(at);
