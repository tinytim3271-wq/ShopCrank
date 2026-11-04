import {
  ENTITY_TYPES,
  canReadEntity,
  canWriteEntity,
  normalizeEntityPayload,
  normalizeEntityType,
  redactEmployee,
} from '../domain.mjs';
import { HttpError, json, requestJson } from '../http.mjs';
import { syncAccessUser } from '../access-users.mjs';
import {
  CUSTOMER_LINKED_TYPES,
  RECORD_DELETE_DENIED,
  canDeleteRecords,
  describeLinkedCounts,
  hasLinkedRecords,
  requiresAdminDelete,
  ARCHIVABLE_TYPES,
  ARCHIVE_FIELDS,
  archiveReason,
  isArchived,
  removalAction,
} from '../../../src/modules/record-deletion.js';

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

export async function listEntities(env, shopId, type, { limit = 0, cursor = '', archived = 'include' } = {}) {
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(200, Math.floor(Number(limit)))
    : 0;
  const nextCursor = String(cursor || '').trim();
  const filters = ['shop_id = ?', 'entity_type = ?'];
  const bindValues = [shopId, type];
  // Archived records stay in the database for reports; list screens ask for them only on purpose.
  if (archived === 'exclude') filters.push("json_extract(data_json, '$.archivedAt') IS NULL");
  if (archived === 'only') filters.push("json_extract(data_json, '$.archivedAt') IS NOT NULL");
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

export async function putEntity(env, context, type, id, body, expectedUpdatedAt = null, createdBy = context.userId, { create = false } = {}) {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    'SELECT created_at, created_by, updated_at, data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(context.shopId, type, id).first();
  if (expectedUpdatedAt && existing && existing.updated_at !== expectedUpdatedAt) {
    throw new HttpError(409, 'Record was updated elsewhere. Reload before saving again.');
  }
  const record = {
    ...archiveFieldsForSave(existing, body, context, { create, type, id }),
    ...body,
    id,
    shopId: context.shopId,
    createdBy: existing?.created_by || createdBy,
    createdAt: body.createdAt || existing?.created_at || now,
    updatedAt: now,
  };
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).bind(context.shopId, type, id, JSON.stringify(record), record.createdBy, record.createdAt, now).run();
  return record;
}

const ARCHIVE_LABELS = { customers: 'Customer', vehicles: 'Vehicle', orders: 'Work order', invoices: 'Invoice', payments: 'Payment' };

/**
 * Saves never quietly change an archived record. Creating a record over an
 * archived one is refused (a reused work-order number or customer name would
 * otherwise overwrite it); a stale edit keeps the archive fields; only an
 * owner/admin sending `archivedAt: null` restores it.
 */
export function archiveFieldsForSave(existingRow, body, context, { create = false, type = '', id = '' } = {}) {
  let previous = null;
  try { previous = existingRow?.data_json ? JSON.parse(existingRow.data_json) : null; } catch { previous = null; }
  const restoring = body.archivedAt === null;
  // Archive fields are owned by the archive/restore routes: a save can neither
  // set them (hiding a record without the admin check) nor change them.
  for (const field of ARCHIVE_FIELDS) delete body[field];
  if (!isArchived(previous)) return {};
  if (create) {
    throw new HttpError(409, `${ARCHIVE_LABELS[type] || 'Record'} ${previous.name || previous.number || id} is archived. Restore it from Settings → Archived records, or use a different name or number.`);
  }
  if (restoring) {
    if (!canDeleteRecords(context.role)) throw new HttpError(403, 'Only the shop owner or an admin can restore archived records');
    return {};
  }
  return Object.fromEntries(ARCHIVE_FIELDS.filter(field => previous[field] !== undefined).map(field => [field, previous[field]]));
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
    archived: ['only', 'include'].includes(url.searchParams.get('archived')) ? url.searchParams.get('archived') : 'exclude',
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

async function listCustomerLinkedIds(env, shopId, type, customerName) {
  const result = await env.DB.prepare(
    "SELECT entity_id, data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND json_extract(data_json, '$.customer') = ?",
  ).bind(shopId, type, customerName).all();
  return (result.results || []).map(row => ({ id: row.entity_id, record: entityRecord(row) || {} }));
}

/**
 * Everything linked to a customer by name, plus payments on the customer's invoices.
 * Returns `{ [type]: [{ id, record }] }` for CUSTOMER_LINKED_TYPES.
 */
export async function customerLinkedEntities(env, shopId, customerName) {
  const name = String(customerName || '').trim();
  const linked = Object.fromEntries(CUSTOMER_LINKED_TYPES.map(type => [type, []]));
  if (!name) return linked;
  for (const type of CUSTOMER_LINKED_TYPES) linked[type] = await listCustomerLinkedIds(env, shopId, type, name);
  const paymentIds = new Set(linked.payments.map(item => item.id));
  for (const invoice of linked.invoices) {
    for (const payment of await listPaymentsByInvoice(env, shopId, invoice.record.number || invoice.id)) {
      if (payment.id && !paymentIds.has(payment.id)) {
        paymentIds.add(payment.id);
        linked.payments.push({ id: payment.id, record: payment });
      }
    }
  }
  return linked;
}

/** D1 statements that remove a customer and everything linked to it, in one batch. */
export function buildCustomerCascadeStatements(env, context, customerId, linked) {
  const remove = (type, id) => env.DB.prepare(
    'DELETE FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(context.shopId, type, id);
  const statements = [remove('customers', customerId)];
  for (const type of CUSTOMER_LINKED_TYPES) {
    for (const item of linked[type] || []) statements.push(remove(type, item.id));
  }
  return statements;
}

async function listPaymentsByInvoice(env, shopId, invoiceNumber) {
  const result = await env.DB.prepare(
    "SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'payments' AND json_extract(data_json, '$.invoiceNumber') = ?",
  ).bind(shopId, invoiceNumber).all();
  return (result.results || []).map(entityRecord).filter(Boolean);
}

/**
 * Build D1 statements for deleting an entity.
 * Employee deletes must revoke Access users even when the row is not an invoice.
 */
export function buildEntityDeleteStatements(env, context, type, id, existing, relatedPayments = []) {
  const statements = [env.DB.prepare(
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
    statements.push(env.DB.prepare(
      'DELETE FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?',
    ).bind(existing.email, context.shopId));
  }

  return statements;
}

async function listByJsonField(env, shopId, type, field, value) {
  if (String(value ?? '').trim() === '') return [];
  const result = await env.DB.prepare(
    `SELECT entity_id, data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND json_extract(data_json, '$.${field}') = ?`,
  ).bind(shopId, type, String(value)).all();
  return (result.results || []).map(row => ({ id: row.entity_id, record: entityRecord(row) || {} }));
}

const REAL_VIN = /^[A-HJ-NPR-Z0-9]{17}$/i;

/** Linked records that decide archive vs delete, looked up in D1 (shape matches relatedForRemoval). */
export async function relatedFromDb(env, shopId, type, id, record) {
  if (type === 'invoices') {
    const number = record.number || id;
    const byNumber = await listPaymentsByInvoice(env, shopId, number);
    // Deposits are taken against the work order before the invoice exists.
    const deposits = record.ro ? (await listByJsonField(env, shopId, 'payments', 'workOrderId', record.ro)).map(item => ({ ...item.record, id: item.id })) : [];
    const payments = [...new Map([...byNumber, ...deposits].map(payment => [payment.id, payment])).values()];
    const links = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM customer_document_links WHERE shop_id = ? AND document_type = 'invoice' AND document_id IN (?, ?)",
    ).bind(shopId, id, number).first().catch(() => ({ n: 0 }));
    return { payments: payments.map(p => ({ id: p.id, record: p })), documentLinks: Number(links?.n || 0) };
  }
  if (type === 'orders') {
    return {
      invoices: await listByJsonField(env, shopId, 'invoices', 'ro', id),
      payments: await listByJsonField(env, shopId, 'payments', 'workOrderId', id),
    };
  }
  if (type === 'vehicles') {
    const vin = REAL_VIN.test(String(record.vin || '').trim()) ? String(record.vin).trim().toUpperCase() : '';
    const orders = [...await listByJsonField(env, shopId, 'orders', 'vehicleId', id), ...(vin ? await listByJsonField(env, shopId, 'orders', 'vin', vin) : [])];
    const invoices = vin ? await listByJsonField(env, shopId, 'invoices', 'vin', vin) : [];
    for (const order of orders) invoices.push(...await listByJsonField(env, shopId, 'invoices', 'ro', order.id));
    return { invoices: [...new Map(invoices.map(item => [item.id, item])).values()] };
  }
  if (type === 'customers') {
    const linked = await customerLinkedEntities(env, shopId, record.name);
    return { invoices: linked.invoices, payments: linked.payments, linked };
  }
  return {};
}

/**
 * Sets only the archive fields (and updatedAt) inside data_json, so an edit that
 * lands between reading the record and archiving it is kept.
 */
function archiveStatement(env, context, type, id, record, options, extra = {}) {
  const fields = { archivedAt: options.at, archivedBy: options.actor || '', archiveReason: options.reason || '', ...(options.group ? { archiveGroup: options.group } : {}), updatedAt: options.at, ...extra };
  const paths = Object.keys(fields).map(key => `'$.${key}', json(?)`).join(', ');
  return env.DB.prepare(`UPDATE entities SET data_json = json_set(data_json, ${paths}), updated_at = ? WHERE shop_id = ? AND entity_type = ? AND entity_id = ?`)
    .bind(...Object.values(fields).map(value => JSON.stringify(value)), options.at, context.shopId, type, id);
}

/**
 * Remove an archivable record under the shop delete policy: records with money
 * attached are archived (with the records that belong to them), the rest are
 * permanently deleted. Returns { action, archived, deleted } with ids per type.
 */
export async function removeShopRecord(env, context, type, id, existing, cascade = false) {
  if (isArchived(existing)) throw new HttpError(409, `${ARCHIVE_LABELS[type] || 'Record'} is already archived`);
  const related = await relatedFromDb(env, context.shopId, type, id, existing);
  if (type === 'customers' && hasLinkedRecords(related.linked) && !cascade) {
    throw new HttpError(409, `${existing.name || 'This customer'} has ${describeLinkedCounts(related.linked)}. Delete them too, or delete those records first.`);
  }
  const action = removalAction(type, existing, related);
  if (action === 'delete') {
    if (type === 'customers' && hasLinkedRecords(related.linked)) {
      await env.DB.batch(buildCustomerCascadeStatements(env, context, id, related.linked));
    } else {
      await env.DB.batch(buildEntityDeleteStatements(env, context, type, id, existing, []));
    }
    return { action: 'delete' };
  }
  const options = { actor: context.email || context.userId || '', at: new Date().toISOString(), reason: archiveReason(type), group: `${type}:${id}` };
  const statements = [archiveStatement(env, context, type, id, existing, options)];
  const archived = { [type]: [id] };
  const deleted = {};
  const add = (bucket, kind, itemId) => { (bucket[kind] ||= []).push(itemId); };
  if (type === 'invoices') {
    for (const payment of related.payments || []) {
      if (isArchived(payment.record)) continue;
      statements.push(archiveStatement(env, context, 'payments', payment.id, payment.record, options));
      add(archived, 'payments', payment.id);
    }
  }
  if (type === 'customers') {
    // The customer's vehicles and work orders go with them; invoices and payments
    // stay as they are (they are the financial record); open appointments go away.
    for (const kind of ['vehicles', 'orders']) {
      for (const item of related.linked[kind] || []) {
        if (isArchived(item.record)) continue;
        statements.push(archiveStatement(env, context, kind, item.id, item.record, options));
        add(archived, kind, item.id);
      }
    }
    for (const item of related.linked.appointments || []) {
      statements.push(env.DB.prepare('DELETE FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?').bind(context.shopId, 'appointments', item.id));
      add(deleted, 'appointments', item.id);
    }
  }
  await env.DB.batch(statements);
  return { action: 'archive', archived, deleted, reason: options.reason };
}

/** Roles that can record a customer's approval or refusal on a work order. */
export const SERVICE_REFUSAL_ROLES = Object.freeze(['owner', 'admin', 'super_admin', 'service_writer']);

/**
 * Archive a work order because the customer refused the work. Allowed for the
 * roles that record approvals; the refusal (who, when, note) is kept on the record
 * and an owner or admin can restore it from Settings -> Archived records.
 */
export async function refuseShopOrder(env, context, id, body = {}) {
  if (!SERVICE_REFUSAL_ROLES.includes(String(context.role || ''))) throw new HttpError(403, 'Only an owner, admin or service writer can record a refused service');
  const existing = await getEntity(env, context.shopId, 'orders', id);
  if (!existing) throw new HttpError(404, 'Not found');
  if (isArchived(existing)) throw new HttpError(409, 'Work order is already archived');
  if (['completed', 'invoiced'].includes(String(existing.status || ''))) throw new HttpError(409, 'A completed or invoiced work order cannot be refused');
  const at = new Date().toISOString();
  const refusal = {
    refusedAt: at,
    recordedBy: context.email || context.userId || '',
    customerName: String(body.customerName || existing.customer || '').trim().slice(0, 100),
    note: String(body.note || '').trim().slice(0, 500),
  };
  const options = { actor: refusal.recordedBy, at, reason: 'Customer refused service', group: `orders:${id}` };
  await env.DB.batch([archiveStatement(env, context, 'orders', id, existing, options, { serviceRefusal: refusal })]);
  return { action: 'archive', archived: { orders: [id] }, deleted: {}, reason: options.reason, refusal };
}

/** Restore a record and everything archived together with it (same archiveGroup). */
export async function restoreShopRecord(env, context, type, id) {
  if (!canDeleteRecords(context.role)) throw new HttpError(403, 'Only the shop owner or an admin can restore archived records');
  const existing = await getEntity(env, context.shopId, type, id);
  if (!existing) throw new HttpError(404, 'Not found');
  if (!isArchived(existing)) return { restored: {} };
  const group = existing.archiveGroup || `${type}:${id}`;
  const result = await env.DB.prepare(
    "SELECT entity_type, entity_id, data_json FROM entities WHERE shop_id = ? AND json_extract(data_json, '$.archiveGroup') = ?",
  ).bind(context.shopId, group).all();
  const rows = (result.results || []).length ? result.results : [{ entity_type: type, entity_id: id, data_json: JSON.stringify(existing) }];
  const now = new Date().toISOString();
  const restored = {};
  // Remove only the archive fields so edits made since the archive are kept.
  const removePaths = ARCHIVE_FIELDS.map(field => `'$.${field}'`).join(', ');
  const statements = rows.map(row => {
    (restored[row.entity_type] ||= []).push(row.entity_id);
    return env.DB.prepare(`UPDATE entities SET data_json = json_set(json_remove(data_json, ${removePaths}), '$.updatedAt', ?), updated_at = ? WHERE shop_id = ? AND entity_type = ? AND entity_id = ?`)
      .bind(now, now, context.shopId, row.entity_type, row.entity_id);
  });
  await env.DB.batch(statements);
  return { restored };
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
      let archived = ARCHIVABLE_TYPES.has(type) ? params.archived : 'include';
      if ((archived === 'only' || (archived === 'include' && !['invoices', 'payments'].includes(type))) && !canDeleteRecords(context.role)) {
        throw new HttpError(403, 'Only the shop owner or an admin can view archived records');
      }
      const result = await listEntities(env, context.shopId, type, { ...params, archived });
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
  if (request.method === 'POST' && id && type === 'orders' && segments.at(-1) === 'refuse') {
    return json(await refuseShopOrder(env, context, decodeURIComponent(segments.slice(2, -1).join('/')), await requestJson(request)));
  }
  if (request.method === 'POST' && id && ARCHIVABLE_TYPES.has(type) && segments.at(-1) === 'restore') {
    const recordId = decodeURIComponent(segments.slice(2, -1).join('/'));
    return json(await restoreShopRecord(env, context, type, recordId));
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
    if (type === 'employees') await syncAccessUser(env, context, body);
    const saved = await putEntity(env, context, type, newId, body, null, context.userId, { create: true });
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
    if (type === 'employees') await syncAccessUser(env, context, body);
    const saved = await putEntity(env, context, type, id, body, request.headers.get('If-Match'));
    return json(saved);
  }
  if (request.method === 'DELETE' && id) {
    const existing = await getEntity(env, context.shopId, type, id);
    if (!existing) throw new HttpError(404, 'Not found');
    if (['conversations', 'chatmessages'].includes(type)
      && (!members(existing).includes(context.email) || (context.role !== 'admin' && existing.createdBy !== context.userId))) {
      throw new HttpError(403, 'Not permitted');
    }
    if (requiresAdminDelete(type) && !canDeleteRecords(context.role)) throw new HttpError(403, RECORD_DELETE_DENIED);
    if (ARCHIVABLE_TYPES.has(type)) {
      const result = await removeShopRecord(env, context, type, id, existing, new URL(request.url).searchParams.get('cascade') === '1');
      return result.action === 'delete' ? new Response(null, { status: 204 }) : json(result);
    }
    await env.DB.batch(buildEntityDeleteStatements(env, context, type, id, existing, []));
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, 'Method not allowed');
}
