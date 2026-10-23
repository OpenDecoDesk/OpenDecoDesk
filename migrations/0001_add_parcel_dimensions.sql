-- Add parcel dimension columns to orders table.
-- (Apply migrations with `npm run db:migrate`.)
ALTER TABLE orders ADD COLUMN parcelLength REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN parcelWidth  REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN parcelHeight REAL NOT NULL DEFAULT 0;
