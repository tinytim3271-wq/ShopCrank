import test from 'node:test';
import assert from 'node:assert/strict';
import { storageKeys } from './storage.js';

test('storage module re-exports canonical keys', () => {
  assert.equal(storageKeys.dispatch, 'shopcrank-dispatch-v1');
  assert.equal(storageKeys.session, 'shopcrank-session');
  assert.ok(storageKeys.mutationQueue);
});
