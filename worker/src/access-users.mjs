import { HttpError } from './http.mjs';

const SHOP_ROLES = new Set(['admin', 'technician', 'office', 'service_writer']);

export async function revokeSessionsForUserIds(env, userIds, revokedAt = new Date().toISOString()) {
  const ids = [...new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  for (const userId of ids) {
    await env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).bind(revokedAt, userId).run();
  }
}

export async function assertAccessUserAvailable(env, context, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const existing = await env.DB.prepare(
    'SELECT id, shop_id FROM users WHERE email = ? COLLATE NOCASE',
  ).bind(normalizedEmail).first();
  if (existing && String(existing.shop_id || '') !== String(context.shopId || '')) {
    throw new HttpError(409, 'That email already belongs to another shop account');
  }
  return existing;
}

export async function accessUserSyncStatements(env, context, employee, entitySnapshot = null) {
  const email = String(employee.email || '').trim().toLowerCase();
  const role = String(employee.role || 'technician');
  if (!email || !SHOP_ROLES.has(role)) throw new HttpError(400, 'Employee email and a valid role are required');
  const existing = await assertAccessUserAvailable(env, context, email);
  const now = employee.updatedAt || new Date().toISOString();
  const enabled = employee.active === false ? 0 : 1;
  const name = String(employee.name || email);
  const snapshotGuard = entitySnapshot
    ? `AND EXISTS (
        SELECT 1 FROM entities
        WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?
          AND data_json = ? AND updated_at = ?
      )`
    : '';
  const snapshotValues = entitySnapshot
    ? [context.shopId, entitySnapshot.id, entitySnapshot.dataJson, entitySnapshot.updatedAt]
    : [];
  const statements = [env.DB.prepare(`
    INSERT INTO users (id, email, shop_id, role, name, enabled, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE 1 = 1 ${snapshotGuard}
    ON CONFLICT(email) DO UPDATE SET
      role = excluded.role, name = excluded.name, enabled = excluded.enabled, updated_at = excluded.updated_at
    WHERE users.shop_id = excluded.shop_id
  `).bind(
    existing?.id || crypto.randomUUID(),
    email,
    context.shopId,
    role,
    name,
    enabled,
    employee.createdAt || now,
    now,
    ...snapshotValues,
  )];
  if (!enabled) {
    statements.push(env.DB.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE revoked_at IS NULL AND user_id IN (
        SELECT id FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?
      ) ${snapshotGuard}
    `).bind(now, email, context.shopId, ...snapshotValues));
  }
  return statements;
}

/**
 * Upsert the SaaS `users` row for an employee without ever reassigning an
 * existing account to a different shop (cross-tenant steal).
 */
export async function syncAccessUser(env, context, employee) {
  const email = String(employee.email || '').trim().toLowerCase();
  const role = String(employee.role || 'technician');
  if (!email || !SHOP_ROLES.has(role)) throw new HttpError(400, 'Employee email and a valid role are required');
  const now = new Date().toISOString();
  const enabled = employee.active === false ? 0 : 1;
  const name = String(employee.name || email);
  const existing = await assertAccessUserAvailable(env, context, email);

  let userId = existing?.id ? String(existing.id) : '';
  if (existing) {
    await env.DB.prepare(`
      UPDATE users
      SET role = ?, name = ?, enabled = ?, updated_at = ?
      WHERE email = ? COLLATE NOCASE AND shop_id = ?
    `).bind(role, name, enabled, now, email, context.shopId).run();
  } else {
    userId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO users (id, email, shop_id, role, name, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(userId, email, context.shopId, role, name, enabled, now, now).run();
  }

  if (!enabled) {
    if (!userId) {
      const row = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
      userId = row?.id ? String(row.id) : '';
    }
    await revokeSessionsForUserIds(env, [userId], now);
  }

  return { id: userId, email, shopId: context.shopId, role, enabled };
}
