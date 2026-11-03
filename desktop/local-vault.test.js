'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { accountStatus, createAccount, loadShop, saveShop, signIn } = require('./local-vault');

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'shopcrank-offline-'));
}

describe('local vault', () => {
  it('stores a password check on disk and signs in without the original password file text', () => {
    const dir = tempDir();
    assert.deepEqual(accountStatus(dir), { exists: false });
    const created = createAccount(dir, { name: 'Lee Owner', email: 'Lee@Shop.test', password: 'bay-door-19' });
    assert.deepEqual(created, { email: 'lee@shop.test', name: 'Lee Owner' });
    const raw = readFileSync(path.join(dir, 'offline-account.json'), 'utf8');
    assert.doesNotMatch(raw, /bay-door-19/);
    assert.match(raw, /"hash":/);
    assert.deepEqual(signIn(dir, { email: 'lee@shop.test', password: 'bay-door-19' }), created);
    assert.throws(() => signIn(dir, { email: 'lee@shop.test', password: 'wrong-pass' }), /does not match/);
    assert.throws(() => createAccount(dir, { name: 'Other', email: 'other@shop.test', password: 'another-1' }), /already has/);
  });

  it('keeps shop records on disk and drops password fields', () => {
    const dir = tempDir();
    saveShop(dir, {
      orders: [{ id: 'RO-1', total: 10 }],
      users: [{ id: 'user-1', email: 'lee@shop.test', password: 'bay-door-19' }],
    });
    const raw = readFileSync(path.join(dir, 'offline-shop.json'), 'utf8');
    assert.doesNotMatch(raw, /bay-door-19/);
    assert.deepEqual(loadShop(dir).orders, [{ id: 'RO-1', total: 10 }]);
    assert.equal(loadShop(dir).users[0].password, undefined);
    assert.equal(loadShop(path.join(dir, 'missing')), null);
  });
});

// Stand-in for Electron safeStorage: reversible, and the plain text never appears in the output.
const fakeCipher = {
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map(byte => byte ^ 0x5a)),
  decrypt: (buffer) => Buffer.from(buffer.map(byte => byte ^ 0x5a)).toString('utf8'),
};

describe('local vault encryption', () => {
  it('with OS encryption the shop file holds no readable customer data', () => {
    const dir = tempDir();
    const result = saveShop(dir, { customers: [{ name: 'Dana Ruiz', phone: '555-0142' }] }, { cipher: fakeCipher });
    assert.equal(result.encrypted, true);
    const raw = readFileSync(path.join(dir, 'offline-shop.json'), 'utf8');
    assert.doesNotMatch(raw, /Dana Ruiz|555-0142/);
    assert.equal(JSON.parse(raw).encrypted, 'os');
    assert.deepEqual(loadShop(dir, { cipher: fakeCipher }).customers, [{ name: 'Dana Ruiz', phone: '555-0142' }]);
    assert.throws(() => loadShop(dir), /encrypted for another computer/);
    // The unreadable file is set aside, never left where the next save would overwrite it.
    const kept = readdirSync(dir).filter(name => name.startsWith('offline-shop.unreadable-'));
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(path.join(dir, kept[0]), 'utf8'), raw);
    assert.equal(loadShop(dir), null);
  });

  it('an existing plain shop file still opens and is encrypted on the next save', () => {
    const dir = tempDir();
    saveShop(dir, { orders: [{ id: 'RO-7' }] });
    assert.deepEqual(loadShop(dir, { cipher: fakeCipher }).orders, [{ id: 'RO-7' }]);
    saveShop(dir, loadShop(dir, { cipher: fakeCipher }), { cipher: fakeCipher });
    assert.doesNotMatch(readFileSync(path.join(dir, 'offline-shop.json'), 'utf8'), /RO-7/);
    assert.deepEqual(loadShop(dir, { cipher: fakeCipher }).orders, [{ id: 'RO-7' }]);
  });
});
