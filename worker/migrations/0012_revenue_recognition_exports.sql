PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS revenue_recognition_exports (
  shop_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  currency TEXT NOT NULL DEFAULT 'usd',
  last_exported_at TEXT,
  last_object_key TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revenue_recognition_exports_enabled
  ON revenue_recognition_exports(enabled);
