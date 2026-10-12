#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'src/shared/config.js');
const backup = readFileSync(configPath, 'utf8');

try {
  const sync = spawnSync(process.execPath, ['scripts/sync-frontend-config.mjs'], {
    cwd: root,
    env: { ...process.env, SHOP_CRANK_API_URL: 'https://api.example.com/' },
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, sync.stderr || sync.stdout);
  const generated = readFileSync(configPath, 'utf8');
  assert.match(generated, /shopcrank-saas/);
  assert.match(generated, /https:\/\/api\.example\.com/);
  assert.match(generated, /https:\/\/api\.example\.com\/auth\/magic-link/);
  assert.match(generated, /__SHOP_CRANK_CONFIG__/);
  assert.doesNotMatch(generated, /amazonaws|cognito|cloudflare-access/i);
  console.log('sync-frontend-config tests passed');
} finally {
  writeFileSync(configPath, backup);
}
