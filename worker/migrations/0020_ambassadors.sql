-- Ambassador program: who sold each membership, recurring monthly commissions,
-- and immutable monthly payout report snapshots. Payout stays manual (mark paid).

CREATE TABLE IF NOT EXISTS ambassadors (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  ambassador_number TEXT NOT NULL UNIQUE,
  referral_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'approved', 'suspended')),
  territory TEXT,
  mailing_address TEXT,
  -- Placeholder until a payout provider is chosen; never store bank numbers here.
  payout_method TEXT NOT NULL DEFAULT 'check',
  payout_details TEXT,
  application_json TEXT CHECK (application_json IS NULL OR json_valid(application_json)),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_ambassadors_email ON ambassadors(email);
CREATE INDEX IF NOT EXISTS idx_ambassadors_status ON ambassadors(status);

ALTER TABLE subscriptions ADD COLUMN sold_by_ambassador_id TEXT;
ALTER TABLE subscriptions ADD COLUMN sold_by TEXT;
ALTER TABLE subscriptions ADD COLUMN sale_source TEXT
  CHECK (sale_source IS NULL OR sale_source IN ('shopcrank_online', 'ambassador_site', 'ambassador_referral', 'admin_manual', 'ai_agent'));
ALTER TABLE subscriptions ADD COLUMN referral_code TEXT;
ALTER TABLE subscriptions ADD COLUMN attributed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_subscriptions_ambassador ON subscriptions(sold_by_ambassador_id);

CREATE TABLE IF NOT EXISTS ambassador_attribution_log (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  previous_ambassador_id TEXT,
  new_ambassador_id TEXT,
  previous_source TEXT,
  new_source TEXT,
  previous_sold_by TEXT,
  new_sold_by TEXT,
  changed_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attribution_log_shop ON ambassador_attribution_log(shop_id, created_at);

-- Monthly commission per plan. Founding plans earn their public tier's rate.
CREATE TABLE IF NOT EXISTS ambassador_commission_rates (
  plan_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('solo', 'shop', 'shop_pro', 'enterprise')),
  monthly_cents INTEGER NOT NULL CHECK (monthly_cents >= 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
INSERT OR IGNORE INTO ambassador_commission_rates (plan_id, tier, monthly_cents, updated_at, updated_by) VALUES
  ('solo', 'solo', 1000, '2026-11-01T00:00:00.000Z', 'migration'),
  ('shop', 'shop', 2000, '2026-11-01T00:00:00.000Z', 'migration'),
  ('shop_pro', 'shop_pro', 4000, '2026-11-01T00:00:00.000Z', 'migration'),
  ('enterprise', 'enterprise', 10000, '2026-11-01T00:00:00.000Z', 'migration'),
  ('founding_solo', 'solo', 1000, '2026-11-01T00:00:00.000Z', 'migration'),
  ('founding_shop', 'shop', 2000, '2026-11-01T00:00:00.000Z', 'migration'),
  ('founding_pro', 'shop_pro', 4000, '2026-11-01T00:00:00.000Z', 'migration');

-- One commission line per shop per month; the rate is copied at accrual time.
CREATE TABLE IF NOT EXISTS ambassador_commissions (
  id TEXT PRIMARY KEY,
  ambassador_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
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
  UNIQUE (shop_id, period)
);
CREATE INDEX IF NOT EXISTS idx_commissions_ambassador_period ON ambassador_commissions(ambassador_id, period);
CREATE INDEX IF NOT EXISTS idx_commissions_period ON ambassador_commissions(period);

-- Frozen monthly payout report. report_json never changes after insert.
CREATE TABLE IF NOT EXISTS ambassador_payout_reports (
  period TEXT PRIMARY KEY CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  grand_total_cents INTEGER NOT NULL,
  ambassador_count INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  email_status TEXT
);

CREATE TABLE IF NOT EXISTS ambassador_payouts (
  period TEXT NOT NULL,
  ambassador_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  check_number TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (period, ambassador_id)
);
