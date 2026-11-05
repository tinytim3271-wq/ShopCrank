-- Paid membership coverage for ambassador commissions. A month earns a
-- commission only when a coverage interval overlaps it. See
-- worker/src/ambassadors/coverage.mjs for how intervals are written and cut.
CREATE TABLE IF NOT EXISTS ambassador_paid_coverage (
  shop_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  paid_through TEXT,
  cut_reason TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_ambassador_paid_coverage_range
  ON ambassador_paid_coverage(shop_id, starts_at, ends_at);

-- Memberships active and not suspended when this ships. Coverage starts at the
-- current billing period or, for admin-managed memberships without one, at the
-- last membership change (never created_at, which may predate a trial).
INSERT OR IGNORE INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, paid_through, cut_reason, source, created_at)
SELECT s.shop_id,
       COALESCE(s.current_period_start, s.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       CASE WHEN COALESCE(a.suspended, 0) = 1
         THEN COALESCE(s.current_period_start, s.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ELSE s.current_period_end END,
       CASE WHEN COALESCE(a.suspended, 0) = 1 THEN s.current_period_end ELSE NULL END,
       CASE WHEN COALESCE(a.suspended, 0) = 1 THEN 'suspension' ELSE NULL END,
       CASE WHEN s.stripe_subscription_id IS NULL THEN 'admin' ELSE 'migration' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM subscriptions s
LEFT JOIN accounts a ON a.shop_id = s.shop_id
WHERE s.status = 'active';
