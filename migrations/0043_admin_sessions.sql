-- Admin sessions in D1.
-- ============================================================================================
-- A row per session, keyed by the SHA-256 of the token (the token itself is never stored), with
-- an expiresAt checked on every read and a lazy sweep of expired rows whenever a new one is
-- issued. Keeping sessions in D1 rather than Workers KV means one fewer binding to create and
-- keep in sync between environments.
--
-- The catalog version counter, the TOTP secret and the TOTP replay counter live in
-- global_settings (keys catalogVersion / totpSecret / totpLastCounter) — no schema change needed.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS admin_sessions (
  tokenHash TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expiresAt);
