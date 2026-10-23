-- 0036_configurable_products.sql
-- Three linked pieces (all additive — classic products are untouched):
--   1. Configurable products: per print LOCATION, a menu of OPTIONS; each option is an embroidery
--      design or a transfer-sheet graphic (DTF/sublimation), with an image(+thumb) and a tier price.
--   2. Transfer sheets as INVENTORY & COGS (mirrors blanks): a `transfers` catalog + `transfer_movements`
--      ledger; the portion of a sheet a job uses is consumed like a blank.
--   3. Reorder QR: an org-level default transfer graphic, selectable per product.

-- Transfer inventory items (global like blanks; optionally restricted to orgs via orgIdsJson).
CREATE TABLE IF NOT EXISTS transfers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  orgIdsJson         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(orgIdsJson)),  -- empty = all orgs
  quantity           INTEGER NOT NULL DEFAULT 0,              -- cache of transfer_movements sum (applications on hand)
  purchasePriceCents INTEGER NOT NULL DEFAULT 0 CHECK (purchasePriceCents >= 0),  -- running weighted-average per application
  visible            INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder          INTEGER NOT NULL DEFAULT 0,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL
);

-- Every transfer stock change (mirror of inventory_movements). transferId is not an FK so deleting a
-- transfer keeps its history. A `purchase` row carries its pct of the receipt sheet.
CREATE TABLE IF NOT EXISTS transfer_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
  pctOfSheet    REAL,                                         -- purchase rows: this item's share of the sheet
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

-- Per-org catalog of selectable OPTIONS (both kinds): an embroidery design or a transfer graphic.
CREATE TABLE IF NOT EXISTS graphics (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId                    TEXT NOT NULL REFERENCES orgs(orgId),
  name                     TEXT NOT NULL,
  kind                     TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('embroidery', 'transfer')),
  designId                 INTEGER REFERENCES designs(id),     -- embroidery options
  transferId               INTEGER REFERENCES transfers(id),   -- transfer options → inventory item
  tier                     TEXT CHECK (tier IS NULL OR tier IN ('small', 'medium', 'large')),  -- NULL = $0/included
  inkColorsJson            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inkColorsJson)),
  imageUrl                 TEXT NOT NULL DEFAULT '',
  thumbUrl                 TEXT NOT NULL DEFAULT '',
  allowedLocationsJson     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowedLocationsJson)),      -- empty = any
  allowedGarmentColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowedGarmentColorsJson)),  -- empty = any
  visible                  INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder                INTEGER NOT NULL DEFAULT 0,
  createdAt                TEXT NOT NULL,
  updatedAt                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graphics_org ON graphics(orgId);

-- Configurable products (additive; classic products keep configurable = 0).
ALTER TABLE products ADD COLUMN configurable     INTEGER NOT NULL DEFAULT 0 CHECK (configurable IN (0, 1));
ALTER TABLE products ADD COLUMN garmentColorsJson TEXT NOT NULL DEFAULT '[]';   -- ordered color names
ALTER TABLE products ADD COLUMN locationsJson    TEXT NOT NULL DEFAULT '[]';    -- [{key,label,graphicIds:[...]}]
ALTER TABLE products ADD COLUMN reorderQr        TEXT NOT NULL DEFAULT 'default'; -- 'default' | 'none' | '<graphicId>'

-- Configured order line snapshot + the transfer-received gate (blanks reuse orders.blankReceivedAt).
ALTER TABLE order_items ADD COLUMN configJson        TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN transferReceivedAt TEXT;

-- Per-org tier prices (both kinds) + the org's default reorder-QR graphic.
ALTER TABLE orgs ADD COLUMN tierPricesJson     TEXT NOT NULL DEFAULT '{"small":100,"medium":200,"large":400}';
ALTER TABLE orgs ADD COLUMN reorderQrGraphicId INTEGER REFERENCES graphics(id);
