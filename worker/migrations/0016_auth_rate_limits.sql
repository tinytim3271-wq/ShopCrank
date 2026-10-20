-- Per-client counters for sign-in email requests (see enforceSignInRateLimit).
-- One row per hashed client IP per 15-minute window; old windows can be pruned.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
