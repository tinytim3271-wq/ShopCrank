'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('diagnostics-bridge module load', () => {
  it('loads without throwing (no stray top-level identifiers)', () => {
    // desktop/main.js requires this at startup; a ReferenceError here crashes Electron.
    const bridge = require('./diagnostics-bridge');
    assert.equal(typeof bridge.listAdapters, 'function');
    assert.equal(typeof bridge.connect, 'function');
    assert.equal(typeof bridge.autoDetectAndConnect, 'function');
  });
});
