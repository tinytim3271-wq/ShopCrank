import { OnboardingBlockedError } from './twilio-executor.mjs';

export async function claimExecution(env, { shopId, stepId, hash, legacyPartial = false }) {
  if (legacyPartial) throw new OnboardingBlockedError('Legacy partial results require operator reconciliation before execution.', 'reconciliation_required');
  const runId = crypto.randomUUID();
  let claimed;
  try {
    claimed = await env.DB.prepare(`
      INSERT INTO onboarding_executions (shop_id, step_id, run_id, plan_hash, status, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?)
      ON CONFLICT(shop_id, step_id) DO UPDATE SET
        run_id = excluded.run_id, plan_hash = excluded.plan_hash, status = 'running', updated_at = excluded.updated_at
      WHERE onboarding_executions.status = 'failed' AND onboarding_executions.pending_key IS NULL
        AND (onboarding_executions.plan_hash = excluded.plan_hash OR onboarding_executions.results_json = '{}')
    `).bind(shopId, stepId, runId, hash, new Date().toISOString()).run();
  } catch (error) {
    if (!/UNIQUE constraint failed/.test(String(error?.message))) throw error;
    throw new OnboardingBlockedError('Another execution needs completion or reconciliation for this shop.', 'execution_claimed');
  }
  if (claimed.meta?.changes !== 1) {
    throw new OnboardingBlockedError('This step is claimed, completed, or has partial results for a different plan. Reconcile before retrying.', 'reconciliation_required');
  }
  const row = await env.DB.prepare('SELECT * FROM onboarding_executions WHERE shop_id = ? AND step_id = ? AND run_id = ?')
    .bind(shopId, stepId, runId).first();
  return { shopId, stepId, runId, hash, results: JSON.parse(row.results_json), pendingKey: null };
}

export async function checkpointExecution(env, claim, { results = claim.results, pendingKey = null, status = 'running' } = {}) {
  const saved = await env.DB.prepare(`
    UPDATE onboarding_executions SET results_json = ?, pending_key = ?, status = ?, updated_at = ?
    WHERE shop_id = ? AND step_id = ? AND run_id = ? AND plan_hash = ? AND status = 'running'
  `).bind(JSON.stringify(results), pendingKey, status, new Date().toISOString(),
    claim.shopId, claim.stepId, claim.runId, claim.hash).run();
  if (saved.meta?.changes !== 1) throw new OnboardingBlockedError('Execution claim was lost; reconcile before retrying.', 'execution_claim_lost');
  claim.results = results;
  claim.pendingKey = pendingKey;
}

export async function recordVoiceEvidence(env, { shopId, callSid, streamSid, xaiStarted = false }) {
  if (!env?.DB || !callSid || !streamSid) return;
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO onboarding_voice_evidence (shop_id, call_sid, stream_sid, media_started_at, xai_started_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, call_sid) DO UPDATE SET
      xai_started_at = CASE WHEN excluded.xai_started_at IS NOT NULL AND onboarding_voice_evidence.stream_sid = excluded.stream_sid
        THEN excluded.xai_started_at ELSE onboarding_voice_evidence.xai_started_at END
  `).bind(shopId, callSid, streamSid, now, xaiStarted ? now : null).run();
}
