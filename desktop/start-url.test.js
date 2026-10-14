'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_DESKTOP_APP_URL, resolveDesktopStart } = require('./start-url');

describe('resolveDesktopStart', () => {
  it('defaults to the hosted production app URL', () => {
    assert.equal(DEFAULT_DESKTOP_APP_URL, 'https://www.shopcrank.com/');
    const result = resolveDesktopStart({ argv: ['electron', '.'], env: {} });
    assert.equal(result.useLocalAssets, false);
    assert.equal(result.remoteUrl, DEFAULT_DESKTOP_APP_URL);
  });

  it('uses local assets for smoke tests', () => {
    const result = resolveDesktopStart({ argv: ['electron', '.', '--smoke-test'], env: {} });
    assert.equal(result.useLocalAssets, true);
  });

  it('uses local assets when SHOP_CRANK_DESKTOP_LOCAL=1', () => {
    const result = resolveDesktopStart({ argv: ['electron', '.'], env: { SHOP_CRANK_DESKTOP_LOCAL: '1' } });
    assert.equal(result.useLocalAssets, true);
  });

  it('loads local files for the offline edition', () => {
    const result = resolveDesktopStart({ argv: ['electron', '.'], env: {}, offline: true });
    assert.equal(result.offline, true);
    assert.equal(result.useLocalAssets, true);
  });

  it('honors SHOP_CRANK_DESKTOP_URL overrides', () => {
    const result = resolveDesktopStart({
      argv: ['electron', '.'],
      env: { SHOP_CRANK_DESKTOP_URL: 'https://shopcrank-dispatch.pages.dev' },
    });
    assert.equal(result.useLocalAssets, false);
    assert.equal(result.remoteUrl, 'https://shopcrank-dispatch.pages.dev/');
  });
});
