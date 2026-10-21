// /api/knowledge/*: per-shop documents, notes, procedures, FAQs, reference
// websites, and memories. All reads are filtered by the caller's role; all
// writes go through resolveKnowledgePermission so technicians cannot create
// customer-safe or accounting knowledge.

import { HttpError, json, requestJson } from '../http.mjs';
import {
  assignableKnowledgePermissions,
  canUseAccounting,
  isStaffRole,
  readableKnowledgePermissions,
  resolveKnowledgePermission,
} from '../assistant/rbac.mjs';
import {
  KNOWLEDGE_KINDS,
  MEMORY_CATEGORIES,
  citationsFrom,
  createKnowledgeItem,
  deleteKnowledgeBySource,
  deleteKnowledgeItem,
  getKnowledgeItem,
  listKnowledgeItems,
  searchKnowledge,
  updateKnowledgeItem,
} from './store.mjs';
import { base64ToBytes, extractDocumentText } from './extract.mjs';
import {
  ALLOWLIST_SETTING_ID,
  MAX_REFRESH_HOURS,
  MIN_REFRESH_HOURS,
  checkUrlAllowed,
  loadAllowlist,
  normalizeAllowlist,
  refreshKnowledgeSource,
} from './web.mjs';
import { deriveRepairPatternMemories, saveMemory } from './memory.mjs';
import { putShopSetting } from '../shop-settings-store.mjs';

const STAFF_KINDS = ['document', 'note', 'procedure', 'faq'];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const SITE_ADMIN_ROLES = ['super_admin', 'owner', 'admin'];

function publicItem(item, { includeBody = true } = {}) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ...(includeBody ? { body: item.body } : { preview: item.body.slice(0, 240) }),
    permission: item.permission,
    sourceType: item.sourceType,
    sourceUrl: item.sourceUrl || undefined,
    category: item.metadata?.category,
    vehicle: item.metadata?.vehicle,
    autoTagged: item.metadata?.autoTagged || undefined,
    createdBy: item.createdBy,
    createdRole: item.createdRole,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function requireStaff(context) {
  if (!isStaffRole(context.role)) throw new HttpError(403, 'Only shop staff can use the knowledge base');
}

async function readableItem(env, context, id) {
  const item = await getKnowledgeItem(env, context.shopId, id);
  const permissions = readableKnowledgePermissions({ persona: 'tech_assistant', role: context.role });
  if (!item || !permissions.includes(item.permission)) throw new HttpError(404, 'Knowledge item not found');
  return item;
}

function ensureMayEdit(context, item) {
  if (item.permission === 'accounting' && !canUseAccounting(context.role)) throw new HttpError(404, 'Knowledge item not found');
  if (item.permission === 'customer_safe' && context.role === 'technician') {
    throw new HttpError(403, 'Customer-safe knowledge is published to the phone bot; ask an admin or office staff to change it.');
  }
  if (['web', 'questionnaire'].includes(item.kind)) throw new HttpError(409, 'This item is managed by its source; edit the website source or the Front Desk questionnaire instead.');
}

function tagFor(context, requested, text) {
  const resolved = resolveKnowledgePermission({ role: context.role, requested, text });
  if (!resolved.permission) {
    throw new HttpError(403, `Your role can tag knowledge as: ${assignableKnowledgePermissions(context.role).join(', ')}.`);
  }
  return resolved;
}

async function bodyFromRequest(env, body) {
  if (body.file?.base64) {
    const bytes = base64ToBytes(body.file.base64);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files must be 8 MB or smaller');
    const name = String(body.file.name || 'document').slice(0, 200);
    const mimeType = String(body.file.mimeType || '').slice(0, 100);
    if (!/^(application\/pdf|text\/(plain|markdown|csv))$/.test(mimeType) && !/\.(pdf|txt|md|csv)$/i.test(name)) {
      throw new HttpError(415, 'Upload a PDF or a text file');
    }
    const text = await extractDocumentText(env, { bytes, mimeType, name });
    if (!text.trim()) throw new HttpError(422, 'No text could be read from that file (scanned PDFs need OCR first).');
    let fileKey = '';
    if (env.FILES?.put) {
      fileKey = `knowledge/${crypto.randomUUID()}/${name.replace(/[^\w.-]+/g, '_')}`;
      await env.FILES.put(fileKey, bytes, { httpMetadata: { contentType: mimeType || 'application/octet-stream' } });
    }
    return { text, name, mimeType, fileKey, sourceType: 'upload' };
  }
  return { text: String(body.body || ''), name: '', mimeType: '', fileKey: '', sourceType: 'manual' };
}

async function handleItems(request, env, context, id, { memory = false } = {}) {
  const shopId = context.shopId;
  const permissions = readableKnowledgePermissions({ persona: 'tech_assistant', role: context.role });
  if (!id && request.method === 'GET') {
    const url = new URL(request.url);
    const kind = memory ? 'memory' : (url.searchParams.get('kind') || '');
    const items = await listKnowledgeItems(env, { shopId, permissions, kind, excludeKind: memory || kind ? '' : 'memory' });
    return json({ items: items.map(item => publicItem(item, { includeBody: memory })), assignablePermissions: assignableKnowledgePermissions(context.role) });
  }
  if (!id && request.method === 'POST') {
    const body = await requestJson(request);
    if (memory) {
      const result = await saveMemory(env, {
        shopId,
        role: context.role,
        userId: context.userId,
        content: body.content || body.body,
        category: body.category,
        vehicle: body.vehicle,
        permission: body.permission || 'staff',
      });
      if (result.error) throw new HttpError(400, result.error);
      return json({ item: publicItem(await getKnowledgeItem(env, shopId, result.id)), autoTagged: result.autoTagged }, 201);
    }
    const kind = STAFF_KINDS.includes(body.kind) ? body.kind : 'note';
    const content = await bodyFromRequest(env, body);
    const title = String(body.title || content.name || '').trim();
    if (!title) throw new HttpError(400, 'A title is required');
    if (!content.text.trim()) throw new HttpError(400, 'Add some text or upload a file');
    const tag = tagFor(context, body.permission || 'staff', `${title}\n${content.text}`);
    const item = await createKnowledgeItem(env, {
      shopId,
      kind: content.sourceType === 'upload' && !STAFF_KINDS.includes(body.kind) ? 'document' : kind,
      title,
      body: content.text,
      permission: tag.permission,
      sourceType: content.sourceType,
      mimeType: content.mimeType,
      fileKey: content.fileKey,
      metadata: tag.autoTagged ? { autoTagged: true } : {},
      createdBy: context.userId,
      createdRole: context.role,
    });
    return json({ item: publicItem(item), autoTagged: tag.autoTagged, chunkCount: item.chunkCount }, 201);
  }
  if (id) {
    const item = await readableItem(env, context, id);
    if (memory && item.kind !== 'memory') throw new HttpError(404, 'Memory not found');
    if (request.method === 'GET') return json({ item: publicItem(item) });
    ensureMayEdit(context, item);
    if (request.method === 'PUT') {
      const body = await requestJson(request);
      const title = body.title ?? item.title;
      const text = body.body ?? body.content ?? item.body;
      const tag = tagFor(context, body.permission || item.permission, `${title}\n${text}`);
      const metadata = memory
        ? { category: MEMORY_CATEGORIES.includes(body.category) ? body.category : item.metadata.category, vehicle: String(body.vehicle ?? item.metadata.vehicle ?? '').slice(0, 80), autoTagged: tag.autoTagged || undefined }
        : { autoTagged: tag.autoTagged || undefined };
      const updated = await updateKnowledgeItem(env, context.shopId, id, { title: memory ? String(text).slice(0, 80) : title, body: text, permission: tag.permission, metadata });
      return json({ item: publicItem(updated), autoTagged: tag.autoTagged });
    }
    if (request.method === 'DELETE') {
      await deleteKnowledgeItem(env, context.shopId, id);
      return json({ deleted: true });
    }
  }
  throw new HttpError(405, 'Method not allowed');
}

function sourceRow(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    permission: row.permission,
    refreshHours: Number(row.refresh_hours),
    status: row.status,
    lastFetchedAt: row.last_fetched_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

async function handleSources(request, env, context, id, subaction, { fetcher }) {
  const shopId = context.shopId;
  const permissions = readableKnowledgePermissions({ persona: 'tech_assistant', role: context.role });
  if (!id && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT * FROM knowledge_sources WHERE shop_id = ? AND permission IN (${permissions.map(() => '?').join(', ')}) ORDER BY created_at DESC`)
      .bind(shopId, ...permissions).all();
    return json({ sources: (rows.results || []).map(sourceRow), allowlist: await loadAllowlist(env, shopId) });
  }
  if (!id && request.method === 'POST') {
    const body = await requestJson(request);
    const allowlist = await loadAllowlist(env, shopId);
    const check = checkUrlAllowed(body.url, allowlist);
    if (!check.ok) throw new HttpError(400, check.reason);
    const tag = tagFor(context, body.permission || 'staff', '');
    const refreshHours = Math.min(MAX_REFRESH_HOURS, Math.max(MIN_REFRESH_HOURS, Math.round(Number(body.refreshHours) || 168)));
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    try {
      await env.DB.prepare(`
        INSERT INTO knowledge_sources (id, shop_id, url, title, permission, refresh_hours, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).bind(sourceId, shopId, check.url.toString(), String(body.title || '').slice(0, 200), tag.permission, refreshHours, context.userId, now, now).run();
    } catch {
      throw new HttpError(409, 'That link is already a reference source');
    }
    const row = await env.DB.prepare('SELECT * FROM knowledge_sources WHERE shop_id = ? AND id = ?').bind(shopId, sourceId).first();
    const refreshed = body.fetchNow === false ? null : await refreshKnowledgeSource(env, row, { fetcher, actor: context.userId });
    const latest = await env.DB.prepare('SELECT * FROM knowledge_sources WHERE shop_id = ? AND id = ?').bind(shopId, sourceId).first();
    return json({ source: sourceRow(latest), refreshed }, 201);
  }
  if (id) {
    const row = await env.DB.prepare('SELECT * FROM knowledge_sources WHERE shop_id = ? AND id = ?').bind(shopId, id).first();
    if (!row || !permissions.includes(row.permission)) throw new HttpError(404, 'Source not found');
    if (row.permission === 'customer_safe' && context.role === 'technician') throw new HttpError(403, 'Ask an admin or office staff to change customer-safe sources.');
    if (request.method === 'POST' && subaction === 'refresh') {
      const result = await refreshKnowledgeSource(env, row, { fetcher, actor: context.userId });
      const latest = await env.DB.prepare('SELECT * FROM knowledge_sources WHERE shop_id = ? AND id = ?').bind(shopId, id).first();
      return json({ source: sourceRow(latest), refreshed: result });
    }
    if (request.method === 'DELETE') {
      await deleteKnowledgeBySource(env, shopId, id);
      await env.DB.prepare('DELETE FROM knowledge_sources WHERE shop_id = ? AND id = ?').bind(shopId, id).run();
      return json({ deleted: true });
    }
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function handleKnowledgeRoutes(request, env, context, segments, { fetcher = fetch, listEntities = null } = {}) {
  requireStaff(context);
  const [, area = '', id = '', subaction = ''] = segments;
  const shopId = context.shopId;

  if (area === 'items') return handleItems(request, env, context, decodeURIComponent(id));
  if (area === 'memories' && id === 'derive') {
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const orders = typeof listEntities === 'function' ? await listEntities(env, shopId, 'orders') : [];
    const created = await deriveRepairPatternMemories(env, { shopId, orders, actor: context.userId });
    return json({ created });
  }
  if (area === 'memories') return handleItems(request, env, context, decodeURIComponent(id), { memory: true });
  if (area === 'sources') return handleSources(request, env, context, decodeURIComponent(id), subaction, { fetcher });

  if (area === 'allowlist') {
    if (request.method === 'GET') return json({ domains: await loadAllowlist(env, shopId) });
    if (request.method === 'PUT') {
      if (!SITE_ADMIN_ROLES.includes(context.role)) throw new HttpError(403, 'Only shop admins can change the allowed sites list');
      const body = await requestJson(request);
      const domains = normalizeAllowlist(body.domains);
      await putShopSetting(env, shopId, ALLOWLIST_SETTING_ID, { domains }, context.userId);
      return json({ domains });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (area === 'search' && request.method === 'GET') {
    const query = new URL(request.url).searchParams.get('q') || '';
    const results = await searchKnowledge(env, { shopId, permissions: readableKnowledgePermissions({ persona: 'tech_assistant', role: context.role }), query, limit: 8 });
    return json({ results, citations: citationsFrom(results) });
  }

  if (area === 'kinds' && request.method === 'GET') return json({ kinds: KNOWLEDGE_KINDS, memoryCategories: MEMORY_CATEGORIES });
  throw new HttpError(404, 'Not found');
}
