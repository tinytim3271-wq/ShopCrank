import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmail } from './front-desk-questionnaire.js';

test('email validation preserves the supported address syntax without backtracking', () => {
  for (const address of ['shop@example.com', 'a+b@sub.example.com', 'a@a..b']) assert.equal(isEmail(address), true, address);
  for (const address of ['', '@example.com', 'a@.com', 'a@example.', 'a@@example.com', 'a b@example.com', 'a@example.com\n']) {
    assert.equal(isEmail(address), false, address);
  }
  assert.equal(isEmail(`!@!${'!.'.repeat(100_000)}`), true);
  assert.equal(isEmail(`!@!${'!.'.repeat(100_000)}@`), false);
  assert.equal(isEmail(`!@!${'!.'.repeat(100_000)}x`), true);
});
