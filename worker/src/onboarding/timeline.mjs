// Onboarding steps and the operator timeline:
//   day 0 intake · days 0-1 Twilio · day 1 A2P · days 1-3 ShopCrank and Grok ·
//   days 2-5 integrations · days 3-5 test calls and calls go-live ·
//   days 10-21 SMS go-live · day 30 check-in.
// gated: spends money or changes a live account/route, so it needs a dry-run
// plan, operator approval of that exact plan, and an explicit live execution.

export const ONBOARDING_STEPS = Object.freeze([
  { id: 'intake', phase: 'Intake', title: 'Intake form complete', startDay: 0, endDay: 0, kind: 'auto' },
  { id: 'roles', phase: 'Intake', title: 'Shop account and staff roles', startDay: 0, endDay: 0, kind: 'internal' },
  { id: 'twilio_subaccount', phase: 'Twilio', title: 'Create Twilio subaccount', startDay: 0, endDay: 1, kind: 'gated', external: true },
  { id: 'twilio_number', phase: 'Twilio', title: 'Buy local number and route it', startDay: 0, endDay: 1, kind: 'gated', external: true, spends: true },
  { id: 'a2p_brand', phase: 'A2P 10DLC', title: 'Submit customer profile, brand, and messaging service', startDay: 1, endDay: 1, kind: 'gated', external: true, spends: true },
  { id: 'a2p_campaign', phase: 'A2P 10DLC', title: 'Submit A2P campaign', startDay: 1, endDay: 3, kind: 'gated', external: true, spends: true },
  { id: 'grok_setup', phase: 'ShopCrank and Grok', title: 'Generate Front Desk and Tech Assistant personas', startDay: 1, endDay: 3, kind: 'internal' },
  { id: 'questionnaire', phase: 'ShopCrank and Grok', title: 'Front Desk go-live questionnaire complete', startDay: 1, endDay: 3, kind: 'auto' },
  { id: 'integrations', phase: 'Integrations', title: 'QuickBooks and PartsTech connected', startDay: 2, endDay: 5, kind: 'auto' },
  { id: 'test_calls', phase: 'Test calls', title: 'Test call passes (no 31920 / 15003 alerts)', startDay: 3, endDay: 5, kind: 'gated', external: true, spends: true },
  { id: 'calls_go_live', phase: 'Go-live', title: 'Phone calls go live', startDay: 3, endDay: 5, kind: 'gated' },
  { id: 'sms_go_live', phase: 'Go-live', title: 'SMS go-live (campaign verified)', startDay: 10, endDay: 21, kind: 'gated' },
  { id: 'checkin_30', phase: 'Check-in', title: '30-day check-in', startDay: 30, endDay: 30, kind: 'manual' },
]);

export const STEP_BY_ID = Object.freeze(Object.fromEntries(ONBOARDING_STEPS.map(step => [step.id, step])));

function addDays(iso, days) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Checklist rows with due dates relative to the intake date. `facts` carries
 * derived completion for auto steps (intake/questionnaire/integrations).
 */
export function buildChecklist(onboarding, { now = new Date(), facts = {} } = {}) {
  const started = onboarding.startedAt || now.toISOString();
  const today = now.toISOString().slice(0, 10);
  return ONBOARDING_STEPS.map(step => {
    const record = onboarding.state.steps?.[step.id] || {};
    let status = record.status || 'pending';
    if (step.kind === 'auto') status = facts[step.id] ? 'done' : (status === 'skipped' ? 'skipped' : 'pending');
    const dueStart = addDays(started, step.startDay);
    const dueEnd = addDays(started, step.endDay);
    const finished = ['done', 'skipped'].includes(status);
    return {
      ...step,
      status,
      dueStart,
      dueEnd,
      overdue: !finished && today > dueEnd,
      approval: record.approval ? { approvedBy: record.approval.approvedBy, approvedAt: record.approval.approvedAt, planHash: record.approval.planHash, usedAt: record.approval.usedAt || null } : null,
      planHash: record.planHash || null,
      lastError: record.error || null,
      completedAt: record.completedAt || null,
      mode: record.lastMode || null,
    };
  });
}

export function overallStatus(checklist) {
  if (checklist.every(item => ['done', 'skipped'].includes(item.status))) return 'complete';
  const firstOpen = checklist.find(item => !['done', 'skipped'].includes(item.status));
  return firstOpen ? firstOpen.phase : 'complete';
}
