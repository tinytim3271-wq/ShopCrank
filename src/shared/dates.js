/**
 * Calendar-date helpers.
 *
 * A shop's invoice date is a *calendar* day, not an instant. Building it with
 * `toISOString()` converts to UTC first, so an RO completed after 7 pm CDT
 * (6 pm CST) lands on tomorrow's date — and on the last day of a month or
 * quarter the sale is booked into the wrong sales-tax period.
 *
 * These helpers read the date in the machine's local time, which is the shop's
 * day, and keep every date-only value free of timezone drift.
 */

/** The local calendar day of `date` as YYYY-MM-DD. */
export function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The local calendar day `days` after `date`. Uses local arithmetic so a day
 * boundary crossed in either direction stays on the intended calendar day.
 *
 * `new Date(y, m, d + n)` re-normalises through the local calendar, which is
 * what we want, but it can land on the previous day when the target falls in a
 * daylight-saving gap. Setting the day of month on a midday anchor avoids
 * that: noon is never skipped by a DST change.
 */
export function addLocalDays(date, days) {
  const anchor = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  anchor.setDate(anchor.getDate() + Number(days || 0));
  return localIsoDate(anchor);
}

/**
 * Normalises any date-ish value to a local calendar day as YYYY-MM-DD.
 * Returns '' for values that are not a usable date.
 *
 * A bare YYYY-MM-DD string is a calendar day, not an instant, so it is read
 * as local midnight rather than UTC midnight — otherwise "2026-10-31" would
 * come back as 2026-10-30 in any timezone west of UTC.
 */
export function toLocalIsoDate(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? '' : localIsoDate(value);
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (Number.isNaN(parsed.valueOf())) return '';
    if (localIsoDate(parsed) !== text) return '';
    return localIsoDate(parsed);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? '' : localIsoDate(parsed);
}
