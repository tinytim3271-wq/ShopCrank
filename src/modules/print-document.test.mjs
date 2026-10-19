import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openPrintDocument } from './print-document.js';

function fakePrintWindow(readyState = 'complete') {
  const calls = [];
  const buttons = [];
  const win = {
    opener: { name: 'parent' },
    closed: false,
    document: {
      readyState,
      open() { calls.push('doc-open'); },
      write(html) { calls.push(['write', html]); },
      close() { calls.push('doc-close'); },
      querySelectorAll() { return buttons; },
    },
    focus() { calls.push('focus'); },
    print() { calls.push('print'); },
    close() { calls.push('win-close'); this.closed = true; },
    addEventListener(type, listener) { calls.push(['listen', type]); listener(); },
  };
  return { win, calls };
}

describe('openPrintDocument', () => {
  it('writes the invoice into a window opened without noopener and prints it', () => {
    const { win, calls } = fakePrintWindow();
    const opened = [];
    const windowObject = {
      open(url, target, features) {
        opened.push({ url, target, features });
        return win;
      },
    };
    const html = '<!DOCTYPE html><html><body><h1>INV-2041</h1></body></html>';
    const ok = openPrintDocument(html, {
      windowObject,
      autoPrint: true,
      schedule: fn => fn(),
    });
    assert.equal(ok, true);
    assert.deepEqual(opened, [{ url: '', target: '_blank', features: undefined }]);
    assert.equal(win.opener, null);
    assert.deepEqual(calls.filter(call => Array.isArray(call) && call[0] === 'write'), [['write', html]]);
    assert.ok(calls.includes('print'));
  });

  it('loads the invoice from a blob URL instead of a blank tab', () => {
    const { win, calls } = fakePrintWindow('loading');
    const opened = [];
    const windowObject = {
      Blob: class InvoiceBlob {
        constructor(parts, options) {
          this.parts = parts;
          this.options = options;
        }
      },
      URL: {
        createObjectURL(blob) {
          assert.match(blob.parts[0], /INV-2041/);
          assert.equal(blob.options.type, 'text/html');
          return 'blob:invoice';
        },
        revokeObjectURL() {},
      },
      open(url, target, features) {
        opened.push({ url, target, features });
        return win;
      },
    };
    const ok = openPrintDocument('<h1>INV-2041</h1>', {
      windowObject,
      schedule: fn => fn(),
    });
    assert.equal(ok, true);
    assert.deepEqual(opened, [{ url: 'blob:invoice', target: '_blank', features: undefined }]);
    assert.ok(calls.includes('print'));
  });

  it('does not open a second blank tab when the invoice window is blocked', () => {
    const { win, calls } = fakePrintWindow();
    const opened = [];
    const frame = {
      style: {},
      isConnected: true,
      contentDocument: win.document,
      contentWindow: win,
      remove() {},
      setAttribute() {},
    };
    const windowObject = {
      Blob: class InvoiceBlob {},
      URL: {
        createObjectURL() { return 'blob:invoice'; },
        revokeObjectURL() {},
      },
      open(url) {
        opened.push(url);
        return null;
      },
      document: {
        body: { appendChild() {} },
        createElement() { return frame; },
      },
    };
    const ok = openPrintDocument('<p>INV-2041</p>', { windowObject, schedule: fn => fn() });
    assert.equal(ok, true);
    assert.deepEqual(opened, ['blob:invoice']);
    assert.ok(calls.includes('print'));
  });

  it('prints from a hidden frame when the popup is blocked', () => {
    const { win, calls } = fakePrintWindow();
    const frame = {
      style: {},
      isConnected: true,
      contentDocument: win.document,
      contentWindow: win,
      remove() { calls.push('frame-remove'); },
      setAttribute() {},
    };
    const windowObject = {
      open() { return null; },
      document: {
        body: { appendChild() { calls.push('append-frame'); } },
        createElement() { return frame; },
      },
    };
    const ok = openPrintDocument('<p>Invoice</p>', {
      windowObject,
      toast() { calls.push('toast'); },
      schedule: fn => fn(),
    });
    assert.equal(ok, true);
    assert.ok(calls.includes('append-frame'));
    assert.ok(calls.includes('print'));
    assert.equal(calls.includes('toast'), false);
  });
});
