import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SMS_TEXT_LENGTH,
  SmsIntegrationError,
  classifySmsKeyword,
  createSmsProvider,
  isE164,
  parseTwilioInboundWebhook,
  resolveTwilioShopConfig,
  sendSms,
  smsIntegrationStatus,
} from '../src/integrations/sms.mjs';

const ENV = {
  TWILIO_ACCOUNT_SID: 'AC1234567890',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_MESSAGING_SERVICE_SID: 'MG1234567890',
};

async function twilioSignature(token, url, parameters) {
  const entries = [...parameters.entries()].sort(([left], [right]) => left.localeCompare(right));
  const data = `${url}${entries.map(([name, value]) => `${name}${value}`).join('')}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return Buffer.from(digest).toString('base64');
}

test('Twilio provider sends caller-composed outbound text as a form request', async () => {
  const calls = [];
  const body = 'Reply APPROVE to authorize repairs. Your vehicle is READY. Pay: https://pay.example/i/42';
  const result = await sendSms(ENV, { to: '+18065550123', body }, {
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ sid: 'SM987', status: 'queued' }, { status: 201 });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC1234567890/Messages.json');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('To'), '+18065550123');
  assert.equal(form.get('Body'), body);
  assert.equal(form.get('MessagingServiceSid'), 'MG1234567890');
  assert.equal(form.has('From'), false);
  assert.deepEqual(result, { provider: 'twilio', messageSid: 'SM987', status: 'queued' });
  assert.equal(JSON.stringify(result).includes(ENV.TWILIO_AUTH_TOKEN), false);
});

test('Twilio provider supports a from number and validates E.164 and bounded text', async () => {
  let sentForm;
  const env = {
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'secret',
    TWILIO_FROM_NUMBER: '+18065550999',
  };
  await sendSms(env, { to: '+447911123456', body: 'Ready for pickup' }, {
    fetcher: async (_url, init) => {
      sentForm = new URLSearchParams(init.body);
      return Response.json({ sid: 'SM123' }, { status: 201 });
    },
  });
  assert.equal(sentForm.get('From'), '+18065550999');
  assert.equal(sentForm.has('MessagingServiceSid'), false);
  assert.equal(isE164('+18065550123'), true);
  assert.equal(isE164('806-555-0123'), false);
  await assert.rejects(
    sendSms(env, { to: '806-555-0123', body: 'hello' }, { fetcher: async () => assert.fail('must not fetch') }),
    error => error instanceof SmsIntegrationError && error.code === 'invalid_phone_number',
  );
  await assert.rejects(
    sendSms(env, { to: '+18065550123', body: 'x'.repeat(MAX_SMS_TEXT_LENGTH + 1) }),
    error => error instanceof SmsIntegrationError && error.code === 'invalid_body',
  );
});

test('unconfigured SMS is hidden and cannot create or use a provider', async () => {
  const partialEnv = {
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'secret',
  };
  assert.equal(smsIntegrationStatus({}), null);
  assert.equal(smsIntegrationStatus(partialEnv), null);
  assert.equal(createSmsProvider(partialEnv), null);
  await assert.rejects(
    sendSms(partialEnv, { to: '+18065550123', body: 'hello' }),
    error => error instanceof SmsIntegrationError
      && error.code === 'sms_not_configured'
      && error.status === 503,
  );
  assert.deepEqual(smsIntegrationStatus(ENV), {
    enabled: true,
    provider: 'twilio',
    senderType: 'messaging_service',
  });
});

test('inbound webhook binds signatures to the configured origin and requested tenant path', async () => {
  const publicUrl = 'https://app.example.com/api/messaging/twilio/webhook/shop-1';
  const workerUrl = 'https://worker.internal.example/api/messaging/twilio/webhook/shop-1';
  const parameters = new URLSearchParams({
    From: '+18065550123',
    To: '+18065550999',
    Body: '  STOP  ',
    MessageSid: 'SM-inbound-1',
  });
  const signature = await twilioSignature(ENV.TWILIO_AUTH_TOKEN, publicUrl, parameters);
  const request = new Request(workerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: parameters,
  });

  assert.deepEqual(await parseTwilioInboundWebhook(request, {
    ...ENV,
    TWILIO_WEBHOOK_URL: 'https://app.example.com',
  }), {
    provider: 'twilio',
    from: '+18065550123',
    to: '+18065550999',
    body: '  STOP  ',
    messageSid: 'SM-inbound-1',
    classification: 'opt_out',
  });

  const otherTenantRequest = new Request('https://worker.internal.example/api/messaging/twilio/webhook/shop-2', {
    method: 'POST',
    headers: { 'X-Twilio-Signature': signature },
    body: parameters,
  });
  await assert.rejects(
    parseTwilioInboundWebhook(otherTenantRequest, {
      ...ENV,
      TWILIO_WEBHOOK_URL: 'https://app.example.com',
    }),
    error => error instanceof SmsIntegrationError
      && error.code === 'invalid_webhook_signature'
      && error.status === 401,
  );
});

test('inbound webhook rejects an invalid Twilio signature', async () => {
  const request = new Request('https://app.example.com/api/sms', {
    method: 'POST',
    headers: { 'X-Twilio-Signature': 'not-valid' },
    body: new URLSearchParams({
      From: '+18065550123',
      To: '+18065550999',
      Body: 'hello',
      MessageSid: 'SM1',
    }),
  });
  await assert.rejects(
    parseTwilioInboundWebhook(request, ENV),
    error => error instanceof SmsIntegrationError
      && error.code === 'invalid_webhook_signature'
      && error.status === 401,
  );
});

test('resolveTwilioShopConfig prefers shop secrets over platform env', async () => {
  const secrets = {
    'twilio-account-sid': 'ACshop0000000000000000000000000001',
    'twilio-auth-token': 'shop-auth-token-abcdef',
    'twilio-from-number': '+18065550111',
  };
  const getSecret = async (_env, _shopId, name) => secrets[name] || '';
  const resolved = await resolveTwilioShopConfig(
    {
      TWILIO_ACCOUNT_SID: 'ACplatform000000000000000000000002',
      TWILIO_AUTH_TOKEN: 'platform-token',
      TWILIO_FROM_NUMBER: '+18065550999',
    },
    'shop-1',
    getSecret,
  );
  assert.equal(resolved.configured, true);
  assert.equal(resolved.keySource, 'shop');
  assert.equal(resolved.accountSid, 'ACshop0000000000000000000000000001');
  assert.equal(resolved.fromNumber, '+18065550111');
  assert.equal(resolved.authToken, 'shop-auth-token-abcdef');

  const platformOnly = await resolveTwilioShopConfig(
    {
      TWILIO_ACCOUNT_SID: 'ACplatform000000000000000000000002',
      TWILIO_AUTH_TOKEN: 'platform-token',
      TWILIO_FROM_NUMBER: '+18065550999',
    },
    'shop-1',
    async () => '',
  );
  assert.equal(platformOnly.configured, true);
  assert.equal(platformOnly.keySource, 'platform');
  assert.equal(platformOnly.accountSid, 'ACplatform000000000000000000000002');
});

test('SMS consent keywords classify opt-out and opt-in commands only', () => {
  for (const keyword of ['STOP', 'stopall', ' unsubscribe ', 'CANCEL', 'END', 'quit']) {
    assert.equal(classifySmsKeyword(keyword), 'opt_out');
  }
  for (const keyword of ['START', ' unstop ']) {
    assert.equal(classifySmsKeyword(keyword), 'opt_in');
  }
  assert.equal(classifySmsKeyword('Please stop texting me'), null);
  assert.equal(classifySmsKeyword(''), null);
});
