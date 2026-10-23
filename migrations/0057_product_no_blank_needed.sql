-- A product made with no blank at all (e.g. a patch: patch twill and thread, which are shop supplies).
-- ===========================================================================================
-- 1 = nothing is bought, received or counted for it: its order lines skip the blank-ordered /
-- shipped / received steps, don't hold up Run Order waiting for a blank, stay off the Blanks to
-- Order shopping list, and the catalog check doesn't ask for its sizes to be linked to a blank.
-- Its materials are recorded as expenses (Supplies), not as inventory.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
-- ===========================================================================================
ALTER TABLE products ADD COLUMN noBlankNeeded INTEGER NOT NULL DEFAULT 0 CHECK (noBlankNeeded IN (0, 1));
