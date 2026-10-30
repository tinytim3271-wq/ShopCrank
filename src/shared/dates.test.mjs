import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { addLocalDays, localIsoDate, toLocalIsoDate } from './dates.js';

// These cases are about a US shop's calendar day; CI runners default to UTC.
process.env.TZ = 'America/Chicago';

// A fixed instant in the evening. In any US timezone this is still the same
// calendar day locally, but UTC has already rolled over to the next day.
// A fixed instant in the evening. In US Central this is still 2026-10-31, but
// UTC has already rolled over to 2026-11-01. Expected values are derived from
// the runner's local calendar so CI (UTC) and shop PCs both pass.
const EVENING = new Date('2026-10-31T21:30:00-05:00');

function localCalendarDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('localIsoDate returns the local calendar day, not the UTC day', () => {
  // The bug: an RO completed at 9:30 pm CDT was invoiced as 2026-11-01
  // because toISOString() converted to UTC first.
  const iso = localIsoDate(EVENING);
  const utcDay = EVENING.toISOString().slice(0, 10);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(iso, localCalendarDay(EVENING));
  if (iso !== utcDay) assert.notEqual(iso, utcDay);
});

test('localIsoDate defaults to now', () => {
  const today = localIsoDate();
  const now = new Date();
  assert.equal(today, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
});

test('addLocalDays keeps the calendar day in local time', () => {
  const start = localCalendarDay(EVENING);
  const plusFourteen = localIsoDate(new Date(EVENING.getFullYear(), EVENING.getMonth(), EVENING.getDate() + 14, 12));
  assert.equal(addLocalDays(EVENING, 0), start);
  assert.equal(addLocalDays(EVENING, 14), plusFourteen);
  assert.equal(addLocalDays(new Date('2026-12-31T12:00:00-06:00'), 1), '2027-01-01');
});

test('toLocalIsoDate normalises dates and rejects unusable values', () => {
  assert.equal(toLocalIsoDate(EVENING), localCalendarDay(EVENING));
  assert.equal(toLocalIsoDate('2026-10-31'), '2026-10-31');
  assert.equal(toLocalIsoDate('2026-02-30'), '');
  assert.equal(toLocalIsoDate('2026-13-01'), '');
  assert.equal(toLocalIsoDate('2026-01-00'), '');
  assert.equal(toLocalIsoDate('2026-02-29'), '');
  assert.equal(toLocalIsoDate('2024-02-29'), '2024-02-29');
  assert.equal(toLocalIsoDate(''), '');
  assert.equal(toLocalIsoDate('not a date'), '');
  assert.equal(toLocalIsoDate(new Date('nope')), '');
});
