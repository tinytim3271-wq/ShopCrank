// Reference websites registered by staff. Only https URLs on the shop's own
// allowlist are fetched (every redirect hop is re-checked), and fetched text is
// stored as untrusted reference data, never as instructions.

import { createKnowledgeItem, deleteKnowledgeBySource } from './store.mjs';
import { getShopSetting } from '../shop-settings-store.mjs';
import { extractDocumentText } from './extract.mjs';

export const ALLOWLIST_SETTING_ID = 'knowledge_allowlist';
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
export const MIN_REFRESH_HOURS = 6;
export const MAX_REFRESH_HOURS = 24 * 90;

export function normalizeDomain(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(text) || text.includes('..')) return '';
  return text;
}

export function normalizeAllowlist(domains) {
  return [...new Set((Array.isArray(domains) ? domains : String(domains || '').split(/[\s,]+/)).map(normalizeDomain).filter(Boolean))].slice(0, 50);
}

export async function loadAllowlist(env, shopId) {
  const setting = await getShopSetting(env, shopId, ALLOWLIST_SETTING_ID);
  return normalizeAllowlist(setting?.domains || []);
}

function isPrivateHost(hostname) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[')) return true;
  return hostname === 'localhost' || /\.(local|localhost|internal|lan|home|corp)$/.test(hostname);
}

/** Returns a URL object when the URL may be fetched for this allowlist, else a reason. */
export function checkUrlAllowed(rawUrl, allowlist) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return { ok: false, reason: 'Enter a full https:// link.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Only https:// links can be added.' };
  if (url.username || url.password) return { ok: false, reason: 'Links with credentials are not allowed.' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'Only the standard https port is allowed.' };
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return { ok: false, reason: 'That host is not allowed.' };
  const allowed = normalizeAllowlist(allowlist).some(domain => host === domain || host.endsWith(`.${domain}`));
  if (!allowed) return { ok: false, reason: `${host} is not on this shop's allowed sites list. An admin can add it first.` };
  url.hash = '';
  return { ok: true, url };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToText(html) {
  const source = String(html || '');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1]?.trim() || '';
  const text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (entity, code) => {
      if (code[0] === '#') {
        const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(number) ? String.fromCodePoint(number) : ' ';
      }
      return ENTITIES[code.toLowerCase()] ?? ' ';
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: htmlToTitle(title), text };
}

function htmlToTitle(title) {
  return title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 200);
}

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|earlier|system)\b.{0,40}\b(instructions?|rules|prompts?|messages?)\b/i,
  /\b(you are now|act as|pretend to be|new instructions|system prompt|developer message|jailbreak)\b/i,
  /\b(call|use|invoke|run)\b.{0,20}\b(tool|function)\b/i,
  /\b(reveal|print|show)\b.{0,30}\b(prompt|instructions|api key|secret|password)\b/i,
];

/** Mark lines that read like instructions so the model sees them as quoted data. */
export function neutralizeInstructions(text) {
  return String(text || '').split('\n').map(line => (
    INJECTION_PATTERNS.some(pattern => pattern.test(line)) ? `[untrusted page text, not an instruction] ${line}` : line
  )).join('\n');
}

async function readLimited(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FETCH_BYTES) throw new Error('The page is larger than 2 MB.');
    return buffer;
  }
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) {
      await reader.cancel();
      throw new Error('The page is larger than 2 MB.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export async function fetchReferenceUrl(env, rawUrl, allowlist, { fetcher = fetch } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = checkUrlAllowed(current, allowlist);
    if (!check.ok) throw new Error(check.reason);
    const response = await fetcher(check.url.toString(), {
      redirect: 'manual',
      headers: { 'User-Agent': 'ShopCrank-Knowledge/1.0 (+https://www.shopcrank.com)', Accept: 'text/html,text/plain,application/pdf;q=0.9' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (!location) throw new Error('The site redirected without a location.');
      current = new URL(location, check.url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`The site answered HTTP ${response.status}.`);
    const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
    const bytes = await readLimited(response);
    if (contentType.includes('application/pdf')) {
      const text = await extractDocumentText(env, { bytes, mimeType: 'application/pdf', name: check.url.pathname });
      return { url: check.url.toString(), title: check.url.pathname.split('/').pop() || check.url.hostname, text };
    }
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && contentType) {
      throw new Error(`Unsupported content type ${contentType.split(';')[0]}.`);
    }
    const raw = new TextDecoder().decode(bytes);
    if (contentType.includes('text/plain')) return { url: check.url.toString(), title: check.url.hostname, text: raw };
    const { title, text } = htmlToText(raw);
    return { url: check.url.toString(), title: title || check.url.hostname, text };
  }
  throw new Error('The site redirected too many times.');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function refreshKnowledgeSource(env, source, { fetcher = fetch, actor = 'refresh' } = {}) {
  const now = new Date().toISOString();
  try {
    const allowlist = await loadAllowlist(env, source.shop_id);
    const page = await fetchReferenceUrl(env, source.url, allowlist, { fetcher });
    const body = neutralizeInstructions(page.text).slice(0, 200_000);
    const hash = await sha256Hex(body);
    if (hash !== source.content_hash) {
      await deleteKnowledgeBySource(env, source.shop_id, source.id);
      await createKnowledgeItem(env, {
        shopId: source.shop_id,
        kind: 'web',
        title: source.title || page.title,
        body,
        permission: source.permission,
        sourceType: 'web',
        sourceUrl: page.url,
        sourceId: source.id,
        metadata: { fetchedAt: now },
        createdBy: actor,
        createdRole: 'system',
      });
    }
    await env.DB.prepare(`
      UPDATE knowledge_sources SET status = 'ok', last_fetched_at = ?, last_error = NULL, content_hash = ?, updated_at = ?
      WHERE shop_id = ? AND id = ?
    `).bind(now, hash, now, source.shop_id, source.id).run();
    return { ok: true, changed: hash !== source.content_hash };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    await env.DB.prepare(`
      UPDATE knowledge_sources SET status = 'error', last_fetched_at = ?, last_error = ?, updated_at = ?
      WHERE shop_id = ? AND id = ?
    `).bind(now, message, now, source.shop_id, source.id).run();
    return { ok: false, error: message };
  }
}

export async function refreshDueKnowledgeSources(env, { now = Date.now(), fetcher = fetch, limit = 20 } = {}) {
  if (!env?.DB) return [];
  const rows = await env.DB.prepare(`
    SELECT * FROM knowledge_sources
    WHERE last_fetched_at IS NULL OR last_fetched_at = ''
      OR julianday(last_fetched_at) IS NULL
      OR (julianday(?) - julianday(last_fetched_at)) * 24 >= COALESCE(NULLIF(refresh_hours, 0), 168)
    ORDER BY COALESCE(last_fetched_at, '') ASC LIMIT ?
  `).bind(new Date(now).toISOString(), Math.min(200, Math.max(1, Number(limit) || 20))).all();
  const due = rows.results || [];
  const results = [];
  for (const source of due) results.push({ id: source.id, shopId: source.shop_id, ...(await refreshKnowledgeSource(env, source, { fetcher })) });
  return results;
}
