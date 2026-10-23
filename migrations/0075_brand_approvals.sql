-- Brand rules (2026-10): a supplier's restricted brands (The North Face, Carhartt, Nike, …) need the supplier's logo
-- approval for large orders. One row per product + brand — the logo on that product is what the supplier reviews — with
-- the supplier's reply (a PDF of the email, …) in the private receipts bucket. Revoked, never deleted. The rules themselves are a
-- setting (global_settings.brandRules). Additive.
CREATE TABLE IF NOT EXISTS brand_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId       TEXT    NOT NULL,
  productId   TEXT    NOT NULL,
  brand       TEXT    NOT NULL,
  approvedOn  TEXT    NOT NULL,
  maxQty      INTEGER CHECK (maxQty IS NULL OR maxQty > 0),
  note        TEXT    NOT NULL DEFAULT '',
  fileKey     TEXT    NOT NULL,
  fileName    TEXT    NOT NULL DEFAULT '',
  createdBy   TEXT    NOT NULL DEFAULT '',
  createdAt   TEXT    NOT NULL,
  revokedAt   TEXT,
  revokeNote  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_brand_approvals_product ON brand_approvals(orgId, productId);
