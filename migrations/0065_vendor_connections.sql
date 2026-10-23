-- Vendor connections through PromoStandards: a supplier from the PromoStandards directory (S&S,
-- SanMar, OTTO Cap…), the endpoints of the services this site uses, and the account's id + password —
-- encrypted with AES-GCM under the VENDOR_CREDENTIALS_KEY variable (functions/_lib/vendorCredentials.js),
-- never sent back to the browser. Additive.
CREATE TABLE IF NOT EXISTS vendor_connections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  companyCode    TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  -- {product: url, ppc: url, media: url, versions: {…}, environment: "production" | "test"}
  endpointsJson  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(endpointsJson)),
  credentialsEnc TEXT    NOT NULL DEFAULT '',
  -- {productIdFormat, fobId} — only where a vendor deviates from the standard.
  overridesJson  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(overridesJson)),
  status         TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ok', 'error')),
  lastTestedAt   TEXT,
  lastRefreshAt  TEXT,
  lastError      TEXT    NOT NULL DEFAULT '',
  createdAt      TEXT    NOT NULL,
  updatedAt      TEXT    NOT NULL
);
-- Which connection a blank's prices and content come from (its sku = the vendor's style #).
ALTER TABLE blanks ADD COLUMN vendorConnectionId INTEGER;
