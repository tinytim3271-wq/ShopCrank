ALTER TABLE ambassador_commissions RENAME TO ambassador_commissions_previous;

CREATE TABLE ambassador_commissions (
  id TEXT PRIMARY KEY,
  ambassador_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  earning_period TEXT NOT NULL CHECK (earning_period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  plan_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  sale_source TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'void')),
  accrued_via TEXT NOT NULL CHECK (accrued_via IN ('cron', 'invoice_paid', 'manual')),
  stripe_invoice_id TEXT,
  check_number TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, earning_period)
);

INSERT INTO ambassador_commissions (
  id, ambassador_id, shop_id, period, earning_period, plan_id, tier, sale_source,
  amount_cents, status, accrued_via, stripe_invoice_id, check_number, paid_at, created_at
)
SELECT
  id, ambassador_id, shop_id, period, period, plan_id, tier, sale_source,
  amount_cents, status, accrued_via, stripe_invoice_id, check_number, paid_at, created_at
FROM ambassador_commissions_previous;

DROP TABLE ambassador_commissions_previous;

CREATE INDEX idx_commissions_ambassador_period ON ambassador_commissions(ambassador_id, period);
CREATE INDEX idx_commissions_period ON ambassador_commissions(period);
