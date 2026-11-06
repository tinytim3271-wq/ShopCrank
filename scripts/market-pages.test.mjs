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

test('robots.txt and sitemap.xml are real files the Pages site serves', async () => {
  const { existsSync } = await import('node:fs');
  const robots = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
  const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  const routes = JSON.parse(readFileSync(new URL('../public/_routes.json', import.meta.url), 'utf8'));
  assert.match(robots, /^User-agent: \*/m);
  assert.match(robots, /^Disallow: \/api\//m, 'the API stays out of search results');
  assert.match(robots, /^Sitemap: https:\/\/www\.shopcrank\.com\/sitemap\.xml$/m);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...sitemap.matchAll(/<loc>https:\/\/www\.shopcrank\.com\/([^<]*)<\/loc>/g)].map(match => match[1]);
  assert.ok(locs.length >= 5);
  for (const path of locs) assert.ok(existsSync(new URL(`../public/${path}index.html`, import.meta.url)), `sitemap lists /${path} but public/${path}index.html is missing`);
  for (const file of ['/robots.txt', '/sitemap.xml']) assert.ok(routes.exclude.includes(file), `${file} must bypass the Worker so the static file is served, not the app`);
});

test('link previews use the 1200x630 PNG card on the home, pricing, features and signup pages', () => {
  const card = 'https://www.shopcrank.com/graphics/shopcrank-og-card-1200x630.png';
  const pages = { home: '../index.html', pricing: '../public/pricing/index.html', features: '../public/features/index.html', signup: '../public/signup/index.html' };
  for (const [name, path] of Object.entries(pages)) {
    const page = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.ok(page.includes(`<meta property="og:image" content="${card}" />`), `${name} og:image`);
    assert.ok(page.includes(`<meta name="twitter:image" content="${card}" />`), `${name} twitter:image`);
    assert.match(page, /<meta name="twitter:card" content="summary_large_image" \/>/, `${name} twitter:card`);
    assert.doesNotMatch(page, /og-card\.svg/, `${name} still points at the SVG card`);
  }
  // SVG previews don't render on Facebook, iMessage, X or LinkedIn: the card must be a real PNG.
  const png = readFileSync(new URL('../public/graphics/shopcrank-og-card-1200x630.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
});
