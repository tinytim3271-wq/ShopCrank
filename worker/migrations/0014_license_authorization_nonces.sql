CREATE TABLE IF NOT EXISTS license_authorization_nonces (
  nonce TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_authorization_nonces_consumed
  ON license_authorization_nonces(consumed_at);
