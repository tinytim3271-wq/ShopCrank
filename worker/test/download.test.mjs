import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const OFFLINE_URL = `https://www.yourcarguy806.com/downloads/ShopCrank-Offline-Setup-${version}.exe`;

function mockPages(t, response) {
  return t.mock.method(globalThis, 'fetch', async () => response());
}

function spaShell() {
  return new Response('<!doctype html><div id="app"></div>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function filesWith(objects = {}) {
  const lookup = async (key) => objects[key] || null;
  return { get: lookup, head: lookup };
}

function r2Object(body) {
  return {
    body,
    httpEtag: '"etag"',
    writeHttpMetadata(headers) { headers.set('Content-Type', 'application/octet-stream'); },
  };
}

test('published installer is served from R2 as an attachment', async (t) => {
  const pages = mockPages(t, spaShell);
  const key = `downloads/ShopCrank-Offline-Setup-${version}.exe`;
  const response = await worker.fetch(new Request(OFFLINE_URL), { FILES: filesWith({ [key]: r2Object('MZ') }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Disposition'), new RegExp(`ShopCrank-Offline-Setup-${version.replaceAll('.', '\\.')}\\.exe`));
  assert.equal(await response.text(), 'MZ');
  assert.equal(pages.mock.callCount(), 0);
});

test('missing installer returns 404 instead of the website shell', async (t) => {
  mockPages(t, spaShell);
  const response = await worker.fetch(new Request(OFFLINE_URL), { FILES: filesWith() });
  assert.equal(response.status, 404);
  assert.match(response.headers.get('Content-Type'), /text\/plain/);
  assert.match(await response.text(), /not been published/);
});

test('missing installer HEAD returns 404 without a body', async (t) => {
  mockPages(t, () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/html' } }));
  const response = await worker.fetch(new Request(OFFLINE_URL, { method: 'HEAD' }), { FILES: filesWith() });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '');
});

test('downloads return 503 when the R2 bucket is not bound', async (t) => {
  mockPages(t, spaShell);
  const response = await worker.fetch(new Request(OFFLINE_URL), {});
  assert.equal(response.status, 503);
  assert.match(await response.text(), /temporarily unavailable/);
});

test('binaries committed to Pages still download when missing from R2', async (t) => {
  mockPages(t, () => new Response('PK', {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.android.package-archive' },
  }));
  const response = await worker.fetch(new Request('https://www.yourcarguy806.com/downloads/ShopCrank.apk'), { FILES: filesWith() });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'PK');
});

test('download links match the version the Windows workflow publishes', () => {
  const sources = [
    readFileSync(new URL('../../downloads/index.html', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/runtime/legacy.js', import.meta.url), 'utf8'),
  ];
  const links = sources.flatMap((source) => [...source.matchAll(/\/downloads\/ShopCrank-(?:Offline-)?Setup-([\d.]+)\.(?:exe|zip)/g)]);
  assert.ok(links.some((match) => match[0].includes('Offline-Setup')), 'offline setup link missing');
  for (const match of links) assert.equal(match[1], version, `${match[0]} does not match package.json ${version}`);
});
