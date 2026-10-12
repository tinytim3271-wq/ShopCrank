'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
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
