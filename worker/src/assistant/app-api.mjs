// The assistant's door into the rest of ShopCrank.
//
// The Tech Assistant calls the same API routes the app uses, as the signed-in
// user: every route's own role checks apply, so it can never do more than that
// person could. Three rules sit on top, enforced here AND again in the router:
//   1. Nothing is deleted: DELETE, and anything that archives, voids, resets,
//      revokes or disconnects, is refused.
//   2. Anything that leaves the shop or moves money (texts and email to
//      customers, payments, billing, integrations, user access, settings) is
//      not run by the assistant; it comes back as a card the user confirms.
//   3. Sign-in, the AI's own routes and voice sessions are off-limits.

const MAX_RESULT_CHARS = 14_000;

let dispatcher = null;

/** index.js registers the authenticated router here at module load (also inside Durable Objects). */
export function registerAppDispatcher(fn) {
  dispatcher = typeof fn === 'function' ? fn : null;
}

export function appDispatcherReady() {
  return Boolean(dispatcher);
}

/** The registered router (tests call it directly to prove the router-side guard). */
export function registeredAppDispatcher() {
  return dispatcher;
}

const DENIED_PREFIXES = ['/auth', '/ai', '/voice/grok/configure', '/billing/webhook', '/payments/webhook', '/downloads'];
// Word in the path that means the call removes something.
const DESTRUCTIVE_PATH = /(^|[/_.-])(delete|deletes|remove|reset|purge|wipe|erase|destroy|archive|void|revoke|disconnect|deactivate|suspend|truncate|clear-all)([/_.-]|$)/i;
const DESTRUCTIVE_STATUS = new Set(['deleted', 'void', 'voided', 'archived', 'removed', 'purged']);
const DESTRUCTIVE_FIELDS = ['archived', 'archivedAt', 'deleted', 'deletedAt', 'voided', 'voidedAt', 'removedAt', 'purgedAt'];

// Records whose changes reach people or money outside the shop floor.
const CONFIRM_ENTITY_TYPES = new Set(['employees', 'shopsettings', 'payments', 'payrollentries']);
// Writes the assistant may run on its own: shop records and lookups that only compute.
const AUTO_WRITE_PATHS = [
  /^\/entities\/[a-z]+(\/[^/]+)?$/,
  /^\/labor-times\/search$/,
  /^\/integrations\/labor-guide\/(search|manual)$/,
  /^\/mileage\/calculate$/,
  /^\/vehicle-data\/[a-z-]+$/,
  /^\/vehicles\/decode\/[A-Za-z0-9]+$/,
  /^\/knowledge\/(items|memories)$/,
  /^\/tax-report$/,
  /^\/document-links$/,
  /^\/entities\/orders\/[^/]+\/refuse$/,
];

/** "/api/entities/orders?x=1" → { path: "/entities/orders", search: "?x=1" }; null when unusable. */
export function normalizeAppPath(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (/^[a-z]+:\/\//i.test(text)) {
    try { const url = new URL(text); text = url.pathname + url.search; } catch { return null; }
  }
  if (!text.startsWith('/')) text = `/${text}`;
  const [pathPart, ...rest] = text.split('?');
  if (/\.\.|\\|%2e%2e/i.test(pathPart)) return null;
  const path = pathPart.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  return { path, search: rest.length ? `?${rest.join('?')}` : '' };
}

function destructiveBody(body) {
  if (!body || typeof body !== 'object') return '';
  for (const field of DESTRUCTIVE_FIELDS) {
    if (body[field]) return `sets ${field}`;
  }
  if (DESTRUCTIVE_STATUS.has(String(body.status || '').trim().toLowerCase())) return `sets status "${body.status}"`;
  return '';
}

/**
 * What the assistant may do with one API call:
 *   { decision: 'run' } | { decision: 'confirm', reason } | { decision: 'deny', reason }.
 */
export function classifyAppApiCall({ method = 'GET', path = '', body = null } = {}) {
  const verb = String(method || 'GET').toUpperCase();
  const normalized = normalizeAppPath(path);
  if (!normalized) return { decision: 'deny', reason: 'That is not a ShopCrank API path.' };
  const target = normalized.path;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) return { decision: 'deny', reason: `Method ${verb} is not supported.` };
  if (verb === 'DELETE') return { decision: 'deny', reason: 'The assistant is not allowed to delete anything. Ask the user to do it themselves.' };
  if (DENIED_PREFIXES.some(prefix => target === prefix || target.startsWith(`${prefix}/`))) {
    return { decision: 'deny', reason: 'Sign-in, AI and voice-session routes are not available to the assistant.' };
  }
  if (DESTRUCTIVE_PATH.test(target)) {
    return { decision: 'deny', reason: 'The assistant is not allowed to delete, archive, void, reset or disconnect anything. Ask the user to do it themselves.' };
  }
  if (verb === 'GET') return { decision: 'run' };
  const removes = destructiveBody(body);
  if (removes) return { decision: 'deny', reason: `The assistant is not allowed to delete or archive records (the change ${removes}).` };
  const entityType = target.match(/^\/entities\/([a-z]+)/)?.[1] || '';
  if (entityType && CONFIRM_ENTITY_TYPES.has(entityType)) {
    return { decision: 'confirm', reason: `Changes to ${entityType} affect money, pay or user access, so the user confirms them.` };
  }
  if (AUTO_WRITE_PATHS.some(pattern => pattern.test(target))) return { decision: 'run' };
  return { decision: 'confirm', reason: 'This reaches outside the shop (customers, payments, billing, integrations or settings), so the user confirms it on screen.' };
}

function compactResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_RESULT_CHARS) return value;
  return { truncated: true, note: `Result cut to ${MAX_RESULT_CHARS} characters; ask for a narrower query (an id, ?limit=, or a search).`, partial: text.slice(0, MAX_RESULT_CHARS) };
}

async function dispatch(env, context, { method, path, search = '', body = null, origin }) {
  if (!dispatcher) throw new Error('ShopCrank app API is not available to the assistant here');
  const url = `${origin || 'https://www.shopcrank.com'}/api${path}${search}`;
  const init = { method, headers: { Accept: 'application/json', 'X-ShopCrank-Assistant': '1' } };
  if (body !== null && body !== undefined && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await dispatcher(new Request(url, init), env, { ...context, viaAssistant: true });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = (response.headers.get('Content-Type') || '').includes('text') ? text.slice(0, MAX_RESULT_CHARS) : '[binary file]'; }
  return { status: response.status, ok: response.ok, data };
}

/** A PUT replaces the whole record, so merge the change into the current one first (no field is lost). */
async function mergedEntityBody(env, context, { path, body, origin }) {
  const match = path.match(/^\/entities\/([a-z]+)\/(.+)$/);
  if (!match || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const current = await dispatch(env, context, { method: 'GET', path, origin });
  if (!current.ok || !current.data || typeof current.data !== 'object') return body;
  return { ...current.data, ...body };
}

/**
 * Run one assistant API call as the signed-in user. Returns what the model sees:
 * the route's status and JSON, a confirmation card, or why it was refused.
 */
export async function callAppApi(env, context, args = {}, { origin = '', channel = 'text' } = {}) {
  const method = String(args.method || 'GET').toUpperCase();
  const normalized = normalizeAppPath(args.path);
  let body = args.body && typeof args.body === 'object' ? args.body : null;
  // Some providers can only pass the body as JSON text.
  if (!body && typeof args.body === 'string' && args.body.trim()) {
    try { body = JSON.parse(args.body); } catch { return { error: 'body must be JSON.' }; }
    if (!body || typeof body !== 'object') return { error: 'body must be a JSON object.' };
  }
  const verdict = classifyAppApiCall({ method, path: args.path, body });
  if (verdict.decision === 'deny') return { error: 'not_allowed', denied: true, message: verdict.reason };
  if (verdict.decision === 'confirm') {
    if (channel !== 'text') {
      return { error: 'needs_confirmation', message: `${verdict.reason} Ask the user to open the text assistant or do it in the app.` };
    }
    return {
      kind: 'app_api_confirmation',
      requiresUserReview: true,
      saved: false,
      method,
      path: `${normalized.path}${normalized.search}`,
      body,
      summary: String(args.summary || `${method} ${normalized.path}`).slice(0, 300),
      reason: verdict.reason,
      message: 'Not done yet: the user must tap Confirm on the card under your reply. Tell them what it will do.',
    };
  }
  const finalBody = method === 'PUT' ? await mergedEntityBody(env, context, { path: normalized.path, body, origin }) : body;
  const result = await dispatch(env, context, { method, path: normalized.path, search: normalized.search, body: finalBody, origin });
  return { status: result.status, ok: result.ok, data: compactResult(result.data) };
}

/** The assistant context the router runs with: the user's identity plus a marker. */
export function assistantContext({ shopId, userId, role, email = '', name = '' }) {
  return {
    shopId,
    userId,
    role,
    email: String(email || '').toLowerCase(),
    name: name || email || 'ShopCrank user',
    claims: { sub: userId, email, name },
    viaAssistant: true,
  };
}
