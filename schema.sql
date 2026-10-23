-- OpenDecoDesk — Cloudflare D1 schema (FRESH INSTALLS ONLY)
-- Existing databases are changed ONLY through migrations/ (wrangler d1
-- migrations apply). This file must always equal "the result of applying every
-- migration" — test33 checks that. Money columns are INTEGER CENTS (*Cents);
-- unset dates are NULL.
-- A new database is built from this file by `npm run setup`, which also records every file in
-- migrations/ as already applied (they are all part of this schema). By hand:
--   node scripts/setup.mjs --print-fresh-sql > fresh.sql
--   npx wrangler d1 execute DB --remote --file fresh.sql

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
  updatedAt           TEXT NOT NULL,
  -- Sales tax (migrations/0007): tax-exempt purchaser + certificate on file.
  taxExempt            INTEGER NOT NULL DEFAULT 0 CHECK (taxExempt IN (0, 1)),
  taxExemptCertificate TEXT NOT NULL DEFAULT '',
  taxExemptExpires     TEXT,
  -- Configurable products (migrations/0036): per-org option tier prices + default reorder-QR graphic.
  tierPricesJson       TEXT NOT NULL DEFAULT '{"small":100,"medium":200,"large":400}',
  reorderQrGraphicId   INTEGER REFERENCES graphics(id),
  -- Delivery / pickup options the customer picks from (migrations/0045); '' = derived from shippingEnabled.
  deliveryOptionsJson  TEXT NOT NULL DEFAULT '',
  -- The shop's default reorder-QR TRANSFER (migrations/0047); reorderQrGraphicId above is the old way.
  reorderQrTransferId  INTEGER REFERENCES transfers(id)
);

CREATE TABLE IF NOT EXISTS products (
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
  -- Non-taxable products, e.g. embroidery on customer-supplied items (migrations/0013).
  taxable                   INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
  -- The product's MAIN design — nullable (migrations/0024); every design is in product_designs (0032).
  designId                  INTEGER REFERENCES designs(id),
  -- migrations/0032: typed-in personalization 'combined' with the main design or its own hooping,
  -- that hooping's hoop, and the pick list's option → design map.
  personalizationMode       TEXT NOT NULL DEFAULT 'combined' CHECK (personalizationMode IN ('combined', 'separate')),
  personalizationHoopId     INTEGER REFERENCES hoops(id),
  personalizationOptionDesigns TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(personalizationOptionDesigns)),
  -- migrations/0034: 1 = no embroidery design needed (e.g. DTF) — the catalog check won't flag it.
  noDesignNeeded            INTEGER NOT NULL DEFAULT 0 CHECK (noDesignNeeded IN (0, 1)),
  blockedGraphicColorsJson  TEXT NOT NULL DEFAULT '[]',
  -- Configurable products (migrations/0036): per-location option menus + reorder-QR selection.
  configurable              INTEGER NOT NULL DEFAULT 0 CHECK (configurable IN (0, 1)),
  garmentColorsJson         TEXT NOT NULL DEFAULT '[]',
  locationsJson             TEXT NOT NULL DEFAULT '[]',
  reorderQr                 TEXT NOT NULL DEFAULT 'default',
  -- migrations/0054: the customer may upload their own design — '' off, 'embroidery' or 'transfer' —
  -- for this add-on per piece (NULL = free).
  customDesign              TEXT NOT NULL DEFAULT '' CHECK (customDesign IN ('', 'embroidery', 'transfer')),
  customDesignPriceCents    INTEGER CHECK (customDesignPriceCents IS NULL OR customDesignPriceCents >= 0),
  -- migrations/0057: 1 = made with no blank at all (a patch: twill and thread are shop supplies), so
  -- its order lines skip the blank steps and nothing is ordered, received or counted for it.
  noBlankNeeded             INTEGER NOT NULL DEFAULT 0 CHECK (noBlankNeeded IN (0, 1)),
  -- migrations/0059: versions of a product (short / long sleeve…) — products of one shop sharing a
  -- non-empty versionGroup are shown as one card with a toggle; versionLabel names this one.
  versionGroup              TEXT NOT NULL DEFAULT '',
  versionLabel              TEXT NOT NULL DEFAULT '',
  -- migrations/0062: when its prices were last set or confirmed against its blanks' vendor prices.
  pricesReviewedAt          TEXT,
  -- migrations/0064: color price groups — [{key, label, colors, sizePricingCents | flatPriceCents}]; a color in
  -- no group takes the product's own prices (the Standard group).
  colorGroupsJson           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(colorGroupsJson)),
  -- migrations/0067: pricing awareness — minutes to make one item, extra DTF / transfer cost per item, and an
  -- override of the global shop-supplies cost per item (all optional).
  runMinutes                REAL,
  transferCostCents         INTEGER,
  suppliesCostCents         INTEGER,
  -- migrations/0068: printed transfers (DTF) that are part of the product, in its price — [{locationId, graphicId, ink}].
  fixedTransfersJson        TEXT NOT NULL DEFAULT '[]',
  -- migrations/0069: embroidered graphics shown on mockups only — [{locationId, graphicId}].
  mockupGraphicsJson        TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (orgId, productId)
);

CREATE TABLE IF NOT EXISTS global_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Admin sessions (migrations/0043): one row per signed-in session, keyed by the SHA-256 of the token.
-- userId: whose it is. pending: a step that user must finish before anything else is answered
-- ('account' | 'password' | '2fa'), else NULL (migrations/0053).
CREATE TABLE IF NOT EXISTS admin_sessions (
  tokenHash TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  userId    INTEGER,
  pending   TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expiresAt);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(userId);

-- Users and roles (migrations/0053). role: 'admin' | 'manager' | 'staff'. status: 'active' |
-- 'disabled' (never deleted, so history keeps its attribution). password: the salted, keyed hash
-- record (functions/_lib/adminAuth.js). recoveryCodes: JSON array of hashes. A new install has no
-- rows: the first sign-in with the installer's passphrase creates the first admin.
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL DEFAULT '',
  name               TEXT    NOT NULL DEFAULT '',
  role               TEXT    NOT NULL DEFAULT 'staff',
  status             TEXT    NOT NULL DEFAULT 'active',
  password           TEXT,
  mustChangePassword INTEGER NOT NULL DEFAULT 0,
  totpSecret         TEXT,
  totpLastCounter    INTEGER,
  recoveryCodes      TEXT,
  createdAt          TEXT    NOT NULL,
  updatedAt          TEXT    NOT NULL,
  lastLoginAt        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email <> '';

-- Accounts money moves through (migrations/0014). Seeds included.
CREATE TABLE IF NOT EXISTS accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  type                TEXT NOT NULL CHECK (type IN ('checking', 'credit_card', 'venmo', 'cash', 'stripe', 'other')),
  openingBalanceCents INTEGER NOT NULL DEFAULT 0,
  openingDate         TEXT NOT NULL DEFAULT '2026-01-01' CHECK (openingDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL,
  csvMapping          TEXT NOT NULL DEFAULT ''   -- statement CSV column mapping (0015)
);
INSERT OR IGNORE INTO accounts (id, name, type, createdAt, updatedAt) VALUES
  (1, 'Business checking', 'checking',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (2, 'Credit card',       'credit_card', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (3, 'Venmo',             'venmo',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (4, 'Cash on hand',      'cash',        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (5, 'Stripe balance',    'stripe',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));


CREATE TABLE IF NOT EXISTS orders (
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
  placedAt            TEXT NOT NULL,
  -- Sales tax snapshot (migrations/0007): prices are tax-inclusive.
  taxExempt           INTEGER NOT NULL DEFAULT 0 CHECK (taxExempt IN (0, 1)),
  taxRateBps          INTEGER NOT NULL DEFAULT 0 CHECK (taxRateBps BETWEEN 0 AND 1500),
  discountTaxCents    INTEGER NOT NULL DEFAULT 0 CHECK (discountTaxCents >= 0),
  -- Voided (never deleted) orders and explicit test flag (migrations/0010).
  voidedAt            TEXT,
  voidReason          TEXT NOT NULL DEFAULT '',
  isTest              INTEGER NOT NULL DEFAULT 0 CHECK (isTest IN (0, 1)),
  -- When the order was closed out — delivered and paid in full (migrations/0016). NULL = open.
  completedAt         TEXT,
  insertedAt          TEXT,
  dueDate             TEXT,                       -- migrations/0038: optional; prioritizes the run queues
  -- Whether sales tax is included in the listed prices or added on top — a snapshot of the store
  -- setting when the order was placed (migrations/0052).
  taxMode             TEXT NOT NULL DEFAULT 'inclusive' CHECK (taxMode IN ('inclusive', 'exclusive'))
);

CREATE TABLE IF NOT EXISTS order_items (
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
  blankConditionNote      TEXT NOT NULL DEFAULT '',
  -- Sales tax backed out of lineTotalCents (migrations/0007).
  taxRateBps              INTEGER NOT NULL DEFAULT 0 CHECK (taxRateBps BETWEEN 0 AND 1500),
  taxCents                INTEGER NOT NULL DEFAULT 0 CHECK (taxCents >= 0),
  -- Blank cost of this line (migrations/0009): 'consumed' when manufactured,
  -- 'estimate' for lines made before inventory tracking; NULL = unknown.
  cogsCents               INTEGER CHECK (cogsCents IS NULL OR cogsCents >= 0),
  cogsSource              TEXT    CHECK (cogsSource IS NULL OR cogsSource IN ('consumed', 'estimate')),
  -- Snapshot of whether the line's product is taxable (migrations/0013).
  taxable                 INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
  -- Per-piece manufacture progress (migrations/0029): pieces of `qty` already run.
  manufacturedQty         INTEGER NOT NULL DEFAULT 0 CHECK (manufacturedQty >= 0),
  -- Configurable line snapshot + transfer-received gate (migrations/0036).
  configJson              TEXT NOT NULL DEFAULT '',
  transferReceivedAt      TEXT,
  -- Per-line-item blank fulfillment (migrations/0039): source of truth; orders.blank* are derived
  -- summaries. Vendor fields set at "blank ordered"; carrier/tracking live in blank_shipments.
  blankOrderedAt          TEXT,
  blankShippedAt          TEXT,
  blankReceivedAt         TEXT,
  blankVendor             TEXT NOT NULL DEFAULT '',
  blankVendorOrderId      TEXT NOT NULL DEFAULT '',
  blankEstDelivery        TEXT,
  -- migrations/0048: when this line's transfers were pressed, for a line that is also embroidered.
  transfersAppliedAt  TEXT,
  -- migrations/0060: filled from the shop's finished stock (no blank / design / making steps).
  fromStock           INTEGER NOT NULL DEFAULT 0 CHECK (fromStock IN (0, 1))
);

CREATE TABLE IF NOT EXISTS design_verifications (
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

-- Invoices the customer can open, choose delivery on and pay online (migrations/0053): one per
-- order; the emailed link is /?invoice=<token> on the shop's own address. Sending again keeps the token.
CREATE TABLE IF NOT EXISTS order_invoices (
  token            TEXT PRIMARY KEY,
  orderId          TEXT NOT NULL UNIQUE REFERENCES orders(orderId) ON DELETE CASCADE,
  orgId            TEXT NOT NULL,
  sentTo           TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  allowDelivery    INTEGER NOT NULL DEFAULT 1 CHECK (allowDelivery IN (0, 1)),
  sentAt           TEXT NOT NULL,
  sendCount        INTEGER NOT NULL DEFAULT 1 CHECK (sendCount >= 1),
  viewedAt         TEXT,
  deliveryChosenAt TEXT,
  deliveryChoice   TEXT NOT NULL DEFAULT ''
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
  updatedAt    TEXT NOT NULL,
  needleTypeId INTEGER REFERENCES needle_types(id),  -- migrations/0044; NULL = not set
  -- migrations/0060: a blank TYPE bought for testing / shop use (still inventory — it could be sold).
  forTesting   INTEGER NOT NULL DEFAULT 0 CHECK (forTesting IN (0, 1)),
  -- migrations/0062: when its vendor prices were last checked (the 30-day reminder).
  pricesCheckedAt TEXT,
  -- migrations/0063: content from its vendor — description, bullet points, and where it came from.
  description  TEXT NOT NULL DEFAULT '',
  featuresJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(featuresJson)),
  sourceJson   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sourceJson)),
  -- migrations/0065: the vendor connection its prices and content come from.
  vendorConnectionId INTEGER
);

-- A blank's colors (migrations/0037): authoritative per-color record — name,
-- ordered images, sort — even for a color with no stock yet. Color is now a
-- dimension of a blank (like size); one blank holds many colors x sizes.
CREATE TABLE IF NOT EXISTS blank_colors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId    INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  color      TEXT NOT NULL DEFAULT '',
  imagesJson TEXT NOT NULL DEFAULT '[]',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  UNIQUE (blankId, color)
);

-- Per-color, per-size stock and purchase price for each blank (migrations/0037
-- added the color dimension; the UNIQUE key widened from (blankId, size)).
CREATE TABLE IF NOT EXISTS blank_sizes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId            INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  color              TEXT NOT NULL DEFAULT '',
  size               TEXT NOT NULL DEFAULT '',
  purchasePriceCents INTEGER NOT NULL DEFAULT 0 CHECK (purchasePriceCents >= 0),
  quantity           INTEGER NOT NULL DEFAULT 0,
  -- migrations/0062: the vendor's price, entered by hand (NULL = not entered) — purchasePriceCents
  -- above is the average cost of the pieces on hand. History in blank_vendor_prices.
  vendorPriceCents   INTEGER CHECK (vendorPriceCents IS NULL OR vendorPriceCents >= 0),
  vendorPriceAt      TEXT,
  -- migrations/0070: the vendor's minimum advertised price (NULL = none) — a product's price for a linked size can't
  -- be below it.
  mapPriceCents      INTEGER CHECK (mapPriceCents IS NULL OR mapPriceCents >= 0),
  -- migrations/0074: keep at least this many free (NULL = no reorder point).
  reorderPoint       INTEGER CHECK (reorderPoint IS NULL OR reorderPoint >= 0),
  -- migrations/0077: one piece's weight in ounces (NULL = not known); products.weightOz overrides it.
  weightOz           REAL CHECK (weightOz IS NULL OR weightOz >= 0),
  UNIQUE (blankId, color, size)
);

-- Every vendor price entered (migrations/0062), append-only; priceCents NULL = cleared.
CREATE TABLE IF NOT EXISTS blank_vendor_prices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId       INTEGER NOT NULL,
  color         TEXT    NOT NULL DEFAULT '',
  size          TEXT    NOT NULL DEFAULT '',
  priceCents    INTEGER CHECK (priceCents IS NULL OR priceCents >= 0),
  previousCents INTEGER,
  enteredAt     TEXT    NOT NULL,
  actor         TEXT    NOT NULL DEFAULT '',
  note          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bvp_size ON blank_vendor_prices (blankId, color, size, enteredAt);

-- Links a product's color+size to a specific blank color+size (for inventory
-- tracking). productColor '' = a classic (single-color) product. migrations/0037
-- added productColor/blankColor; the UNIQUE key widened to include productColor.
CREATE TABLE IF NOT EXISTS product_blank_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId        TEXT NOT NULL,
  productId    TEXT NOT NULL,
  productColor TEXT NOT NULL DEFAULT '',
  productSize  TEXT NOT NULL DEFAULT '',
  blankId      INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  blankColor   TEXT NOT NULL DEFAULT '',
  blankSize    TEXT NOT NULL DEFAULT '',
  UNIQUE (orgId, productId, productColor, productSize)
);

-- Thread catalog — one row per thread color, shared across every shop (like blanks). Imported
-- from a vendor's Hatch (.tch) chart export or entered by hand. migrations/0021. Unique key
-- widened to (brand, type, weight, code) by migrations/0023 — a code is only unique within its
-- own type+weight line (e.g. Madeira PolyNeon 40 code 1538 and Madeira Rayon 40 code 1538 are
-- different, real threads).
CREATE TABLE IF NOT EXISTS threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brand       TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  weight      TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  colorHex    TEXT NOT NULL DEFAULT '' CHECK (colorHex = '' OR (length(colorHex) = 6)),
  sourceFlag  TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  UNIQUE (brand, type, weight, code)
);
CREATE INDEX IF NOT EXISTS idx_threads_brand_type_weight ON threads(brand, type, weight);

-- Thread inventory: a shared spool-size catalog (description + length in whole metres) and
-- per-thread stock — each thread can hold several inventory items at different spool sizes.
-- migrations/0028.
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

-- Hoop catalog — global, one shared list a design's required hoop and a machine's supported
-- hoops both reference. migrations/0022.
CREATE TABLE IF NOT EXISTS hoops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  widthMm     REAL,
  heightMm    REAL,
  isCapFrame  INTEGER NOT NULL DEFAULT 0 CHECK (isCapFrame IN (0, 1)),
  notes       TEXT NOT NULL DEFAULT '',
  sortOrder   INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

-- Needle settings (migrations/0044): the recommended needle shown on Run Order. SIZE follows the
-- thread (needle_sizes: thread weight -> needle size); TYPE follows the garment (needle_types, picked
-- per blank as blanks.needleTypeId). Global, edited from admin -> Threads -> Needle settings.
CREATE TABLE IF NOT EXISTS needle_sizes (
  weight      TEXT PRIMARY KEY,
  needleSize  TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
INSERT OR IGNORE INTO needle_sizes (weight, needleSize, createdAt, updatedAt) VALUES
  ('40', '75/11', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('60', '65/9',  '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
CREATE TABLE IF NOT EXISTS needle_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_needle_types_name ON needle_types(name COLLATE NOCASE);
INSERT OR IGNORE INTO needle_types (name, sortOrder, createdAt, updatedAt) VALUES
  ('Sharp',     1, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('Ballpoint', 2, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');

-- Product categories (migrations/0051): the managed list a product's `type` and a blank's
-- `productType` are picked from. `key` is the stored value; `plural` is the storefront heading;
-- `packAs` is the package-size limit the category counts against when a box is chosen.
CREATE TABLE IF NOT EXISTS product_categories (
  key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 40),
  name       TEXT NOT NULL,
  plural     TEXT NOT NULL DEFAULT '',
  packAs     TEXT NOT NULL DEFAULT 'other' CHECK (packAs IN ('shirt', 'sweatshirt', 'cap', 'other')),
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_name ON product_categories(name COLLATE NOCASE);

-- The three that existed (same keys, so every product, blank and order line keeps its category),
-- plus Patch, T Shirt, Hoodie and Other.
INSERT OR IGNORE INTO product_categories (key, name, plural, packAs, sortOrder, createdAt, updatedAt) VALUES
  ('shirt',      'Shirt',      'Shirts',      'shirt',      1, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('t-shirt',    'T Shirt',    'T Shirts',    'shirt',      2, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('sweatshirt', 'Sweatshirt', 'Sweatshirts', 'sweatshirt', 3, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('hoodie',     'Hoodie',     'Hoodies',     'sweatshirt', 4, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('cap',        'Cap',        'Caps',        'cap',        5, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('patch',      'Patch',      'Patches',     'other',      6, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('other',      'Other',      'Other',       'other',      7, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');

-- Global garment-location lookup (Front/Back/Left Chest/Right Chest, admin-editable). migrations/0041.
-- Referenced by id from products.locationsJson[].locationId and blank_colors.imagesJson[].locationId.
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

-- Per-location graphic × garment-color mockups for configurable products (migrations/0042) — the
-- storefront preview. A transparent graphic composited over the blank color photo; placementJson
-- keeps the overlay params so the editor can reopen a saved mockup.
CREATE TABLE IF NOT EXISTS product_graphic_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId         TEXT NOT NULL,
  productId     TEXT NOT NULL,
  locationId    INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  graphicId     INTEGER NOT NULL REFERENCES graphics(id) ON DELETE CASCADE,
  garmentColor  TEXT NOT NULL DEFAULT '',
  imageUrl      TEXT NOT NULL DEFAULT '',
  thumbUrl      TEXT NOT NULL DEFAULT '',
  placementJson TEXT NOT NULL DEFAULT '{}',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  FOREIGN KEY (orgId, productId) REFERENCES products(orgId, productId) ON DELETE CASCADE,
  UNIQUE (orgId, productId, locationId, graphicId, garmentColor)
);
CREATE INDEX IF NOT EXISTS idx_pgi_product ON product_graphic_images(orgId, productId);

-- Embroidery designs — one per product (products.designId above). stabilizer/hoopId live here,
-- not per version, since they're properties of the design's placement. migrations/0024.
CREATE TABLE IF NOT EXISTS designs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId       TEXT NOT NULL REFERENCES orgs(orgId),
  name        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  stabilizer  TEXT NOT NULL DEFAULT '',
  hoopId      INTEGER REFERENCES hoops(id),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  -- migrations/0033: 1 = a global design every shop can use (orgId stays its home shop).
  isGlobal    INTEGER NOT NULL DEFAULT 0 CHECK (isGlobal IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_designs_global ON designs(isGlobal);
CREATE INDEX IF NOT EXISTS idx_designs_org ON designs(orgId);

-- Append-only file history for a design — the "current" version is the newest row
-- (MAX(uploadedAt) per designId). threadColorsJson: an ORDERED array of {needle, threadId},
-- needle position = this design's own color-change sequence (1-based). migrations/0024. Two
-- required files per version (migrations/0026): designFile (the native, editable design-software
-- project file — .emb/.jdx/etc) and machineFile (the actual stitch file the machine runs —
-- .dst/.exp/etc, what "Send design to machine" sends to the machine).
CREATE TABLE IF NOT EXISTS design_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  designId         INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  designFileKey    TEXT NOT NULL DEFAULT '',
  designFileName   TEXT NOT NULL DEFAULT '',
  designFileExt    TEXT NOT NULL DEFAULT '',
  machineFileKey   TEXT NOT NULL DEFAULT '',
  machineFileName  TEXT NOT NULL DEFAULT '',
  machineFileExt   TEXT NOT NULL DEFAULT '',
  threadColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(threadColorsJson)),
  notes            TEXT NOT NULL DEFAULT '',
  uploadedAt       TEXT NOT NULL,
  createdAt        TEXT NOT NULL,
  -- migrations/0071: stitches in the machine file (NULL = not known yet)
  stitchCount      INTEGER CHECK (stitchCount IS NULL OR stitchCount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_design_versions_design ON design_versions(designId, uploadedAt);

-- Per-line-item customization uploads (images or embroidery files) — separate from
-- design_verifications (that's one admin-mockup/customer-reply exchange per whole order,
-- expiring after 60 days; this is per line item and persists for the order's life).
-- migrations/0024.
CREATE TABLE IF NOT EXISTS order_item_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  itemId      INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  fileKey     TEXT NOT NULL DEFAULT '',
  fileName    TEXT NOT NULL DEFAULT '',
  fileExt     TEXT NOT NULL DEFAULT '',
  uploadedBy  TEXT NOT NULL DEFAULT 'admin' CHECK (uploadedBy IN ('admin', 'customer')),
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_item_files_item ON order_item_files(itemId);
CREATE INDEX IF NOT EXISTS idx_order_item_files_key ON order_item_files(fileKey);

-- An image a customer uploaded from the shop page (migrations/0054), before it is on an order. The
-- file is in the private DESIGNS bucket under order-files/pending/; placing the order records it on the
-- line (order_item_files, uploadedBy 'customer'). Unattached uploads are deleted after 48 hours.
CREATE TABLE IF NOT EXISTS customer_design_uploads (
  id          TEXT    PRIMARY KEY,
  orgId       TEXT    NOT NULL,
  productId   TEXT    NOT NULL,
  fileKey     TEXT    NOT NULL UNIQUE,
  fileName    TEXT    NOT NULL DEFAULT '',
  fileExt     TEXT    NOT NULL CHECK (fileExt IN ('png', 'jpg', 'webp')),
  contentType TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  createdAt   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_design_uploads_created ON customer_design_uploads(createdAt);

-- Machine catalog + live state (migrations/0025). ipAddress/embDir are for the local send-agent
-- (a separate program) to send a design to the machine -- never read server-side otherwise.
CREATE TABLE IF NOT EXISTS machines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL DEFAULT '',
  needleCount    INTEGER NOT NULL DEFAULT 1 CHECK (needleCount > 0),
  ipAddress      TEXT NOT NULL DEFAULT '',
  embDir         TEXT NOT NULL DEFAULT '/EMB',
  currentHoopId  INTEGER REFERENCES hoops(id),
  notes          TEXT NOT NULL DEFAULT '',
  macAddress     TEXT NOT NULL DEFAULT '',  -- stable identity; IP is populated by the scanner (migrations/0027)
  verifiedAt     TEXT,                      -- when discovery last confirmed this MAC present (migrations/0027)
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  -- migrations/0071: the machine's stitch counter and cumulative run time (cache of machine_counter_events)
  stitchCount    INTEGER NOT NULL DEFAULT 0,
  runSeconds     INTEGER NOT NULL DEFAULT 0,
  counterUpdatedAt TEXT
);

-- Which hoops a machine supports — the Run Order screen only offers a machine a job whose
-- design's required hoop is in this set. migrations/0025.
CREATE TABLE IF NOT EXISTS machine_hoops (
  machineId  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  hoopId     INTEGER NOT NULL REFERENCES hoops(id),
  PRIMARY KEY (machineId, hoopId)
);

-- A machine's LIVE state: what thread is physically loaded on each needle right now. Sparse — a
-- needle with nothing loaded just has no row. migrations/0025.
CREATE TABLE IF NOT EXISTS machine_needles (
  machineId  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  needle     INTEGER NOT NULL CHECK (needle > 0),
  threadId   INTEGER REFERENCES threads(id),
  updatedAt  TEXT NOT NULL,
  PRIMARY KEY (machineId, needle)
);

-- Run tracking (migrations/0030): a managed abort-reason list and a row per physical piece run on a
-- machine. A running row (status='running', finishedAt IS NULL) is the sole source of truth for both
-- "piece in progress" and "machine busy". machineName/designName/abortReasonLabel are snapshots so
-- the run-time report survives a later rename/delete — hence machineId/abortReasonId carry no FK.
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
  createdAt        TEXT NOT NULL,
  -- migrations/0032: per-hooping tracking (piece, step n of stepCount); timed = 0 → untimed.
  pieceNo          INTEGER,
  stepNo           INTEGER,
  stepCount        INTEGER,
  stepLabel        TEXT NOT NULL DEFAULT '',
  hoopId           INTEGER,
  itemDesignId     INTEGER,
  timed            INTEGER NOT NULL DEFAULT 1 CHECK (timed IN (0, 1)),
  -- migrations/0046: what went wrong during the run, noted when it's finished ({"threadBreak":3,…}) + the "other" note.
  issuesJson       TEXT NOT NULL DEFAULT '{}',
  issueNote        TEXT NOT NULL DEFAULT '',
  -- migrations/0071: the hooping's design stitches, and what the run added to its machine's counters.
  stitchCount      INTEGER,
  stitchesCounted  INTEGER,
  secondsCounted   INTEGER,
  estimated        INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON production_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_machine ON production_runs(machineId, status);
CREATE INDEX IF NOT EXISTS idx_runs_item    ON production_runs(itemId);
CREATE INDEX IF NOT EXISTS idx_runs_design  ON production_runs(designId);
-- migrations/0031: at most one running job per machine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_machine
  ON production_runs(machineId) WHERE status = 'running' AND machineId IS NOT NULL;

-- migrations/0032: one done row per hooping, one running hooping per piece.
CREATE INDEX IF NOT EXISTS idx_runs_piece ON production_runs(itemId, pieceNo, stepNo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_done_per_step
  ON production_runs(itemId, pieceNo, stepNo) WHERE status = 'done' AND pieceNo IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_piece
  ON production_runs(itemId, pieceNo) WHERE status = 'running' AND pieceNo IS NOT NULL;

-- migrations/0032: a design's hoops (on its own / with a typed-in name), a product's designs in
-- run order (one MAIN), and the order-specific design for a typed-in-personalization line.
CREATE TABLE IF NOT EXISTS design_hoops (
  designId  INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  hoopId    INTEGER NOT NULL REFERENCES hoops(id),
  purpose   TEXT NOT NULL DEFAULT 'design' CHECK (purpose IN ('design', 'personalization')),
  sortOrder INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (designId, hoopId, purpose)
);
CREATE INDEX IF NOT EXISTS idx_design_hoops_hoop ON design_hoops(hoopId);
CREATE TABLE IF NOT EXISTS product_designs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId     TEXT NOT NULL,
  productId TEXT NOT NULL,
  designId  INTEGER NOT NULL REFERENCES designs(id),
  placement TEXT NOT NULL DEFAULT '',
  isMain    INTEGER NOT NULL DEFAULT 0 CHECK (isMain IN (0, 1)),
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_designs_product ON product_designs(orgId, productId);
CREATE INDEX IF NOT EXISTS idx_product_designs_design ON product_designs(designId);
CREATE TABLE IF NOT EXISTS order_item_designs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  itemId           INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  designFileKey    TEXT NOT NULL DEFAULT '',
  designFileName   TEXT NOT NULL DEFAULT '',
  designFileExt    TEXT NOT NULL DEFAULT '',
  machineFileKey   TEXT NOT NULL DEFAULT '',
  machineFileName  TEXT NOT NULL DEFAULT '',
  machineFileExt   TEXT NOT NULL DEFAULT '',
  threadColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(threadColorsJson)),
  notes            TEXT NOT NULL DEFAULT '',
  uploadedAt       TEXT NOT NULL,
  createdAt        TEXT NOT NULL,
  -- migrations/0055: which location of the line this design is for ('' = the line's one design).
  location         TEXT NOT NULL DEFAULT '',
  -- migrations/0071: stitches in the machine file (NULL = not known yet)
  stitchCount      INTEGER CHECK (stitchCount IS NULL OR stitchCount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_item_designs_item ON order_item_designs(itemId, uploadedAt);

-- migrations/0031: orders.insertedAt (when the row was written) drives the 6 AM roll-up's
-- "new since the last email" cursor; set by this trigger on every insert.
CREATE INDEX IF NOT EXISTS idx_orders_inserted ON orders(insertedAt, orderId);
CREATE TRIGGER IF NOT EXISTS orders_set_inserted_at AFTER INSERT ON orders
  WHEN NEW.insertedAt IS NULL
BEGIN
  UPDATE orders SET insertedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE orderId = NEW.orderId;
END;

-- Payment records — one row per actual payment received (supports partial payments)
CREATE TABLE IF NOT EXISTS order_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  orderId     TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  amountCents INTEGER NOT NULL CHECK (amountCents <> 0),
  note        TEXT NOT NULL DEFAULT '',
  receivedAt  TEXT NOT NULL,
  externalRef TEXT NOT NULL DEFAULT '',
  -- How the money moved and what kind of movement it was (migrations/0008).
  -- Refunds and lost disputes are NEGATIVE amounts.
  method      TEXT NOT NULL DEFAULT 'other'
    CHECK (method IN ('card', 'venmo', 'zelle', 'check', 'cash', 'other')),
  reference   TEXT NOT NULL DEFAULT '',
  feeCents    INTEGER NOT NULL DEFAULT 0 CHECK (feeCents >= 0),
  kind        TEXT NOT NULL DEFAULT 'payment'
    CHECK (kind IN ('payment', 'refund', 'dispute')),
  -- Mistaken entries are voided, not deleted (migrations/0010).
  voidedAt    TEXT,
  voidReason  TEXT NOT NULL DEFAULT '',
  accountId   INTEGER REFERENCES accounts(id),  -- which account the money moved through (0014)
  -- (0017, superseded by payment_cashouts in 0018 — no longer written or read.)
  cashoutTransferId INTEGER REFERENCES account_transfers(id),
  -- (0035) how much of a refund / lost dispute was shipping — untaxed, so no sales tax is backed out of it.
  shippingCents INTEGER NOT NULL DEFAULT 0 CHECK (shippingCents >= 0)
);

-- How much of a Venmo payment each Venmo -> bank transfer covers (migrations/0018). A payment
-- can be cashed out in parts; allocations to a deleted transfer don't count.
CREATE TABLE IF NOT EXISTS payment_cashouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paymentId   INTEGER NOT NULL REFERENCES order_payments(id) ON DELETE CASCADE,
  transferId  INTEGER NOT NULL REFERENCES account_transfers(id),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_cashouts_payment  ON payment_cashouts(paymentId);
CREATE INDEX IF NOT EXISTS idx_payment_cashouts_transfer ON payment_cashouts(transferId);

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
  avgCostCents INTEGER NOT NULL DEFAULT 0 CHECK (avgCostCents >= 0),   -- migrations/0060: finished stock's running average cost
  UNIQUE (orgId, productId, size)
);
-- migrations/0060: every change to finished stock (ready_to_ship.quantity is the cache of their sum).
CREATE TABLE IF NOT EXISTS finished_goods_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId           TEXT    NOT NULL,
  productId       TEXT    NOT NULL,
  productName     TEXT    NOT NULL DEFAULT '',
  color           TEXT    NOT NULL DEFAULT '',
  size            TEXT    NOT NULL DEFAULT '',
  qtyDelta        INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents   INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind            TEXT    NOT NULL CHECK (kind IN ('opening', 'make', 'sell', 'return', 'adjust')),
  blankMovementId INTEGER,
  orderId         TEXT,
  itemId          INTEGER,
  note            TEXT    NOT NULL DEFAULT '',
  occurredAt      TEXT    NOT NULL,
  createdAt       TEXT    NOT NULL,
  voidedAt        TEXT,
  voidReason      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fgm_item ON finished_goods_movements (orgId, productId, size, occurredAt);
CREATE INDEX IF NOT EXISTS idx_fgm_occurred ON finished_goods_movements (occurredAt);


CREATE INDEX IF NOT EXISTS idx_orders_org            ON orders(orgId, placedAt DESC);
CREATE INDEX IF NOT EXISTS idx_orders_placed         ON orders(placedAt);
CREATE INDEX IF NOT EXISTS idx_orders_ship_state     ON orders(shipState);
CREATE INDEX IF NOT EXISTS idx_items_order           ON order_items(orderId);
CREATE INDEX IF NOT EXISTS idx_items_org             ON order_items(orgId);
CREATE INDEX IF NOT EXISTS idx_payments_order        ON order_payments(orderId);
CREATE INDEX IF NOT EXISTS idx_payments_received     ON order_payments(receivedAt);
CREATE INDEX IF NOT EXISTS idx_payments_cashout      ON order_payments(cashoutTransferId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_ref ON order_payments(externalRef) WHERE externalRef <> '';
CREATE INDEX IF NOT EXISTS idx_verif_order           ON design_verifications(orderId);
CREATE INDEX IF NOT EXISTS idx_products_org          ON products(orgId, visible, sortOrder);
CREATE INDEX IF NOT EXISTS idx_blank_sizes           ON blank_sizes(blankId);
CREATE INDEX IF NOT EXISTS idx_blank_colors          ON blank_colors(blankId);
CREATE INDEX IF NOT EXISTS idx_inventory_type  ON inventory(productType, size);
CREATE INDEX IF NOT EXISTS idx_blanks_type     ON blanks(productType);
CREATE INDEX IF NOT EXISTS idx_prod_blank_link ON product_blank_links(orgId, productId);
CREATE INDEX IF NOT EXISTS idx_rts_org         ON ready_to_ship(orgId, productId);
CREATE INDEX IF NOT EXISTS idx_items_from_stock ON order_items (orgId, productId, size) WHERE fromStock = 1;

-- Default global settings
INSERT OR IGNORE INTO global_settings (key, value)
VALUES ('enabledPayments', '{"card":true,"venmo":true,"zelle":true,"check":true}');
-- (No 'salesTax' row: sales tax is unset — rate 0, no home state — until the admin saves it; 0051.)
CREATE INDEX IF NOT EXISTS idx_orders_tax_exempt ON orders(taxExempt);
CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completedAt);
CREATE INDEX IF NOT EXISTS idx_payments_kind_received ON order_payments(kind, receivedAt);

-- Postage bought through Shippo: an expense against shipping income (migrations/0008).
CREATE TABLE IF NOT EXISTS shipping_labels (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  orderId             TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  shippoTransactionId TEXT NOT NULL UNIQUE,
  carrier             TEXT NOT NULL DEFAULT '',
  service             TEXT NOT NULL DEFAULT '',
  amountCents         INTEGER NOT NULL CHECK (amountCents >= 0),
  trackingNumber      TEXT NOT NULL DEFAULT '',
  labelUrl            TEXT NOT NULL DEFAULT '',
  purchasedAt         TEXT NOT NULL,
  voidedAt            TEXT,
  accountId           INTEGER REFERENCES accounts(id)   -- charged to (0014)
);
CREATE INDEX IF NOT EXISTS idx_labels_order     ON shipping_labels(orderId);
CREATE INDEX IF NOT EXISTS idx_labels_purchased ON shipping_labels(purchasedAt);

-- Blank (garment) shipments (migrations/0039): one row per tracking number, linked to the line
-- items it covers; per-scan carrier history in blank_tracking_events. Polled daily via Shippo.
CREATE TABLE IF NOT EXISTS blank_shipments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier        TEXT NOT NULL DEFAULT '',
  trackingNumber TEXT NOT NULL DEFAULT '',
  vendor         TEXT NOT NULL DEFAULT '',
  shippedAt      TEXT,
  status         TEXT NOT NULL DEFAULT '',
  statusDetail   TEXT NOT NULL DEFAULT '',
  statusDate     TEXT,
  deliveredAt    TEXT,
  lastCheckedAt  TEXT,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  supplierPoNumber TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_blank_shipments_tracking ON blank_shipments(trackingNumber);
CREATE INDEX IF NOT EXISTS idx_blank_shipments_active   ON blank_shipments(deliveredAt, lastCheckedAt);

CREATE TABLE IF NOT EXISTS blank_shipment_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shipmentId INTEGER NOT NULL REFERENCES blank_shipments(id) ON DELETE CASCADE,
  itemId     INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,  -- FK added in 0040
  UNIQUE (shipmentId, itemId)
);
CREATE INDEX IF NOT EXISTS idx_blank_shipment_items_item ON blank_shipment_items(itemId);

CREATE TABLE IF NOT EXISTS blank_tracking_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shipmentId   INTEGER NOT NULL REFERENCES blank_shipments(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT '',
  statusDetail TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  occurredAt   TEXT NOT NULL DEFAULT '',
  recordedAt   TEXT NOT NULL,
  UNIQUE (shipmentId, status, occurredAt)
);
CREATE INDEX IF NOT EXISTS idx_blank_tracking_events_shipment ON blank_tracking_events(shipmentId, occurredAt);

-- Every change to blank stock (migrations/0009). blankId is not an FK on
-- purpose: deleting a blank must keep its cost history.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  blankId       INTEGER NOT NULL,
  blankName     TEXT NOT NULL DEFAULT '',
  size          TEXT NOT NULL DEFAULT '',
  qtyDelta      INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('purchase', 'consume', 'adjust', 'writeoff')),
  orderId       TEXT,
  itemId        INTEGER,
  vendor        TEXT NOT NULL DEFAULT '',
  vendorRef     TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  occurredAt    TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  vendorChargedTax INTEGER NOT NULL DEFAULT 0 CHECK (vendorChargedTax IN (0, 1)),  -- migrations/0013
  accountId     INTEGER REFERENCES accounts(id),                                   -- purchases: paid from (0014)
  paidPersonally INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),      -- 0014
  receiptKey    TEXT NOT NULL DEFAULT '',                                          -- 0019
  receiptName   TEXT NOT NULL DEFAULT '',                                          -- 0019
  voidedAt      TEXT,                                                              -- 0020
  voidReason    TEXT NOT NULL DEFAULT '',                                          -- 0020
  color         TEXT NOT NULL DEFAULT '',                                          -- 0037 (stock dimension)
  reason        TEXT NOT NULL DEFAULT ''                                           -- 0060: writeoff testing|damaged|lost|other; consume ''|finished
);
CREATE INDEX IF NOT EXISTS idx_movements_blank    ON inventory_movements(blankId, size, occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_blank_color ON inventory_movements(blankId, color, size, occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_occurred ON inventory_movements(occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_order    ON inventory_movements(orderId);

-- Months already filed: changes that would alter them are refused (migrations/0010).
CREATE TABLE IF NOT EXISTS closed_periods (
  month    TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  closedAt TEXT NOT NULL,
  closedBy TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_reportable ON orders(isTest, voidedAt, placedAt);

-- Owner notices queued for the 6 AM daily roll-up (migrations/0011; 'delivered' added in 0016).
CREATE TABLE IF NOT EXISTS owner_notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'design', 'delivered', 'invoice')),
  orderId   TEXT NOT NULL DEFAULT '',
  orgId     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  imageUrls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imageUrls)),
  urgent    INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  createdAt TEXT NOT NULL,
  sentAt    TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_notices_unsent ON owner_notices(sentAt, id);

-- Business expenses + categories (migrations/0012). Seeds included.
CREATE TABLE IF NOT EXISTS expense_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  deductionType TEXT NOT NULL CHECK (deductionType IN ('depreciation', 'deductible', 'none')),
  scheduleCLine TEXT NOT NULL DEFAULT '',
  deductiblePct INTEGER NOT NULL DEFAULT 100 CHECK (deductiblePct BETWEEN 0 AND 100),
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  useTaxable    INTEGER NOT NULL DEFAULT 0 CHECK (useTaxable IN (0, 1))  -- owes use tax if untaxed (0013)
);

CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  expenseDate     TEXT NOT NULL CHECK (expenseDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description     TEXT NOT NULL CHECK (length(trim(description)) > 0),
  categoryId      INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amountCents     INTEGER NOT NULL CHECK (amountCents <> 0),   -- negative = a refund of an earlier purchase (0017)
  vendor          TEXT NOT NULL DEFAULT '',
  businessUsePct  INTEGER NOT NULL DEFAULT 100 CHECK (businessUsePct BETWEEN 1 AND 100),
  receiptKey      TEXT NOT NULL DEFAULT '',
  receiptName     TEXT NOT NULL DEFAULT '',
  placedInService TEXT,
  depMethod       TEXT CHECK (depMethod IS NULL OR depMethod IN ('section179', 'bonus', 'macrs5', 'macrs7', 'ask_cpa')),
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  deletedAt       TEXT,
  vendorChargedTax INTEGER NOT NULL DEFAULT 1 CHECK (vendorChargedTax IN (0, 1)),  -- migrations/0013
  accountId       INTEGER REFERENCES accounts(id),                                   -- paid from (0014)
  paidPersonally  INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),       -- owner's own money (0014)
  refundOfId      INTEGER REFERENCES expenses(id) ON DELETE SET NULL                 -- the purchase this refunds (0017)
);
CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(deletedAt, expenseDate);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(categoryId);

-- Starting categories (all editable / deletable while unused).
INSERT OR IGNORE INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt) VALUES
  ('Equipment & machines',                   'depreciation', '13',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Supplies (thread, stabilizer, needles)', 'deductible',   '22',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Software & subscriptions',               'deductible',   '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Advertising',                            'deductible',   '8',   100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Meals (50%)',                            'deductible',   '24b', 50,  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Office expense',                         'deductible',   '18',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Repairs & maintenance',                  'deductible',   '21',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Insurance',                              'deductible',   '15',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Legal & professional',                   'deductible',   '17',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Taxes & licenses',                       'deductible',   '23',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Travel',                                 'deductible',   '24a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Utilities & phone',                      'deductible',   '25',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Contract labor',                         'deductible',   '11',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Rent / lease',                           'deductible',   '20b', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Bank & other fees',                      'deductible',   '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Personal / non-deductible',              'none',         '',    0,   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Audit log — admin changes to orders (see migrations/0002 and 0004)
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT    NOT NULL,
  orgId     TEXT,
  orderId   TEXT,
  action    TEXT    NOT NULL,
  detail    TEXT,             -- JSON: what changed (before/after where relevant)
  actor     TEXT,             -- the user's email (or "passphrase" for the installer's)
  ip        TEXT,
  actorUserId  INTEGER,       -- users.id of who did it, on security entries (migrations/0053)
  targetUserId INTEGER        -- users.id of the account it was done to
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

-- Use-taxable starting categories (migrations/0013).
UPDATE expense_categories SET useTaxable = 1
WHERE name IN ('Equipment & machines', 'Supplies (thread, stabilizer, needles)', 'Office expense', 'Repairs & maintenance');

-- Other income, owner contributions/draws, transfers between accounts (migrations/0014).
CREATE TABLE IF NOT EXISTS other_income (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  incomeDate  TEXT NOT NULL CHECK (incomeDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  type        TEXT NOT NULL CHECK (type IN ('service', 'other', 'interest')),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  accountId   INTEGER NOT NULL REFERENCES accounts(id),
  reference   TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_other_income_date ON other_income(deletedAt, incomeDate);

CREATE TABLE IF NOT EXISTS owner_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  txDate      TEXT NOT NULL CHECK (txDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  kind        TEXT NOT NULL CHECK (kind IN ('contribution', 'draw')),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  accountId   INTEGER NOT NULL REFERENCES accounts(id),
  note        TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_tx_date ON owner_transactions(deletedAt, txDate);

CREATE TABLE IF NOT EXISTS account_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  transferDate  TEXT NOT NULL CHECK (transferDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  fromAccountId INTEGER NOT NULL REFERENCES accounts(id),
  toAccountId   INTEGER NOT NULL REFERENCES accounts(id),
  amountCents   INTEGER NOT NULL CHECK (amountCents > 0),
  note          TEXT NOT NULL DEFAULT '',
  externalRef   TEXT NOT NULL DEFAULT '',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  deletedAt     TEXT,
  CHECK (fromAccountId <> toAccountId)
);
CREATE INDEX IF NOT EXISTS idx_transfers_date ON account_transfers(deletedAt, transferDate);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_external_ref ON account_transfers(externalRef) WHERE externalRef <> '';

-- Statement import & monthly reconciliation (migrations/0015).
CREATE TABLE IF NOT EXISTS statement_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId    INTEGER NOT NULL REFERENCES accounts(id),
  lineDate     TEXT NOT NULL CHECK (lineDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description  TEXT NOT NULL DEFAULT '',
  amountCents  INTEGER NOT NULL CHECK (amountCents <> 0),
  fingerprint  TEXT NOT NULL,
  importBatch  TEXT NOT NULL DEFAULT '',
  importedAt   TEXT NOT NULL,
  ignoredAt    TEXT,
  ignoreReason TEXT NOT NULL DEFAULT '',
  UNIQUE (accountId, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_statement_lines_account_date ON statement_lines(accountId, lineDate);

CREATE TABLE IF NOT EXISTS statement_matches (
  lineId    INTEGER NOT NULL REFERENCES statement_lines(id) ON DELETE CASCADE,
  src       TEXT NOT NULL,
  srcId     INTEGER NOT NULL,
  matchedAt TEXT NOT NULL,
  auto      INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
  PRIMARY KEY (src, srcId)
);
CREATE INDEX IF NOT EXISTS idx_statement_matches_line ON statement_matches(lineId);

CREATE TABLE IF NOT EXISTS reconciliations (
  accountId                  INTEGER NOT NULL REFERENCES accounts(id),
  month                      TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  statementEndingBalanceCents INTEGER NOT NULL,
  bookBalanceCents           INTEGER NOT NULL,
  reconciledAt               TEXT NOT NULL,
  reconciledBy               TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (accountId, month)
);

-- Configurable products + transfer-sheet inventory + reorder QR (migrations/0036).
CREATE TABLE IF NOT EXISTS transfers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  orgIdsJson         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(orgIdsJson)),
  quantity           INTEGER NOT NULL DEFAULT 0,
  purchasePriceCents INTEGER NOT NULL DEFAULT 0 CHECK (purchasePriceCents >= 0),
  visible            INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder          INTEGER NOT NULL DEFAULT 0,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  transferId    INTEGER NOT NULL,
  transferName  TEXT NOT NULL DEFAULT '',
  qtyDelta      INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('purchase', 'consume', 'adjust', 'writeoff')),
  orderId       TEXT,
  itemId        INTEGER,
  vendor        TEXT NOT NULL DEFAULT '',
  vendorRef     TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  pctOfSheet    REAL,
  occurredAt    TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  accountId     INTEGER REFERENCES accounts(id),
  paidPersonally INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),
  receiptKey    TEXT NOT NULL DEFAULT '',
  receiptName   TEXT NOT NULL DEFAULT '',
  voidedAt      TEXT,
  voidReason    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_transfer_movements_item     ON transfer_movements(transferId, occurredAt);
CREATE INDEX IF NOT EXISTS idx_transfer_movements_occurred ON transfer_movements(occurredAt);
CREATE INDEX IF NOT EXISTS idx_transfer_movements_order    ON transfer_movements(orderId);

CREATE TABLE IF NOT EXISTS graphics (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId                    TEXT NOT NULL REFERENCES orgs(orgId),
  name                     TEXT NOT NULL,
  kind                     TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('embroidery', 'transfer')),
  designId                 INTEGER REFERENCES designs(id),
  transferId               INTEGER REFERENCES transfers(id),
  tier                     TEXT CHECK (tier IS NULL OR tier IN ('small', 'medium', 'large')),
  inkColorsJson            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inkColorsJson)),
  imageUrl                 TEXT NOT NULL DEFAULT '',
  thumbUrl                 TEXT NOT NULL DEFAULT '',
  allowedLocationsJson     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowedLocationsJson)),
  allowedGarmentColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowedGarmentColorsJson)),
  visible                  INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder                INTEGER NOT NULL DEFAULT 0,
  createdAt                TEXT NOT NULL,
  updatedAt                TEXT NOT NULL,
  -- migrations/0078: every shop can use it (its design must be global too).
  isGlobal                 INTEGER NOT NULL DEFAULT 0 CHECK (isGlobal IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_graphics_org ON graphics(orgId);

-- Receipt links (migrations/0061): the records one receive wrote share a receiptGroup.
CREATE INDEX IF NOT EXISTS idx_inventory_movements_receiptGroup ON inventory_movements(receiptGroup) WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_movements_receiptGroup  ON transfer_movements(receiptGroup)  WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_receiptGroup            ON expenses(receiptGroup)            WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_owner_transactions_receiptGroup  ON owner_transactions(receiptGroup)  WHERE receiptGroup IS NOT NULL;

-- Vendor connections through PromoStandards (migrations/0065); credentials AES-GCM encrypted.
CREATE TABLE IF NOT EXISTS vendor_connections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  companyCode    TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  endpointsJson  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(endpointsJson)),
  credentialsEnc TEXT    NOT NULL DEFAULT '',
  overridesJson  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(overridesJson)),
  status         TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ok', 'error')),
  lastTestedAt   TEXT,
  lastRefreshAt  TEXT,
  lastError      TEXT    NOT NULL DEFAULT '',
  createdAt      TEXT    NOT NULL,
  updatedAt      TEXT    NOT NULL
);

-- migrations/0071: machine counters and maintenance.
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

-- Orders placed with a supplier through PromoStandards sendPO (migrations/0072).
CREATE TABLE IF NOT EXISTS supplier_orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  connectionId        INTEGER NOT NULL,
  vendor              TEXT    NOT NULL DEFAULT '',
  environment         TEXT    NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'test')),
  poNumber            TEXT    NOT NULL UNIQUE,
  status              TEXT    NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'placed', 'failed', 'unknown')),
  transactionId       TEXT    NOT NULL DEFAULT '',
  error               TEXT    NOT NULL DEFAULT '',
  carrier             TEXT    NOT NULL DEFAULT '',
  service             TEXT    NOT NULL DEFAULT '',
  shipToJson          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(shipToJson)),
  totalCents          INTEGER NOT NULL DEFAULT 0 CHECK (totalCents >= 0),
  linesJson           TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(linesJson)),
  itemIdsJson         TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(itemIdsJson)),
  createdAt           TEXT    NOT NULL,
  createdBy           TEXT    NOT NULL DEFAULT '',
  placedAt            TEXT,
  lastShipmentCheckAt TEXT,
  cancelledAt         TEXT,
  cancelNote          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_created ON supplier_orders(createdAt);

-- Restock orders placed by hand, recorded so the restock isn't suggested again while on its way (migrations/0074).
CREATE TABLE IF NOT EXISTS blank_restock_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor     TEXT NOT NULL DEFAULT '',
  reference  TEXT NOT NULL DEFAULT '',
  linesJson  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(linesJson)),
  createdAt  TEXT NOT NULL,
  createdBy  TEXT NOT NULL DEFAULT '',
  voidedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_blank_restock_orders_created ON blank_restock_orders(createdAt);

-- Brand approvals: a supplier's logo approval per product + brand, with its file (migrations/0075).
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

-- A shop's published catalog (its orgs + products rows), what shoppers see and orders are priced from (migrations/0076).
CREATE TABLE IF NOT EXISTS catalog_snapshots (
  orgId        TEXT    PRIMARY KEY,
  json         TEXT    NOT NULL CHECK (json_valid(json)),
  publishedAt  TEXT    NOT NULL,
  publishedBy  TEXT    NOT NULL DEFAULT ''
);
