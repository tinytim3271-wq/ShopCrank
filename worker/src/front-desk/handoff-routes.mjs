// Twilio call control for Front Desk handoffs. When a handoff fires, the bridge
// closes the Media Stream; Twilio then follows the <Redirect> after </Connect>
// to /after-stream, which says one line and rings the shop's transfer targets
// in order. If nobody answers, the caller gets voicemail or a callback promise
// and staff are notified with the caller's number and a transcript snippet.

import { HttpError } from '../http.mjs';
import { TWILIO_STREAM_FALLBACK_SAY, verifyTwilioVoiceRequest } from '../grok-voice.mjs';
import { createTwilioSmsProvider, resolveTwilioShopConfig } from '../integrations/sms.mjs';
import { getShopSetting } from '../shop-settings-store.mjs';
import { availableTransferTargets, normalizeQuestionnaireAnswers } from '../../../src/modules/front-desk-questionnaire.js';
import { HANDOFF_LINE } from './handoff-detect.mjs';
import { findOpenHandoffForCall, getHandoff, updateHandoff } from './handoff-store.mjs';

const DEFAULT_RING_SECONDS = 18;
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function twiml(body) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { status: 200, headers: XML_HEADERS });
}

function handoffActionUrl(origin, shopId, handoffId, action, attempt = null) {
  const base = `${origin}/api/voice/twilio/handoff/${encodeURIComponent(shopId)}/${encodeURIComponent(handoffId)}/${action}`;
  return attempt === null ? base : `${base}?attempt=${attempt}`;
}

export function buildDialTwiml({ target, timeout, actionUrl }) {
  return `<Dial timeout="${Number(timeout) || DEFAULT_RING_SECONDS}" answerOnBridge="true" action="${xml(actionUrl)}" method="POST"><Number>${xml(target.phone)}</Number></Dial>`;
}

async function loadAnswers(env, shopId) {
  const setting = await getShopSetting(env, shopId, 'front_desk_questionnaire').catch(() => null);
  return normalizeQuestionnaireAnswers(setting?.answers || {});
}

function ringSeconds(answers) {
  const value = Number(answers.ringTimeoutSeconds);
  return Number.isFinite(value) && value >= 5 && value <= 60 ? value : DEFAULT_RING_SECONDS;
}

export async function notifyHandoffStaff(env, { shopId, handoff, answers, recordingUrl = '', getSecret = null, fetcher = fetch }) {
  const shopName = answers.dbaName || shopId;
  const lines = [
    recordingUrl ? `${shopName}: the caller left a voicemail after a missed handoff.` : `${shopName}: a phone caller wanted a person and nobody answered.`,
    `Caller: ${handoff.caller || 'unknown number'}`,
    `Reason: ${handoff.trigger}${handoff.reason ? ` (${handoff.reason})` : ''}`,
    handoff.transcriptSnippet ? `Caller said: "${handoff.transcriptSnippet.slice(0, 300)}"` : '',
    recordingUrl ? `Voicemail: ${recordingUrl}` : 'No voicemail left; please call back.',
  ].filter(Boolean);
  const text = lines.join('\n');
  const result = { sms: [], email: [] };
  const smsTargets = (answers.notifySms || []).filter(phone => /^\+[1-9]\d{7,14}$/.test(phone));
  if (smsTargets.length) {
    const config = await resolveTwilioShopConfig(env, shopId, getSecret);
    for (const to of smsTargets) {
      try {
        if (!config.configured) throw new Error('Twilio is not configured for this shop');
        const provider = createTwilioSmsProvider(env, { fetcher, config, shopId });
        await provider.send({ to, body: text.slice(0, 1500) });
        result.sms.push({ to, ok: true });
      } catch (error) {
        result.sms.push({ to, ok: false, error: String(error?.message || error).slice(0, 120) });
      }
    }
  }
  const from = String(env.SUPPORT_EMAIL_FROM || env.AUTH_EMAIL_FROM || '').trim();
  for (const to of answers.notifyEmails || []) {
    try {
      if (typeof env.EMAIL?.send !== 'function' || !from) throw new Error('Email sending is not configured');
      await env.EMAIL.send({ to, from, subject: `Missed handoff call from ${handoff.caller || 'a caller'}`, text });
      result.email.push({ to, ok: true });
    } catch (error) {
      result.email.push({ to, ok: false, error: String(error?.message || error).slice(0, 120) });
    }
  }
  return result;
}

async function noAnswerFallback(env, { request, shopId, handoff, answers, getSecret, fetcher }) {
  const origin = new URL(request.url).origin;
  if (answers.noAnswerFallback === 'callback_message') {
    const notified = await notifyHandoffStaff(env, { shopId, handoff, answers, getSecret, fetcher });
    await updateHandoff(env, shopId, handoff.id, { status: 'callback_promised', outcome: 'no_answer', notified });
    const promise = answers.callbackPromise ? ` ${answers.callbackPromise}` : ' as soon as possible';
    return twiml(`<Say>Sorry, nobody is available right now. Someone from ${xml(answers.dbaName || 'the shop')} will call you back${xml(promise)}.</Say><Hangup/>`);
  }
  const notified = await notifyHandoffStaff(env, { shopId, handoff, answers, getSecret, fetcher });
  await updateHandoff(env, shopId, handoff.id, { status: 'voicemail_offered', outcome: 'no_answer', notified });
  const prompt = answers.voicemailGreeting || 'Sorry, nobody is available right now. Please leave your name, number, and message after the tone, and we will call you back.';
  return twiml(`<Say>${xml(prompt)}</Say><Record maxLength="120" playBeep="true" action="${xml(handoffActionUrl(origin, shopId, handoff.id, 'voicemail'))}" method="POST"/><Say>We did not get a message. Goodbye.</Say>`);
}

/** Twilio <Redirect> target after the Media Stream ends. */
export async function handleTwilioAfterStream(request, env, shopId, { getSecret = null, now = () => new Date() } = {}) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!shopId) throw new HttpError(400, 'Shop ID is required');
  const params = new URLSearchParams(await request.text());
  await verifyTwilioVoiceRequest(request, env, shopId, params, getSecret);
  const handoff = await findOpenHandoffForCall(env, shopId, String(params.get('CallSid') || ''));
  if (!handoff) return twiml(`<Say>${xml(TWILIO_STREAM_FALLBACK_SAY)}</Say>`);
  const answers = await loadAnswers(env, shopId);
  const targets = availableTransferTargets(answers, now());
  const updated = await updateHandoff(env, shopId, handoff.id, { status: targets.length ? 'dialing' : 'no_targets', attempt: 0, targets });
  if (!targets.length) {
    return noAnswerFallback(env, { request, shopId, handoff: updated, answers, getSecret, fetcher: fetch });
  }
  const origin = new URL(request.url).origin;
  return twiml(`<Say>${xml(HANDOFF_LINE)}</Say>${buildDialTwiml({ target: targets[0], timeout: ringSeconds(answers), actionUrl: handoffActionUrl(origin, shopId, handoff.id, 'dial', 0) })}`);
}

/** <Dial action> and <Record action> callbacks for one handoff. */
export async function handleTwilioHandoffAction(request, env, shopId, handoffId, action, { getSecret = null, fetcher = fetch } = {}) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const params = new URLSearchParams(await request.text());
  await verifyTwilioVoiceRequest(request, env, shopId, params, getSecret);
  const handoff = await getHandoff(env, shopId, handoffId);
  if (!handoff) throw new HttpError(404, 'Handoff not found');
  const answers = await loadAnswers(env, shopId);

  if (action === 'dial') {
    const attempt = Math.max(0, Number(new URL(request.url).searchParams.get('attempt') || 0));
    const status = String(params.get('DialCallStatus') || '').toLowerCase();
    const target = handoff.targets[attempt];
    if (status === 'completed' || status === 'answered') {
      await updateHandoff(env, shopId, handoffId, { status: 'connected', attempt, outcome: `answered_by:${target?.label || target?.name || attempt}` });
      return twiml('<Hangup/>');
    }
    const next = attempt + 1;
    if (handoff.targets[next]) {
      await updateHandoff(env, shopId, handoffId, { status: 'dialing', attempt: next });
      const origin = new URL(request.url).origin;
      return twiml(buildDialTwiml({ target: handoff.targets[next], timeout: ringSeconds(answers), actionUrl: handoffActionUrl(origin, shopId, handoffId, 'dial', next) }));
    }
    return noAnswerFallback(env, { request, shopId, handoff: { ...handoff, attempt }, answers, getSecret, fetcher });
  }

  if (action === 'voicemail') {
    const recordingUrl = String(params.get('RecordingUrl') || '').slice(0, 500);
    const notified = recordingUrl
      ? await notifyHandoffStaff(env, { shopId, handoff, answers, recordingUrl, getSecret, fetcher })
      : handoff.notified;
    await updateHandoff(env, shopId, handoffId, { status: recordingUrl ? 'voicemail_left' : 'voicemail_empty', outcome: 'no_answer', notified });
    return twiml('<Say>Thanks, we got your message. Goodbye.</Say><Hangup/>');
  }

  throw new HttpError(404, 'Not found');
}
