import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsExtraPanels } from './settings-panels.js';

const deps = {
  icon: name => `<i data-lucide="${name}"></i>`,
  escapeHtml: value => String(value).replace(/</g, '&lt;'),
  archiveNote: 'Kept for <tax>',
  phoneUsagePanel: () => '<section id="phone-usage"></section>',
  twilioPanel: '',
  apiUrl: '/api',
  shopId: 'shop-1',
};
const ids = html => [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);

test('an admin sees every panel in page order', () => {
  const html = settingsExtraPanels({ role: 'admin', canDeleteRecords: true, offline: false }, deps);
  assert.deepEqual(ids(html), ['open-full-reset', 'open-archived-records', 'phone-usage', 'agentphone-config-form', 'upgrade-shop-plan']);
  assert.match(html, /\/api\/agentphone\/webhook\/shop-1/);
  assert.match(html, /Kept for &lt;tax>/, 'the archive note is escaped');
});

test('a service writer sees only phone usage; an owner also sees archived records', () => {
  assert.deepEqual(ids(settingsExtraPanels({ role: 'service_writer', canDeleteRecords: false }, deps)), ['phone-usage']);
  assert.deepEqual(ids(settingsExtraPanels({ role: 'owner', canDeleteRecords: true }, deps)), ['open-archived-records', 'phone-usage']);
});

test('the offline desktop hides archived records; a Twilio panel shows for non-admins too', () => {
  assert.ok(!ids(settingsExtraPanels({ role: 'owner', canDeleteRecords: true, offline: true }, deps)).includes('open-archived-records'));
  const html = settingsExtraPanels({ role: 'office' }, { ...deps, twilioPanel: '<section id="twilio-panel"></section>' });
  assert.deepEqual(ids(html), ['phone-usage', 'twilio-panel']);
});
