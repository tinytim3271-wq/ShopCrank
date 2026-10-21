import test from 'node:test';
import assert from 'node:assert/strict';
import { addLocalDays, localIsoDate, toLocalIsoDate } from './dates.js';

// A fixed instant in the evening. In any US timezone this is still the same
// calendar day locally, but UTC has already rolled over to the next day.
const EVENING = new Date('2026-10-31T21:30:00-05:00');

test('localIsoDate returns the local calendar day, not the UTC day', () => {
  // The bug: an RO completed at 9:30 pm CDT was invoiced as 2026-11-01
  // because toISOString() converted to UTC first.
  const iso = localIsoDate(EVENING);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(iso, '2026-10-31');
  assert.notEqual(iso, EVENING.toISOString().slice(0, 10));
});

test('localIsoDate defaults to now', () => {
  const today = localIsoDate();
  const now = new Date();
  assert.equal(today, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
});

test('addLocalDays keeps the calendar day in local time', () => {
  assert.equal(addLocalDays(EVENING, 14), '2026-11-14');
  assert.equal(addLocalDays(EVENING, 0), '2026-10-31');
  assert.equal(addLocalDays(new Date('2026-12-31T12:00:00-06:00'), 1), '2027-01-01');
});

test('toLocalIsoDate normalises dates and rejects unusable values', () => {
  assert.equal(toLocalIsoDate(EVENING), '2026-10-31');
  assert.equal(toLocalIsoDate('2026-10-31'), '2026-10-31');
  assert.equal(toLocalIsoDate(''), '');
  assert.equal(toLocalIsoDate('not a date'), '');
  assert.equal(toLocalIsoDate(new Date('nope')), '');
});
