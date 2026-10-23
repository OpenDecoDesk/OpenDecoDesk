-- Optional per-order due date (when the customer needs it by). Additive, nullable: NULL = no due
-- date set. Used to prioritize the Run Order and Run Transfer Sheets queues (soonest due first,
-- undated last). Not a financial field — no period lock, set/edited from the admin Orders screen.
ALTER TABLE orders ADD COLUMN dueDate TEXT;
