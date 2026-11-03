import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTwilioVoiceIncoming, verifyTwilioVoiceRequest } from '../src/grok-voice.mjs';
import { HttpError } from '../src/http.mjs';

const SHOP = 'shop-voice-1';

function incoming(headers = {}) {
  return new Request(`https://www.shopcrank.com/api/voice/twilio/incoming/${SHOP}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ From: '+18065550199', CallSid: 'CA-forged' }).toString(),
  });
}

async function twilioSignature(authToken, url, params) {
  const data = url + [...params.keys()].sort().map(key => `${key}${params.get(key)}`).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...digest));
}

const noSecrets = async () => '';

test('an unsigned incoming call is refused when the shop has no Twilio token', async () => {
  await assert.rejects(
    handleTwilioVoiceIncoming(incoming(), {}, SHOP, { getSecret: noSecrets }),
    error => error instanceof HttpError && error.status === 503,
  );
});

test('local development may skip the check only with DEV_AUTH_BYPASS', async () => {
  const params = new URLSearchParams({ From: '+18065550199' });
  await assert.doesNotReject(verifyTwilioVoiceRequest(incoming(), { DEV_AUTH_BYPASS: '1' }, SHOP, params, noSecrets));
});

test('a wrong signature is rejected and a correct one accepted', async () => {
  const env = { TWILIO_AUTH_TOKEN: 'twilio-test-token' };
  const params = new URLSearchParams({ From: '+18065550199', CallSid: 'CA1' });
  const url = `https://www.shopcrank.com/api/voice/twilio/incoming/${SHOP}`;
  await assert.rejects(
    verifyTwilioVoiceRequest(incoming({ 'X-Twilio-Signature': 'forged' }), env, SHOP, params, noSecrets),
    error => error instanceof HttpError && error.status === 401,
  );
  const good = await twilioSignature('twilio-test-token', url, params);
  await assert.doesNotReject(verifyTwilioVoiceRequest(incoming({ 'X-Twilio-Signature': good }), env, SHOP, params, noSecrets));
});
