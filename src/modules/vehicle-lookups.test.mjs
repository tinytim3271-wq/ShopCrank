import test from 'node:test';
import assert from 'node:assert/strict';
import { plateLookupFill, plateLookupHtml, serviceHistoryHtml } from './vehicle-lookups.js';

test('plate lookup fills only empty vehicle fields', () => {
  assert.deepEqual(plateLookupFill({ vin: '1FTFW1E50NFA00001', year: '2022', make: 'FORD', model: 'F-150' }, { make: 'Ford', model: '' }), { vin: '1FTFW1E50NFA00001', year: '2022', model: 'F-150' });
});

test('controls use sanitizer-safe names and history renders escaped rows', () => {
  assert.match(plateLookupHtml(), /<option selected>TX<\/option>/);
  assert.doesNotMatch(plateLookupHtml(), /name="(name|title|method|body|role)"/);
  const html = serviceHistoryHtml({ found: true, records: [{ date: '2025-03-01', odometer: 41234, description: '<b>Oil</b> changed', source: 'Quick Lube' }] }, { escapeHtml: value => String(value).replace(/</g, '&lt;') });
  assert.match(html, /41,234/);
  assert.match(html, /&lt;b>Oil/);
  assert.match(serviceHistoryHtml({ found: false }), /no service records/);
});
