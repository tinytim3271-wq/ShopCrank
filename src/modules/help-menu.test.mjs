import test from 'node:test';
import assert from 'node:assert/strict';
import {
  helpCanJump,
  helpContext,
  helpSearch,
  resetHelpUi,
  syncHelp,
  getHelpUi,
} from './help-menu.js';

test('phone-order snapshot resolves to the phone section and names the work order', () => {
  const topic = helpContext({
    route: 'pos',
    role: 'office',
    subview: 'phone',
    selectionLabel: 'RO-1040 · Ada · F-150',
  });
  assert.equal(topic.id, 'pos-phone');
  assert.match(topic.title, /Phone order/i);
  assert.match(topic.summary, /RO-1040 · Ada · F-150/);
  assert.match(topic.summary, /Stripe/i);
  assert.ok(topic.limits.some((line) => /Never paste a card number into a MechPro/i.test(line)));
});

test('office search for payroll returns nothing; admin and technician search return payroll', () => {
  assert.equal(helpSearch('payroll', 'office').length, 0);
  assert.equal(helpSearch('payroll', 'technician').some((item) => item.id === 'payroll'), true);
  assert.equal(helpSearch('payroll', 'admin').some((item) => item.id === 'payroll'), true);
});

test('jump action is omitted when the role cannot open that route', () => {
  const payroll = helpSearch('payroll', 'admin')[0];
  assert.equal(helpCanJump(payroll, 'admin'), true);
  assert.equal(helpCanJump(payroll, 'office'), false);
  assert.equal(helpSearch('', 'technician').some((item) => item.id === 'invoices'), false);
  assert.equal(helpSearch('', 'technician').some((item) => item.id === 'pos' || item.id === 'pos-phone'), false);
  const invoices = helpSearch('', 'admin').find((item) => item.id === 'invoices');
  assert.equal(helpCanJump(invoices, 'technician'), false);
});

test('syncHelp leaves the panel open after the route changes', () => {
  resetHelpUi();
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  // Minimal document stub for syncHelp
  const realDocument = globalThis.document;
  const listeners = [];
  globalThis.document = {
    querySelector(selector) {
      if (selector === '#help-root') return host;
      if (selector === '#help-panel') return host._panel || null;
      if (selector === '#help-open') return host._open || null;
      if (selector === '#help-search-input') return host._search || null;
      return null;
    },
    addEventListener(type, handler) {
      listeners.push([type, handler]);
    },
  };
  host.querySelector = (selector) => {
    if (selector === '#help-open') return host._open;
    if (selector === '#help-close') return host._close;
    if (selector === '#help-panel') return host._panel;
    if (selector === '#help-search-input') return host._search;
    return null;
  };
  host.querySelectorAll = () => [];
  Object.defineProperty(host, 'innerHTML', {
    set(value) {
      host._html = value;
      host._open = {
        addEventListener(type, fn) {
          if (type === 'click') host._openClick = fn;
        },
        setAttribute() {},
        focus() {},
      };
      host._close = {
        addEventListener(type, fn) {
          if (type === 'click') host._closeClick = fn;
        },
      };
      host._panel = { hidden: !getHelpUi().open };
      host._search = {
        addEventListener() {},
        focus() {},
        value: getHelpUi().query,
      };
    },
    get() {
      return host._html || '';
    },
  });

  syncHelp({ route: 'home', role: 'admin', subview: '', selectionLabel: '' });
  getHelpUi().open = true;
  syncHelp({ route: 'pos', role: 'admin', subview: 'phone', selectionLabel: 'RO-1' });
  assert.equal(getHelpUi().open, true);
  assert.match(host.innerHTML, /Phone order/);

  globalThis.document = realDocument;
  resetHelpUi();
});

test('topic text has no seed-key procedure and does not tell the reader to type a card into MechPro', () => {
  const keys = helpContext({ route: 'keys', role: 'technician' });
  const blob = `${keys.summary} ${keys.steps.join(' ')} ${keys.limits.join(' ')}`;
  assert.match(keys.limits.join(' '), /does not provide seed-key bypass/i);
  assert.equal(/enter the seed|calculate the key|derive the key|clone the immobilizer/i.test(blob), false);

  const phone = helpContext({ route: 'pos', role: 'office', subview: 'phone' });
  const phoneBlob = `${phone.summary} ${phone.steps.join(' ')} ${phone.limits.join(' ')}`;
  assert.match(phoneBlob, /Stripe/i);
  assert.equal(/type the card (number )?into mechpro/i.test(phoneBlob), false);
  assert.match(phoneBlob, /Never paste a card number into a MechPro/i);
});
