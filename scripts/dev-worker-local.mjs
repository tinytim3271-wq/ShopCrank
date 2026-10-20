#!/usr/bin/env node
/**
 * Run the API Worker fully offline: no Cloudflare login needed.
 *
 * wrangler.jsonc binds Workers AI and the Send Email binding as remote, so plain
 * `wrangler dev` needs Cloudflare credentials. This writes wrangler.local.json
 * (git-ignored) without those remote bindings and starts `wrangler dev` with it.
 * AI routes answer "not configured" and sign-in links are returned in the API
 * response when AUTH_EXPOSE_LOGIN_LINK=1 is in .dev.vars.
 *
 *   npm run dev:worker              # offline, local D1/R2
 *   npm run dev:worker:remote       # original config (needs `wrangler login`)
 *   node scripts/dev-worker-local.mjs --port 8788   # extra args go to wrangler dev
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_WRANGLER_CONFIG = 'wrangler.local.json';
// Run wrangler's own script with this Node binary: no PATH lookup (npx/shell) involved.
export const WRANGLER_BIN = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Parse wrangler.jsonc (strip comments and trailing commas). */
export function readWranglerConfig(path = join(root, 'wrangler.jsonc')) {
  const text = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(text);
}

/** Config with remote-only bindings removed, so wrangler dev runs without credentials. */
export function localWranglerConfig(config) {
  const local = { ...config };
  delete local.$schema;
  delete local.ai;
  if (Array.isArray(local.send_email)) local.send_email = local.send_email.map(({ name }) => ({ name }));
  return local;
}

export function writeLocalWranglerConfig() {
  const path = join(root, LOCAL_WRANGLER_CONFIG);
  writeFileSync(path, `${JSON.stringify(localWranglerConfig(readWranglerConfig()), null, 2)}\n`);
  return path;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dev-worker-local.mjs')) {
  const config = writeLocalWranglerConfig();
  const child = spawn(process.execPath, [WRANGLER_BIN, 'dev', '-c', config, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('exit', code => process.exit(code ?? 0));
}
