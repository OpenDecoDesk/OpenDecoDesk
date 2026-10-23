-- Publish per shop (2026-10): the shop's catalog as published — its orgs row and its products rows, exactly as stored
-- — is what shoppers see and what orders are priced from. Edits in the admin stay a draft until that shop is
-- published again. A shop with no row here (never published since this) is served live, as before. Additive.
CREATE TABLE IF NOT EXISTS catalog_snapshots (
  orgId        TEXT    PRIMARY KEY,
  json         TEXT    NOT NULL CHECK (json_valid(json)),
  publishedAt  TEXT    NOT NULL,
  publishedBy  TEXT    NOT NULL DEFAULT ''
);
