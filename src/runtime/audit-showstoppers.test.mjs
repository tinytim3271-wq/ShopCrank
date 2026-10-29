import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ESLint } from 'eslint';
import { readFormValues } from '../shared/form-fields.js';

// Client-side regression coverage for the five release blockers in
// .10x/reviews/2026-10-20-qa-report.md. The Worker halves are in
// worker/test/audit-showstoppers.test.mjs; the browser smoke test
// (scripts/smoke/browser-smoke.mjs) drives all five end to end.

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(srcRoot, '..');
const legacy = readFileSync(join(srcRoot, 'runtime', 'legacy.js'), 'utf8');

function block(source, prefix) {
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error(`not found: ${prefix}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

/** Runs readFormValues over a form whose fields are given as [name, value] pairs. */
function submitForm(entries) {
  const previous = globalThis.FormData;
  globalThis.FormData = class { constructor() { return entries; } };
  try {
    return readFormValues({});
  } finally {
    globalThis.FormData = previous;
  }
}

test('blocker 1: the payment form submits a method the Worker accepts', () => {
  const form = block(legacy, 'function recordTargetPayment(');
  assert.match(form, /<select name="paymentMethod">/, 'method uses the sanitizer-safe alias');
  assert.doesNotMatch(form, /name="method"/, 'DOMPurify strips name="method"');
  assert.match(form, /readFormValues\(event\.target\)/);
  assert.equal(submitForm([['amount', '10'], ['paymentMethod', 'cash'], ['receivedAt', '2026-10-20T10:00']]).method, 'cash');
  const save = block(legacy, 'async function saveRecordedPayment(');
  assert.match(save, /method: data\.method/);
});

test('blocker 2: the customer form reads the name from a field the sanitizer keeps', () => {
  const form = block(legacy, 'function openCustomerForm(');
  assert.match(form, /<input name="displayName"/);
  assert.doesNotMatch(form, /<input name="name"/);
  assert.match(form, /const data = readFormValues\(event\.target\)/);
  assert.equal(submitForm([['displayName', 'Alice Brooks'], ['phone', '806-555-0101']]).name, 'Alice Brooks');
});

test('blocker 3: lint rejects a local `state` that shadows the global (the Payroll crash)', async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const buggy = [
    'let state = { payrollEntries: [] };',
    'export function ytdPayForUser(user) {',
    '  const periods = state.payrollEntries.filter(e => e.employeeId === user.id);',
    '  let gross = 0; let state = 0;',
    '  return { gross, state, periods };',
    '}',
  ].join('\n');
  const [result] = await eslint.lintText(buggy, { filePath: join(srcRoot, 'runtime', 'legacy.js') });
  assert.ok(result.messages.some(message => message.ruleId === 'no-restricted-syntax'), 'the shadowing guard fires');
  for (const file of ['legacy.js', 'filing-overrides.js']) {
    const source = readFileSync(join(srcRoot, 'runtime', file), 'utf8');
    const ytd = block(source, 'function ytdPayForUser(');
    assert.doesNotMatch(ytd, /\b(?:let|const|var)\s+state\b/, `${file} ytdPayForUser`);
    assert.match(ytd, /stateTax/);
  }
});

test('blocker 4: no shipped source names the demo shop, and the profile defaults are blank', () => {
  const offenders = [];
  const walk = dir => readdirSync(dir).forEach(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    if (/\.(js|mjs|html)$/.test(entry) && !/\.test\.mjs$/.test(entry) && /Your Car Guy/.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(repoRoot.length + 1));
  });
  [srcRoot, join(repoRoot, 'public'), join(repoRoot, 'worker', 'src')].forEach(walk);
  assert.deepEqual(offenders, []);

  const defaults = block(legacy, 'const shopProfileDefaults = {');
  for (const field of ['shopName', 'phone', 'address', 'logoUrl']) {
    assert.match(defaults, new RegExp(`\\b${field}: ""`), `${field} default must be blank`);
  }
  const display = block(legacy, 'function shopDisplayName(');
  const shopDisplayName = vm.runInNewContext(`(${display.replace('function shopDisplayName(profile = shopProfile())', 'function (profile)')})`);
  assert.equal(shopDisplayName({ shopName: 'Lubbock Brake & Tire' }), 'Lubbock Brake & Tire');
  assert.equal(shopDisplayName({ shopName: '' }), 'Your shop');

  const patch = block(legacy, 'function saveProfilePatch(');
  assert.doesNotMatch(patch, /shopProfileDefaults/, 'saving a patch must not persist demo defaults');
});

test('blocker 5: a cloud shop starts with empty collections; only local demo shells get samples', () => {
  const seedSource = block(legacy, 'const seed = {').replace('const seed =', 'var seed =');
  const isDemoShell = block(legacy, 'function isDemoShell(');
  const initialState = block(legacy, 'function initialState(');
  const run = (hostname, protocol = 'https:', offline = false) => vm.runInNewContext(
    `${seedSource}; ${isDemoShell}; ${initialState}; initialState()`,
    { structuredClone, location: { hostname, protocol }, isOfflineDesktop: () => offline },
  );
  const cloud = run('www.shopcrank.com');
  for (const key of ['orders', 'customers', 'invoices', 'expenses', 'appointments']) {
    assert.equal(cloud[key].length, 0, `cloud ${key} must start empty`);
  }
  assert.doesNotMatch(JSON.stringify(cloud.payments || []), /Demo/);
  assert.ok(run('localhost', 'http:').orders.length > 0, 'localhost keeps the demo');
  assert.ok(run('', 'file:', true).orders.length > 0, 'the offline USB demo keeps the demo');
});
