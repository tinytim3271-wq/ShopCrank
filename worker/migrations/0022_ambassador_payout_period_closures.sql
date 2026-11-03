CREATE TABLE IF NOT EXISTS ambassador_payout_period_closures (
  period TEXT PRIMARY KEY CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL DEFAULT 'closing' CHECK (status IN ('closing', 'frozen')),
  closed_at TEXT NOT NULL
);
