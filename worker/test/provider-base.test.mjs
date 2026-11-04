import test from 'node:test';
import assert from 'node:assert/strict';
import { providerBase } from '../src/provider-base.mjs';

test('the smoke override works only for a loopback http address', () => {
  const live = 'https://api.stripe.com/v1';
  assert.equal(providerBase({}, 'STRIPE', live), live);
  assert.equal(providerBase({ SMOKE_STRIPE_API_BASE: 'http://127.0.0.1:9000/v1/' }, 'STRIPE', live), 'http://127.0.0.1:9000/v1');
  assert.equal(providerBase({ SMOKE_STRIPE_API_BASE: 'https://evil.example/v1' }, 'STRIPE', live), live);
  assert.equal(providerBase({ SMOKE_STRIPE_API_BASE: 'http://10.0.0.5/v1' }, 'STRIPE', live), live);
  assert.equal(providerBase({ SMOKE_STRIPE_API_BASE: 'not a url' }, 'STRIPE', live), live);
});
