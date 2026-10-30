import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildPartstechOrderRequest } from '../modules/partstech.js';

// The shell (src/runtime/legacy.js) is one large module, so these checks read
// its source. Each one describes a defect that was found in a live shop.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacy = readFileSync(join(root, 'runtime', 'legacy.js'), 'utf8');

/** Returns the source of the function whose definition starts with `prefix`. */
function functionSource(prefix) {
  const start = legacy.indexOf(prefix);
  if (start < 0) throw new Error(`not found: ${prefix}`);
  let depth = 0;
  let i = legacy.indexOf('{', start);
  for (; i < legacy.length; i += 1) {
    if (legacy[i] === '{') depth += 1;
    else if (legacy[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return legacy.slice(start, i + 1);
}

test('PartsTech ordering excludes declined parts before validating the remaining cart', async () => {
  const approved = { id: 'approved', type: 'part', source: 'partstech', approvalStatus: 'approved', priceStatus: 'priced', unitPrice: 40, quantity: 1, partstech: { storeId: 'store-1', partNumber: 'PAD-1' } };
  const declined = { ...approved, id: 'declined', approvalStatus: 'declined', partstech: { storeId: 'other-store' } };
  let submitted;
  const order = vm.runInNewContext(`${functionSource('async function orderTargetPartstechParts(')}; orderTargetPartstechParts`, {
    state: { orders: [{ id: 'RO-1', estimate: { lines: [approved, declined] } }] },
    orderingTargetOrderId: 'RO-1',
    partstechAccount: {},
    buildPartstechOrderRequest,
    window: { open: () => null },
    apiFetch: async (_path, options) => { submitted = JSON.parse(options.body); throw new Error('stop after submission'); },
    toast: () => {},
  });
  await order();
  assert.deepEqual(submitted.lines.map(line => line.id), ['approved']);
});

test('offline desktop texting has disabled controls and cannot queue consent or sends', async () => {
  const panel = vm.runInNewContext(`${functionSource('function smsInboxPanel(')}; smsInboxPanel()`, { isOfflineDesktop: () => true });
  assert.match(panel, /fieldset disabled/);
  assert.match(panel, /No messages or consent changes are queued offline/);
  assert.doesNotMatch(panel, /<form/);
  for (const id of ['sms-consent-form', 'sms-send-form']) {
    const handler = legacy.slice(legacy.indexOf(`document.querySelector("#${id}")?.addEventListener("submit"`));
    assert.ok(handler.indexOf('if (isOfflineDesktop())') < handler.indexOf('await apiFetch('), id);
  }
  const send = vm.runInNewContext(`${functionSource('async function sendSmsFromInbox(')}; sendSmsFromInbox`, {
    isOfflineDesktop: () => true,
    toast: () => {},
    apiFetch: () => assert.fail('offline SMS must never reach the mutation queue'),
  });
  await send({}, {});
  assert.match(legacy, /body: data\.messageBody/);
  assert.match(legacy, /if \(result\.queued === true\) throw/);
});

test('the vehicle form\'s save button is a typed submit button', () => {
  // The save handler looks up button[type=submit]. With no type attribute the
  // lookup returned null, `button.disabled = true` threw, and the vehicle was
  // never stored.
  const form = functionSource('function openVehicleForm(');
  const saveButton = form.match(/<button[^>]*>\s*Save vehicle\s*<\/button>/);
  assert.ok(saveButton, 'the vehicle form has a Save vehicle button');
  assert.match(saveButton[0], /type="submit"/);

  // The handler must find that button.
  assert.match(form, /querySelector\("button\[type=submit\]"\)/);
});

test('every form whose handler looks up button[type=submit] has a typed submit button', () => {
  const offenders = [];
  const formRe = /<form[^>]*id="([a-z0-9-]+)"[\s\S]*?<\/form>/g;
  let match;
  while ((match = formRe.exec(legacy)) !== null) {
    const buttons = [...match[0].matchAll(/<button[^>]*>/g)].map((button) => button[0]);
    if (buttons.some((button) => button.includes('type="submit"'))) continue;
    // Find the handler statement that belongs to THIS form. A handler is one
    // statement: "#form-id" up to the end of the expression it starts.
    const id = match[1];
    const handlerRe = new RegExp(`#${id}[^;]{0,1200}?button\\[type=submit\\]`);
    if (handlerRe.test(legacy)) offenders.push(id);
  }
  assert.deepEqual(offenders, [], `these forms break their save handler: ${offenders.join(', ')}`);
});

test('the work order estimate picker offers only the shop\'s own estimates', () => {
  const sources = functionSource('function availableEstimateSources(');
  assert.doesNotMatch(sources, /REFERENCE_ESTIMATE/);
  assert.match(sources, /state\.estimates/);
});

test('the estimate register does not advertise the reference sample', () => {
  const register = functionSource('savedEstimates = function () {');
  assert.doesNotMatch(register, /REFERENCE_ESTIMATE/);
  assert.doesNotMatch(register, /reference-template-card/);
});

test('the reference sample is not offered anywhere in the shop shell', () => {
  // The bundled reference estimate is a documentation fixture. It must not
  // reach a shop, and it must not be named in the shell at all.
  assert.doesNotMatch(legacy, /Jordan Example/);
  assert.doesNotMatch(legacy, /REFERENCE_ESTIMATE/);
  assert.doesNotMatch(legacy, /reference-template-card/);
});

test('the sign-in handler is split into named functions', () => {
  // The sign-in submit handler was one 3.4k-character function and tripped
  // SonarCloud's cognitive-complexity rule (S3776). The three sign-in paths
  // now live in their own functions.
  for (const name of ['signInOfflineDesktop', 'signInLocalShell', 'signInWithEmailLink', 'resetFailedSignIn']) {
    assert.ok(legacy.includes(`function ${name}(`), `missing helper: ${name}`);
  }
  const handler = legacy.split('\n').find((line) => line.startsWith('bind = function () { bindBeforeProfileSync();'));
  assert.ok(handler, 'the sign-in bind handler');
  assert.ok(handler.length < 2000, `the sign-in handler is still ${handler.length} characters`);
  assert.match(handler, /await signInOfflineDesktop\(form\)/);
  assert.match(handler, /await signInLocalShell\(\)/);
  assert.match(handler, /await signInWithEmailLink\(/);
  assert.match(handler, /resetFailedSignIn\(/);
});

test('no invoice date is built with toISOString', () => {
  // A date built from toISOString is a UTC day, not the shop's day.
  const offenders = [];
  for (const [index, line] of legacy.split('\n').entries()) {
    if (/date:\s*\w+\.toISOString\(\)\.slice\(0,\s*10\)/.test(line)) {
      offenders.push(`legacy.js:${index + 1}`);
    }
  }
  assert.deepEqual(offenders, [], `invoice dates still use UTC: ${offenders.join(', ')}`);
});
