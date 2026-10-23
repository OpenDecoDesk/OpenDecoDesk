-- Ledger integrity rebuild.
-- ===========================================================================
-- Rebuilds the money-carrying tables so that:
--   1. Money is INTEGER CENTS (columns renamed *Cents), not floating-point REAL.
--   2. "Not set" dates are NULL, not ''.
--   3. Foreign keys + CHECK constraints guard against orphaned or invalid rows
--      (negative amounts, qty 0, unknown org, bad status values).
--   4. Ship-to state/ZIP are real, indexed columns (generated from the
--      shippingAddress JSON, so they can never drift from it) for sales-tax
--      reporting by jurisdiction.
-- Also backfills orders.paidAt for paid orders that never recorded one, from
-- their latest payment's receivedAt.
--
-- HOW: SQLite can't change column types/constraints in place, so each table is
-- renamed to *_old, recreated, copied, and the old copy dropped. Renaming the
-- PARENT table (orders) makes SQLite rewrite the old children's foreign keys
-- to point at orders_old, so dropping the old tables can never cascade into the
-- new ones. D1 runs the whole file in one transaction: any error rolls it all
-- back. defer_foreign_keys postpones FK checks to commit.
--
-- REHEARSE a rebuild like this against a full export of the live database before
-- applying it, comparing every row count and every amount (as cents) before/after.
-- The application code that reads these columns ships with it.
-- ===========================================================================

PRAGMA defer_foreign_keys = true;

ALTER TABLE order_payments       RENAME TO order_payments_old;
ALTER TABLE design_verifications RENAME TO design_verifications_old;
ALTER TABLE order_items          RENAME TO order_items_old;
ALTER TABLE orders               RENAME TO orders_old;
ALTER TABLE products             RENAME TO products_old;
ALTER TABLE blank_sizes          RENAME TO blank_sizes_old;

-- ---- orders ---------------------------------------------------------------
CREATE TABLE orders (
  orderId             TEXT PRIMARY KEY,
  orgId               TEXT NOT NULL REFERENCES orgs(orgId),
  customerName        TEXT NOT NULL,
  contact             TEXT NOT NULL,
  paymentMethod       TEXT NOT NULL DEFAULT '',
  -- Cached from the payments ledger by refreshPaidStatus() in db.js — the
  -- ledger (order_payments) is the source of truth.
  paid                INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  paidAt              TEXT,
  refundedAt          TEXT,
  disputeStatus       TEXT NOT NULL DEFAULT '',
  subtotalCents       INTEGER NOT NULL DEFAULT 0 CHECK (subtotalCents >= 0),
  shippingCostCents   INTEGER NOT NULL DEFAULT 0 CHECK (shippingCostCents >= 0),
  totalCents          INTEGER NOT NULL DEFAULT 0 CHECK (totalCents >= 0),
  shippingMethod      TEXT NOT NULL DEFAULT '',
  shippingAddress     TEXT CHECK (shippingAddress IS NULL OR json_valid(shippingAddress)),
  shipState           TEXT GENERATED ALWAYS AS (
                        CASE WHEN json_valid(shippingAddress)
                             THEN upper(trim(json_extract(shippingAddress, '$.state'))) END) VIRTUAL,
  shipZip             TEXT GENERATED ALWAYS AS (
                        CASE WHEN json_valid(shippingAddress)
                             THEN substr(trim(json_extract(shippingAddress, '$.zip')), 1, 5) END) VIRTUAL,
  totalWeightOz       REAL NOT NULL DEFAULT 0 CHECK (totalWeightOz >= 0),
  parcelLength        REAL NOT NULL DEFAULT 0,
  parcelWidth         REAL NOT NULL DEFAULT 0,
  parcelHeight        REAL NOT NULL DEFAULT 0,
  shippingPaidCents   INTEGER NOT NULL DEFAULT 0 CHECK (shippingPaidCents >= 0),
  discountCents       INTEGER NOT NULL DEFAULT 0 CHECK (discountCents >= 0),
  discountNote        TEXT NOT NULL DEFAULT '',
  trackingNumber      TEXT NOT NULL DEFAULT '',
  receivedEmailAt     TEXT,
  confirmedEmailAt    TEXT,
  blankOrderedAt      TEXT,
  blankVendor         TEXT NOT NULL DEFAULT '',
  blankVendorOrderId  TEXT NOT NULL DEFAULT '',
  blankEstDelivery    TEXT,
  blankReceivedAt     TEXT,
  blankCondition      TEXT NOT NULL DEFAULT '',
  manufacturedAt      TEXT,
  digitizingCompleteAt TEXT,
  designApprovedAt    TEXT,
  qaPackedAt          TEXT,
  shippedAt           TEXT,
  deliveredAt         TEXT,
  placedAt            TEXT NOT NULL
);

INSERT INTO orders (
  orderId, orgId, customerName, contact, paymentMethod, paid, paidAt, refundedAt, disputeStatus,
  subtotalCents, shippingCostCents, totalCents, shippingMethod, shippingAddress, totalWeightOz,
  parcelLength, parcelWidth, parcelHeight, shippingPaidCents, discountCents, discountNote,
  trackingNumber, receivedEmailAt, confirmedEmailAt, blankOrderedAt, blankVendor, blankVendorOrderId,
  blankEstDelivery, blankReceivedAt, blankCondition, manufacturedAt, digitizingCompleteAt,
  designApprovedAt, qaPackedAt, shippedAt, deliveredAt, placedAt)
SELECT
  o.orderId, o.orgId, o.customerName, o.contact, o.paymentMethod, o.paid,
  -- paidAt: keep a real one; backfill from the latest payment for paid orders missing it.
  COALESCE(NULLIF(o.paidAt, ''),
           CASE WHEN o.paid = 1 THEN (SELECT max(p.receivedAt) FROM order_payments_old p WHERE p.orderId = o.orderId) END),
  NULLIF(o.refundedAt, ''), o.disputeStatus,
  CAST(round(o.subtotal * 100) AS INTEGER), CAST(round(o.shippingCost * 100) AS INTEGER),
  CAST(round(o.total * 100) AS INTEGER), o.shippingMethod, o.shippingAddress, o.totalWeightOz,
  o.parcelLength, o.parcelWidth, o.parcelHeight,
  CAST(round(o.shippingPaidAmount * 100) AS INTEGER), CAST(round(o.discountAmount * 100) AS INTEGER),
  o.discountNote, o.trackingNumber,
  NULLIF(o.receivedEmailAt, ''), NULLIF(o.confirmedEmailAt, ''), NULLIF(o.blankOrderedAt, ''),
  o.blankVendor, o.blankVendorOrderId, NULLIF(o.blankEstDelivery, ''), NULLIF(o.blankReceivedAt, ''),
  o.blankCondition, NULLIF(o.manufacturedAt, ''), NULLIF(o.digitizingCompleteAt, ''),
  NULLIF(o.designApprovedAt, ''), NULLIF(o.qaPackedAt, ''), NULLIF(o.shippedAt, ''),
  NULLIF(o.deliveredAt, ''), o.placedAt
FROM orders_old o;

-- ---- order_items ------------------------------------------------------------
-- productId is deliberately NOT a foreign key: admin local sales can carry a
-- custom (non-catalog) item, and historical rows must survive product edits.
CREATE TABLE order_items (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId                 TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  orgId                   TEXT NOT NULL,
  productId               TEXT NOT NULL DEFAULT '',
  name                    TEXT NOT NULL,
  type                    TEXT NOT NULL,
  size                    TEXT NOT NULL DEFAULT '',
  qty                     INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  unitPriceCents          INTEGER NOT NULL DEFAULT 0 CHECK (unitPriceCents >= 0),
  personalized            INTEGER NOT NULL DEFAULT 0 CHECK (personalized IN (0, 1)),
  persName                TEXT NOT NULL DEFAULT '',
  personalizationFeeCents INTEGER NOT NULL DEFAULT 0 CHECK (personalizationFeeCents >= 0),
  lineTotalCents          INTEGER NOT NULL DEFAULT 0 CHECK (lineTotalCents >= 0),
  cancelDate              TEXT,
  cancelReason            TEXT NOT NULL DEFAULT '',
  lateCancel              INTEGER NOT NULL DEFAULT 0 CHECK (lateCancel IN (0, 1)),
  refundDate              TEXT,
  refundCents             INTEGER CHECK (refundCents IS NULL OR refundCents >= 0),
  blankCondition          TEXT NOT NULL DEFAULT '',
  blankConditionNote      TEXT NOT NULL DEFAULT ''
);

INSERT INTO order_items (
  id, orderId, orgId, productId, name, type, size, qty, unitPriceCents, personalized, persName,
  personalizationFeeCents, lineTotalCents, cancelDate, cancelReason, lateCancel, refundDate,
  refundCents, blankCondition, blankConditionNote)
SELECT
  id, orderId, orgId, productId, name, type, size, qty, CAST(round(unitPrice * 100) AS INTEGER),
  personalized, persName, CAST(round(personalizationFee * 100) AS INTEGER),
  CAST(round(lineTotal * 100) AS INTEGER), NULLIF(cancelDate, ''), cancelReason, lateCancel,
  NULLIF(refundDate, ''), CASE WHEN refundAmount IS NULL THEN NULL ELSE CAST(round(refundAmount * 100) AS INTEGER) END,
  blankCondition, blankConditionNote
FROM order_items_old;

-- ---- order_payments (the ledger) -------------------------------------------
-- amountCents <> 0 rather than > 0 so refunds can later be recorded as
-- negative ledger rows without another rebuild.
CREATE TABLE order_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId     TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  amountCents INTEGER NOT NULL CHECK (amountCents <> 0),
  note        TEXT NOT NULL DEFAULT '',
  receivedAt  TEXT NOT NULL,
  externalRef TEXT NOT NULL DEFAULT ''
);

INSERT INTO order_payments (id, orderId, amountCents, note, receivedAt, externalRef)
SELECT id, orderId, CAST(round(amount * 100) AS INTEGER), note, receivedAt, externalRef
FROM order_payments_old;

-- ---- design_verifications ---------------------------------------------------
CREATE TABLE design_verifications (
  token              TEXT PRIMARY KEY,
  orgId              TEXT NOT NULL,
  orderId            TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  customerEmail      TEXT NOT NULL,
  customerName       TEXT NOT NULL DEFAULT '',
  message            TEXT NOT NULL DEFAULT '',
  imagesJson         TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revision')),
  customerNote       TEXT NOT NULL DEFAULT '',
  customerImagesJson TEXT NOT NULL DEFAULT '[]',
  sentAt             TEXT NOT NULL,
  respondedAt        TEXT,
  uploadCount        INTEGER NOT NULL DEFAULT 0 CHECK (uploadCount >= 0)
);

INSERT INTO design_verifications (
  token, orgId, orderId, customerEmail, customerName, message, imagesJson, status,
  customerNote, customerImagesJson, sentAt, respondedAt, uploadCount)
SELECT token, orgId, orderId, customerEmail, customerName, message, imagesJson, status,
  customerNote, customerImagesJson, sentAt, NULLIF(respondedAt, ''), uploadCount
FROM design_verifications_old;

-- ---- products (catalog prices) ---------------------------------------------
CREATE TABLE products (
  productId                 TEXT NOT NULL,
  orgId                     TEXT NOT NULL REFERENCES orgs(orgId),
  type                      TEXT NOT NULL,
  name                      TEXT NOT NULL,
  sub                       TEXT NOT NULL DEFAULT '',
  weightOz                  REAL DEFAULT NULL CHECK (weightOz IS NULL OR weightOz >= 0),
  personalizationPriceCents INTEGER DEFAULT NULL CHECK (personalizationPriceCents IS NULL OR personalizationPriceCents >= 0),
  personalizationOptions    TEXT NOT NULL DEFAULT '[]',
  pricingMode               TEXT NOT NULL DEFAULT 'sized' CHECK (pricingMode IN ('flat', 'sized')),
  flatPriceCents            INTEGER DEFAULT NULL CHECK (flatPriceCents IS NULL OR flatPriceCents >= 0),
  sizePricingCents          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sizePricingCents)),
  imagesJson                TEXT NOT NULL DEFAULT '[]',
  featuresJson              TEXT NOT NULL DEFAULT '[]',
  visible                   INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder                 INTEGER NOT NULL DEFAULT 0,
  createdAt                 TEXT NOT NULL,
  updatedAt                 TEXT NOT NULL,
  PRIMARY KEY (orgId, productId)
);

INSERT INTO products (
  productId, orgId, type, name, sub, weightOz, personalizationPriceCents, personalizationOptions,
  pricingMode, flatPriceCents, sizePricingCents, imagesJson, featuresJson, visible, sortOrder,
  createdAt, updatedAt)
SELECT
  productId, orgId, type, name, sub, weightOz,
  CASE WHEN personalizationPrice IS NULL THEN NULL ELSE CAST(round(personalizationPrice * 100) AS INTEGER) END,
  personalizationOptions, pricingMode,
  CASE WHEN flatPrice IS NULL THEN NULL ELSE CAST(round(flatPrice * 100) AS INTEGER) END,
  COALESCE((SELECT json_group_object(j.key, CAST(round(j.value * 100) AS INTEGER))
            FROM json_each(p.sizePricing) j), '{}'),
  imagesJson, featuresJson, visible, sortOrder, createdAt, updatedAt
FROM products_old p;

-- ---- blank_sizes (blank purchase costs) --------------------------------------
CREATE TABLE blank_sizes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId            INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  size               TEXT NOT NULL DEFAULT '',
  purchasePriceCents INTEGER NOT NULL DEFAULT 0 CHECK (purchasePriceCents >= 0),
  quantity           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (blankId, size)
);

INSERT INTO blank_sizes (id, blankId, size, purchasePriceCents, quantity)
SELECT id, blankId, size, CAST(round(purchasePrice * 100) AS INTEGER), quantity FROM blank_sizes_old;

-- ---- drop old copies (children first) ----------------------------------------
DROP TABLE order_payments_old;
DROP TABLE design_verifications_old;
DROP TABLE order_items_old;
DROP TABLE orders_old;
DROP TABLE products_old;
DROP TABLE blank_sizes_old;

-- ---- indexes (the old ones were dropped with their tables) ---------------------
CREATE INDEX idx_orders_org            ON orders(orgId, placedAt DESC);
CREATE INDEX idx_orders_placed         ON orders(placedAt);
CREATE INDEX idx_orders_ship_state     ON orders(shipState);
CREATE INDEX idx_items_order           ON order_items(orderId);
CREATE INDEX idx_items_org             ON order_items(orgId);
CREATE INDEX idx_payments_order        ON order_payments(orderId);
CREATE INDEX idx_payments_received     ON order_payments(receivedAt);
CREATE UNIQUE INDEX idx_payments_external_ref ON order_payments(externalRef) WHERE externalRef <> '';
CREATE INDEX idx_verif_order           ON design_verifications(orderId);
CREATE INDEX idx_products_org          ON products(orgId, visible, sortOrder);
CREATE INDEX idx_blank_sizes           ON blank_sizes(blankId);
