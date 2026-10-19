import test from 'node:test';
import assert from 'node:assert/strict';
import {
  revenueRecognitionPanelHtml,
  revrecReady,
  revrecStatusLabel,
} from './revenue-recognition.js';

test('revrec status helpers reflect readiness', () => {
  assert.equal(revrecReady({ stripeConfigured: true, s3Configured: true }), true);
  assert.equal(revrecReady({ stripeConfigured: true, s3Configured: false }), false);
  assert.match(revrecStatusLabel({ enabled: true, stripeConfigured: true, s3Configured: true }), /enabled/i);
  assert.match(revrecStatusLabel({ stripeConfigured: false }), /Connect shop Stripe/i);
});

test('panel markup includes configure and export controls for admins', () => {
  const html = revenueRecognitionPanelHtml({
    enabled: false,
    currency: 'usd',
    stripeConfigured: true,
    s3Configured: true,
    shopId: 'demo-shop',
    folderHint: 'revrec/demo-shop/general/',
  }, {
    canSave: true,
    escapeHtml: value => String(value ?? ''),
    icon: () => '',
  });
  assert.match(html, /revrec-config-form/);
  assert.match(html, /revrec-export-now/);
  assert.match(html, /revrec-download-csv/);
  assert.match(html, /revrec\/demo-shop\/general\//);
});
