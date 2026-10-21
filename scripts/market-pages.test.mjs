import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pricing = readFileSync(new URL('../public/pricing/index.html', import.meta.url), 'utf8');
const features = readFileSync(new URL('../public/features/index.html', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('../public/privacy/index.html', import.meta.url), 'utf8');
const terms = readFileSync(new URL('../public/terms/index.html', import.meta.url), 'utf8');
const plansSql = readFileSync(new URL('../worker/migrations/0002_public_saas_auth.sql', import.meta.url), 'utf8');
const legacy = readFileSync(new URL('../src/runtime/legacy.js', import.meta.url), 'utf8');
const diagnosticsUi = readFileSync(new URL('../diagnostics-ui.js', import.meta.url), 'utf8');

test('marketing pages and the app shell advertise www.shopcrank.com', () => {
  const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(shell, /https:\/\/www\.shopcrank\.com\//);
  assert.match(shell, /connect-src[^"]*https:\/\/api\.x\.ai/);
  assert.match(shell, /connect-src[^"]*wss:\/\/api\.x\.ai/);
  assert.doesNotMatch(shell, /yourcarguy806|MechPro dispatch board/);
  for (const href of ['/features/', '/pricing/', '/login/', '/signup/']) {
    const page = readFileSync(new URL(`../public${href}index.html`, import.meta.url), 'utf8');
    assert.match(page, new RegExp(`https://www\\.shopcrank\\.com${href.replaceAll('/', '\\/')}`));
  }
});

test('the legal pages are generic and name no legacy shop or host', () => {
  for (const [name, page] of [['privacy', privacy], ['terms', terms]]) {
    assert.doesNotMatch(page, /Your Car Guy|yourcarguy806|MechPro/i, `${name} names a legacy brand`);
    assert.match(page, new RegExp('https://www\\.shopcrank\\.com/' + name + '/'), `${name} canonical URL`);
  }
  assert.match(privacy, /subscribing shop/);
});

test('the public site sells the launch catalog, not the retired starter plan', () => {
  assert.match(plansSql, /'starter', 'price_starter', 'Starter', 4900, 3, 1/);
  assert.match(pricing, /\$69/);
  assert.match(pricing, /\$139/);
  assert.match(pricing, /\$279/);
  assert.match(pricing, /\$559/);
  assert.match(pricing, /Unlimited users/);
  assert.doesNotMatch(pricing, /Founding Member|\$49/);
});

test('the website front explains import, security, and who the shop is for', () => {
  assert.match(features, /invoice/i);
  assert.match(features, /estimate/i);
  assert.match(features, /password/i);
  assert.match(features, /technician|employee/i);
  assert.match(features, /graphics\/dispatch-board\.svg/);
  for (const href of ['/pricing', '/signup', '/login', '/downloads', '/privacy', '/terms']) {
    assert.match(features, new RegExp(`href="${href}"`));
  }
});

test('every shop screen still has a view function', () => {
  const views = [
    'superAdmin', 'homeDashboard', 'dispatch', 'orders', 'schedule', 'customers',
    'teamChat', 'invoices', 'aiWorkbench', 'messaging', 'payments', 'reports',
    'settings', 'accounting', 'payroll', 'imports', 'employees',
  ];
  for (const name of views) {
    assert.match(legacy, new RegExp(`function ${name}\\b|\\b${name} = function\\b`));
  }
  assert.match(diagnosticsUi, /function oemDiagnosticsView\b/);
  assert.match(legacy, /invoices:/);
  assert.match(legacy, /estimates:/);
});
