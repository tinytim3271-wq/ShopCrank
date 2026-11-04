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

test('an unverified incoming call is still answered, without the AI or a stream token', async () => {
  for (const env of [{}, { TWILIO_AUTH_TOKEN: 'twilio-test-token' }]) {
    const response = await handleTwilioVoiceIncoming(incoming({ 'X-Twilio-Signature': 'forged' }), env, SHOP, { getSecret: noSecrets });
    assert.equal(response.status, 200);
    const twiml = await response.text();
    assert.match(twiml, /<Response>/);
    assert.doesNotMatch(twiml, /<Stream|<Connect|wss:/, 'no AI stream is handed out');
  }
});

test('a token saved without texting settings still verifies voice calls', async () => {
  const params = new URLSearchParams({ From: '+18065550199', CallSid: 'CA1' });
  const url = `https://www.shopcrank.com/api/voice/twilio/incoming/${SHOP}`;
  const shopToken = async (_env, _shop, name) => (name === 'twilio-auth-token' ? 'shop-only-token' : '');
  const good = await twilioSignature('shop-only-token', url, params);
  await assert.doesNotReject(verifyTwilioVoiceRequest(incoming({ 'X-Twilio-Signature': good }), {}, SHOP, params, shopToken));
});

test('a number configured on the apex host verifies on the www host, and the master token counts', async () => {
  const params = new URLSearchParams({ From: '+18065550199', CallSid: 'CA2' });
  const apex = `https://shopcrank.com/api/voice/twilio/incoming/${SHOP}`;
  const signed = await twilioSignature('master-token', apex, params);
  await assert.doesNotReject(verifyTwilioVoiceRequest(incoming({ 'X-Twilio-Signature': signed }), { TWILIO_MASTER_AUTH_TOKEN: 'master-token' }, SHOP, params, noSecrets));
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

test('TWILIO_VERIFY_VOICE=0 cannot switch the check off outside local development', async () => {
  const params = new URLSearchParams({ From: '+18065550199' });
  await assert.rejects(
    verifyTwilioVoiceRequest(incoming(), { TWILIO_VERIFY_VOICE: '0' }, SHOP, params, noSecrets),
    error => error instanceof HttpError && error.status === 503,
  );
  await assert.rejects(
    verifyTwilioVoiceRequest(incoming({ 'X-Twilio-Signature': 'forged' }), { TWILIO_VERIFY_VOICE: '0', TWILIO_AUTH_TOKEN: 'twilio-test-token' }, SHOP, params, noSecrets),
    error => error instanceof HttpError && error.status === 401,
  );
  await assert.doesNotReject(verifyTwilioVoiceRequest(incoming(), { TWILIO_VERIFY_VOICE: '0', DEV_AUTH_BYPASS: '1', TWILIO_AUTH_TOKEN: 'twilio-test-token' }, SHOP, params, noSecrets));
});
