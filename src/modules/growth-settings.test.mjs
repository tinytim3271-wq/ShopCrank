import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingUrl, growthSettingsHtml, growthSettingsRecords } from './growth-settings.js';

test('booking link is the public Worker page for the shop', () => {
  assert.equal(bookingUrl('https://www.shopcrank.com/', 'shop-abc123'), 'https://www.shopcrank.com/api/book/shop-abc123');
  assert.equal(bookingUrl('https://x', ''), '');
});

test('form values become booking and follow-up settings with safe bounds', () => {
  const { booking, followups } = growthSettingsRecords({
    bookingEnabled: 'on', bookingHours: 'Mon-Fri 8-5', bookingCapacity: '99', bookingLeadMinutes: '-5',
    bookingServices: 'Oil change, Brakes, , Tires', reviewEnabled: 'on', googleReviewUrl: 'https://g.page/r/x/review',
  }, { followups: { reviewRequests: { delayHours: 4 } } });
  assert.deepEqual(booking, { id: 'booking', enabled: true, hours: 'Mon-Fri 8-5', capacity: 20, leadMinutes: 0, services: ['Oil change', 'Brakes', 'Tires'] });
  assert.equal(followups.reviewRequests.enabled, true);
  assert.equal(followups.reviewRequests.delayHours, 4, 'keeps stored values the form does not show');
  assert.equal(followups.serviceReminders.autoSend, false, 'unchecked box turns reminders off');
});

test('panel shows the booking link and is read-only for non-admins', () => {
  const admin = growthSettingsHtml({ shopId: 'shop-abc123', origin: 'https://www.shopcrank.com', canSave: true });
  assert.match(admin, /value="https:\/\/www\.shopcrank\.com\/api\/book\/shop-abc123"/);
  assert.match(admin, /id="growth-run-now"/);
  assert.doesNotMatch(admin, /name="(name|title|method|body|role)"/);
  const staff = growthSettingsHtml({ shopId: 'shop-abc123', origin: 'https://www.shopcrank.com', canSave: false });
  assert.match(staff, /disabled/);
  assert.doesNotMatch(staff, /id="growth-run-now"/);
});
