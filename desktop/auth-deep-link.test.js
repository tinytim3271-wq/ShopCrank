'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAuthDeepLink } = require('./auth-deep-link');

describe('resolveAuthDeepLink', () => {
  it('converts a valid Shop Crank handoff into the hosted auth callback', () => {
    assert.equal(
      resolveAuthDeepLink(`shopcrank://auth?token=${'a'.repeat(32)}`, 'https://www.shopcrank.com/'),
      `https://www.shopcrank.com/api/auth/callback?token=${'a'.repeat(32)}`,
    );
  });

  it('rejects other schemes, hosts, and malformed tokens', () => {
    assert.equal(resolveAuthDeepLink(`https://auth?token=${'a'.repeat(32)}`, 'https://www.shopcrank.com/'), '');
    assert.equal(resolveAuthDeepLink(`shopcrank://other?token=${'a'.repeat(32)}`, 'https://www.shopcrank.com/'), '');
    assert.equal(resolveAuthDeepLink('shopcrank://auth?token=bad', 'https://www.shopcrank.com/'), '');
  });
});
