// Direct read/write of `shopsettings` entities for modules that run outside the
// authenticated entity routes (Durable Objects, Twilio webhooks, onboarding).

function parseRow(row) {
  if (!row?.data_json) return null;
  try {
    return JSON.parse(row.data_json);
  } catch {
    return null;
  }
}

export async function getShopSetting(env, shopId, id) {
  if (!env?.DB || !shopId) return null;
  const row = await env.DB.prepare(
    "SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'shopsettings' AND entity_id = ?",
  ).bind(shopId, id).first();
  return parseRow(row);
}

export async function putShopSetting(env, shopId, id, record, actor = 'system') {
  const now = new Date().toISOString();
  const payload = { ...record, id, shopId, updatedAt: now };
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, 'shopsettings', ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).bind(shopId, id, JSON.stringify(payload), actor, now, now).run();
  return payload;
}

export async function putShopEntity(env, shopId, entityType, entityId, record, actor = 'system') {
  const now = new Date().toISOString();
  const payload = { ...record, id: entityId, shopId, createdAt: record.createdAt || now, updatedAt: now };
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).bind(shopId, entityType, entityId, JSON.stringify(payload), actor, payload.createdAt, now).run();
  return payload;
}
