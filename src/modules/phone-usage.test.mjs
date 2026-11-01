import test from 'node:test';
import assert from 'node:assert/strict';
import { capCentsFromInput, phoneUsagePanelHtml, phoneUsageStatus } from './phone-usage.js';

const base = { planName: 'Shop', includedMinutes: 800, overageRateCents: 12, active: true, periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', calls: 1, overageCapCents: null, capReached: false };

test('status explains included, nearly used, overage, capped and no-plan states', () => {
  assert.equal(phoneUsageStatus({ ...base, usedMinutes: 100 }).text, '700 included minutes left this period.');
  assert.match(phoneUsageStatus({ ...base, usedMinutes: 700 }).text, /^100 included minutes left\. Extra minutes bill at 12¢\/min\.$/);
  assert.equal(phoneUsageStatus({ ...base, usedMinutes: 810, overageChargeCents: 120 }).text, '10 minutes over the plan, billed at 12¢/min: $1.20 so far.');
  assert.equal(phoneUsageStatus({ ...base, usedMinutes: 810, overageCapCents: 100, capReached: true }).text, 'Spending cap of $1.00 reached: calls ring the shop until Dec 1.');
  assert.match(phoneUsageStatus({ ...base, active: false }).text, /No active plan/);
});

test('panel shows usage, a meter capped at 100%, singular call count, and the cap form only for owners', () => {
  const html = phoneUsagePanelHtml({ ...base, usedMinutes: 810, overageChargeCents: 120 }, { canEdit: true });
  assert.match(html, /810 of 800 minutes used/);
  assert.match(html, /1 call ·/);
  assert.match(html, /style="width:100%"/);
  assert.match(html, /id="phone-usage-cap-form"/);
  assert.doesNotMatch(phoneUsagePanelHtml({ ...base, usedMinutes: 0 }, { canEdit: false }), /phone-usage-cap-form/);
  assert.match(phoneUsagePanelHtml(null), /Loading usage/);
});

test('cap input: blank is no cap, dollars become cents, negatives are refused', () => {
  assert.equal(capCentsFromInput(''), null);
  assert.equal(capCentsFromInput('25'), 2500);
  assert.equal(capCentsFromInput('0'), 0);
  assert.equal(capCentsFromInput('12.345'), 1235);
  assert.throws(() => capCentsFromInput('-1'), /\$0 or more/);
});
