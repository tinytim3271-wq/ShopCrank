import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRINT_BASE_CSS, modalOffersPrint, withPrintBaseStyles } from './record-print.js';

test('print base styles set 12pt body text', () => {
  assert.match(PRINT_BASE_CSS, /^@media print\{html,body\{font-size:12pt!important/);
});

test('inspection damage-zone state remains visible when printing records', () => {
  const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
  assert.match(styles, /:is\(button:not\(\.damage-zone\),\.modal-actions/);
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

test('record print styles retain state-bearing damage-zone buttons', () => {
  const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
  assert.match(css, /button:not\(\.damage-zone\)/);
});

test('record print labels use a dark color in print mode', () => {
  const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
  assert.match(css, /body\.printing-record #modal-root \.modal label\{color:#111!important\}/);
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
