#!/usr/bin/env node
import { cpSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'www');
const files = [
  'index.html',
  'styles.css',
  'theme.css',
  'app.js',
  'diagnostics-ui.js',
  'service-worker.js',
  'manifest.webmanifest',
  'shopcrank-icon.svg',
];

rmSync(webDir, { recursive: true, force: true });
mkdirSync(webDir, { recursive: true });

for (const file of files) {
  copyFileSync(join(root, file), join(webDir, file));
}

cpSync(join(root, 'assets'), join(webDir, 'assets'), { recursive: true });
