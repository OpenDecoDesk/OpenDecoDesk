-- A new install starts with NO sales tax configured (rate 0, no home state) until the admin sets it
-- in Global settings → Sales tax. Migration 0007 seeds a sample rate; this takes that seed back
-- out, but only from a database that has never been used: the row must still be the seed (with or
-- without a state code) AND there must be no orders. A database with any history keeps its setting
-- untouched, so nothing changes for an existing shop.
DELETE FROM global_settings
WHERE key = 'salesTax'
  AND (value = '{"rateBps":600,"taxShipping":false,"jurisdiction":""}'
       OR value GLOB '{"rateBps":600,"taxShipping":false,"jurisdiction":"[A-Z][A-Z]"}')
  AND NOT EXISTS (SELECT 1 FROM orders);
