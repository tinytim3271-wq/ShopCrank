import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { extractDocumentText, extractPdfTextFallback, MAX_DOCUMENT_BYTES } from '../src/knowledge/extract.mjs';
import { htmlToText, normalizeDomain, refreshDueKnowledgeSources } from '../src/knowledge/web.mjs';
import { slugifyShopId } from '../src/onboarding/intake.mjs';
import { publicOrigin } from '../src/onboarding/twilio-plans.mjs';
import { putShopSetting } from '../src/shop-settings-store.mjs';
import worker from '../src/index.js';
import { FOLLOWUP_CRON } from '../src/customer-followups.mjs';

function pdfStream(content, compress = true) {
  const body = compress ? deflateSync(Buffer.from(content)) : Buffer.from(content);
  return Buffer.concat([Buffer.from(`<<${compress ? '/Filter /FlateDecode' : ''}>>\nstream\n`), body, Buffer.from('\nendstream\n')]);
}

test('PDF scanner extracts literal strings, arrays, nested parentheses, escapes and multiple streams', async () => {
  const content = String.raw`BT (Hello \(shop\) \101) Tj T* [(Good) -20 ( morning (team))] TJ ET`;
  for (const compress of [true, false]) {
    assert.equal(await extractPdfTextFallback(pdfStream(content, compress)), 'Hello (shop) A\nGood morning (team)');
  }
  assert.equal(await extractPdfTextFallback(Buffer.concat([pdfStream('(one) Tj'), pdfStream('(two) Tj')])), 'one\n\ntwo');
  assert.equal(await extractPdfTextFallback(Buffer.from('<< /Resources << /X 1 >> >>\nstream\n(nested dictionary) Tj\nendstream')), 'nested dictionary');
  assert.equal(await extractPdfTextFallback(pdfStream('(only once) Tj Tj Tj', false)), 'only once');
  assert.equal(await extractPdfTextFallback(pdfStream('[(only once)] TJ TJ TJ', false)), 'only once');
  assert.equal(await extractPdfTextFallback(Buffer.from('<< % ignore <<\n /X 1 >>\nstream\n(comment) Tj\nendstream')), 'comment');
  assert.equal(await extractPdfTextFallback(pdfStream('(unterminated', false)), '');
  assert.equal(await extractPdfTextFallback(pdfStream('[(unterminated', false)), '');
  assert.equal(await extractPdfTextFallback(Buffer.from('<< /incomplete <<')), '');
});

test('domain, slug and public origin normalization preserve ordinary input behavior', () => {
  assert.equal(normalizeDomain(' HTTPS://*.EXAMPLE.COM/path/to/page '), 'example.com');
  assert.equal(normalizeDomain('bad..example.com'), '');
  assert.equal(slugifyShopId('--- My Auto Shop ---'), 'my-auto-shop');
  assert.equal(slugifyShopId('---'), '');
  assert.equal(publicOrigin({ SHOPCRANK_PUBLIC_ORIGIN: 'https://example.com///' }), 'https://example.com');
});

test('reference HTML is extracted as plain text with blocked contents omitted, not sanitized markup', () => {
  const result = htmlToText('<head><title>Shop &amp; Service</title><style>hidden</style></head><p>Welcome<br>Service</p><script>hidden</script><form>hidden</form>');
  assert.deepEqual(result, { title: 'Shop & Service', text: 'Welcome\nService' });
  for (const html of [
    '<p>Visible</p><script>alert(1)',
    '<p>Visible</p><SCRIPT type="text/javascript">hidden</SCRIPT ><p>End</p>',
    '<p>Visible</p><script><script>hidden</script><p>End</p>',
    '<p>Visible</p><script>hidden</scriptx><p>also hidden</p>',
    '<p>Visible</p><template><template>hidden</template>hidden</template><p>End</p>',
    '<p>Visible</p><!-- <script>hidden</script>',
    '<p>Visible</p><iframe srcdoc=">">hidden</iframe><p>End</p>',
  ]) {
    const { text } = htmlToText(html);
    assert.ok(text.startsWith('Visible'), html);
    assert.doesNotMatch(text, /hidden|alert|<script/i, html);
  }
  assert.equal(htmlToText('<p>&lt;script&gt;plain text&lt;/script&gt; &#x110000; &#0;</p>').text, '<script>plain text</script>');
  assert.equal(htmlToText('<title>Literal &lt;b&gt;title&lt;/b&gt;</title>').title, 'Literal <b>title</b>');
});

test('malformed extraction and normalization inputs finish within a bounded subprocess', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { extractPdfTextFallback } from './worker/src/knowledge/extract.mjs';
    import { htmlToText, normalizeDomain } from './worker/src/knowledge/web.mjs';
    import { slugifyShopId } from './worker/src/onboarding/intake.mjs';
    import { publicOrigin } from './worker/src/onboarding/twilio-plans.mjs';
    import { isEmail } from './src/modules/front-desk-questionnaire.js';
    const pdf = content => Buffer.from('<<>>\\nstream\\n' + content + '\\nendstream');
    for (const input of ['('.repeat(200_000), '['.repeat(200_000), '[' + '('.repeat(200_000) + '] TJ']) {
      assert.equal(await extractPdfTextFallback(pdf(input)), '');
    }
    assert.equal(await extractPdfTextFallback(Buffer.from('<<a'.repeat(200_000))), '');
    assert.equal(normalizeDomain('example.com' + '/'.repeat(200_000)), 'example.com');
    assert.equal(normalizeDomain('example.com' + '/'.repeat(200_000) + '\\na'), 'example.com');
    assert.equal(slugifyShopId('-'.repeat(200_000)), '');
    assert.equal(publicOrigin({ SHOPCRANK_PUBLIC_ORIGIN: '/'.repeat(200_000) }), '');
    assert.equal(publicOrigin({ SHOPCRANK_PUBLIC_ORIGIN: '/'.repeat(200_000) + 'x' }), '/'.repeat(200_000) + 'x');
    assert.equal(isEmail('!@!' + '!.'.repeat(200_000) + '@'), false);
    assert.equal(htmlToText('<script>'.repeat(100_000)).text, '');
    assert.equal(htmlToText('<'.repeat(200_000)).text, '');
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

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
