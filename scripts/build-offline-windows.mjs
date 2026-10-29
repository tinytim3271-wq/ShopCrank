import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  run('npx', ['--no-install', 'electron-builder', '--win', demo ? 'zip' : 'nsis', '--x64', '--publish', 'never', '--config', demo ? 'desktop/builder-demo.json' : 'desktop/builder-offline.json']);
} finally {
  writeFileSync(editionPath, originalEdition);
}
