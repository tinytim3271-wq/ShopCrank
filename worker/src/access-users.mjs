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

export async function validateAccessUser(env, context, employee) {
  const email = String(employee.email || '').trim().toLowerCase();
  const role = String(employee.role || 'technician');
  if (!email || !SHOP_ROLES.has(role)) throw new HttpError(400, 'Employee email and a valid role are required');
  const existing = await env.DB.prepare(
    'SELECT id, shop_id FROM users WHERE email = ? COLLATE NOCASE',
  ).bind(email).first();
  if (existing && String(existing.shop_id || '') !== String(context.shopId || '')) {
    throw new HttpError(409, 'That email already belongs to another shop account');
  }
  return { email, role, existing };
}

/**
 * Upsert the SaaS `users` row for an employee without ever reassigning an
 * existing account to a different shop (cross-tenant steal).
 */
export async function syncAccessUser(env, context, employee) {
  const { email, role, existing } = await validateAccessUser(env, context, employee);
  const now = new Date().toISOString();
  const enabled = employee.active === false ? 0 : 1;
  const name = String(employee.name || email);

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
