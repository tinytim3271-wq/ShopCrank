-- Make Gemini the default shop AI provider for new/implicit provider rows.
-- Existing explicit provider values are preserved.

PRAGMA foreign_keys = OFF;

ALTER TABLE shop_ai_settings RENAME TO shop_ai_settings_old;

CREATE TABLE IF NOT EXISTS shop_ai_settings (
  shop_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'gemini' CHECK (provider IN ('anthropic', 'gemini')),
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_last4 TEXT NOT NULL DEFAULT '',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
  last_error TEXT,
  last_error_at TEXT,
  validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

INSERT INTO shop_ai_settings (
  shop_id, provider, key_ciphertext, key_iv, key_last4, model, status,
  last_error, last_error_at, validated_at, created_at, updated_at, updated_by
)
SELECT
  shop_id,
  CASE WHEN provider = 'anthropic' THEN 'anthropic' ELSE 'gemini' END,
  key_ciphertext,
  key_iv,
  key_last4,
  model,
  status,
  last_error,
  last_error_at,
  validated_at,
  created_at,
  updated_at,
  updated_by
FROM shop_ai_settings_old;

DROP TABLE shop_ai_settings_old;

PRAGMA foreign_keys = ON;
