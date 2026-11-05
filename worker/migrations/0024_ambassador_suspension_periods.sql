-- When each shop was suspended, so a payment made during a suspension never
-- earns ambassador commission, even if Stripe's webhook only arrives after the
-- account is restored. One row per suspension; ended_at is NULL while it lasts.
CREATE TABLE IF NOT EXISTS ambassador_suspension_periods (
  shop_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (shop_id, started_at)
);

-- Accounts already suspended when this ships. Their real start is unknown, so
-- use their last account change (never later than now).
INSERT OR IGNORE INTO ambassador_suspension_periods (shop_id, started_at, ended_at)
SELECT shop_id, COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), NULL
FROM accounts
WHERE suspended = 1;
