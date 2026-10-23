-- Rate-limit counters in D1 (free tier: 100,000 row writes/day; Workers KV's
-- free tier allows only 1,000 writes/day). See functions/_lib/rateLimit.js.
-- One row per (bucket, client IP, 60-second window); expired rows are swept
-- opportunistically. Until this is applied the limiter can't count in D1 (logged).
CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,           -- "rl:<bucket>:<ip>:<window index>"
  count     INTEGER NOT NULL DEFAULT 0,
  expiresAt INTEGER NOT NULL            -- unix seconds; safe to delete after
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expiresAt);
