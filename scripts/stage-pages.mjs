#!/usr/bin/env node
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const destination = '.pages-dist';
const MAX_PAGES_FILE_BYTES = 25 * 1024 * 1024;

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const file of [
  'index.html',
  'app.js',
  'styles.css',
  'theme.css',
  'service-worker.js',
  'diagnostics-ui.js',
  'manifest.webmanifest',
  'shopcrank-icon.svg',
]) cpSync(file, `${destination}/${file}`);
cpSync('assets', `${destination}/assets`, { recursive: true });
cpSync('public', destination, { recursive: true });

mkdirSync(`${destination}/downloads`, { recursive: true });
try {
  for (const entry of readdirSync('downloads')) {
    const source = path.join('downloads', entry);
    const info = statSync(source);
    if (!info.isFile()) continue;
    if (info.size > MAX_PAGES_FILE_BYTES) {
      console.log(`Skipping oversized Pages asset downloads/${entry} (${Math.round(info.size / (1024 * 1024))} MiB)`);
      continue;
    }
    cpSync(source, path.join(destination, 'downloads', entry));
  }
} catch {
  // downloads folder is optional for Pages staging
}
console.log(`Staged Cloudflare Pages assets in ${destination}`);
