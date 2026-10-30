import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildPartstechOrderRequest } from '../modules/partstech.js';
import * as Filing from '../modules/filing/index.js';
import { toLocalIsoDate } from '../shared/dates.js';
import { escapeHtml } from '../shared/html.js';

// The shell (src/runtime/legacy.js) is one large module, so these checks read
// its source. Each one describes a defect that was found in a live shop.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacy = readFileSync(join(root, 'runtime', 'legacy.js'), 'utf8');
const filingOverrides = readFileSync(join(root, 'runtime', 'filing-overrides.js'), 'utf8');

test('HTML sinks fail closed if DOMPurify is unavailable, including decoded DOM text', () => {
  const attack = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  for (const DOMPurify of [undefined, {}]) {
    const render = vm.runInNewContext(`${functionSource('function safeHtml(')}; safeHtml`, { DOMPurify, escapeHtml });
    assert.equal(render(attack), escapeHtml(attack));
    assert.equal(render('<b>Trusted formatting</b>'), '&lt;b&gt;Trusted formatting&lt;/b&gt;');
  }
  const render = vm.runInNewContext(`${functionSource('function safeHtml(')}; safeHtml`, {
    escapeHtml,
    DOMPurify: { sanitize: (markup, options) => {
      assert.equal(options.USE_PROFILES.html, true);
      assert.deepEqual([...options.ADD_ATTR], ['target']);
      return markup === '<b>Trusted formatting</b>' ? markup : '';
    } },
  });
  assert.equal(render('<b>Trusted formatting</b>'), '<b>Trusted formatting</b>');
  assert.equal(render(attack), '');
});

test('fresh cloud shops use state-only Texas tax without changing demo or saved rates', () => {
  for (const demo of [false, true]) {
    const state = vm.runInNewContext(`${functionSource('function initialState(')}; initialState()`, {
      seed: { orders: [1], taxSettings: { rate: 8.25 } },
      structuredClone,
      isDemoShell: () => demo,
      Filing,
    });
    assert.equal(state.taxSettings.rate, demo ? 8.25 : 6.25);
  }
  assert.match(legacy, /rate: Number\(tax\.rate\) \|\| 0/);
});

test('invoice editor roundtrips date-only values without UTC drift', () => {
  const dateValue = vm.runInNewContext(`${functionSource('function invoiceDateValue(')}; invoiceDateValue`, { toLocalIsoDate });
  assert.equal(dateValue('2026-10-31'), '2026-10-31');
  assert.equal(dateValue('2026-02-30'), '');
  assert.equal(dateValue('2024-02-29'), '2024-02-29');
});

test('tax reports keep migrated recognition dates while payment history keeps CSV receipt dates', () => {
  const invoice = {
    number: 'INV-MIGRATED',
    customer: 'Maria',
    amount: 120,
    status: 'partial',
    paymentImportLegacyCloseout: { paidAt: '2025-03-15T12:00:00.000Z' },
  };
  const payment = {
    invoiceNumber: invoice.number,
    customer: invoice.customer,
    amount: 40,
    receivedAt: '2026-09-05T12:00:00.000Z',
    status: 'completed',
  };
  const context = {
    state: { invoices: [invoice], payments: [payment] },
    getFinanceDerived: () => ({ invoiceByNumber: new Map([[invoice.number, invoice]]) }),
    invoiceTaxBreakdown: () => ({ subtotal: 110, tax: 10 }),
  };
  const report = vm.runInNewContext(`${functionSource('function paymentRecords(')}; ${functionSource('function taxReport(')}; taxReport('2025-03-01', '2025-03-31')`, context);
  const history = vm.runInNewContext(`${functionSource('function paymentRecords(')}; paymentRecords()`, context);

  assert.equal(report.totals.gross, 120);
  assert.equal(report.rows[0].date, '2025-03-15T12:00:00.000Z');
  assert.equal(history[0].receivedAt, '2026-09-05T12:00:00.000Z');
});

test('tax reporting preserves migrated recognition while payment history keeps CSV receipt dates', () => {
  const invoice = {
    number: 'INV-LEGACY', customer: 'Morgan Ray', status: 'partial',
    paymentImportLegacyRecognition: { amount: 100, receivedAt: '2026-09-15T12:00:00.000Z' },
  };
  const records = vm.runInNewContext(`${functionSource('function paymentRecords(')}; paymentRecords`, {
    state: {
      invoices: [invoice],
      payments: [{
        invoiceNumber: invoice.number, amount: 40, receivedAt: '2026-10-05T12:00:00.000Z', status: 'completed',
      }],
    },
  });
  const history = records();
  const reporting = records({ forReporting: true });
  assert.equal(history.length, 1);
  assert.equal(history[0].amount, 40);
  assert.equal(history[0].receivedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(reporting.length, 1);
  assert.equal(reporting[0].amount, 100);
  assert.equal(reporting[0].receivedAt, '2026-09-15T12:00:00.000Z');
  assert.equal([...filingOverrides.matchAll(/paymentRecords\(\{ forReporting: true \}\)/g)].length, 2);
});

test('Texas filing mismatches block generation, exports, and printing but not other states', async () => {
  const state = { taxSettings: { state: 'TX', rate: 8.25, jurisdictions: null } };
  const context = {
    state, Filing, toast: () => {},
    taxReportResult: { rows: [] },
    navigator: { onLine: true },
    isLocalShell: () => false,
    apiFetch: () => assert.fail('mismatch must not request reports'),
    taxReport: () => assert.fail('mismatch must not generate reports'),
  };
  vm.createContext(context);
  for (const prefix of ['function isFilingRateConsistent(', 'function filingRateIsConsistent(', 'async function generateTaxReportFromForm(', 'function exportSalesTaxCsv(', 'function exportTexasWebfilePackage(']) {
    vm.runInContext(functionSource(prefix), context);
  }
  assert.equal(context.isFilingRateConsistent(), false);
  await context.generateTaxReportFromForm('2026-10-01', '2026-10-31');
  context.exportSalesTaxCsv();
  context.exportTexasWebfilePackage();
  assert.match(legacy, /querySelector\('#print-tax-report'\)\?\.addEventListener\('click', event => \{\s*if \(!filingRateIsConsistent\(\)\)/);
  state.taxSettings = { state: 'TX', rate: 6.25, jurisdictions: [] };
  assert.equal(context.isFilingRateConsistent(), true);
  for (const [region, rate] of [['OR', 0], ['CA', 7.25]]) {
    state.taxSettings = { state: region, rate, jurisdictions: null };
    assert.equal(context.isFilingRateConsistent(), true);
  }
});

test('one enhanced tax submit persists extended settings and valid custom jurisdictions', async () => {
  const handlers = [];
  const form = {
    dataset: {},
    querySelector: () => ({}),
    addEventListener: (type, handler, options) => handlers.push({ type, handler, options }),
  };
  let data = {
    state: 'TX', taxId: ' TX-123 ', rate: '8.25', filingFrequency: 'Monthly',
    ein: ' EIN ', texasTaxpayerNumber: ' taxpayer ', webfileNumber: ' webfile ',
    jurisdictionsJson: '[]', feesTaxable: 'on',
  };
  const writes = [];
  const state = { taxSettings: { extraSetting: 'retained' } };
  const context = {
    state, Filing, taxReportResult: { rows: [] }, readFormValues: () => data, now: () => 'now',
    toast: () => {}, render: () => {},
    saveShopEntity: async (entity, record) => writes.push({ entity, record }),
  };
  const bind = vm.runInNewContext(`${functionSource('function bindTaxSettingsForm(')}; bindTaxSettingsForm`, context);
  bind(form);
  bind(form);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].options.capture, true);
  assert.equal((legacy.match(/tax-settings-form["']\)\?\.addEventListener\(["']submit/g) || []).length, 0);
  const submit = () => handlers[0].handler({ target: form, preventDefault() {}, stopImmediatePropagation() {} });
  await submit();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].entity, 'shopsettings');
  assert.equal(writes[0].record.rate, 6.25);
  assert.equal(writes[0].record.taxId, 'TX-123');
  assert.equal(state.taxSettings.ein, 'EIN');
  assert.equal(state.taxSettings.extraSetting, 'retained');
  assert.equal(state.taxSettings.laborTaxable, false);
  assert.equal(state.taxSettings.feesTaxable, true);
  assert.equal(context.taxReportResult, null);
  const custom = [...Filing.DEFAULT_TX_JURISDICTIONS, { code: '2123456', name: 'City', kind: 'city', rate: 2, required: false }];
  data = { ...data, jurisdictionsJson: JSON.stringify(custom) };
  await submit();
  assert.equal(state.taxSettings.rate, 8.25);
  assert.deepEqual(JSON.parse(JSON.stringify(state.taxSettings.jurisdictions)), custom);
  data = { ...data, state: 'OR', rate: '0' };
  await submit();
  assert.equal(state.taxSettings.rate, 0);
  const saved = state.taxSettings;
  for (const invalid of ['not json', '{}', '[null]', '[{"rate":-1}]']) {
    data = { ...data, jurisdictionsJson: invalid };
    await submit();
    assert.equal(writes.length, 3);
    assert.equal(state.taxSettings, saved);
  }
});

test('printed per-finding inspection photos have width and height bounds', () => {
  const source = readFileSync(join(root, 'runtime', 'catalog-inspection-ui.js'), 'utf8');
  assert.match(source, /\.finding-photos img\{[^}]*width:120px;[^}]*height:90px;[^}]*max-width:100%;[^}]*max-height:90px;[^}]*object-fit:contain/);
});

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
