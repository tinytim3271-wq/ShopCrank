'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDiagnosticsPublicKey } = require('./diagnostics-secrets');
const { isTrustedLocalDiagnosticsRequest } = require('./diagnostics-bridge');

describe('resolveDiagnosticsPublicKey', () => {
  it('prefers environment variables', () => {
    const result = resolveDiagnosticsPublicKey({
      env: { DIAGNOSTICS_SIGNING_PUBLIC_KEY: ' from-env ' },
      packaged: true,
    });
    assert.equal(result.publicKey, 'from-env');
    assert.equal(result.source, 'env');
  });

  it('uses the explicit public-key file when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopcrank-diag-public-key-'));
    const filePath = path.join(dir, 'capability-public-key.pem');
    fs.writeFileSync(filePath, 'public-key-from-file\n');
    try {
      const result = resolveDiagnosticsPublicKey({
        env: { DIAGNOSTICS_SIGNING_PUBLIC_KEY_FILE: filePath },
        packaged: true,
      });
      assert.equal(result.publicKey, 'public-key-from-file');
      assert.equal(result.source, filePath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the packaged public-key file when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopcrank-diag-public-key-'));
    const previous = process.resourcesPath;
    process.resourcesPath = dir;
    try {
      const nested = path.join(dir, 'diagnostics-keys');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'capability-public-key.pem'), 'nested-packaged-public-key\n');
      const result = resolveDiagnosticsPublicKey({ env: {}, packaged: true });
      assert.equal(result.publicKey, 'nested-packaged-public-key');
      assert.match(result.source, /capability-public-key\.pem$/);
    } finally {
      if (previous === undefined) delete process.resourcesPath;
      else process.resourcesPath = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when packaged public key is missing', () => {
    // candidates: [] isolates the test from the repo's committed public key file.
    const result = resolveDiagnosticsPublicKey({ env: {}, packaged: true, candidates: [] });
    assert.equal(result.publicKey, '');
    assert.equal(result.source, 'missing-packaged');
  });

  it('does not throw when the dev public key is missing', () => {
    const result = resolveDiagnosticsPublicKey({ env: {}, packaged: false, candidates: [] });
    assert.equal(result.publicKey, '');
    assert.equal(result.source, 'missing-dev');
  });
});

describe('isTrustedLocalDiagnosticsRequest', () => {
  it('allows same-origin loopback requests carrying the local client header', () => {
    assert.equal(
      isTrustedLocalDiagnosticsRequest({
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'sec-fetch-site': 'same-origin',
          'x-shopcrank-local-client': '1',
        },
      }),
      true,
    );
  });

  it('rejects non-loopback, missing header, or cross-origin requests', () => {
    assert.equal(
      isTrustedLocalDiagnosticsRequest({
        socket: { remoteAddress: '192.168.1.50' },
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'x-shopcrank-local-client': '1',
        },
      }),
      false,
    );
    assert.equal(
      isTrustedLocalDiagnosticsRequest({
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
        },
      }),
      false,
    );
    assert.equal(
      isTrustedLocalDiagnosticsRequest({
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:3000',
          origin: 'https://evil.example',
          'x-shopcrank-local-client': '1',
        },
      }),
      false,
    );
  });
});

describe('Windows packaging', () => {
  const root = path.join(__dirname, '..');
  const configs = {
    online: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build,
    offline: JSON.parse(fs.readFileSync(path.join(__dirname, 'builder-offline.json'), 'utf8')),
  };

  for (const [name, config] of Object.entries(configs)) {
    it(`${name} installer ships the public verification key and no shared secret`, () => {
      const resources = JSON.stringify(config.extraResources);
      assert.doesNotMatch(resources, /packaged-secrets|capability-secret|private/i);
      assert.ok(config.files.includes('!desktop/packaged-secrets/**/*'));
      assert.ok(config.extraResources.some(entry => entry.from === 'diagnostics/keys'
        && entry.to === 'diagnostics-keys'
        && entry.filter.length === 1 && entry.filter[0] === 'capability-public-key.pem'));
    });
  }

  it('build scripts and the release workflow never bake a diagnostics secret', () => {
    const scripts = JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts);
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'windows-desktop.yml'), 'utf8');
    const offline = fs.readFileSync(path.join(root, 'scripts', 'build-offline-windows.mjs'), 'utf8');
    for (const text of [scripts, workflow, offline]) {
      assert.doesNotMatch(text, /bake-diagnostics-secret|DIAGNOSTICS_CAPABILITY_SECRET/);
    }
  });

  it('the committed production key is a public key', () => {
    const pem = fs.readFileSync(path.join(root, 'diagnostics', 'keys', 'capability-public-key.pem'), 'utf8');
    assert.match(pem, /BEGIN PUBLIC KEY/);
    assert.doesNotMatch(pem, /PRIVATE/);
  });
});
