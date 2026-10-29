/** Recent AI phone calls with summaries, shown on the Schedule page. */

const OUTCOMES = Object.freeze({
  booked: { label: 'Booked', badge: 'paid' },
  estimate: { label: 'Estimate saved', badge: 'approved' },
  quoted: { label: 'Quoted', badge: 'approved' },
  status_check: { label: 'Status check', badge: 'sent' },
  info: { label: 'Question', badge: 'sent' },
});

export function recentCalls(calls = [], limit = 10) {
  return [...calls].sort((a, b) => String(b.endedAt || b.createdAt || '').localeCompare(String(a.endedAt || a.createdAt || ''))).slice(0, limit);
}

export function callLogHtml(calls = [], { escapeHtml = value => String(value ?? ''), escapeAttr = escapeHtml, icon = () => '', time = value => String(value || '') } = {}) {
  const rows = recentCalls(calls).map(call => {
    const outcome = OUTCOMES[call.outcome] || OUTCOMES.info;
    const who = call.customer || call.caller || 'Unknown caller';
    const minutes = call.durationSeconds ? ` · ${Math.max(1, Math.round(call.durationSeconds / 60))} min` : '';
    return `<article class="call-log-row"><div><strong>${escapeHtml(who)}</strong>${call.returningCaller ? ' <span class="badge approved">Returning</span>' : ''}<small>${escapeHtml(call.caller || '')} · ${escapeHtml(time(call.endedAt || call.createdAt))}${minutes}</small></div><span class="badge ${outcome.badge}">${escapeHtml(outcome.label)}</span><p>${escapeHtml(call.summary || '')}</p>${call.appointmentId ? `<button type="button" class="mini-action" data-edit-appointment="${escapeAttr(call.appointmentId)}">${icon('calendar', 13)} Open appointment</button>` : ''}</article>`;
  }).join('');
  return `<section class="data-panel call-log"><div class="statement-head"><div><div class="eyebrow">AI phone line</div><h2>Recent calls</h2><p>Every call the AI receptionist answers is summarized here. Appointments it books land on this calendar.</p></div>${icon('phone-call', 20)}</div>${rows || '<p class="ops-note">No AI phone calls yet.</p>'}</section>`;
}
