-- migrations/0078 — graphics.isGlobal: a graphic every shop can use (like a global design, 0033), kept in one place with
-- its home shop (orgId). A global graphic may only be linked to a global design and a transfer open to every shop.
ALTER TABLE graphics ADD COLUMN isGlobal INTEGER NOT NULL DEFAULT 0 CHECK (isGlobal IN (0, 1));
