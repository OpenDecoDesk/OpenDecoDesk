-- A blank's content from its vendor: onboarding a complete blank from a vendor's product file
-- (and later its PromoStandards web services) brings its description, bullet-point features and where it
-- came from. Additive only.
ALTER TABLE blanks ADD COLUMN description  TEXT NOT NULL DEFAULT '';
ALTER TABLE blanks ADD COLUMN featuresJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(featuresJson));
-- {vendor, style, sourceUrl, images: [vendor image file names already brought in], syncedAt} — so a later
-- import knows which of the vendor's images are already on the blank.
ALTER TABLE blanks ADD COLUMN sourceJson   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sourceJson));
