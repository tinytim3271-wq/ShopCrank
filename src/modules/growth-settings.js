/**
 * Settings panel for online booking, automatic service reminders, and Google
 * review requests (all included on every plan). Records are saved as
 * shopsettings/booking and shopsettings/followups.
 */

function text(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

export function bookingUrl(origin, shopId) {
  return shopId ? `${String(origin || '').replace(/\/$/, '')}/api/book/${encodeURIComponent(shopId)}` : '';
}

export function growthSettingsHtml({ booking = {}, followups = {}, shopId = '', origin = '', canSave = false }, { escapeHtml = value => String(value ?? ''), escapeAttr = escapeHtml, icon = () => '' } = {}) {
  const review = followups.reviewRequests || {};
  const reminders = followups.serviceReminders || {};
  const link = bookingUrl(origin, shopId);
  const disabled = canSave ? '' : 'disabled';
  const checked = value => (value !== false ? 'checked' : '');
  return `<section class="settings-panel growth-settings"><div class="statement-head"><div><div class="eyebrow">Included on every plan</div><h2>Online booking, reminders &amp; reviews</h2><p>Customers book on your calendar, get service reminders by text, and are asked for a Google review after they pay.</p></div>${icon('calendar-check', 20)}</div>
  <form id="growth-settings-form" class="form-grid">
    <label class="toggle-field full"><input type="checkbox" name="bookingEnabled" ${checked(booking.enabled)} ${disabled}/><span>Online booking page is on</span></label>
    ${link ? `<label class="full">Booking link (put it on your website and Google profile)<input id="booking-link" readonly value="${escapeAttr(link)}"/></label>` : ''}
    <label class="full">Booking hours<input name="bookingHours" maxlength="300" placeholder="Monday–Friday 8:00 AM – 5:30 PM; Saturday 9 AM – 1 PM" value="${escapeAttr(booking.hours || '')}" ${disabled}/></label>
    <label>Appointments per time slot<input name="bookingCapacity" type="number" min="1" max="20" value="${escapeAttr(booking.capacity || 2)}" ${disabled}/></label>
    <label>Minimum notice (minutes)<input name="bookingLeadMinutes" type="number" min="0" max="10080" value="${escapeAttr(booking.leadMinutes ?? 60)}" ${disabled}/></label>
    <label class="full">Services customers can pick (comma separated)<input name="bookingServices" maxlength="1000" value="${escapeAttr((booking.services || []).join(', '))}" placeholder="Oil change, Brakes, Check engine light, Tires" ${disabled}/></label>
    <label class="toggle-field full"><input type="checkbox" name="reviewEnabled" ${checked(review.enabled)} ${disabled}/><span>Text a Google review request after an invoice is paid</span></label>
    <label class="full">Google review link or Place ID<input name="googleReviewUrl" maxlength="500" placeholder="https://g.page/r/…/review or ChIJ…" value="${escapeAttr(review.googleReviewUrl || '')}" ${disabled}/></label>
    <label class="toggle-field full"><input type="checkbox" name="remindersAutoSend" ${checked(reminders.autoSend)} ${disabled}/><span>Create service reminders from completed work and text them when due</span></label>
    ${canSave ? `<div class="full"><button class="primary" type="submit">${icon('save', 14)} Save</button> <button class="secondary" type="button" id="growth-run-now">${icon('send', 14)} Send due follow-ups now</button>${link ? ` <button class="secondary" type="button" id="booking-link-copy">${icon('copy', 14)} Copy booking link</button>` : ''}</div>` : '<p class="ops-note full">Ask an owner or admin to change these settings.</p>'}
  </form></section>`;
}

/** Form values → the two settings records, merged over what is stored. */
export function growthSettingsRecords(values = {}, current = {}) {
  const services = text(values.bookingServices, 1000).split(',').map(item => text(item, 80)).filter(Boolean).slice(0, 30);
  const capacity = Math.min(20, Math.max(1, Math.round(Number(values.bookingCapacity) || 2)));
  const leadMinutes = Math.min(10080, Math.max(0, Math.round(Number(values.bookingLeadMinutes) || 0)));
  const booking = {
    ...(current.booking || {}),
    id: 'booking',
    enabled: values.bookingEnabled === 'on',
    hours: text(values.bookingHours, 300),
    capacity,
    leadMinutes,
    services,
  };
  const followups = {
    ...(current.followups || {}),
    id: 'followups',
    reviewRequests: { ...(current.followups?.reviewRequests || {}), enabled: values.reviewEnabled === 'on', googleReviewUrl: text(values.googleReviewUrl, 500) },
    serviceReminders: { ...(current.followups?.serviceReminders || {}), enabled: true, autoCreate: values.remindersAutoSend === 'on', autoSend: values.remindersAutoSend === 'on' },
  };
  return { booking, followups };
}
