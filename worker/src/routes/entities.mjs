import {
  ENTITY_TYPES,
  canReadEntity,
  canWriteEntity,
  normalizeEntityPayload,
  normalizeEntityType,
  redactEmployee,
} from '../domain.mjs';
import { HttpError, json, requestJson } from '../http.mjs';
import { accessUserSyncStatements } from '../access-users.mjs';
import {
  SELF_MANAGED_DELETE_TYPES,
  archivedRecord,
  canDeleteRecords,
  deletionPlan,
  isArchived,
  linkLookups,
} from '../../../src/modules/record-retention.js';

const ARCHIVE_FIELDS = ['archivedAt', 'archivedBy', 'archiveReasons'];

function entityRecord(row, type = '') {
  if (!row) return null;
  try {
    const record = JSON.parse(row.data_json);
    return type ? normalizeEntityPayload(type, record) : record;
  } catch {
    return null;
  }
}

export async function getEntity(env, shopId, type, id) {
  return entityRecord(await env.DB.prepare(
    'SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(shopId, type, id).first(), type);
}

export async function listEntities(env, shopId, type, { limit = 0, cursor = '' } = {}) {
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(200, Math.floor(Number(limit)))
    : 0;
  const nextCursor = String(cursor || '').trim();
  const filters = ['shop_id = ?', 'entity_type = ?'];
  const bindValues = [shopId, type];
  if (nextCursor) {
    const [cursorTs, cursorId] = nextCursor.split('|');
    filters.push('(updated_at > ? OR (updated_at = ? AND entity_id > ?))');
    bindValues.push(cursorTs, cursorTs, cursorId);
  }
  let sql = `SELECT data_json, updated_at, entity_id FROM entities WHERE ${filters.join(' AND ')} ORDER BY updated_at, entity_id`;
  if (boundedLimit) {
    sql += ' LIMIT ?';
    bindValues.push(boundedLimit);
  }
  const result = await env.DB.prepare(sql).bind(...bindValues).all();
  const rows = result.results || [];
  const records = rows.map(row => entityRecord(row, type)).filter(Boolean);
  if (!boundedLimit) return records;
  return {
    records,
    nextCursor: rows.length === boundedLimit ? `${rows.at(-1)?.updated_at}|${rows.at(-1)?.entity_id}` : null,
  };
}

export async function putEntity(env, context, type, id, body, expectedUpdatedAt = null, createdBy = context.userId) {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    'SELECT created_at, created_by, updated_at, data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(context.shopId, type, id).first();
  if (expectedUpdatedAt && existing && existing.updated_at !== expectedUpdatedAt) {
    throw new HttpError(409, 'Record was updated elsewhere. Reload before saving again.');
  }
  const record = {
    ...preservedArchiveFields(existing, body, context),
    ...body,
    id,
    shopId: context.shopId,
    createdBy: existing?.created_by || createdBy,
    createdAt: body.createdAt || existing?.created_at || now,
    updatedAt: now,
  };
  if (type === 'employees' && isArchived(record)) record.active = false;
  const employeeAccessStatements = type === 'employees'
    ? await accessUserSyncStatements(env, context, record, { id, dataJson: JSON.stringify(record), updatedAt: now })
    : null;
  const employeeAccessGuard = type === 'employees'
    ? 'AND NOT EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND shop_id <> ?)'
    : '';
  const employeeAccessValues = type === 'employees'
    ? [String(record.email || '').trim().toLowerCase(), context.shopId]
    : [];
  const writeStatement = existing
    ? env.DB.prepare(`
      UPDATE entities SET data_json = ?, updated_at = ?
      WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
        AND data_json = ? AND updated_at = ?
        ${employeeAccessGuard}
    `).bind(
      JSON.stringify(record), now, context.shopId, type, id, existing.data_json, existing.updated_at,
      ...employeeAccessValues,
    )
    : type === 'employees'
      ? env.DB.prepare(`
        INSERT OR IGNORE INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND shop_id <> ?)
      `).bind(
        context.shopId, type, id, JSON.stringify(record), record.createdBy, record.createdAt, now,
        ...employeeAccessValues,
      )
      : env.DB.prepare(`
        INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).bind(context.shopId, type, id, JSON.stringify(record), record.createdBy, record.createdAt, now);
  const results = employeeAccessStatements
    ? await env.DB.batch([writeStatement, ...employeeAccessStatements])
    : [await writeStatement.run()];
  const result = results[0];
  if (!result?.meta?.changes) throw new HttpError(409, 'Record was updated elsewhere. Reload before saving again.');
  return record;
}

/**
 * Saves from stale clients must not silently un-archive a record. Only an
 * owner/admin sending `archivedAt: null` restores it.
 */
export function preservedArchiveFields(existingRow, body, context) {
  const previous = existingRow ? entityRecord(existingRow) : null;
  if (Object.hasOwn(body || {}, 'archivedAt') && body.archivedAt !== null
    && (typeof body.archivedAt !== 'string' || !body.archivedAt.trim())) {
    throw new HttpError(400, 'archivedAt must be a non-empty timestamp or null');
  }
  if (!isArchived(previous)) {
    if (isArchived(body) && !canDeleteRecords(context.role)) {
      throw new HttpError(403, 'Only the shop owner or an admin can archive records');
    }
    return {};
  }
  if (body.archivedAt === null) {
    if (!canDeleteRecords(context.role)) throw new HttpError(403, 'Only the shop owner or an admin can restore archived records');
    return {};
  }
  if (body.archivedAt !== undefined) {
    if (!isArchived(body)) throw new HttpError(400, 'Use archivedAt: null to restore an archived record');
    return {};
  }
  return Object.fromEntries(ARCHIVE_FIELDS.filter(field => previous[field] !== undefined).map(field => [field, previous[field]]));
}

async function countLinkedEntities(env, shopId, spec) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS found FROM entities WHERE shop_id = ? AND entity_type = ? AND json_extract(data_json, ?) = ?',
  ).bind(shopId, spec.type, `$.${spec.field}`, spec.value).first();
  return Number(row?.found || 0);
}

async function archiveEntity(env, context, type, id, existing, reasons) {
  const record = archivedRecord(existing, { actor: context.email, reasons });
  const updatedAt = new Date().toISOString();
  const patch = {
    archivedAt: record.archivedAt,
    archivedBy: record.archivedBy,
    archiveReasons: record.archiveReasons,
    updatedAt,
    ...('active' in existing ? { active: false } : {}),
  };
  const statements = [env.DB.prepare(`
    UPDATE entities SET data_json = json_patch(data_json, ?), updated_at = ?
    WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
  `).bind(JSON.stringify(patch), updatedAt, context.shopId, type, id)];
  if (type === 'employees' && existing.email) {
    statements.push(env.DB.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE revoked_at IS NULL AND user_id IN (
        SELECT id FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?
      )
    `).bind(updatedAt, existing.email, context.shopId));
    statements.push(env.DB.prepare(`
      DELETE FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?
        AND EXISTS (
          SELECT 1 FROM entities WHERE shop_id = ? AND entity_type = 'employees'
            AND entity_id = ? AND COALESCE(trim(json_extract(data_json, '$.archivedAt')), '') <> ''
        )
    `).bind(existing.email, context.shopId, context.shopId, id));
  }
  const results = await env.DB.batch(statements);
  if (!results?.[0]?.meta?.changes) throw new HttpError(409, 'Record was updated elsewhere. Reload before removing it.');
  const updated = await getEntity(env, context.shopId, type, id);
  if (!updated) throw new HttpError(404, 'Not found');
  return updated;
}

function conditionalDeleteStatement(env, context, type, id, existingRow, existing) {
  const lookups = linkLookups(type, existing);
  const predicates = [];
  const values = [context.shopId, type, id, existingRow.data_json, existingRow.updated_at];
  for (const spec of [...lookups.financial, ...lookups.blocking]) {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM entities linked
      WHERE linked.shop_id = ? AND linked.entity_type = ?
        AND json_extract(linked.data_json, ?) = ?
    )`);
    values.push(context.shopId, spec.type, `$.${spec.field}`, spec.value);
  }
  return env.DB.prepare(`
    DELETE FROM entities
    WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
      AND data_json = ? AND updated_at = ?
      ${predicates.map(predicate => `AND ${predicate}`).join(' ')}
  `).bind(...values);
}

export async function linkCountsForRecord(env, shopId, type, record) {
  const { financial, blocking } = linkLookups(type, record);
  const counts = {};
  for (const spec of [...financial, ...blocking]) {
    const key = `${spec.type}.${spec.field}`;
    counts[key] = (counts[key] || 0) + await countLinkedEntities(env, shopId, spec);
  }
  return counts;
}

function membershipDeleteAllowed(existing, context) {
  return members(existing).includes(context.email) && (context.role === 'admin' || existing.createdBy === context.userId);
}

/**
 * Remove an entity under the shop deletion policy: owner/admin only; records
 * with financial ties are archived; returns `{ status, body }`.
 */
export async function removeEntity(env, context, type, id, { archiveOnly = false, attempt = 0 } = {}) {
  const existingRow = await env.DB.prepare(
    'SELECT data_json, updated_at FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(context.shopId, type, id).first();
  const existing = entityRecord(existingRow, type);
  if (!existing) throw new HttpError(404, 'Not found');
  if (SELF_MANAGED_DELETE_TYPES.has(type)) {
    if (!membershipDeleteAllowed(existing, context)) throw new HttpError(403, 'Not permitted');
    await env.DB.batch(buildEntityDeleteStatements(env, context, type, id, existing));
    return { status: 204, action: 'delete' };
  }
  if (!canDeleteRecords(context.role)) throw new HttpError(403, 'Only the shop owner or an admin can delete records');
  if (isArchived(existing)) {
    if (type === 'employees' && existing.email) {
      await env.DB.batch([env.DB.prepare(`
        UPDATE sessions SET revoked_at = ?
        WHERE revoked_at IS NULL AND user_id IN (
          SELECT id FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?
        )
      `).bind(new Date().toISOString(), existing.email, context.shopId), env.DB.prepare(`
        DELETE FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?
          AND EXISTS (
            SELECT 1 FROM entities WHERE shop_id = ? AND entity_type = 'employees'
              AND entity_id = ? AND COALESCE(trim(json_extract(data_json, '$.archivedAt')), '') <> ''
          )
      `).bind(existing.email, context.shopId, context.shopId, id)]);
    }
    return { status: 200, action: 'archive', body: { archived: true, record: existing, reasons: existing.archiveReasons || [] } };
  }
  const plan = deletionPlan(type, existing, await linkCountsForRecord(env, context.shopId, type, existing));
  if (plan.action === 'blocked' && !archiveOnly) throw new HttpError(409, plan.message);
  if (archiveOnly || plan.action === 'archive') {
    const reasons = plan.action === 'archive' ? plan.reasons : ['archived at user request'];
    const record = await archiveEntity(env, context, type, id, existing, reasons);
    return { status: 200, action: 'archive', body: { archived: true, record, reasons } };
  }
  const statements = buildEntityDeleteStatements(
    env,
    context,
    type,
    id,
    existing,
    [],
    conditionalDeleteStatement(env, context, type, id, existingRow, existing),
  );
  const results = await env.DB.batch(statements);
  if (!results?.[0]?.meta?.changes) {
    if (attempt < 2) return removeEntity(env, context, type, id, { archiveOnly, attempt: attempt + 1 });
    throw new HttpError(409, 'Record or its links changed while removing it. Reload and try again.');
  }
  return { status: 204, action: 'delete' };
}

function members(record) {
  return [...new Set((Array.isArray(record?.memberEmails) ? record.memberEmails : [])
    .map(email => String(email).trim().toLowerCase()).filter(Boolean))];
}

function listParams(request) {
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(200, Math.floor(requestedLimit))
    : 0;
  return {
    limit,
    cursor: String(url.searchParams.get('cursor') || '').trim(),
    conversationId: String(url.searchParams.get('conversationId') || '').trim(),
  };
}

async function listConversationIdsForMember(env, shopId, email, { limit = 0, cursor = '' } = {}) {
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(200, Math.floor(Number(limit)))
    : 0;
  const bindValues = [shopId, email.toLowerCase()];
  let sql = `
    SELECT e.entity_id, e.updated_at, e.data_json
    FROM entities e, json_each(e.data_json, '$.memberEmails') member
    WHERE e.shop_id = ? AND e.entity_type = 'conversations' AND lower(member.value) = ?
  `;
  if (cursor) {
    sql += ' AND e.updated_at > ?';
    bindValues.push(cursor);
  }
  sql += ' ORDER BY e.updated_at';
  if (boundedLimit) {
    sql += ' LIMIT ?';
    bindValues.push(boundedLimit);
  }
  const result = await env.DB.prepare(sql).bind(...bindValues).all();
  const rows = result.results || [];
  const records = rows.map(entityRecord).filter(Boolean);
  return {
    records,
    ids: records.map(record => String(record.id || '')).filter(Boolean),
    nextCursor: boundedLimit && rows.length === boundedLimit ? String(rows.at(-1)?.updated_at || '') : null,
  };
}

export async function listChatMessagesForConversations(env, shopId, email, { limit = 0, cursor = '', conversationId = '' } = {}) {
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(200, Math.floor(Number(limit)))
    : 0;
  const bindValues = [shopId, email.toLowerCase()];
  let sql = `
    SELECT m.data_json, m.updated_at FROM entities m
    WHERE m.shop_id = ?1 AND m.entity_type = 'chatmessages'
      AND json_extract(m.data_json, '$.conversationId') IN (
        SELECT c.entity_id FROM entities c, json_each(c.data_json, '$.memberEmails') mem
        WHERE c.shop_id = ?1 AND c.entity_type = 'conversations' AND lower(trim(mem.value)) = ?2)
  `;
  if (conversationId) {
    sql += " AND json_extract(m.data_json, '$.conversationId') = ?";
    bindValues.push(conversationId);
  }
  if (cursor) {
    sql += ' AND m.updated_at > ?';
    bindValues.push(cursor);
  }
  sql += ' ORDER BY m.updated_at';
  if (boundedLimit) {
    sql += ' LIMIT ?';
    bindValues.push(boundedLimit);
  }
  const result = await env.DB.prepare(sql).bind(...bindValues).all();
  const rows = result.results || [];
  return {
    records: rows.map(entityRecord).filter(Boolean),
    nextCursor: boundedLimit && rows.length === boundedLimit ? String(rows.at(-1)?.updated_at || '') : null,
  };
}

/**
 * Build D1 statements for deleting an entity.
 * Employee deletes must revoke Access users even when the row is not an invoice.
 */
export function buildEntityDeleteStatements(env, context, type, id, existing, relatedPayments = [], deleteStatement = null) {
  const statements = [deleteStatement || env.DB.prepare(
    'DELETE FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(context.shopId, type, id)];

  if (type === 'invoices') {
    for (const payment of relatedPayments.filter(record => record.invoiceNumber === (existing.number || existing.id))) {
      statements.push(env.DB.prepare(
        'DELETE FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
      ).bind(context.shopId, 'payments', payment.id));
    }
  }

  if (type === 'employees' && existing.email) {
    statements.push(env.DB.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE revoked_at IS NULL AND user_id IN (
        SELECT id FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM entities WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?
      )
    `).bind(new Date().toISOString(), existing.email, context.shopId, context.shopId, id));
    statements.push(env.DB.prepare(
      `DELETE FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM entities WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?
        )`,
    ).bind(existing.email, context.shopId, context.shopId, id));
  }

  return statements;
}

export async function handleEntities(request, env, context, segments) {
  const sourceType = String(segments[1] || '').toLowerCase();
  const type = normalizeEntityType(sourceType);
  const id = segments[2] ? decodeURIComponent(segments.slice(2).join('/')) : null;
  if (!ENTITY_TYPES.has(type)) throw new HttpError(404, `Unknown entity type: ${type}`);
  if (request.method === 'GET' && !canReadEntity(type, context.role)) throw new HttpError(403, `Role ${context.role} cannot read ${type}`);
  if (request.method !== 'GET' && !canWriteEntity(type, context.role)) throw new HttpError(403, `Role ${context.role} cannot modify ${type}`);

  if (request.method === 'GET' && !id) {
    const params = listParams(request);
    const paginated = params.limit > 0;
    let records;
    let nextCursor = null;
    if (type === 'conversations') {
      const result = await listConversationIdsForMember(env, context.shopId, context.email, params);
      records = result.records;
      nextCursor = result.nextCursor;
    } else {
      const result = await listEntities(env, context.shopId, type, params);
      records = paginated ? result.records : result;
      nextCursor = paginated ? result.nextCursor : null;
    }
    if (type === 'chatmessages') {
      const allowedResult = await listConversationIdsForMember(env, context.shopId, context.email);
      const allowedIds = new Set(allowedResult.ids);
      if (params.conversationId && !allowedIds.has(params.conversationId)) throw new HttpError(404, 'Conversation not found');
      const listed = await listChatMessagesForConversations(env, context.shopId, context.email, params);
      records = listed.records;
      nextCursor = listed.nextCursor;
    }
    if (type === 'employees') records = records.map(record => redactEmployee(record, context.role));
    return paginated ? json({ records, nextCursor }) : json(records);
  }
  if (request.method === 'GET' && id) {
    const record = await getEntity(env, context.shopId, type, id);
    if (!record) throw new HttpError(404, 'Not found');
    if (type === 'conversations' && !members(record).includes(context.email)) throw new HttpError(404, 'Not found');
    if (type === 'chatmessages') {
      const conversation = await getEntity(env, context.shopId, 'conversations', record.conversationId);
      if (!conversation || !members(conversation).includes(context.email)) throw new HttpError(404, 'Not found');
    }
    return json(type === 'employees' ? redactEmployee(record, context.role) : record);
  }
  if (request.method === 'POST' && !id) {
    let body = normalizeEntityPayload(sourceType, await requestJson(request));
    const naturalId = type === 'invoices' ? body.number : type === 'customers' ? body.name : null;
    const newId = String(body.id || naturalId || crypto.randomUUID());
    if (type === 'conversations') {
      if (!['direct', 'group'].includes(body.kind)) throw new HttpError(400, 'Conversation kind must be direct or group');
      if (body.kind === 'group' && context.role !== 'admin') throw new HttpError(403, 'Only owners can create group conversations');
      const memberEmails = members(body);
      if (!memberEmails.includes(context.email) || memberEmails.length < 2) {
        throw new HttpError(400, 'Conversation requires the creator and at least one other member');
      }
      body = { ...body, memberEmails, creatorEmail: context.email };
    }
    if (type === 'chatmessages') {
      const conversation = await getEntity(env, context.shopId, 'conversations', String(body.conversationId || ''));
      if (!conversation || !members(conversation).includes(context.email) || !String(body.body || '').trim()) {
        throw new HttpError(404, 'Conversation not found');
      }
      body = {
        ...body,
        body: String(body.body).trim().slice(0, 4000),
        memberEmails: members(conversation),
        senderEmail: context.email,
      };
    }
    const saved = await putEntity(env, context, type, newId, body);
    return json(saved, 201);
  }
  if (request.method === 'PUT' && id) {
    let body = normalizeEntityPayload(sourceType, await requestJson(request));
    if (type === 'chatmessages') throw new HttpError(405, 'Chat messages cannot be edited');
    if (type === 'conversations') {
      const existing = await getEntity(env, context.shopId, type, id);
      if (!existing || !members(existing).includes(context.email)) throw new HttpError(404, 'Conversation not found');
      if (existing.kind !== 'group' || context.role !== 'admin') throw new HttpError(403, 'Only owners can edit group conversations');
      const memberEmails = members(body);
      if (!memberEmails.includes(context.email) || memberEmails.length < 2) {
        throw new HttpError(400, 'Group requires the owner and at least one other member');
      }
      body = { ...body, memberEmails, creatorEmail: existing.creatorEmail };
    }
    const saved = await putEntity(env, context, type, id, body, request.headers.get('If-Match'));
    return json(saved);
  }
  if (request.method === 'DELETE' && id) {
    const result = await removeEntity(env, context, type, id, {
      archiveOnly: request.headers.get('X-ShopCrank-Archive-Only') === 'true',
    });
    return result.status === 204 ? new Response(null, { status: 204 }) : json(result.body);
  }
  throw new HttpError(405, 'Method not allowed');
}
