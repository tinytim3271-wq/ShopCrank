-- Operator-driven onboarding for new shops (Twilio + Grok voice), the per-shop
-- assistant knowledge base and memory, and Front Desk human-handoff logging.

CREATE TABLE IF NOT EXISTS shop_onboarding (
  shop_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'intake',
  intake_json TEXT NOT NULL DEFAULT '{}',
  state_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL
);

-- Every plan, approval, execution, and status change; never holds credentials.
CREATE TABLE IF NOT EXISTS onboarding_events (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  step TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_events_shop ON onboarding_events(shop_id, created_at);

-- Documents, notes, procedures, FAQs, fetched web pages, questionnaire answers,
-- and assistant memories. permission gates who may retrieve an item:
--   customer_safe: phone Front Desk bot and all staff
--   staff:         all signed-in staff, never the phone bot
--   accounting:    accounting roles only (admin/owner)
CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  permission TEXT NOT NULL CHECK (permission IN ('customer_safe', 'staff', 'accounting')),
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT,
  source_id TEXT,
  mime_type TEXT,
  file_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_role TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_shop_kind ON knowledge_items(shop_id, kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_source ON knowledge_items(shop_id, source_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  permission TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_shop_perm ON knowledge_chunks(shop_id, permission);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_item ON knowledge_chunks(item_id);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  permission TEXT NOT NULL CHECK (permission IN ('customer_safe', 'staff', 'accounting')),
  refresh_hours INTEGER NOT NULL DEFAULT 168,
  status TEXT NOT NULL DEFAULT 'pending',
  last_fetched_at TEXT,
  last_error TEXT,
  content_hash TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, url)
);

CREATE TABLE IF NOT EXISTS voice_handoffs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  call_sid TEXT NOT NULL,
  caller TEXT,
  trigger TEXT NOT NULL,
  reason TEXT,
  transcript_snippet TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  targets_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  notified_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_handoffs_call ON voice_handoffs(shop_id, call_sid);
