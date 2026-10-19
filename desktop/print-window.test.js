'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPrintPopupUrl } = require('./print-window');

describe('isPrintPopupUrl', () => {
  it('allows the blank document invoice printing writes into', () => {
    assert.equal(isPrintPopupUrl(''), true);
    assert.equal(isPrintPopupUrl('about:blank'), true);
    assert.equal(isPrintPopupUrl('blob:https://www.shopcrank.com/1234'), true);
  });

  it('keeps external links out of the app window', () => {
    assert.equal(isPrintPopupUrl('https://www.shopcrank.com/'), false);
    assert.equal(isPrintPopupUrl('https://example.com/invoice'), false);
  });
});
