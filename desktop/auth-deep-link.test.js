'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findAuthDeepLink, resolveAuthDeepLink } = require('./auth-deep-link');

describe('resolveAuthDeepLink', () => {
  it('converts a valid ShopCrank handoff into the hosted auth callback', () => {
    assert.equal(
      resolveAuthDeepLink(`shopcrank://auth?token=${'a'.repeat(32)}`, 'https://www.shopcrank.com/'),
      `https://www.shopcrank.com/api/auth/callback?token=${'a'.repeat(32)}`,
    );
  });

  it('accepts the slashless and trailing-slash forms Windows passes through', () => {
    const token = 'a'.repeat(32);
    assert.equal(
      resolveAuthDeepLink(`shopcrank:auth?token=${token}`, 'https://www.shopcrank.com/'),
      `https://www.shopcrank.com/api/auth/callback?token=${token}`,
    );
    assert.equal(
      resolveAuthDeepLink(`shopcrank://auth/?token=${token.toUpperCase()}`, 'https://www.shopcrank.com/'),
      `https://www.shopcrank.com/api/auth/callback?token=${token}`,
    );
  });

  it('rejects other schemes, hosts, and malformed tokens', () => {
    assert.equal(resolveAuthDeepLink(`https://auth?token=${'a'.repeat(32)}`, 'https://www.shopcrank.com/'), '');
    assert.equal(resolveAuthDeepLink(`shopcrank://other?token=${'a'.repeat(32)}`, 'https://www.shopcrank.com/'), '');
    assert.equal(resolveAuthDeepLink('shopcrank://auth?token=bad', 'https://www.shopcrank.com/'), '');
  });

  it('finds a protocol URL inside a Windows command line', () => {
    const token = 'b'.repeat(32);
    assert.equal(
      findAuthDeepLink(['C:\\Program Files\\ShopCrank\\ShopCrank.exe', `shopcrank://auth?token=${token}`]),
      `shopcrank://auth?token=${token}`,
    );
    assert.equal(
      findAuthDeepLink([`"C:\\Program Files\\ShopCrank\\ShopCrank.exe" "shopcrank:auth?token=${token}"`]),
      `shopcrank:auth?token=${token}`,
    );
    assert.equal(findAuthDeepLink(['ShopCrank.exe']), '');
  });
});
