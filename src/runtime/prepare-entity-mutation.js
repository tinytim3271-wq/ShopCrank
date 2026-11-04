const OFFLINE_QUEUE_BLOCKED = /\/entities\/(employees|payrollentries|shopsettings|invoices|payments|expenses)(\/|$)/i;
/** Cascade deletes remove linked records chosen at confirm time; replaying one later could remove newer records. */
const CASCADE_DELETE = /[?&]cascade=/i;

function defaultMutationId() {
  return globalThis.crypto?.randomUUID?.() || `mutation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Attach If-Match so online PUTs get the same optimistic-concurrency check as offline flush. */
export function withOptimisticConcurrencyHeaders(options = {}, expectedUpdatedAt = null) {
  if (!expectedUpdatedAt) return options;
  return {
    ...options,
    headers: {
      ...(options.headers || {}),
      'If-Match': expectedUpdatedAt,
    },
  };
}

function mutationBody(rawBody, method, createMutationId) {
  let body = null;
  if (rawBody) {
    try { body = JSON.parse(rawBody); } catch { body = null; }
  }
  const isPlainObject = body && typeof body === 'object' && !Array.isArray(body);
  return method === 'POST' && isPlainObject && !body.id ? { ...body, id: createMutationId() } : body;
}

function mutationKey(path, method, body, createMutationId) {
  if (method !== 'POST') return path;
  return `${path}/${body?.id || createMutationId()}`;
}

export function prepareEntityMutation(path, options, createMutationId = defaultMutationId) {
  const { queueRecord, ...requestOptions } = options;
  const method = String(options.method || 'GET').toUpperCase();
  const isEntityMutation = path.startsWith('/entities/') && ['POST', 'PUT', 'DELETE'].includes(method);
  const queueArchive = method === 'DELETE' && Boolean(String(queueRecord?.archivedAt || '').trim());
  const containsSensitiveEndpoint = path === '/agentphone/configure' || path === '/voice/grok/configure';
  const queueable = isEntityMutation && (!OFFLINE_QUEUE_BLOCKED.test(path) || queueArchive) && !CASCADE_DELETE.test(path) && !containsSensitiveEndpoint;
  if (!queueable) return { path, options: requestOptions, queueable: false };
  const body = mutationBody(options.body, method, createMutationId);
  const entityKey = mutationKey(path, method, body, createMutationId);
  return {
    path,
    options: { ...requestOptions, method, body: body ? JSON.stringify(body) : undefined },
    queueable: Boolean(body) || method === 'DELETE',
    queueBody: queueArchive && typeof queueRecord === 'object' ? JSON.stringify(queueRecord) : null,
    expectedUpdatedAt: method === 'PUT' ? body?.updatedAt : null,
    key: entityKey,
  };
}
