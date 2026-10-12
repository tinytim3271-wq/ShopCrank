#!/usr/bin/env node
// CI rebuild trigger: bake DIAGNOSTICS_CAPABILITY_SECRET into packaged desktop.
/**
 * Ensure desktop/packaged-secrets/capability-secret.txt exists so electron-builder
 * extraResources does not fail on an empty filter. Prefer env; otherwise leave
 * empty (read-only J2534 still works; Clear DTC needs the Worker-matching secret).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'desktop', 'packaged-secrets');
const target = path.join(dir, 'capability-secret.txt');
fs.mkdirSync(dir, { recursive: true });

const fromEnv = String(
  process.env.SHOP_CRANK_DIAG_CAPABILITY_SECRET
    || process.env.DIAGNOSTICS_CAPABILITY_SECRET
    || '',
).trim();

if (fromEnv) {
  fs.writeFileSync(target, fromEnv, 'utf8');
  console.log('Wrote diagnostics capability secret for packaging.');
} else if (!fs.existsSync(target)) {
  fs.writeFileSync(target, '', 'utf8');
  console.log('Wrote empty diagnostics capability secret placeholder for packaging.');
} else {
  console.log('Using existing packaged diagnostics capability secret file.');
}
