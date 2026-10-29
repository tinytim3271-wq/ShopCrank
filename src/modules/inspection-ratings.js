/**
 * Red / yellow / green inspection ratings, finding media, and declined-work
 * follow-up. Ratings map the existing DVI statuses so older inspections keep
 * their meaning:
 *   critical / fail → red (needs attention now), soon / monitor / attention → yellow,
 *   ok → green, skipped / blank → unrated.
 */

export const RATINGS = Object.freeze({
  red: { id: 'red', label: 'Needs attention now', short: 'Red' },
  yellow: { id: 'yellow', label: 'Needs attention soon', short: 'Yellow' },
  green: { id: 'green', label: 'Good', short: 'Green' },
});

const STATUS_RATING = Object.freeze({
  critical: 'red', fail: 'red', failed: 'red', red: 'red',
  soon: 'yellow', monitor: 'yellow', attention: 'yellow', yellow: 'yellow',
  ok: 'green', pass: 'green', good: 'green', green: 'green',
});

export function ratingForStatus(status) {
  return STATUS_RATING[String(status || '').trim().toLowerCase()] || null;
}

export function ratingSummary(items = []) {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const item of items) {
    const rating = ratingForStatus(item?.status ?? item?.inspectionStatus);
    if (rating) counts[rating] += 1;
  }
  return counts;
}

export function ratingChipHtml(status, escapeHtml = value => String(value ?? '')) {
  const rating = ratingForStatus(status);
  if (!rating) return '';
  return `<span class="rating-chip rating-${rating}" title="${escapeHtml(RATINGS[rating].label)}">${escapeHtml(RATINGS[rating].short)}</span>`;
}

// Uploaded videos are keyed shops/<shop>/inspection-video/<uuid> with no extension.
const VIDEO_KEY = /\.(mp4|webm|mov)$|(^|\/)[a-z-]*video\//i;

/** Photo and video keys attached to an estimate line or inspection item. */
export function mediaKeys(record = {}) {
  const keys = [...(record.photoKeys || []), ...(record.videoKeys || []), ...(record.mediaKeys || [])];
  return [...new Set(keys.map(key => String(key || '').trim()).filter(Boolean))];
}

export function isVideoMedia(key, contentType = '') {
  return /^video\//i.test(contentType) || VIDEO_KEY.test(String(key || ''));
}

/** Upload kind used for R2 keys so the media type can be inferred from the key later. */
export function inspectionUploadKind(file) {
  return /^video\//i.test(String(file?.type || '')) ? 'inspection-video' : 'inspection';
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const FOLLOW_UP_DAYS = Object.freeze({ red: 3, yellow: 30, default: 30 });

/**
 * Every estimate line a customer declined, newest first, with when the shop
 * should follow up. Red findings come due quickly; everything else in 30 days.
 */
export function declinedWorkItems(orders = [], { now = Date.now() } = {}) {
  const items = [];
  for (const order of orders) {
    const approval = order?.estimateApproval;
    if (!approval || !['approved', 'declined'].includes(approval.status)) continue;
    const decisions = approval.decisions || {};
    const declinedAt = approval.respondedAt || approval.approvedAt || approval.signedAt || order.linesLockedAt || '';
    const lines = order.estimate?.lines || [];
    lines.forEach((line, index) => {
      const id = String(line.id || `line-${index + 1}`);
      const declined = decisions[id] === 'declined' || line.approvalStatus === 'declined';
      if (!declined) return;
      const rating = ratingForStatus(line.inspectionStatus) || null;
      const followUp = order.declinedFollowUps?.[id] || null;
      const days = FOLLOW_UP_DAYS[rating] || FOLLOW_UP_DAYS.default;
      const base = Date.parse(declinedAt);
      const dueAt = Number.isFinite(base) ? new Date(base + days * DAY_MS).toISOString() : '';
      const amount = Number(line.originalTotal ?? line.declinedTotal ?? line.total ?? 0) || Number(line.hours || 0) * Number(line.laborRate || 0) || Number(line.quantity || 0) * Number(line.unitPrice || 0);
      items.push({
        key: `${order.id}:${id}`,
        orderId: order.id,
        lineId: id,
        customer: order.customer || '',
        customerId: order.customerId || '',
        phone: order.phone || '',
        vehicle: order.vehicle || '',
        vin: order.vin || '',
        description: String(line.description || line.service || 'Declined work'),
        amount: Math.round(amount * 100) / 100,
        rating,
        declinedAt,
        dueAt,
        due: Boolean(dueAt) && Date.parse(dueAt) <= now && !followUp?.completedAt,
        followUp,
        status: followUp?.completedAt ? 'sold' : followUp?.lastContactAt ? 'contacted' : 'open',
      });
    });
  }
  return items.sort((a, b) => String(b.declinedAt).localeCompare(String(a.declinedAt)));
}

export function declinedWorkSummary(items = []) {
  const open = items.filter(item => item.status !== 'sold');
  return {
    openCount: open.length,
    openValue: Math.round(open.reduce((total, item) => total + item.amount, 0) * 100) / 100,
    dueCount: open.filter(item => item.due).length,
    redCount: open.filter(item => item.rating === 'red').length,
  };
}

export function declinedFollowUpMessage(item, shopName) {
  const vehicle = item.vehicle ? ` on your ${item.vehicle}` : '';
  const urgency = item.rating === 'red' ? ' Our technician flagged it as needing attention now.' : '';
  return `Hi ${String(item.customer || '').split(' ')[0] || 'there'}, this is ${shopName}. During your last visit we recommended ${item.description}${vehicle}.${urgency} Reply to this text to schedule it, or call us with any questions.`;
}

/** Record a follow-up on the order so declined work can be tracked to a sale. */
export function recordDeclinedFollowUp(order, lineId, { contacted = false, sold = false, by = '', at = new Date().toISOString(), note = '' } = {}) {
  const current = order.declinedFollowUps?.[lineId] || { contacts: [] };
  const next = { ...current, contacts: [...(current.contacts || [])] };
  if (contacted) {
    next.lastContactAt = at;
    next.contacts.push({ at, by, note: String(note || '').slice(0, 300) });
  }
  if (sold) next.completedAt = at;
  return { ...order, declinedFollowUps: { ...(order.declinedFollowUps || {}), [lineId]: next } };
}

export function declinedWorkHtml(items = [], { escapeHtml = value => String(value ?? ''), escapeAttr = escapeHtml, money = value => `$${Number(value || 0).toFixed(2)}`, icon = () => '', date = value => String(value || '').slice(0, 10) } = {}) {
  const summary = declinedWorkSummary(items);
  const rows = items.map(item => `<tr class="${item.due ? 'due' : ''}"><td>${ratingChipHtml(item.rating, escapeHtml) || '—'}</td><td><b>${escapeHtml(item.description)}</b><small>${escapeHtml(item.orderId)}</small></td><td>${escapeHtml(item.customer)}<small>${escapeHtml(item.vehicle)}</small></td><td>${money(item.amount)}</td><td>${escapeHtml(date(item.declinedAt))}</td><td>${item.status === 'sold' ? 'Sold' : item.due ? `<b>Due ${escapeHtml(date(item.dueAt))}</b>` : escapeHtml(date(item.dueAt))}${item.followUp?.lastContactAt ? `<small>Contacted ${escapeHtml(date(item.followUp.lastContactAt))}</small>` : ''}</td><td>${item.status === 'sold' ? '' : `<button type="button" class="mini-action" data-declined-text="${escapeAttr(item.key)}">${icon('message-square', 13)} Text</button><button type="button" class="mini-action" data-declined-sold="${escapeAttr(item.key)}">${icon('check', 13)} Sold</button>`}</td></tr>`).join('');
  return `<section class="data-panel declined-work"><div class="statement-head"><div><div class="eyebrow">Follow-up</div><h2>Declined work</h2><p>${summary.openCount} open recommendation${summary.openCount === 1 ? '' : 's'} worth ${money(summary.openValue)} · ${summary.dueCount} due for follow-up${summary.redCount ? ` · ${summary.redCount} red` : ''}.</p></div>${icon('list-todo', 20)}</div><table><thead><tr><th>Rating</th><th>Recommendation</th><th>Customer</th><th>Value</th><th>Declined</th><th>Follow up</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No declined work yet. Lines customers decline on an estimate show up here.</td></tr>'}</tbody></table></section>`;
}
