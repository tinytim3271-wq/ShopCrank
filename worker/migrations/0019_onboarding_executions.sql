-- Claims never expire automatically: an interrupted provider request requires
-- reconciliation before another run can create a potentially paid resource.
CREATE TABLE onboarding_executions (
  shop_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'completed', 'reconcile')),
  results_json TEXT NOT NULL DEFAULT '{}',
  pending_key TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, step_id)
);
CREATE UNIQUE INDEX onboarding_one_running_shop
  ON onboarding_executions(shop_id) WHERE status IN ('running', 'reconcile');

CREATE TABLE onboarding_voice_evidence (
  shop_id TEXT NOT NULL,
  call_sid TEXT NOT NULL,
  stream_sid TEXT NOT NULL,
  media_started_at TEXT NOT NULL,
  xai_started_at TEXT,
  PRIMARY KEY (shop_id, call_sid)
);
