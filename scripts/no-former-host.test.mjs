// ShopCrank is served on shopcrank.com only. The host it shipped under before
// the cutover now belongs to a different business's website, so nothing in
// ShopCrank's code, config, or current docs may point at it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Built from parts so this file never matches itself.
const FORMER_HOST = ['yourcarguy', '806'].join('');

// Archived conversation transcripts and dated review reports are history, not
// configuration; they are left as written.
const ARCHIVED = [/^docs\/handoff\//, /^\.10x\/reviews\//];
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|exe|apk|aab|jar|keystore|p12|pfx|dll|so|dylib|bin|wasm)$/i;

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

test('no ShopCrank code, config, or current doc points at the former host', () => {
  const offenders = [];
  for (const file of trackedFiles()) {
    if (ARCHIVED.some((pattern) => pattern.test(file)) || BINARY.test(file)) continue;
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (text.toLowerCase().includes(FORMER_HOST)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `former host still referenced in: ${offenders.join(', ')}`);
});
