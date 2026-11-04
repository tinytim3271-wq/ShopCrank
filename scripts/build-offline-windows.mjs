import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeSignedConfig } from './windows-signing.mjs';

const editionPath = new URL('../desktop/edition.json', import.meta.url);
const originalEdition = readFileSync(editionPath);
const demo = process.argv.includes('--demo');
const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

try {
  writeFileSync(editionPath, `${JSON.stringify({ offline: true, ...(demo ? { portable: true, demo: true } : {}) }, null, 2)}\n`);
  run('npm', ['run', 'build:web']);
  if (!demo) {
    run('npm', ['run', 'build:j2534']);
  }
  // The demo ZIP stays unsigned; the offline installer is signed when CI has signing secrets.
  let config = demo ? 'desktop/builder-demo.json' : 'desktop/builder-offline.json';
  if (!demo) {
    const signed = 'dist/signing/builder-offline.json';
    console.log(`Windows signing: ${writeSignedConfig(fileURLToPath(new URL(`../${config}`, import.meta.url)), fileURLToPath(new URL(`../${signed}`, import.meta.url)))}`);
    config = signed;
  }
  run('npx', ['--no-install', 'electron-builder', '--win', demo ? 'zip' : 'nsis', '--x64', '--publish', 'never', '--config', config]);
} finally {
  writeFileSync(editionPath, originalEdition);
}
