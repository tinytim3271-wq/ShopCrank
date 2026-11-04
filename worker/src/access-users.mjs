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
export async function syncAccessUser(env, context, employee, { employeeSnapshot } = {}) {
  const { email, role, existing } = await validateAccessUser(env, context, employee);
  const now = new Date().toISOString();
  const enabled = employee.active === false ? 0 : 1;
  const name = String(employee.name || email);
  const snapshotGuard = employeeSnapshot
    ? ` AND EXISTS (
        SELECT 1 FROM entities
        WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ? AND data_json = ?
      )`
    : '';
  const snapshotBinds = employeeSnapshot
    ? [context.shopId, String(employeeSnapshot.id), JSON.stringify(employeeSnapshot)]
    : [];

  let userId = existing?.id ? String(existing.id) : '';
  let outcome;
  if (existing) {
    outcome = await env.DB.prepare(`
      UPDATE users
      SET role = ?, name = ?, enabled = ?, updated_at = ?
      WHERE email = ? COLLATE NOCASE AND shop_id = ?${snapshotGuard}
    `).bind(role, name, enabled, now, email, context.shopId, ...snapshotBinds).run();
  } else {
    userId = crypto.randomUUID();
    const insert = employeeSnapshot
      ? `
        INSERT INTO users (id, email, shop_id, role, name, enabled, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM entities
          WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ? AND data_json = ?
        )
      `
      : `
        INSERT INTO users (id, email, shop_id, role, name, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
    outcome = await env.DB.prepare(insert)
      .bind(userId, email, context.shopId, role, name, enabled, now, now, ...snapshotBinds)
      .run();
  }

  if (!enabled && outcome?.meta?.changes) {
    if (!userId) {
      const row = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
      userId = row?.id ? String(row.id) : '';
    }
    await revokeSessionsForUserIds(env, [userId], now);
  }

  return { id: userId, email, shopId: context.shopId, role, enabled };
}

export function validateEmployeeAccess(employee) {
  const email = String(employee.email || '').trim().toLowerCase();
  const role = String(employee.role || 'technician');
  if (!email || !SHOP_ROLES.has(role)) throw new HttpError(400, 'Employee email and a valid role are required');
  return { email, role };
}

export async function employeeAccessStatements(env, context, employee, serializedRecord) {
  const { email, role } = validateEmployeeAccess(employee);
  const existing = await env.DB.prepare(
    'SELECT id, shop_id FROM users WHERE email = ? COLLATE NOCASE',
  ).bind(email).first();

  if (existing && String(existing.shop_id || '') !== String(context.shopId || '')) {
    throw new HttpError(409, 'That email already belongs to another shop account');
  }

  const updatedAt = String(employee.updatedAt || '');
  const entityGuard = `
    EXISTS (
      SELECT 1 FROM entities
      WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?
        AND updated_at = ? AND data_json = ?
    )
  `;
  const guardArgs = [context.shopId, employee.id, updatedAt, serializedRecord];
  const enabled = employee.active === false ? 0 : 1;
  const name = String(employee.name || email);
  const userId = String(existing?.id || crypto.randomUUID());
  const now = updatedAt || new Date().toISOString();
  const statements = existing
    ? [env.DB.prepare(`
      UPDATE users
      SET role = ?, name = ?, enabled = ?, updated_at = ?
      WHERE email = ? COLLATE NOCASE AND shop_id = ? AND ${entityGuard}
    `).bind(role, name, enabled, now, email, context.shopId, ...guardArgs)]
    : [env.DB.prepare(`
      INSERT INTO users (id, email, shop_id, role, name, enabled, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${entityGuard}
    `).bind(userId, email, context.shopId, role, name, enabled, now, now, ...guardArgs)];

  if (!enabled) {
    statements.push(env.DB.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND ${entityGuard}
    `).bind(now, userId, ...guardArgs));
  }
  return { statements, email, hasExisting: Boolean(existing) };
}

/**
 * Save an employee record and its Access user in one guarded batch, so a stale
 * save can neither overwrite a newer record nor re-enable access. Used by both
 * entity handlers (worker/src/index.js and worker/src/routes/entities.mjs).
 */
export async function saveEmployeeWithAccess(env, context, { id, record, create, existing, expectedUpdatedAt }) {
  const serializedRecord = JSON.stringify(record);
  const { statements, email, hasExisting } = await employeeAccessStatements(env, context, record, serializedRecord);
  const accessGuard = hasExisting
    ? 'EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?)'
    : 'NOT EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE)';
  const accessGuardArgs = hasExisting ? [email, context.shopId] : [email];
  const entityWrite = create
    ? env.DB.prepare(`
      INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).bind(context.shopId, 'employees', id, serializedRecord, record.createdBy, record.createdAt, record.updatedAt)
    : env.DB.prepare(`
      UPDATE entities SET data_json = ?, updated_at = ?
      WHERE shop_id = ? AND entity_type = ? AND entity_id = ? AND updated_at = ? AND data_json = ?
        AND ${accessGuard}
    `).bind(serializedRecord, record.updatedAt, context.shopId, 'employees', id,
      expectedUpdatedAt || existing?.updated_at || '', existing?.data_json || '', ...accessGuardArgs);
  const results = await env.DB.batch([entityWrite, ...statements]);
  if (!results?.[0]?.meta?.changes) {
    throw new HttpError(409, 'Record was updated elsewhere. Reload before saving again.');
  }
  return record;
}

/** Employee saves always move updated_at forward, so the guarded batch can tell a stale save apart. */
export function nextEmployeeTimestamp(existing, now = new Date().toISOString()) {
  const previous = Date.parse(existing?.updated_at || '');
  return Number.isFinite(previous) && Date.parse(now) <= previous ? new Date(previous + 1).toISOString() : now;
}
