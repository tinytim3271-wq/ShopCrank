import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLocalIsoDate } from '../shared/dates.js';

// The shell (src/runtime/legacy.js) is one large module, so these checks read
// its source. Each one describes a defect that was found in a live shop.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacy = readFileSync(join(root, 'runtime', 'legacy.js'), 'utf8');

/** Returns the source of the function whose definition starts with `prefix`. */
function functionSource(prefix) {
  return sourceFunction(prefix, legacy);
}

function sourceFunction(prefix, source) {
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error(`not found: ${prefix}`);
  let depth = 0;
  let parentheses = 0;
  let quote = '';
  let escaped = false;
  let bodyStart = -1;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') parentheses += 1;
    else if (char === ')' && --parentheses === 0) {
      bodyStart = source.indexOf('{', i + 1);
      break;
    }
  }
  let i = bodyStart;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

function functionSources(source) {
  const functions = [];
  const declaration = /(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/g;
  let match;
  while ((match = declaration.exec(source)) !== null) {
    const body = sourceFunction(match[0], source.slice(match.index));
    functions.push(body);
  }
  return functions;
}

function blockAt(source, openingBrace) {
  let depth = 0;
  for (let i = openingBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(openingBrace, i + 1);
  }
  return '';
}

function handlerUsesSubmitButton(body, id) {
  const selector = new RegExp(`querySelector\\(["']#${id}["']\\)`);
  const selectedForm = selector.exec(body);
  if (!selectedForm) return false;
  const tail = body.slice(selectedForm.index, selectedForm.index + 1200);
  const eventIndex = tail.search(/\.addEventListener\(\s*["']submit["']|\.onsubmit\s*=/);
  if (eventIndex < 0) return false;
  const arrow = tail.indexOf('=>', eventIndex);
  const openingBrace = arrow < 0 ? -1 : tail.indexOf('{', arrow);
  if (openingBrace < 0) return false;
  return /querySelector\(["']button\[type=submit\]["']\)/.test(blockAt(tail, openingBrace));
}

function submitButtonOffenders(source) {
  const offenders = new Set();
  for (const body of functionSources(source)) {
    const formRe = /<form[^>]*id="([a-z0-9-]+)"[\s\S]*?<\/form>/g;
    let match;
    while ((match = formRe.exec(body)) !== null) {
      const id = match[1];
      const buttons = [...match[0].matchAll(/<button[^>]*>/g)].map((button) => button[0]);
      if (buttons.some((button) => button.includes('type="submit"'))) continue;
      if (handlerUsesSubmitButton(body, id)) offenders.add(id);
    }
  }
  return [...offenders].sort();
}

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

test('fresh-shop billing uses the default jurisdiction rate', () => {
  const initial = functionSource('function initialState(');
  assert.match(initial, /base\.taxSettings\.rate = Filing\.combinedSalesTaxRate\(Filing\.DEFAULT_TX_JURISDICTIONS\)/);
  assert.match(legacy, /loadShopEntities = async function \(\) \{[\s\S]*?rate: Number\(tax\.rate\) \|\| 0/);
});

test('filing reports and exports require the configured rate to match jurisdictions', () => {
  assert.match(functionSource('function isFilingRateConsistent('), /Filing\.salesTaxRateMatchesJurisdictions/);
  assert.match(functionSource('async function generateTaxReportFromForm('), /if \(!filingRateIsConsistent\(\)\) return;/);
  assert.match(functionSource('function exportSalesTaxCsv()'), /!filingRateIsConsistent\(\)/);
  assert.match(functionSource('function exportTexasWebfilePackage()'), /!filingRateIsConsistent\(\)/);
  assert.match(legacy, /document\.querySelector\('#print-tax-report'\)\?\.addEventListener\('click', event => \{\s*if \(!filingRateIsConsistent\(\)\)/);
  assert.match(functionSource('reports = function () {'), /const result = rateMatches \? taxReportResult : null/);
});

test('every form whose handler looks up button[type=submit] has a typed submit button', () => {
  assert.deepEqual(submitButtonOffenders(legacy), []);
});

test('cross-form submit detection catches broken forms after intervening statements', () => {
  const broken = `function openVehicleForm() {
    const html = '<form id="vehicle-form"><button>Save vehicle</button></form>';
    document.querySelector("#vehicle-form").addEventListener("submit", event => {
      event.preventDefault();
      const form = document.querySelector("#vehicle-form");
      const button = form.querySelector("button[type=submit]");
    });
  }`;
  assert.deepEqual(submitButtonOffenders(broken), ['vehicle-form']);
});

test('the work order estimate picker offers only the shop\'s own estimates', () => {
  const sources = functionSource('function availableEstimateSources(');
  assert.doesNotMatch(sources, /REFERENCE_ESTIMATE/);
  assert.match(sources, /state\.estimates/);
});

test('work order picker is conditional while estimate adjustments remain available', () => {
  const controls = functionSource('function addEstimateSourceControls(');
  const adjustments = controls.indexOf('estimate-adjustments');
  const emptySources = controls.indexOf('if (!sources.length) return;');
  const options = controls.indexOf('const options = sources.map');
  const panel = controls.indexOf('body.insertAdjacentHTML');
  assert.ok(adjustments >= 0 && adjustments < emptySources);
  assert.ok(emptySources < options && options < panel);
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

test('desktop email sign-in explains browser handoff and link expiry', () => {
  const signIn = functionSource('async function signInWithEmailLink(');
  assert.match(signIn, /isDesktopApp \? "Check your email and open the sign-in link\..*Open ShopCrank.*15 minutes\."/);
  assert.match(signIn, /result\.message \|\| "Check your email for a sign-in link\. It expires in 15 minutes\."/);
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

test('invoice editor round-trips date-only values in America/Chicago', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const invoiceDateValue = runInNewContext(`(${functionSource('function invoiceDateValue(')})`, { toLocalIsoDate });
    const invoice = { date: '2026-10-31', due: '2026-11-14' };
    const formValues = {
      date: invoiceDateValue(invoice.date),
      due: invoiceDateValue(invoice.due),
    };
    assert.deepEqual({ ...invoice, ...formValues }, invoice);
    assert.match(functionSource('function openInvoiceEditor('), /date: data\.date, due: data\.due/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
