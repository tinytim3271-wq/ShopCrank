import test from 'node:test';
import assert from 'node:assert/strict';
import { autozoneProLoginUrl, orderingPanelHtml } from './autozone-pro.js';

const html = {
  escapeHtml: (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  icon: () => '',
};

test('AutoZone Pro login returns to a keyword search', () => {
  const url = new URL(autozoneProLoginUrl('canister purge valve pump'));
  assert.equal(url.origin, 'https://www.autozonepro.com');
  assert.equal(url.pathname, '/ui/login');
  assert.equal(url.searchParams.get('originalURL'), '/ui/product-results?searchKeyword=canister+purge+valve+pump');
});

test('a blank search opens the AutoZone Pro catalog sign-in', () => {
  const url = new URL(autozoneProLoginUrl('   '));
  assert.equal(url.searchParams.get('originalURL'), '/ui/product-results');
});

test('the ordering panel shows the username and keeps the password out of the page', () => {
  const panel = orderingPanelHtml(
    { connected: true, username: 'shop<script>' },
    { canSave: true, ...html },
  );
  assert.match(panel, /shop&lt;script&gt;/);
  assert.doesNotMatch(panel, /type="password"[^>]*value=/);
  assert.match(panel, /Search on AutoZone Pro/);
});

test('the panel never offers to copy or paste the saved password', () => {
  for (const canSave of [true, false]) {
    const panel = orderingPanelHtml({ connected: true, username: 'counter', password: 'leaked-secret' }, { canSave, ...html });
    assert.doesNotMatch(panel, /leaked-secret/);
    assert.doesNotMatch(panel, /paste the saved password|copy the AutoZone Pro login|Password copied/i);
  }
});
