-- 0032_hoopings.sql
-- Multiple designs per product, multiple hoops per design, pick-list → design mapping, order-specific
-- designs for typed-in personalization, and per-hooping run tracking. All additive.
--
-- design_hoops: the hoops a design can run in. purpose 'design' = the design on its own; purpose
-- 'personalization' = the design WITH a typed-in name stitched in the same hooping (often a bigger
-- hoop, e.g. a left-chest logo in a 6.9" hoop, or logo + name in a 7.7" x 12.5"). Backfilled from
-- designs.hoopId, which stays as the design's first 'design' hoop for older readers.
CREATE TABLE IF NOT EXISTS design_hoops (
  designId  INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  hoopId    INTEGER NOT NULL REFERENCES hoops(id),
  purpose   TEXT NOT NULL DEFAULT 'design' CHECK (purpose IN ('design', 'personalization')),
  sortOrder INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (designId, hoopId, purpose)
);
CREATE INDEX IF NOT EXISTS idx_design_hoops_hoop ON design_hoops(hoopId);
INSERT OR IGNORE INTO design_hoops (designId, hoopId, purpose, sortOrder)
  SELECT id, hoopId, 'design', 0 FROM designs WHERE hoopId IS NOT NULL;

-- product_designs: a product's designs, in run order (e.g. a cap's front logo, then its back
-- design). One is the MAIN design — the one a typed-in name is combined with. Backfilled from
-- products.designId, which stays as the main design's id for older readers.
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
INSERT INTO product_designs (orgId, productId, designId, placement, isMain, sortOrder, createdAt)
  SELECT orgId, productId, designId, 'Main', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM products WHERE designId IS NOT NULL;

-- Personalization per product: a typed-in name is either stitched WITH the main design in one
-- hooping ('combined', using the design's personalization hoops) or as its OWN hooping
-- ('separate', on personalizationHoopId). A pick list maps each option to a design
-- (personalizationOptionDesigns, {"COACH": 12, ...}) — always its own hooping.
ALTER TABLE products ADD COLUMN personalizationMode TEXT NOT NULL DEFAULT 'combined' CHECK (personalizationMode IN ('combined', 'separate'));
ALTER TABLE products ADD COLUMN personalizationHoopId INTEGER REFERENCES hoops(id);
ALTER TABLE products ADD COLUMN personalizationOptionDesigns TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(personalizationOptionDesigns));

-- The order-specific design for a line with typed-in personalization (the name digitized, alone
-- or with the main design) — same two files + thread map as a design version; newest wins.
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
  createdAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_item_designs_item ON order_item_designs(itemId, uploadedAt);

-- Per-hooping runs: a piece (pieceNo) of a line goes through stepCount hoopings (stepNo 1..n),
-- each its own timed run. Old rows keep NULL pieceNo/stepNo (one-hooping pieces). timed = 0 for
-- a hooping recorded with "Mark done (no timing)" — kept out of the timing report.
ALTER TABLE production_runs ADD COLUMN pieceNo INTEGER;
ALTER TABLE production_runs ADD COLUMN stepNo INTEGER;
ALTER TABLE production_runs ADD COLUMN stepCount INTEGER;
ALTER TABLE production_runs ADD COLUMN stepLabel TEXT NOT NULL DEFAULT '';
ALTER TABLE production_runs ADD COLUMN hoopId INTEGER;
ALTER TABLE production_runs ADD COLUMN itemDesignId INTEGER;
ALTER TABLE production_runs ADD COLUMN timed INTEGER NOT NULL DEFAULT 1 CHECK (timed IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_runs_piece ON production_runs(itemId, pieceNo, stepNo);
-- A hooping is done at most once, and a piece runs at most one hooping at a time — so a
-- double-click or two tabs can't record a step twice or start two steps of one piece.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_done_per_step
  ON production_runs(itemId, pieceNo, stepNo) WHERE status = 'done' AND pieceNo IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_piece
  ON production_runs(itemId, pieceNo) WHERE status = 'running' AND pieceNo IS NOT NULL;
