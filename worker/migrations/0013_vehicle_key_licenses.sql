PRAGMA foreign_keys = ON;

-- Vehicle key/immobilizer licensing. The platform owner (ACCESS_ADMIN_EMAILS)
-- reviews requests, approves licenses with an explicit expiry, and can suspend,
-- revoke, or reissue at any time. Unlock tokens are reusable until the license
-- expiry but every use is re-checked against these tables.

CREATE TABLE IF NOT EXISTS license_requests (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  license_number TEXT,
  proof_details TEXT NOT NULL,
  proof_file_key TEXT,
  proof_file_name TEXT,
  requested_devices INTEGER NOT NULL DEFAULT 1 CHECK (requested_devices BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decision_note TEXT,
  decided_by TEXT,
  decided_at TEXT,
  license_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_requests_status ON license_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_license_requests_shop ON license_requests(shop_id, created_at);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  -- Admin-chosen expiry (ISO-8601, whole seconds). Embedded as the token exp claim.
  expires_at TEXT NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices BETWEEN 1 AND 100),
  -- Embedded as the token tv claim. Bumping it invalidates every outstanding token.
  token_version INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  notes TEXT,
  request_id TEXT REFERENCES license_requests(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  suspended_at TEXT,
  revoked_at TEXT
);

-- One current (non-revoked) license per shop; revoked rows stay for history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_one_current_per_shop
  ON licenses(shop_id) WHERE status != 'revoked';

CREATE TABLE IF NOT EXISTS license_devices (
  license_id TEXT NOT NULL REFERENCES licenses(id),
  -- base64url SHA-256 of public_key; the device proves possession of the private key.
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  bound_at TEXT NOT NULL,
  bound_by TEXT,
  revoked_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (license_id, device_id)
);

CREATE TABLE IF NOT EXISTS license_tokens (
  jti TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  device_id TEXT NOT NULL,
  token_version INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  issued_by TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_license_tokens_license ON license_tokens(license_id, issued_at);

CREATE TABLE IF NOT EXISTS license_audit_log (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  license_id TEXT,
  request_id TEXT,
  shop_id TEXT,
  device_id TEXT,
  jti TEXT,
  actor_id TEXT,
  actor_email TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_audit_license ON license_audit_log(license_id, created_at);
CREATE INDEX IF NOT EXISTS idx_license_audit_created ON license_audit_log(created_at);

CREATE TABLE IF NOT EXISTS license_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
