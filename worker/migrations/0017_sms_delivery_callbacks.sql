ALTER TABLE sms_consent ADD COLUMN recorded_by TEXT;

CREATE TABLE IF NOT EXISTS sms_delivery_callbacks (
  shop_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, provider_message_id)
);
