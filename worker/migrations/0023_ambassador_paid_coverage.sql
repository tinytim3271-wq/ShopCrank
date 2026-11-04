CREATE TABLE IF NOT EXISTS ambassador_paid_coverage (
  shop_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_ambassador_paid_coverage_range
  ON ambassador_paid_coverage(shop_id, starts_at, ends_at);

INSERT OR IGNORE INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, source, created_at)
SELECT shop_id,
       COALESCE(current_period_start, created_at, updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       current_period_end, 'migration',
       COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM subscriptions
WHERE status = 'active';
