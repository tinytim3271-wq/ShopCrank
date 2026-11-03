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
      const archivedRecord = mutation.archivedRecord;
      if (archivedRecord && String(archivedRecord.id) === id) records.set(id, archivedRecord);
      else records.delete(id);
    }
    if (method === 'POST' || method === 'PUT') records.set(id, body);
  }

  return [...records.values()];
}
