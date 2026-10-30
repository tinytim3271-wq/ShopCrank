import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { extractDocumentText, extractPdfTextFallback, MAX_DOCUMENT_BYTES } from '../src/knowledge/extract.mjs';
import { refreshDueKnowledgeSources } from '../src/knowledge/web.mjs';
import { putShopSetting } from '../src/shop-settings-store.mjs';
import worker from '../src/index.js';
import { FOLLOWUP_CRON } from '../src/customer-followups.mjs';

function pdfStream(content, compress = true) {
  const body = compress ? deflateSync(Buffer.from(content)) : Buffer.from(content);
  return Buffer.concat([Buffer.from(`<<${compress ? '/Filter /FlateDecode' : ''}>>\nstream\n`), body, Buffer.from('\nendstream\n')]);
}

test('PDF extraction stops a single decompression bomb incrementally', async () => {
  const bytes = pdfStream(`(${'x'.repeat(1_000_000)}) Tj`);
  assert.ok(bytes.length < 2000);
  await assert.rejects(extractPdfTextFallback(bytes, { maxBytes: 16_000 }), error => error.status === 413);
});

test('PDF extraction shares a cumulative budget across streams and extracted text', async () => {
  const one = pdfStream(`(${'x'.repeat(4000)}) Tj`);
  assert.equal((await extractPdfTextFallback(one, { maxBytes: 10_000 })).length, 4000);
  await assert.rejects(extractPdfTextFallback(Buffer.concat([one, one]), { maxBytes: 10_000 }), error => error.status === 413);
  const plain = pdfStream(`(${'x'.repeat(4000)}) Tj`, false);
  await assert.rejects(extractPdfTextFallback(plain, { maxBytes: 7000 }), error => error.status === 413);
  assert.equal(await extractPdfTextFallback(pdfStream('(Hello world) Tj')), 'Hello world');
});

test('AI Markdown extraction cannot bypass the document text budget', async () => {
  await assert.rejects(extractDocumentText({ AI: { toMarkdown: async () => [{ data: 'x'.repeat(MAX_DOCUMENT_BYTES) }] } }, {
    bytes: Buffer.from('%PDF'), mimeType: 'application/pdf',
  }), error => error.status === 413);
});

test('knowledge refresh selects due sources before limiting, even behind 200 not-due sources', async () => {
  const env = { DB: createD1() };
  await putShopSetting(env, 'shop-1', 'knowledge_allowlist', { domains: ['example.com'] });
  const insert = env.DB.sqlite.prepare("INSERT INTO knowledge_sources (id, shop_id, url, permission, refresh_hours, last_fetched_at, content_hash, created_at, updated_at) VALUES (?, 'shop-1', ?, 'staff', ?, ?, '', ?, ?)");
  const now = new Date('2026-10-30T12:00:00Z');
  for (let i = 0; i < 205; i++) insert.run(`not-due-${i}`, `https://example.com/${i}`, 2160, '2026-10-01T00:00:00Z', now.toISOString(), now.toISOString());
  insert.run('due', 'https://example.com/due', 6, '2026-10-30T00:00:00Z', now.toISOString(), now.toISOString());
  let fetched = 0;
  const result = await refreshDueKnowledgeSources(env, { now: now.getTime(), limit: 1, fetcher: async () => {
    fetched++;
    return new Response('Shop service information', { headers: { 'Content-Type': 'text/plain' } });
  } });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'due');
  assert.equal(result[0].ok, true);
  assert.equal(fetched, 1);
});

test('scheduled handler keeps the follow-up cron separate and dispatches knowledge and A2P work on the export cron', async () => {
  const queries = [];
  const DB = createD1();
  const prepare = DB.prepare;
  DB.prepare = sql => {
    queries.push(sql);
    return prepare(sql);
  };
  const pending = [];
  await worker.scheduled({ cron: FOLLOWUP_CRON }, { DB, ONBOARDING_LIVE_MODE: '1' }, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  assert.equal(queries.some(sql => /knowledge_sources|shop_onboarding/.test(sql)), false);
  await worker.scheduled({ cron: '0 8 * * *' }, { DB, ONBOARDING_LIVE_MODE: '1' }, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  assert.ok(queries.some(sql => /SELECT \* FROM knowledge_sources/.test(sql)));
  assert.ok(queries.some(sql => /SELECT \* FROM shop_onboarding/.test(sql)));
});
