CREATE TABLE IF NOT EXISTS pending_membership_attributions (
  shop_id TEXT PRIMARY KEY,
  referral_code TEXT NOT NULL,
  sale_source TEXT,
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
