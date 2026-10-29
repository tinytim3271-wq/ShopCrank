import { DEFAULT_WORKERS_AI_MODEL } from './ai.mjs';

/**
 * AI phone call summaries. Every call ends with a `calls` record the shop can
 * read on the Schedule / Messaging screens: who called, why, what the agent did
 * (booked, quoted, looked up status), and a short summary. The summary is
 * deterministic from the transcript and actions, and is upgraded by Workers AI
 * when the binding is available.
 */

const MAX_LINES = 80;

function clean(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Record a tool call the agent made so the summary can say what happened. */
export function callActionFromTool(name, args = {}, output = {}) {
  if (output?.error) return { type: 'error', tool: name, detail: clean(output.error, 200) };
  if (name === 'book_appointment' && output?.booked) {
    return { type: 'booked', appointmentId: output.appointmentId, date: output.date, time: output.time, service: clean(output.service, 120) };
  }
  if (name === 'save_call_intake_and_estimate' && output?.saved) {
    return { type: 'estimate', orderId: output.orderId, total: Number(output.estimateTotal) || 0, complaint: clean(output.complaint, 160) };
  }
  if (name === 'calculate_service_estimate') return { type: 'quoted', total: Number(output?.total) || 0 };
  if (name === 'check_appointment_availability') return { type: 'availability' };
  if (name === 'lookup_customer_and_vehicles') return { type: 'lookup', query: clean(args.query, 80) };
  return { type: 'info', tool: name };
}

function outcomeFor(actions) {
  if (actions.some(action => action.type === 'booked')) return 'booked';
  if (actions.some(action => action.type === 'estimate')) return 'estimate';
  if (actions.some(action => action.type === 'quoted')) return 'quoted';
  if (actions.some(action => action.type === 'lookup')) return 'status_check';
  return 'info';
}

export function extractiveCallSummary({ transcript = [], actions = [], callerName = '' }) {
  const callerLines = transcript.filter(line => line.role === 'caller').map(line => clean(line.text, 240)).filter(text => text.length > 3);
  const reason = callerLines.find(text => text.split(' ').length >= 3) || callerLines[0] || '';
  const parts = [];
  parts.push(`${callerName || 'Caller'}${reason ? ` called about: "${reason}"` : ' called the shop'}.`);
  for (const action of actions) {
    if (action.type === 'booked') parts.push(`Booked ${action.service || 'an appointment'} for ${action.date} at ${action.time}.`);
    if (action.type === 'estimate') parts.push(`Saved an estimate draft${action.orderId ? ` (${action.orderId})` : ''}${action.total ? ` for about $${action.total.toFixed(2)}` : ''}.`);
    if (action.type === 'quoted' && !actions.some(item => item.type === 'estimate')) parts.push(`Gave a ballpark quote${action.total ? ` of about $${action.total.toFixed(2)}` : ''}.`);
    if (action.type === 'lookup') parts.push('Looked up the customer\'s records.');
  }
  if (!actions.length) parts.push('No booking or estimate was made; follow up if needed.');
  return [...new Set(parts)].join(' ');
}

async function aiCallSummary(env, transcript, fallback) {
  if (!env?.AI || typeof env.AI.run !== 'function' || !transcript.length) return null;
  const text = transcript.slice(-MAX_LINES).map(line => `${line.role === 'caller' ? 'Caller' : 'Agent'}: ${clean(line.text, 300)}`).join('\n');
  try {
    const result = await Promise.race([
      env.AI.run(String(env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL), {
        messages: [
          { role: 'system', content: 'Summarize this auto repair shop phone call for the service advisor in at most 3 short sentences: who called, the vehicle and problem, and what was booked, quoted, or still needs a callback. Plain text only.' },
          { role: 'user', content: `${text}\n\nActions recorded: ${fallback}` },
        ],
        max_tokens: 160,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    return clean(result?.response || result?.result?.response || '', 600) || null;
  } catch {
    return null;
  }
}

export async function buildCallSummary(env, { shopId, callSid = '', caller = '', callerContext = null, transcript = [], actions = [], startedAt, endedAt = new Date().toISOString(), durationSeconds = 0, provider = 'grok_phone', reason = '' }) {
  const callerName = clean(callerContext?.customer?.name || actions.find(action => action.customerName)?.customerName || '', 120);
  const fallback = extractiveCallSummary({ transcript, actions, callerName });
  const aiSummary = await aiCallSummary(env, transcript, fallback);
  return {
    id: `call-${callSid || crypto.randomUUID()}`,
    shopId,
    callSid,
    caller: clean(caller, 40),
    customer: callerName,
    customerId: callerContext?.customer?.id || '',
    returningCaller: Boolean(callerContext?.customer),
    provider,
    startedAt: startedAt || endedAt,
    endedAt,
    durationSeconds: Math.max(0, Math.round(Number(durationSeconds) || 0)),
    outcome: outcomeFor(actions),
    summary: aiSummary || fallback,
    summarySource: aiSummary ? 'ai' : 'transcript',
    actions,
    appointmentId: actions.find(action => action.type === 'booked')?.appointmentId || '',
    orderId: actions.find(action => action.type === 'estimate')?.orderId || '',
    transcript: transcript.slice(-MAX_LINES).map(line => ({ role: line.role === 'caller' ? 'caller' : 'agent', text: clean(line.text, 500) })),
    endReason: clean(reason, 60),
  };
}

export async function saveCallSummary(env, record) {
  if (!env?.DB || !record?.shopId) return record;
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, 'calls', ?, ?, 'ai-phone', ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `).bind(record.shopId, record.id, JSON.stringify({ ...record, createdAt: record.endedAt || now, updatedAt: now }), record.endedAt || now, now).run();
  return record;
}

/** AgentPhone `agent.call_ended`: transcript arrives as text or [{ role, text|content }]. */
export async function agentPhoneCallSummary(env, shopId, body = {}) {
  const data = body.data || {};
  const raw = Array.isArray(data.transcript) ? data.transcript : Array.isArray(data.messages) ? data.messages : [];
  const transcript = raw.length
    ? raw.map(line => ({ role: /user|caller|customer/i.test(line.role || line.speaker || '') ? 'caller' : 'agent', text: clean(line.text || line.content || line.message, 500) })).filter(line => line.text)
    : String(data.transcript || '').split('\n').map(text => ({ role: /^agent|^assistant/i.test(text) ? 'agent' : 'caller', text: clean(text.replace(/^\w+:\s*/, ''), 500) })).filter(line => line.text);
  const caller = clean(data.from || data.caller || body.from || '', 40);
  const digits = caller.replace(/\D/g, '').slice(-10);
  let callerContext = null;
  if (digits.length >= 7 && env?.DB) {
    const row = await env.DB.prepare(`
      SELECT entity_id, data_json FROM entities WHERE shop_id = ? AND entity_type = 'customers'
        AND replace(replace(replace(replace(replace(json_extract(data_json, '$.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? LIMIT 1
    `).bind(shopId, `%${digits}`).first();
    if (row) {
      try { callerContext = { customer: { ...JSON.parse(row.data_json), id: row.entity_id } }; } catch { callerContext = null; }
    }
  }
  const record = await buildCallSummary(env, {
    shopId, callSid: clean(data.callId || data.call_id || body.id || '', 120), caller, callerContext, transcript,
    actions: [], durationSeconds: Number(data.durationSeconds || data.duration || 0), provider: 'agentphone', reason: 'call_ended',
    startedAt: data.startedAt, endedAt: data.endedAt || new Date().toISOString(),
  });
  if (data.summary) return { ...record, summary: clean(data.summary, 600), summarySource: 'agentphone' };
  return record;
}
