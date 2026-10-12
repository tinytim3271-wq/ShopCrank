import test from 'node:test';
import assert from 'node:assert/strict';
import { storageKeys } from './storage.js';

test('storage module re-exports canonical keys', () => {
  assert.equal(storageKeys.dispatch, 'mechpro-dispatch-v1');
  assert.equal(storageKeys.session, 'mechpro-session');
  assert.ok(storageKeys.mutationQueue);
});
