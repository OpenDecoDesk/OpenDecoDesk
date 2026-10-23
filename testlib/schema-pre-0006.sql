-- FROZEN FIXTURE: schema.sql as it was just before migrations/0006 (money as
-- REAL dollars, '' dates). test33 builds a database from this, seeds it, applies
-- 0006, and checks nothing was lost. Do not edit to track newer schema changes.

-- OpenDecoDesk — Cloudflare D1 schema

CREATE TABLE IF NOT EXISTS orgs (
  orgId               TEXT PRIMARY KEY,
  subdomain           TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  eyebrow             TEXT NOT NULL DEFAULT '',
  accent              TEXT NOT NULL DEFAULT '#2563eb',
  desc                TEXT NOT NULL DEFAULT '',
  ready               INTEGER NOT NULL DEFAULT 0,
  shippingEnabled     INTEGER NOT NULL DEFAULT 0,
  enabledPayments     TEXT NOT NULL DEFAULT '{"card":true,"venmo":true,"zelle":true,"check":true}',
  orderDeadline            TEXT DEFAULT NULL,
  closedMessage            TEXT DEFAULT NULL,
  allowOrdersAfterDeadline INTEGER NOT NULL DEFAULT 1,
  designImageShirt    TEXT NOT NULL DEFAULT '',
  designImageCap      TEXT NOT NULL DEFAULT '',
  designImageDetail   TEXT NOT NULL DEFAULT '',
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  productId               TEXT NOT NULL,
  orgId                   TEXT NOT NULL REFERENCES orgs(orgId),
  type                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  sub                     TEXT NOT NULL DEFAULT '',
  weightOz                REAL DEFAULT NULL,
  personalizationPrice    REAL DEFAULT NULL,
  personalizationOptions  TEXT NOT NULL DEFAULT '[]',
  pricingMode             TEXT NOT NULL DEFAULT 'sized',
  flatPrice               REAL DEFAULT NULL,
  sizePricing             TEXT NOT NULL DEFAULT '{}',
  imagesJson              TEXT NOT NULL DEFAULT '[]',
  featuresJson            TEXT NOT NULL DEFAULT '[]',
  visible                 INTEGER NOT NULL DEFAULT 1,
  sortOrder               INTEGER NOT NULL DEFAULT 0,
  createdAt               TEXT NOT NULL,
  updatedAt               TEXT NOT NULL,
  PRIMARY KEY (orgId, productId)
);

CREATE TABLE IF NOT EXISTS global_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  orderId             TEXT PRIMARY KEY,
  orgId               TEXT NOT NULL,
  customerName        TEXT NOT NULL,
  contact             TEXT NOT NULL,
  paymentMethod       TEXT NOT NULL DEFAULT '',
  paid                INTEGER NOT NULL DEFAULT 0,
  paidAt              TEXT NOT NULL DEFAULT '',
  refundedAt          TEXT NOT NULL DEFAULT '',
  disputeStatus       TEXT NOT NULL DEFAULT '',
  subtotal            REAL NOT NULL DEFAULT 0,
  shippingCost        REAL NOT NULL DEFAULT 0,
  total               REAL NOT NULL DEFAULT 0,
  shippingMethod      TEXT NOT NULL DEFAULT '',
  shippingAddress     TEXT DEFAULT NULL,
  totalWeightOz       REAL NOT NULL DEFAULT 0,
  parcelLength        REAL NOT NULL DEFAULT 0,
  parcelWidth         REAL NOT NULL DEFAULT 0,
  parcelHeight        REAL NOT NULL DEFAULT 0,
  shippingPaidAmount  REAL NOT NULL DEFAULT 0,
  discountAmount      REAL NOT NULL DEFAULT 0,
  discountNote        TEXT NOT NULL DEFAULT '',
  trackingNumber      TEXT NOT NULL DEFAULT '',
  receivedEmailAt     TEXT NOT NULL DEFAULT '',
  confirmedEmailAt    TEXT NOT NULL DEFAULT '',
  blankOrderedAt      TEXT NOT NULL DEFAULT '',
  blankVendor         TEXT NOT NULL DEFAULT '',
  blankVendorOrderId  TEXT NOT NULL DEFAULT '',
  blankEstDelivery    TEXT NOT NULL DEFAULT '',
  blankReceivedAt          TEXT NOT NULL DEFAULT '',
  blankCondition           TEXT NOT NULL DEFAULT '',
  manufacturedAt           TEXT NOT NULL DEFAULT '',
  digitizingCompleteAt     TEXT NOT NULL DEFAULT '',
  designApprovedAt         TEXT NOT NULL DEFAULT '',
  qaPackedAt               TEXT NOT NULL DEFAULT '',
  shippedAt                TEXT NOT NULL DEFAULT '',
  deliveredAt              TEXT NOT NULL DEFAULT '',
  placedAt                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId             TEXT NOT NULL REFERENCES orders(orderId),
  orgId               TEXT NOT NULL,
  productId           TEXT NOT NULL DEFAULT '',
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  size                TEXT NOT NULL DEFAULT '',
  qty                 INTEGER NOT NULL DEFAULT 1,
  unitPrice           REAL NOT NULL DEFAULT 0,
  personalized        INTEGER NOT NULL DEFAULT 0,
  persName            TEXT NOT NULL DEFAULT '',
  personalizationFee  REAL NOT NULL DEFAULT 0,
  lineTotal           REAL NOT NULL DEFAULT 0,
  cancelDate          TEXT NOT NULL DEFAULT '',
  cancelReason        TEXT NOT NULL DEFAULT '',
  lateCancel          INTEGER NOT NULL DEFAULT 0,
  refundDate          TEXT NOT NULL DEFAULT '',
  refundAmount        REAL DEFAULT NULL,
  blankCondition      TEXT NOT NULL DEFAULT '',
  blankConditionNote  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS design_verifications (
  token              TEXT PRIMARY KEY,
  orgId              TEXT NOT NULL,
  orderId            TEXT NOT NULL,
  customerEmail      TEXT NOT NULL,
  customerName       TEXT NOT NULL DEFAULT '',
  message            TEXT NOT NULL DEFAULT '',
  imagesJson         TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'pending',
  customerNote       TEXT NOT NULL DEFAULT '',
  customerImagesJson TEXT NOT NULL DEFAULT '[]',
  sentAt             TEXT NOT NULL,
  respondedAt        TEXT NOT NULL DEFAULT '',
  uploadCount        INTEGER NOT NULL DEFAULT 0
);

-- Legacy inventory table (superseded by blanks/blank_sizes — kept for existing data)
CREATE TABLE IF NOT EXISTS inventory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  productType   TEXT NOT NULL DEFAULT '',
  vendor        TEXT NOT NULL DEFAULT '',
  brand         TEXT NOT NULL DEFAULT '',
  sku           TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '',
  size          TEXT NOT NULL DEFAULT '',
  purchasePrice REAL NOT NULL DEFAULT 0,
  quantity      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

-- Blank catalog — one row per style/color (e.g. "Gildan 18500 Hoodie, Sport Grey")
CREATE TABLE IF NOT EXISTS blanks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL DEFAULT '',
  productType  TEXT NOT NULL DEFAULT '',
  vendor       TEXT NOT NULL DEFAULT '',
  brand        TEXT NOT NULL DEFAULT '',
  sku          TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL
);

-- Per-size stock and purchase price for each blank
CREATE TABLE IF NOT EXISTS blank_sizes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId       INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  size          TEXT NOT NULL DEFAULT '',
  purchasePrice REAL NOT NULL DEFAULT 0,
  quantity      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (blankId, size)
);

-- Links org product sizes to specific blank sizes (for inventory tracking)
CREATE TABLE IF NOT EXISTS product_blank_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId       TEXT NOT NULL,
  productId   TEXT NOT NULL,
  productSize TEXT NOT NULL DEFAULT '',
  blankId     INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  blankSize   TEXT NOT NULL DEFAULT '',
  UNIQUE (orgId, productId, productSize)
);

-- Payment records — one row per actual payment received (supports partial payments)
CREATE TABLE IF NOT EXISTS order_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId    TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  amount     REAL NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  receivedAt TEXT NOT NULL,
  externalRef TEXT NOT NULL DEFAULT ''   -- e.g. Stripe PaymentIntent id; UNIQUE when set
);

-- Stripe webhook events already processed (idempotency — see stripe-webhook.js)
CREATE TABLE IF NOT EXISTS stripe_events (
  eventId     TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT '',
  orderId     TEXT,
  processedAt TEXT NOT NULL
);

-- Org-specific ready-to-ship finished inventory (decorated items on hand, immediately shippable)
CREATE TABLE IF NOT EXISTS ready_to_ship (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId     TEXT NOT NULL,
  productId TEXT NOT NULL,
  size      TEXT NOT NULL DEFAULT '',
  quantity  INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  UNIQUE (orgId, productId, size)
);

-- Migrations: run once on existing databases
-- ALTER TABLE orders ADD COLUMN shippingPaidAmount REAL NOT NULL DEFAULT 0;
-- ALTER TABLE orders ADD COLUMN discountAmount REAL NOT NULL DEFAULT 0;
-- ALTER TABLE orders ADD COLUMN discountNote TEXT NOT NULL DEFAULT '';
-- (blanks/blank_sizes/product_blank_links/order_payments/ready_to_ship: run full CREATE TABLE statements above — IF NOT EXISTS is safe)

CREATE INDEX IF NOT EXISTS idx_orders_org      ON orders(orgId, placedAt DESC);
CREATE INDEX IF NOT EXISTS idx_items_order     ON order_items(orderId);
CREATE INDEX IF NOT EXISTS idx_items_org       ON order_items(orgId);
CREATE INDEX IF NOT EXISTS idx_products_org    ON products(orgId, visible, sortOrder);
CREATE INDEX IF NOT EXISTS idx_verif_order     ON design_verifications(orderId);
CREATE INDEX IF NOT EXISTS idx_inventory_type  ON inventory(productType, size);
CREATE INDEX IF NOT EXISTS idx_blanks_type     ON blanks(productType);
CREATE INDEX IF NOT EXISTS idx_blank_sizes     ON blank_sizes(blankId);
CREATE INDEX IF NOT EXISTS idx_prod_blank_link ON product_blank_links(orgId, productId);
CREATE INDEX IF NOT EXISTS idx_payments_order  ON order_payments(orderId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_ref ON order_payments(externalRef) WHERE externalRef <> '';
CREATE INDEX IF NOT EXISTS idx_rts_org         ON ready_to_ship(orgId, productId);

-- Default global settings
INSERT OR IGNORE INTO global_settings (key, value)
VALUES ('enabledPayments', '{"card":true,"venmo":true,"zelle":true,"check":true}');

-- Audit log — admin changes to orders (see migrations/0002 and 0004)
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT    NOT NULL,
  orgId     TEXT,
  orderId   TEXT,
  action    TEXT    NOT NULL,
  detail    TEXT,             -- JSON: what changed (before/after where relevant)
  actor     TEXT,             -- Access email, "session:<8 hex>", or "passphrase"
  ip        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_createdAt ON audit_log(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_orgId     ON audit_log(orgId);
CREATE INDEX IF NOT EXISTS idx_audit_log_orderId   ON audit_log(orderId);

-- Rate-limit counters (see migrations/0005 and functions/_lib/rateLimit.js)
CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expiresAt);
