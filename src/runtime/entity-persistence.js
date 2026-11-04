function entityPath(type) {
  return `/entities/${type}`;
}

export function persistMutationQueue(storage, key, queue) {
  const records = Array.isArray(queue) ? queue : [];
  if (records.length === 0) {
    storage.removeItem(key);
    return '[]';
  }
  const raw = JSON.stringify(records);
  storage.setItem(key, raw);
  return raw;
}

export function queuePendingEntityMutation(queue, mutation, { id, queuedAt, conflict = false } = {}) {
  const records = Array.isArray(queue) ? queue : [];
  const method = String(mutation?.options?.method || mutation?.method || '').toUpperCase();
  const archive = method === 'DELETE' && Boolean(mutation?.queueBody);
  const queueKey = archive ? `${mutation.key}:archive` : mutation.key;
  const existingIndex = records.findIndex(item => item.key === mutation.key);
  if (!archive && method === 'DELETE' && existingIndex >= 0 && records[existingIndex].method === 'POST') {
    records.splice(existingIndex, 1);
    return records;
  }
  const item = {
    id,
    key: queueKey,
    path: mutation.path,
    method,
    body: mutation.queueBody || mutation.options?.body,
    expectedUpdatedAt: mutation.expectedUpdatedAt || null,
    queuedAt,
    conflict,
  };
  const itemIndex = records.findIndex(record => record.key === queueKey);
  if (itemIndex >= 0) records.splice(itemIndex, 1, item);
  else records.push(item);
  return records;
}

export function applyQueuedEntityMutations(type, remoteRecords, queue) {
  const basePath = entityPath(type);
  const records = new Map(
    (Array.isArray(remoteRecords) ? remoteRecords : [])
      .map((record, index) => [record?.id ? String(record.id) : `__local-${index}`, record]),
  );

  for (const mutation of Array.isArray(queue) ? queue : []) {
    const path = String(mutation?.path || '');
    if (mutation?.conflict || (path !== basePath && !path.startsWith(`${basePath}/`))) continue;
    const method = String(mutation.method || '').toUpperCase();
    let body = null;
    try {
      body = mutation.body ? JSON.parse(mutation.body) : null;
    } catch {
      continue;
    }
    const pathId = path.startsWith(`${basePath}/`)
      ? decodeURIComponent(path.slice(basePath.length + 1))
      : '';
    const id = String(body?.id || pathId || '');
    if (!id) continue;
    if (method === 'DELETE') {
      if (body?.archivedAt && ['invoices', 'payments'].includes(type)) {
        const remote = records.get(id);
        const archived = remote && typeof remote === 'object' ? { ...body, ...remote } : body;
        for (const field of ['archivedAt', 'archivedBy', 'archiveReason', 'archiveGroup']) {
          if (body[field] !== undefined) archived[field] = body[field];
        }
        records.set(id, archived);
      } else {
        records.delete(id);
      }
    }
    if (method === 'POST' || method === 'PUT') records.set(id, body);
  }

  return [...records.values()];
}
