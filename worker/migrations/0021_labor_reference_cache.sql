-- Platform-wide cache for reference labor data (Open Labor Project). Keys are
-- vehicle + job, never shop data, so every shop shares the cached answers and
-- the provider's daily request limit goes further.
CREATE TABLE IF NOT EXISTS labor_reference_cache (
  cache_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labor_reference_cache_expires ON labor_reference_cache(expires_at);
