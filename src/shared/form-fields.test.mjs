import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORM_FIELD_ALIASES, canonicalFormValues } from './form-fields.js';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { names: clobberNames } = JSON.parse(readFileSync(join(srcRoot, 'shared', 'dom-clobber-names.json'), 'utf8'));
const clobber = new Set(clobberNames);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(js|mjs)$/.test(entry) && !/\.test\.mjs$/.test(entry) ? [path] : [];
  });
}

test('canonicalFormValues maps sanitizer-safe aliases back to canonical keys', () => {
  assert.deepEqual(
    canonicalFormValues({ displayName: 'Maria', jobTitle: 'Lead', accessRole: 'technician', paymentMethod: 'cash', messageBody: 'Hi', email: 'm@example.com' }),
    { name: 'Maria', title: 'Lead', role: 'technician', method: 'cash', body: 'Hi', email: 'm@example.com' },
  );
});

test('canonicalFormValues leaves forms without aliases unchanged', () => {
  assert.deepEqual(canonicalFormValues({ amount: '10', reference: 'R-1' }), { amount: '10', reference: 'R-1' });
});

test('every alias maps to a name the sanitizer would strip, and no alias is itself stripped', () => {
  for (const [alias, canonical] of Object.entries(FORM_FIELD_ALIASES)) {
    assert.ok(clobber.has(canonical), `${canonical} should be a DOM-clobbering name`);
    assert.ok(!clobber.has(alias), `${alias} must survive DOMPurify`);
  }
});

test('no template uses a name/id that DOMPurify strips (use the FORM_FIELD_ALIASES alias instead)', () => {
  const offenders = [];
  const attr = /\b(name|id)=\\?["']([A-Za-z_$][\w$-]*)\\?["']/g;
  for (const file of sourceFiles(srcRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(attr)) {
      if (clobber.has(match[2])) offenders.push(`${file.slice(srcRoot.length + 1)}: ${match[1]}="${match[2]}"`);
    }
  }
  assert.deepEqual(offenders, [], `Rename these fields (see src/shared/form-fields.js):\n${offenders.join('\n')}`);
});
