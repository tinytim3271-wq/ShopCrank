-- Two 0008 migrations both created oauth_states with different columns
-- (0008_repair_flow_integrations: state/meta_json; 0008_integrations_support:
-- state_hash/PKCE verifier). Whichever ran first won, so some databases cannot
-- start a QuickBooks connection. Rows are 10-minute OAuth handshakes only, so
-- rebuild the table in the PKCE shape the QuickBooks routes use.
DROP TABLE IF EXISTS oauth_states;
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  return_to TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_shop ON oauth_states(shop_id, provider);
