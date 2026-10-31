import test from 'node:test';
import assert from 'node:assert/strict';
import { PRINT_BASE_CSS, modalOffersPrint, withPrintBaseStyles } from './record-print.js';

test('print base styles set 12pt body text', () => {
  assert.match(PRINT_BASE_CSS, /^@media print\{html,body\{font-size:12pt!important/);
});

test('withPrintBaseStyles injects into the head and keeps the doctype first', () => {
  const withHead = withPrintBaseStyles('<!DOCTYPE html><html><head><title>x</title></head><body></body></html>');
  assert.match(withHead, /^<!DOCTYPE html><html><head><title>x<\/title><style data-print-base>/);
  const noHead = withPrintBaseStyles('<!DOCTYPE html><html lang="en"><body></body></html>');
  assert.match(noHead, /^<!DOCTYPE html><html lang="en"><head><style data-print-base>/);
  const doctypeOnly = withPrintBaseStyles('<!doctype html><p>x</p>');
  assert.match(doctypeOnly, /^<!doctype html><style data-print-base>/);
  assert.equal(withPrintBaseStyles(withHead), withHead);
});

function fakeModal({ matches = false, head = true, body = true } = {}) {
  return {
    matches: () => matches,
    querySelector: selector => (selector === '.modal-head' ? head : selector === '.modal-body' ? body : null) || null,
  };
}

test('form and record modals offer print; tools and destructive confirms do not', () => {
  assert.equal(modalOffersPrint(fakeModal()), true);
  assert.equal(modalOffersPrint(fakeModal({ matches: true })), false);
  assert.equal(modalOffersPrint(fakeModal({ body: false })), false);
  assert.equal(modalOffersPrint(null), false);
});
