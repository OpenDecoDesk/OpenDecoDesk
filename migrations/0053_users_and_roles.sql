-- Users and roles (functions/_lib/adminAuth.js). Until now the admin had one shared password and
-- a session said nothing about who was signed in.
--   users          — one row per person. role: 'admin' | 'manager' | 'staff' (kept as plain text
--                    so a later migration can add a role without rebuilding the table; the code
--                    refuses anything it doesn't know). status: 'active' | 'disabled' — a user
--                    is disabled, never deleted, so history keeps its attribution.
--                    password: the salted, keyed hash record. recoveryCodes: JSON array of hashes.
--   admin_sessions — which user a session belongs to, and a step they still have to finish
--                    before anything else is answered: 'account' | 'password' | '2fa'.
--   audit_log      — who did it and to whom, for the security entries.
-- STRUCTURE ONLY. The owner of an install that predates this becomes the first admin in code, at
-- their next sign-in (their password and two-step secret are in global_settings and are left
-- there). Old session rows have no user and simply stop being accepted: everyone signs in once.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL DEFAULT '',
  name               TEXT    NOT NULL DEFAULT '',
  role               TEXT    NOT NULL DEFAULT 'staff',
  status             TEXT    NOT NULL DEFAULT 'active',
  password           TEXT,
  mustChangePassword INTEGER NOT NULL DEFAULT 0,
  totpSecret         TEXT,
  totpLastCounter    INTEGER,
  recoveryCodes      TEXT,
  createdAt          TEXT    NOT NULL,
  updatedAt          TEXT    NOT NULL,
  lastLoginAt        TEXT
);
-- One account per address. The owner adopted from an older install has no address until they
-- give one, so blank is allowed (and is the only value that may repeat).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email <> '';

ALTER TABLE admin_sessions ADD COLUMN userId  INTEGER;
ALTER TABLE admin_sessions ADD COLUMN pending TEXT;
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(userId);

ALTER TABLE audit_log ADD COLUMN actorUserId  INTEGER;
ALTER TABLE audit_log ADD COLUMN targetUserId INTEGER;
