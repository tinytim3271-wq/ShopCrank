#!/usr/bin/env node
/**
 * Cache-busting for the app shell. Browsers keep app.js and the stylesheets for
 * hours, so index.html must name a new URL whenever their content changes.
 * Each asset gets `?v=<first 10 hex of its SHA-256>`; nobody has to remember
 * to bump a number. Run by scripts/build-web.mjs after every build.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMPED_ASSETS = Object.freeze(['app.js', 'styles.css', 'theme.css', 'diagnostics-ui.js']);

export function contentVersion(content) {
  // Hash with LF line endings so a Windows checkout (CRLF) stamps the same version as CI.
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);
}

/** Rewrite `./<asset>` or `./<asset>?v=…` references in index.html markup. */
export function stampIndexHtml(html, versions) {
  let out = html;
  for (const [asset, version] of Object.entries(versions)) {
    const escaped = asset.replace(/[.]/g, '\\.');
    out = out.replace(new RegExp(`(["'])\\./${escaped}(?:\\?v=[^"']*)?\\1`, 'g'), `$1./${asset}?v=${version}$1`);
  }
  return out;
}

export function stampAssets(root) {
  const versions = Object.fromEntries(STAMPED_ASSETS.map(asset => [asset, contentVersion(readFileSync(join(root, asset)))]));
  const indexPath = join(root, 'index.html');
  const before = readFileSync(indexPath, 'utf8');
  const after = stampIndexHtml(before, versions);
  if (after !== before) writeFileSync(indexPath, after);
  return versions;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const versions = stampAssets(join(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(`Stamped index.html: ${Object.entries(versions).map(([a, v]) => `${a}?v=${v}`).join(', ')}`);
}
