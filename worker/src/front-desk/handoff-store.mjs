// Every Front Desk handoff is logged here, from trigger to outcome.

import { getShopSetting } from '../shop-settings-store.mjs';
import { normalizeQuestionnaireAnswers } from '../../../src/modules/front-desk-questionnaire.js';

export function afterStreamUrl(origin, shopId) {
  return `${origin}/api/voice/twilio/after-stream/${encodeURIComponent(shopId)}`;
}

export async function shopHasHandoffTargets(env, shopId) {
  const setting = await getShopSetting(env, shopId, 'front_desk_questionnaire').catch(() => null);
  const answers = normalizeQuestionnaireAnswers(setting?.answers || {});
  return (answers.transferTargets || []).some(target => /^\+[1-9]\d{7,14}$/.test(target.phone || ''));
}

function rowToHandoff(row) {
  if (!row) return null;
  const parse = (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    shopId: row.shop_id,
    callSid: row.call_sid,
    caller: row.caller || '',
    trigger: row.trigger,
    reason: row.reason || '',
    transcriptSnippet: row.transcript_snippet || '',
    status: row.status,
    attempt: Number(row.attempt || 0),
    targets: parse(row.targets_json || '[]', []),
    outcome: row.outcome || '',
    notified: parse(row.notified_json || 'null', null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createHandoff(env, { shopId, callSid, caller = '', trigger, reason = '', transcriptSnippet = '' }) {
  if (!env?.DB) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO voice_handoffs (id, shop_id, call_sid, caller, trigger, reason, transcript_snippet, status, attempt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', 0, ?, ?)
  `).bind(id, shopId, callSid, caller, trigger, String(reason).slice(0, 200), String(transcriptSnippet).slice(0, 1000), now, now).run();
  console.log(JSON.stringify({ message: 'front desk handoff requested', shopId, callSid, trigger, reason }));
  return getHandoff(env, shopId, id);
}

export async function getHandoff(env, shopId, id) {
  return rowToHandoff(await env.DB.prepare('SELECT * FROM voice_handoffs WHERE shop_id = ? AND id = ?').bind(shopId, id).first());
}

export async function findOpenHandoffForCall(env, shopId, callSid) {
  if (!env?.DB || !callSid) return null;
  return rowToHandoff(await env.DB.prepare(`
    SELECT * FROM voice_handoffs WHERE shop_id = ? AND call_sid = ? AND status = 'requested'
    ORDER BY created_at DESC LIMIT 1
  `).bind(shopId, callSid).first());
}

export async function updateHandoff(env, shopId, id, patch = {}) {
  const existing = await getHandoff(env, shopId, id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  await env.DB.prepare(`
    UPDATE voice_handoffs SET status = ?, attempt = ?, targets_json = ?, outcome = ?, notified_json = ?, updated_at = ?
    WHERE shop_id = ? AND id = ?
  `).bind(next.status, next.attempt, JSON.stringify(next.targets || []), next.outcome || null,
    next.notified ? JSON.stringify(next.notified) : null, new Date().toISOString(), shopId, id).run();
  console.log(JSON.stringify({ message: 'front desk handoff updated', shopId, handoffId: id, status: next.status, attempt: next.attempt, outcome: next.outcome || undefined }));
  return getHandoff(env, shopId, id);
}

export async function listHandoffs(env, shopId, limit = 50) {
  const result = await env.DB.prepare('SELECT * FROM voice_handoffs WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?').bind(shopId, limit).all();
  return (result.results || []).map(rowToHandoff);
}
