-- Machine identity by MAC + last-verified date (additive).
--
-- The MAC address is now the machine's stable identity: it never changes, while the LAN IP
-- address can change (DHCP lease, router reboot). The IP is populated/refreshed by the scanner
-- (UDP discovery) rather than typed by hand, and `verifiedAt` records when discovery last
-- confirmed that MAC present at that IP. The admin screens re-run discovery before a list/upload
-- when `verifiedAt` is more than an hour old and update the IP if it changed.
--
-- Both columns are additive with safe defaults, so existing rows keep working (a machine with no
-- MAC yet just can't be auto-rediscovered until it's scanned once).

ALTER TABLE machines ADD COLUMN macAddress TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN verifiedAt TEXT;
