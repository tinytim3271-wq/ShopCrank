#!/usr/bin/env node
/**
 * Browser smoke test: the real Worker (local D1/R2) + the staged Pages build,
 * driven by Chromium as a brand-new shop through the production sign-in path.
 *
 * Covers the flows that broke without any unit test noticing (see
 * .10x/reviews/2026-10-20-qa-report.md): signup identity, no demo data,
 * customers, employees, payroll, intake -> work order -> invoice -> payment,
 * Texas sales tax on parts only, and every module rendering on desktop and phone.
 *
 * Prereqs: npm run build:web && npm run stage:pages, plus a Chromium for
 * Playwright (CI: npx playwright install --with-deps chromium; locally you can
 * point SMOKE_CHROMIUM_PATH at an existing Chromium). Needs openssl on PATH.
 *
 *   npm run test:smoke
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, createReadStream, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import { chromium } from 'playwright';
import { LOCAL_WRANGLER_CONFIG, writeLocalWranglerConfig } from '../dev-worker-local.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pagesDir = join(root, '.pages-dist');
const artifactsDir = join(root, 'smoke-artifacts');
const HOST = 'app.shopcrank.test';
const ORIGIN = `https://${HOST}`;
const WORKER_PORT = Number(process.env.SMOKE_WORKER_PORT || 8797);
const PROXY_PORT = Number(process.env.SMOKE_PROXY_PORT || 8798);
const WORKER = `http://127.0.0.1:${WORKER_PORT}`;
const SHOP = 'Smoke Test Garage';

const results = [];
const children = [];
let server;

function record(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass || !detail ? '' : `\n      ${String(detail).slice(0, 300)}`}`);
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    record(name, outcome !== false, outcome === false ? 'assertion failed' : '');
  } catch (error) {
    record(name, false, error?.message || error);
  }
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, stdio: 'pipe', shell: process.platform === 'win32', ...opts }).toString();
}

async function waitFor(url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff' };

/** Serves .pages-dist like Pages (folder index, SPA fallback) and forwards /api to the Worker. */
async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/ShopCrank')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers };
    delete headers.host;
    const upstream = await fetch(`${WORKER}${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    });
    const out = {};
    upstream.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(key)) out[key] = value;
    });
    const cookies = upstream.headers.getSetCookie?.() || [];
    if (cookies.length) out['set-cookie'] = cookies;
    if (out.location) out.location = out.location.replace(WORKER, ORIGIN);
    let body = Buffer.from(await upstream.arrayBuffer());
    if (/json|text|html/.test(out['content-type'] || '')) body = Buffer.from(body.toString('utf8').replaceAll(WORKER, ORIGIN));
    res.writeHead(upstream.status, out);
    res.end(body);
    return;
  }
  let file = normalize(join(pagesDir, decodeURIComponent(url.pathname)));
  if (!file.startsWith(pagesDir)) { res.writeHead(403); res.end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) file = join(pagesDir, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

async function startStack() {
  if (!existsSync(join(pagesDir, 'index.html'))) throw new Error('Missing .pages-dist. Run: npm run build:web && npm run stage:pages');
  const work = mkdtempSync(join(tmpdir(), 'shopcrank-smoke-'));
  const config = writeLocalWranglerConfig();
  const persist = join(work, 'state');
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '-c', config, '--persist-to', persist], { env: { ...process.env, CI: '1' } });
  const vars = {
    AUTH_EXPOSE_LOGIN_LINK: '1',
    ALLOWED_ORIGINS: ORIGIN,
    INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    LICENSE_TOKEN_SECRET: randomBytes(32).toString('hex'),
    DIAGNOSTICS_CAPABILITY_SECRET: randomBytes(32).toString('hex'),
  };
  if (await fetch(`${WORKER}/api/healthz`).then(() => true, () => false)) {
    throw new Error(`Port ${WORKER_PORT} is already serving; stop that process or set SMOKE_WORKER_PORT`);
  }
  const worker = spawn('npx', ['wrangler', 'dev', '-c', config, '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--persist-to', persist,
    ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}:${value}`])], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: { ...process.env, CI: '1' },
    detached: process.platform !== 'win32',
  });
  let workerLog = '';
  worker.stdout.on('data', data => { workerLog += data; });
  worker.stderr.on('data', data => { workerLog += data; });
  children.push(worker);
  try {
    await waitFor(`${WORKER}/api/healthz`, 90_000);
  } catch (error) {
    throw new Error(`${error.message}\n${workerLog.slice(-2000)}`);
  }
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'), '-days', '1', '-subj', `/CN=${HOST}`]);
  server = https.createServer({ key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) }, (req, res) => {
    handle(req, res).catch(error => { res.writeHead(502); res.end(String(error)); });
  });
  await new Promise(resolve => server.listen(PROXY_PORT, '127.0.0.1', resolve));
  return work;
}

// 64x48 grey PNG used for the intake walk-around photos.
function photoFixture(dir) {
  const path = join(dir, 'photo.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAU0lEQVR4nO3PsQ3AIADAMOBqZmaO7hEMVqX4gmTuc8efLR3wqgGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAe0DDtIB5uQ/i7MAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path, png);
  return path;
}

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  const work = await startStack();
  const photo = photoFixture(work);
  const browser = await chromium.launch({
    executablePath: process.env.SMOKE_CHROMIUM_PATH || undefined,
    args: ['--no-proxy-server', `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PROXY_PORT}`],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const toasts = [];
  await page.exposeFunction('smokeToast', text => toasts.push(text));
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const region = document.querySelector('#toast-region');
      if (region) new MutationObserver(() => { const text = region.innerText.trim(); if (text) window.smokeToast(text); }).observe(region, { childList: true, subtree: true, characterData: true });
    });
  });
  const main = () => page.evaluate(() => (document.querySelector('main') || document.body).innerText);
  const route = async name => { await page.click(`[data-route=${name}]`); await page.waitForTimeout(900); };

  try {
    await check('signup creates the shop and signs in through the confirm page', async () => {
      await page.goto(`${ORIGIN}/signup/`, { waitUntil: 'networkidle' });
      await page.fill('input[name=shopName]', SHOP);
      await page.fill('input[name=ownerName]', 'Sam Smoke');
      await page.fill('input[name=email]', `owner-${Date.now()}@smoke.test`);
      await page.click('button[type=submit]');
      await page.waitForSelector('text=Continue to ShopCrank', { timeout: 15_000 }).catch(async () => {
        throw new Error(`no confirm page at ${page.url()}: ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 120)} | errors: ${[...pageErrors, ...consoleErrors].join(' / ').slice(0, 300)}`);
      });
      await page.click('text=Continue to ShopCrank');
      await page.waitForSelector('[data-route=home]', { timeout: 20_000 });
      await page.waitForTimeout(2500);
      return true;
    });
    await check('new shop shows its own name and no demo identity or data', async () => {
      const text = await page.evaluate(() => document.body.innerText);
      if (!text.includes(SHOP)) throw new Error('shop name missing from header');
      const leaked = ['Your Car Guy', 'Demo Customer', '100 Demo Street', 'RO-1051'].filter(value => text.includes(value));
      if (leaked.length) throw new Error(`demo content visible: ${leaked.join(', ')}`);
    });
    await check('add customer saves (sanitizer-safe field names)', async () => {
      await route('customers');
      for (const name of ['Alice Brooks', 'Ben Carter']) {
        await page.getByRole('button', { name: 'Add customer' }).first().click();
        await page.fill('.modal [name=displayName]', name);
        await page.fill('.modal [name=phone]', '806-555-0101');
        await page.locator('.modal button[type=submit]').last().click();
        await page.waitForTimeout(1200);
        if (!(await main()).includes(name)) throw new Error(`${name} not listed`);
      }
    });
    await check('add employee keeps name, title and role', async () => {
      await route('employees');
      await page.getByRole('button', { name: 'Add employee' }).first().click();
      await page.fill('.modal [name=displayName]', 'Terry Tech');
      await page.fill('.modal [name=jobTitle]', 'Lead Technician');
      await page.selectOption('.modal [name=accessRole]', 'technician');
      for (const [selector, value] of [['[name=workEmail]', 'terry@smoke.test'], ['[name=employeeId]', 'EMP-101'], ['[name=techName]', 'Terry'], ['[name=payRate]', '28'], ['[name=startDate]', '2026-10-01']]) {
        if (await page.locator(`.modal ${selector}`).count()) await page.fill(`.modal ${selector}`, value);
      }
      await page.locator('.modal button[type=submit]').last().click();
      await page.waitForTimeout(1800);
      const text = await main();
      if (!text.includes('Terry Tech') || !text.includes('Lead Technician')) throw new Error('employee or title missing');
    });
    await check('payroll opens without errors', async () => {
      pageErrors.length = 0;
      await route('payroll');
      if (pageErrors.length) throw new Error(pageErrors.join(' | '));
      if (!/payroll/i.test((await main()).slice(0, 400))) throw new Error('payroll page did not render');
    });
    await check('intake converts to a work order', async () => {
      await route('home');
      await page.getByRole('button', { name: 'New Customer Intake' }).first().click();
      const modal = page.locator('.modal');
      for (const [field, value] of [['firstName', 'Maria'], ['lastName', 'Gonzalez'], ['phone', '806-555-0134'], ['email', 'maria@example.com']]) await modal.locator(`[name=${field}]`).fill(value);
      await page.click('#intake-next');
      for (const [field, value] of [['year', '2019'], ['make', 'Toyota'], ['model', 'Camry'], ['vin', '4T1B11HK5KU123456'], ['mileage', '84210']]) await modal.locator(`[name=${field}]`).fill(value);
      await page.click('#intake-next');
      const inputs = page.locator('.modal input[type=file]');
      for (let index = 0; index < 4; index += 1) { await inputs.nth(index).setInputFiles(photo); await page.waitForTimeout(300); }
      await page.click('#intake-next');
      await modal.locator('textarea[name=description]').fill('Grinding noise from front brakes');
      await page.click('#intake-next');
      await page.click('#intake-next');
      await modal.locator('[name=line-description]').first().fill('Front brake pads and rotors');
      await modal.locator('[name=line-hours]').first().fill('1.8');
      await page.click('#intake-next');
      await page.click('#intake-convert');
      await page.waitForTimeout(3500);
      if (await page.locator('.modal').count()) throw new Error('intake dialog still open');
    });
    await check('work order estimate carries the shop name, approves, and completes', async () => {
      await route('orders');
      await page.locator('tr:has-text("Maria Gonzalez") button:has-text("Edit")').first().click();
      await page.waitForTimeout(1200);
      const estimate = await page.evaluate(() => document.querySelector('.modal')?.innerText || '');
      if (!estimate.toUpperCase().includes(SHOP.toUpperCase())) throw new Error('estimate header lacks shop name');
      await page.click('#sign-job-estimate');
      await page.selectOption('[name=approvalType]', { label: 'In-person approval' });
      await page.fill('[name=authorizationName]', 'Maria Gonzalez');
      await page.click('#save-document-approval');
      await page.waitForTimeout(1800);
      if (!(await page.locator('#job-detail-status').count())) {
        await page.locator('tr:has-text("Maria Gonzalez") button:has-text("Edit")').first().click();
        await page.waitForTimeout(1000);
      }
      await page.selectOption('#job-detail-status', 'completed');
      await page.waitForTimeout(2500);
      await page.evaluate(() => document.querySelector('#modal-root')?.remove());
    });
    await check('invoice taxes parts and supplies only (Texas default) and payments mark it paid', async () => {
      await route('invoices');
      const row = page.locator('tr:has-text("Maria Gonzalez")').first();
      const before = await row.innerText();
      // 1.8 h labor + 3% supplies ($7.56) at 8.25%: only the supplies are taxed.
      if (!/Tax \$0\.62/.test(before)) throw new Error(`unexpected tax: ${before.replace(/\s+/g, ' ').slice(0, 160)}`);
      const remaining = () => row.innerText().then(text => Number((text.match(/Remaining \$([\d,.]+)/) || [])[1]?.replace(/,/g, '')));
      for (const [amount, method] of [['100', 'Cash'], [null, 'Check']]) {
        await row.locator('button:has-text("Record payment")').click();
        await page.fill('.modal [name=amount]', amount || String(await remaining()));
        await page.locator('.modal [name=paymentMethod]').selectOption({ label: method });
        await page.locator('.modal button[type=submit]:has-text("Record payment")').click();
        await page.waitForTimeout(1800);
        if (toasts.some(text => /Unsupported payment method/.test(text))) throw new Error('payment rejected');
      }
      const after = await row.innerText();
      if (!/PAID/.test(after) || !/2 payments/.test(after)) throw new Error(after.replace(/\s+/g, ' ').slice(0, 200));
    });
    for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      await check(`every module renders on ${label} with no errors or sideways scroll`, async () => {
        await page.setViewportSize(viewport);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        const routes = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-route]')].map(element => element.dataset.route))]);
        const problems = [];
        for (const name of routes) {
          pageErrors.length = 0;
          await page.evaluate(target => document.querySelector(`[data-route="${target}"]`)?.click(), name);
          await page.waitForTimeout(700);
          if (pageErrors.length) problems.push(`${name}: ${pageErrors[0]}`);
          if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)) problems.push(`${name}: horizontal scroll`);
          const text = await main();
          if (/Your Car Guy|Demo Customer/.test(text)) problems.push(`${name}: demo content`);
        }
        if (routes.length < 15) problems.push(`only ${routes.length} modules in navigation`);
        if (problems.length) throw new Error(problems.join(' | '));
      });
    }
  } finally {
    if (results.some(result => !result.pass)) await page.screenshot({ path: join(artifactsDir, 'failure.png'), fullPage: true }).catch(() => {});
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main()
  .catch(error => record('smoke harness', false, error?.stack || error))
  .finally(() => {
    server?.close();
    // npx -> wrangler -> workerd: stop the whole tree, or workerd keeps the port.
    for (const child of children) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    rmSync(join(root, LOCAL_WRANGLER_CONFIG), { force: true });
    const failed = results.filter(result => !result.pass);
    console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
    setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
  });

