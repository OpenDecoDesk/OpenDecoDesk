-- Who performed each audited admin action, and from where.
-- actor = Cloudflare Access email when Access is configured, otherwise a
-- short non-reversible session label ("session:1a2b3c4d") or "passphrase".
-- Apply BEFORE deploying the code that writes these columns.
ALTER TABLE audit_log ADD COLUMN actor TEXT;
ALTER TABLE audit_log ADD COLUMN ip    TEXT;
