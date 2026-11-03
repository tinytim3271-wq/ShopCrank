import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAMPED_ASSETS, contentVersion, stampAssets, stampIndexHtml } from './stamp-assets.mjs';

test('stamping replaces old and missing versions and leaves other URLs alone', () => {
  const html = '<link rel="stylesheet" href="./styles.css" />\n<script src="./app.js?v=41"></script>\n<script src="./other.js?v=1"></script>';
  const out = stampIndexHtml(html, { 'app.js': 'abc123', 'styles.css': 'def456' });
  assert.match(out, /href="\.\/styles\.css\?v=def456"/);
  assert.match(out, /src="\.\/app\.js\?v=abc123"/);
  assert.match(out, /src="\.\/other\.js\?v=1"/);
});

test('a content change gives a new version; the same content keeps it', () => {
  assert.equal(contentVersion('body{}'), contentVersion('body{}'));
  assert.notEqual(contentVersion('body{}'), contentVersion('body{color:red}'));
  assert.match(contentVersion('x'), /^[0-9a-f]{10}$/);
});

test('stampAssets rewrites index.html from the files on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shopcrank-stamp-'));
  for (const asset of STAMPED_ASSETS) writeFileSync(join(dir, asset), `/* ${asset} */`);
  writeFileSync(join(dir, 'index.html'), '<script src="./app.js?v=41"></script><link href="./theme.css">');
  const versions = stampAssets(dir);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`app\\.js\\?v=${versions['app.js']}`));
  assert.match(html, new RegExp(`theme\\.css\\?v=${versions['theme.css']}`));
});

test('the committed index.html matches the committed assets (run npm run build:web)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const asset of STAMPED_ASSETS) {
    const version = contentVersion(readFileSync(join(root, asset)));
    assert.ok(html.includes(`./${asset}?v=${version}`), `${asset} is not stamped with its current content`);
  }
});
