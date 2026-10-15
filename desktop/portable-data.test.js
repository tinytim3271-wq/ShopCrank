'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, renameSync } = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { configurePortableData } = require('./portable-data');
const vault = require('./local-vault');

test('installed editions leave Electron data paths unchanged', () => {
  const app = { setPath: () => assert.fail('Installed data paths must not change') };
  assert.equal(configurePortableData(app, { offline: false }), null);
  assert.equal(configurePortableData(app, { offline: true }), null);
});

test('portable profile and shop records follow the executable, not the working directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shopcrank-portable-'));
  try {
    const original = path.join(root, 'USB A');
    mkdirSync(original);
    const paths = {};
    const app = { setPath: (key, value) => { paths[key] = value; } };
    const dir = configurePortableData(app, { offline: true, portable: true }, path.join(original, 'Shop Crank Demo.exe'));
    assert.equal(dir, path.join(original, 'Shop Crank Demo Data'));
    assert.equal(paths.userData, dir);
    assert.equal(paths.sessionData, dir);
    assert.ok(existsSync(paths.logs));
    assert.ok(existsSync(paths.crashDumps));
    const account = { email: 'demo@shop.test', name: 'Demo Owner', password: 'test-only-password' };
    vault.createAccount(dir, account);
    vault.saveShop(dir, { orders: [{ id: 'USB-1' }] });
    assert.deepEqual(vault.loadShop(dir), { orders: [{ id: 'USB-1' }] });
    assert.equal(configurePortableData(app, { portable: true }, path.join(original, 'Shop Crank Demo.exe')), dir);
    assert.deepEqual(vault.loadShop(paths.userData), { orders: [{ id: 'USB-1' }] });
    const moved = path.join(root, 'USB B');
    renameSync(original, moved);
    configurePortableData(app, { portable: true }, path.join(moved, 'Shop Crank Demo.exe'));
    assert.equal(paths.userData, path.join(moved, 'Shop Crank Demo Data'));
    assert.deepEqual(vault.loadShop(paths.userData), { orders: [{ id: 'USB-1' }] });
    assert.equal(vault.signIn(paths.userData, account).email, account.email);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sandboxed preload requires only Electron and exposes the supplied edition flags', () => {
  for (const argv of [[], ['--shopcrank-offline', '--shopcrank-portable', '--shopcrank-demo']]) {
    const exposed = {};
    vm.runInNewContext(readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
      process: { argv, platform: 'win32', versions: { electron: 'test' } },
      require: (name) => {
        assert.equal(name, 'electron', 'Sandboxed preload cannot require local JSON or modules');
        return {
          contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
          ipcRenderer: { invoke: async () => ({ ok: true, result: {} }) },
        };
      },
    });
    assert.equal(exposed.shopcrankDesktop.offline, argv.length > 0);
    assert.equal(exposed.shopcrankDesktop.portable, argv.length > 0);
    assert.equal(exposed.shopcrankDesktop.demo, argv.length > 0);
    assert.equal(Boolean(exposed.shopcrankDesktop.localShop), argv.length > 0);
    assert.ok(exposed.shopcrankDiagnostics);
  }
});

test('demo packaging excludes credentials and does not inherit production resources', () => {
  const config = JSON.parse(readFileSync(path.join(__dirname, 'builder-demo.json'), 'utf8'));
  assert.equal(config.extends, null);
  assert.deepEqual(config.extraResources, []);
  assert.ok(config.files.includes('!desktop/packaged-secrets/**/*'));
  assert.ok(!config.files.includes('downloads/**'));
  assert.deepEqual(config.win.target, [{ target: 'zip', arch: ['x64'] }]);
});

test('demo document title matches the packaged product name', () => {
  const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<title>[^<]*Shop Crank[^<]*<\/title>/);
});

test('an unusable portable data directory fails instead of using host storage', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shopcrank-portable-'));
  try {
    writeFileSync(path.join(root, 'Shop Crank Demo Data'), 'not a directory');
    assert.throws(() => configurePortableData({ setPath: () => assert.fail() }, { portable: true }, path.join(root, 'Shop Crank Demo.exe')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
