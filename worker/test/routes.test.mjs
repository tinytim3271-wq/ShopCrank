import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntityDeleteStatements,
  listChatMessagesForConversations,
  listEntities,
  putEntity,
} from '../src/routes/entities.mjs';
import {
  assertUploadContentType,
  assertUploadSize,
  handleFiles,
  storeUploadedFile,
} from '../src/routes/files.mjs';
import { HttpError } from '../src/http.mjs';
import { createD1 } from './helpers/d1-sqlite.mjs';

function mockDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...args) {
          const entry = { sql, args };
          statements.push(entry);
          return entry;
        },
      };
    },
    async batch(items) {
      return items;
    },
  };
}

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test('employee delete also revokes the Access user row', () => {
  const env = { DB: mockDb() };
  const context = { shopId: 'shop-1' };
  const existing = { id: 'emp-1', email: 'tech@shop.test', name: 'Tech' };
  const statements = buildEntityDeleteStatements(env, context, 'employees', 'emp-1', existing, []);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /DELETE FROM entities/i);
  assert.match(statements[1].sql, /DELETE FROM users/i);
  assert.deepEqual(statements[1].args, ['tech@shop.test', 'shop-1']);
});

test('invoice delete removes linked payments without requiring employee branch', () => {
  const env = { DB: mockDb() };
  const context = { shopId: 'shop-1' };
  const existing = { id: 'inv-1', number: 'INV-1' };
  const payments = [
    { id: 'pay-1', invoiceNumber: 'INV-1' },
    { id: 'pay-2', invoiceNumber: 'INV-9' },
  ];
  const statements = buildEntityDeleteStatements(env, context, 'invoices', 'inv-1', existing, payments);
  assert.equal(statements.length, 2);
  assert.match(statements[1].sql, /DELETE FROM entities/i);
  assert.deepEqual(statements[1].args, ['shop-1', 'payments', 'pay-1']);
});

test('listEntities keeps full-array response when no pagination parameters are supplied', async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [
                    { data_json: JSON.stringify({ id: 'a' }), updated_at: '2026-09-24T00:00:00.000Z' },
                    { data_json: JSON.stringify({ id: 'b' }), updated_at: '2026-09-24T00:01:00.000Z' },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };
  const records = await listEntities(env, 'shop-1', 'orders');
  assert.deepEqual(records.map(record => record.id), ['a', 'b']);
});

test('listEntities returns cursor metadata when limit is provided', async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [
                    { data_json: JSON.stringify({ id: 'a' }), updated_at: '2026-09-24T00:00:00.000Z', entity_id: 'a' },
                    { data_json: JSON.stringify({ id: 'b' }), updated_at: '2026-09-24T00:01:00.000Z', entity_id: 'b' },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };
  const paged = await listEntities(env, 'shop-1', 'orders', { limit: 2 });
  assert.deepEqual(paged.records.map(record => record.id), ['a', 'b']);
  assert.equal(paged.nextCursor, '2026-09-24T00:01:00.000Z|b');
});

test('listChatMessagesForConversations keeps bind count fixed under D1\'s 100-parameter cap', async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            statements.push({ sql, args });
            return {
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  await listChatMessagesForConversations(env, 'shop-1', 'tech@shop.test');
  assert.equal(statements.length, 1);
  assert.equal(statements[0].args.length, 2);
  assert.deepEqual(statements[0].args, ['shop-1', 'tech@shop.test']);
  assert.match(statements[0].sql, /json_each\(c\.data_json, '\$\.memberEmails'\)/);
  assert.doesNotMatch(statements[0].sql, /IN \(\?(?:, \?)+\)/);
});

test('listEntities compound cursor does not skip same-timestamp siblings', async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            statements.push({ sql, args });
            return {
              async all() {
                return {
                  results: [
                    { data_json: JSON.stringify({ id: 'c' }), updated_at: '2026-09-24T00:00:00.000Z', entity_id: 'c' },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };
  const paged = await listEntities(env, 'shop-1', 'orders', {
    limit: 1,
    cursor: '2026-09-24T00:00:00.000Z|b',
  });
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /updated_at > \? OR \(updated_at = \? AND entity_id > \?\)/);
  assert.deepEqual(statements[0].args.slice(0, 5), [
    'shop-1',
    'orders',
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
    'b',
  ]);
  assert.equal(paged.records[0].id, 'c');
});

test('upload size guard rejects oversized and empty declarations', () => {
  assert.equal(assertUploadSize(1024), 1024);
  assert.throws(() => assertUploadSize(0), HttpError);
  assert.throws(() => assertUploadSize(20 * 1024 * 1024), HttpError);
});

test('upload content-type guard allows images and PDF only', () => {
  assert.equal(assertUploadContentType('image/png'), 'image/png');
  assert.equal(assertUploadContentType('application/pdf; charset=binary'), 'application/pdf');
  assert.throws(() => assertUploadContentType('text/html'), HttpError);
});

test('files route rejects keys outside the authenticated shop', async () => {
  const request = new Request('https://example.test/api/files/object?key=shops/other/file.png');
  const context = { shopId: 'shop-1', userId: 'u1' };
  await assert.rejects(
    () => handleFiles(request, { FILES: {} }, context, ['files', 'object']),
    (error) => error instanceof HttpError && error.status === 403,
  );
});

test('file storage buffers the capped stream into an R2-compatible body', async () => {
  let stored;
  const files = {
    async put(key, body, metadata) {
      stored = { key, body, metadata };
    },
  };
  const metadata = { httpMetadata: { contentType: 'image/png' } };
  const received = await storeUploadedFile(
    files,
    'shops/shop-1/signature/test',
    streamFromChunks([new Uint8Array([1, 2]), new Uint8Array([3])]),
    metadata,
  );

  assert.equal(received, 3);
  assert.equal(stored.key, 'shops/shop-1/signature/test');
  assert.ok(stored.body instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(stored.body)], [1, 2, 3]);
  assert.deepEqual(stored.metadata, { ...metadata, onlyIf: { etagDoesNotMatch: '*' } });
});

test('both signature namespaces use atomic create-only writes, including concurrent uploads', async () => {
  const objects = new Map();
  const env = {
    FILES: {
      async put(key, bytes, options) {
        assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
        if (objects.has(key)) return null;
        objects.set(key, new TextDecoder().decode(bytes));
        return {};
      },
    },
  };
  for (const kind of ['signature', 'signatures']) {
    const key = `shops/shop-1/${kind}/existing.png`;
    const upload = value => handleFiles(new Request(`https://example.test/api/files/upload?key=${key}`, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: value,
    }), env, { shopId: 'shop-1', userId: 'tech' }, ['files', 'upload']);
    const results = await Promise.allSettled([upload('original'), upload('replacement')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal(objects.get(key), 'original');
    await assert.rejects(() => upload('replacement'), error => error.status === 409);
  }
});

test('legacy evidence at ordinary paths is protected without blocking unrelated file replacement', async () => {
  const DB = createD1();
  const protectedKeys = ['shops/shop-1/photos/estimate.png', 'shops/shop-1/file/invoice.png'];
  for (const [type, field, key] of [
    ['orders', 'estimateApproval', protectedKeys[0]],
    ['invoices', 'signature', protectedKeys[1]],
  ]) {
    await DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('shop-1', type, type, JSON.stringify({ [field]: { signatureKey: key } }), 'writer', 'now', 'now').run();
  }
  const writes = [];
  const env = { DB, FILES: { async put(key, bytes, options) {
    assert.equal(options.onlyIf, undefined);
    writes.push({ key, bytes });
  } } };
  const upload = key => handleFiles(new Request(`https://example.test/api/files/upload?key=${key}`, {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: 'replacement',
  }), env, { shopId: 'shop-1', userId: 'tech' }, ['files', 'upload']);
  for (const key of protectedKeys) await assert.rejects(() => upload(key), error => error.status === 409);
  assert.equal(writes.length, 0);
  const ordinaryKey = 'shops/shop-1/photos/ordinary.png';
  assert.equal((await upload(ordinaryKey)).status, 204);
  assert.equal((await upload(ordinaryKey)).status, 204);
  assert.equal(writes.length, 2);
  await DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('shop-other', 'orders', 'other', JSON.stringify({ estimateApproval: { signatureKey: ordinaryKey } }), 'writer', 'now', 'now').run();
  assert.equal((await upload(ordinaryKey)).status, 204, 'foreign tenant records do not lock this shop uploads');
});

test('files route rejects streamed uploads that exceed the 15 MB limit', async () => {
  const request = new Request('https://example.test/api/files/upload?key=shops/shop-1/file/upload.bin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: streamFromChunks([
      new Uint8Array(10 * 1024 * 1024),
      new Uint8Array(6 * 1024 * 1024),
    ]),
    duplex: 'half',
  });
  const context = { shopId: 'shop-1', userId: 'u1' };
  const env = {
    DB: createD1(),
    FILES: {
      async put(_key, body) {
        const reader = body.getReader();
        while (!(await reader.read()).done);
      },
    },
  };
  await assert.rejects(
    () => handleFiles(request, env, context, ['files', 'upload']),
    (error) => error instanceof HttpError && error.status === 413,
  );
});

test('files route reports non-size upload storage failures as unavailable', async () => {
  const request = new Request('https://example.test/api/files/upload?key=shops/shop-1/file/upload.bin', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': '1024',
    },
    body: new Uint8Array(1024),
    duplex: 'half',
  });
  const context = { shopId: 'shop-1', userId: 'u1' };
  const env = {
    DB: createD1(),
    FILES: {
      async put() {
        throw new Error('R2 unavailable');
      },
    },
  };
  await assert.rejects(
    () => handleFiles(request, env, context, ['files', 'upload']),
    (error) => error instanceof HttpError
      && error.status === 503
      && error.message === 'File storage is temporarily unavailable. Try again.',
  );
});

test('files route preserves an upstream storage status without misreporting a size error', async () => {
  const request = new Request('https://example.test/api/files/upload?key=shops/shop-1/file/upload.bin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': '1024' },
    body: new Uint8Array(1024),
    duplex: 'half',
  });
  const context = { shopId: 'shop-1', userId: 'u1' };
  const env = {
    DB: createD1(),
    FILES: {
      async put() {
        throw Object.assign(new Error('R2 rate limited'), { status: 429 });
      },
    },
  };
  await assert.rejects(
    () => handleFiles(request, env, context, ['files', 'upload']),
    (error) => error instanceof HttpError
      && error.status === 429
      && error.message === 'File storage is temporarily unavailable. Try again.',
  );
});

test('putEntity rejects stale If-Match so remote approvals are not overwritten', async () => {
  const writes = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (/SELECT created_at, created_by, updated_at(?:, data_json)? FROM entities/i.test(sql)) {
                  return {
                    created_at: '2026-10-06T10:00:00.000Z',
                    created_by: 'writer-1',
                    updated_at: '2026-10-06T12:00:00.000Z',
                  };
                }
                return null;
              },
              async run() {
                writes.push({ sql, args });
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
  const context = { shopId: 'shop-1', userId: 'writer-1' };
  const staleBody = {
    id: 'RO-1',
    status: 'estimate',
    updatedAt: '2026-10-06T10:00:00.000Z',
  };

  await assert.rejects(
    () => putEntity(env, context, 'orders', 'RO-1', staleBody, '2026-10-06T10:00:00.000Z'),
    (error) => error instanceof HttpError
      && error.status === 409
      && /updated elsewhere/i.test(error.message),
  );
  assert.equal(writes.length, 0);

  const saved = await putEntity(
    env,
    context,
    'orders',
    'RO-1',
    { ...staleBody, estimateApproval: { status: 'approved' }, linesLockedAt: '2026-10-06T12:00:00.000Z' },
    '2026-10-06T12:00:00.000Z',
  );
  assert.equal(writes.length, 1);
  assert.equal(saved.estimateApproval.status, 'approved');
  assert.ok(saved.updatedAt);
});
