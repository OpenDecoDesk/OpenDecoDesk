-- Data fix: stock movements carry the blank's name as it was when each was written, so a blank
-- renamed later (e.g. "Sport Red Men's Zone Performance Polo" → "Team 365 TT51 Zone Performance Polo") kept
-- its old name in Blanks → History, receipts and the Inventory & COGS report. Bring every movement of a blank
-- that still exists up to the blank's current name (the rule blankName_ uses: its name, else brand + color).
-- From now on updateBlank renames its movements too. A deleted blank's movements keep their name. Data only.
UPDATE inventory_movements
   SET blankName = (SELECT CASE WHEN b.name <> '' THEN b.name ELSE TRIM(b.brand || ' ' || b.color) END FROM blanks b WHERE b.id = inventory_movements.blankId)
 WHERE blankId IN (SELECT id FROM blanks WHERE name <> '' OR TRIM(brand || ' ' || color) <> '')
   AND blankName <> (SELECT CASE WHEN b.name <> '' THEN b.name ELSE TRIM(b.brand || ' ' || b.color) END FROM blanks b WHERE b.id = inventory_movements.blankId);
