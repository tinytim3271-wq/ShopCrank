import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const SETUP_NAME = `ShopCrank-Setup-${version}.exe`;
const SETUP_URL = `https://www.shopcrank.com/api/downloads/${SETUP_NAME}`;

function filesWith(objects = {}) {
  const lookup = async (key) => objects[key] || null;
  return { get: lookup, head: lookup };
}

function r2Object(body, contentType = 'application/octet-stream') {
  return {
    body,
    httpEtag: '"etag"',
    writeHttpMetadata(headers) { headers.set('Content-Type', contentType); },
  };
}

test('published Windows installer downloads from R2 as an attachment on the /api route', async (t) => {
  const pages = t.mock.method(globalThis, 'fetch', async () => new Response('<!doctype html><div id="root"></div>'));
  const env = { FILES: filesWith({ [`downloads/${SETUP_NAME}`]: r2Object('MZ') }) };
  const response = await worker.fetch(new Request(SETUP_URL), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(response.headers.get('Content-Disposition'), `attachment; filename="${SETUP_NAME}"`);
  assert.equal(await response.text(), 'MZ');
  assert.equal(pages.mock.callCount(), 0);
});

test('HEAD on a published installer returns headers without a body', async () => {
  const env = { FILES: filesWith({ [`downloads/${SETUP_NAME}`]: r2Object('MZ') }) };
  const response = await worker.fetch(new Request(SETUP_URL, { method: 'HEAD' }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('missing installer returns 404 instead of the website shell or a sign-in error', async (t) => {
  const pages = t.mock.method(globalThis, 'fetch', async () => new Response('<!doctype html><div id="root"></div>'));
  const response = await worker.fetch(new Request(SETUP_URL), { FILES: filesWith() });
  assert.equal(response.status, 404);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  assert.match((await response.json()).message, /not been published/);
  assert.equal(pages.mock.callCount(), 0);
});

test('downloads return 503 when the R2 bucket is not bound', async () => {
  const response = await worker.fetch(new Request(SETUP_URL), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /temporarily unavailable/);
});

test('download route rejects writes and paths outside the allowlist', async () => {
  const env = { FILES: filesWith({ 'downloads/secret.txt': r2Object('nope') }) };
  const post = await worker.fetch(new Request(SETUP_URL, { method: 'POST' }), env);
  assert.equal(post.status, 405);
  const traversal = await worker.fetch(new Request('https://www.shopcrank.com/api/downloads/secret.txt'), env);
  assert.equal(traversal.status, 404);
});

test('Windows download links use the Worker route and the version the Windows workflow publishes', () => {
  const sources = {
    'downloads/index.html': readFileSync(new URL('../../downloads/index.html', import.meta.url), 'utf8'),
    // The Settings "Apps and subscription" panel (moved out of legacy.js).
    'src/modules/settings-panels.js': readFileSync(new URL('../../src/modules/settings-panels.js', import.meta.url), 'utf8'),
  };
  for (const [file, source] of Object.entries(sources)) {
    const links = [...source.matchAll(/href="([^"]*ShopCrank-(?:Offline-)?Setup-[^"]+)"/g)].map((match) => match[1]);
    assert.ok(links.length > 0, `${file} has no Windows installer link`);
    for (const link of links) {
      assert.match(link, /^\/api\/downloads\//, `${file} links ${link}, which Pages answers with the app shell`);
      assert.ok(link.includes(`-${version}.`), `${file} links ${link} but package.json is ${version}`);
    }
  }
});

test('Pages redirects legacy /downloads installer URLs to the Worker route', () => {
  const redirects = readFileSync(new URL('../../public/_redirects', import.meta.url), 'utf8');
  assert.match(redirects, /^\/downloads\/ShopCrank-Setup-\*\s+\/api\/downloads\/ShopCrank-Setup-:splat\s+302$/m);
  assert.match(redirects, /^\/downloads\/ShopCrank-Offline-Setup-\*\s+\/api\/downloads\/ShopCrank-Offline-Setup-:splat\s+302$/m);
});

function sizedFiles(key, bytes) {
  const data = new TextEncoder().encode(bytes);
  const object = (body) => ({ body, size: data.length, httpEtag: '"v1"', writeHttpMetadata() {} });
  const calls = [];
  return {
    calls,
    files: {
      head: async (k) => (k === key ? object(null) : null),
      get: async (k, options = {}) => {
        calls.push(options);
        if (k !== key) return null;
        const { offset = 0, length = data.length - offset } = options.range || {};
        return object(data.slice(offset, offset + length));
      },
    },
  };
}

test('installer downloads resume: a Range request gets 206 with just those bytes', async () => {
  const { files, calls } = sizedFiles(`downloads/${SETUP_NAME}`, 'MZ0123456789');
  const env = { FILES: files };
  const full = await worker.fetch(new Request(SETUP_URL), env);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(full.headers.get('Content-Length'), '12');

  const middle = await worker.fetch(new Request(SETUP_URL, { headers: { Range: 'bytes=2-5' } }), env);
  assert.equal(middle.status, 206);
  assert.equal(middle.headers.get('Content-Range'), 'bytes 2-5/12');
  assert.equal(middle.headers.get('Content-Length'), '4');
  assert.equal(await middle.text(), '0123');
  assert.deepEqual(calls.at(-1), { range: { offset: 2, length: 4 } });

  const rest = await worker.fetch(new Request(SETUP_URL, { headers: { Range: 'bytes=10-' } }), env);
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get('Content-Range'), 'bytes 10-11/12');
  assert.equal(await rest.text(), '89');

  const tail = await worker.fetch(new Request(SETUP_URL, { headers: { Range: 'bytes=-3' } }), env);
  assert.equal(await tail.text(), '789');

  const past = await worker.fetch(new Request(SETUP_URL, { headers: { Range: 'bytes=50-' } }), env);
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('Content-Range'), 'bytes */12');

  // The file changed since the partial download started: send the whole new file.
  const stale = await worker.fetch(new Request(SETUP_URL, { headers: { Range: 'bytes=2-5', 'If-Range': '"old"' } }), env);
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), 'MZ0123456789');

  // Several ranges at once are not supported: whole file.
  const multi = await worker.fetch(new Request(SETUP_URL, { headers: { Range: 'bytes=0-1,4-5' } }), env);
  assert.equal(multi.status, 200);
});

test('a Range request for an unpublished installer is still a clean 404', async () => {
  const { files } = sizedFiles('downloads/other.exe', 'MZ');
  const response = await worker.fetch(new Request(SETUP_URL, { headers: { Range: 'bytes=0-1' } }), { FILES: files });
  assert.equal(response.status, 404);
});
