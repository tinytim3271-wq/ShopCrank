import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  GROK_REALTIME_URL,
  GROK_SHOP_TOOLS,
  buildGrokSessionUpdate,
  calculateGrokServiceEstimate,
  executeGrokShopTool,
  extractGrokClientSecret,
  grokClientSecretRejectionMessage,
  handleGrokClientSecret,
  handleTwilioVoiceIncoming,
  mulawByteToPcm16,
  pcm16ToMulawByte,
  signGrokStreamToken,
  transcodeGrokPcm24kToTwilioMulaw8k,
  transcodeTwilioMulaw8kToGrokPcm24k,
  verifyGrokStreamToken,
} from '../src/grok-voice.mjs';

test('buildGrokSessionUpdate configures grok-voice-latest, server_vad, grok-transcribe, and shop tools', () => {
  const update = buildGrokSessionUpdate({
    shopSettings: {
      voice: 'rex',
      shopName: 'Lubbock Auto Care',
      shopAddress: '101 Main St',
      shopHours: 'Mon-Fri 8-5',
      greeting: 'Welcome to Lubbock Auto Care!',
    },
    pricing: { laborRate: 155, taxRate: 8.25 },
    callerPhone: '+18065550199',
  });

  assert.equal(update.type, 'session.update');
  assert.equal(update.session.voice, 'rex');
  assert.deepEqual(update.session.turn_detection, { type: 'server_vad' });
  assert.equal(update.session.audio.input.format.type, 'audio/pcm');
  assert.equal(update.session.audio.input.format.rate, 24000);
  assert.equal(update.session.audio.input.transcription.model, 'grok-transcribe');
  assert.equal(update.session.audio.output.format.rate, 24000);
  assert.match(update.session.instructions, /Lubbock Auto Care/);
  assert.match(update.session.instructions, /\$155\.00\/hr/);
  assert.match(update.session.instructions, /\+18065550199/);
  assert.equal(update.session.tools.length, GROK_SHOP_TOOLS.length);
  assert.ok(update.session.tools.some((t) => t.name === 'save_call_intake_and_estimate'));
  assert.ok(update.session.tools.some((t) => t.name === 'calculate_service_estimate'));
});

test('calculateGrokServiceEstimate computes labor, parts, shop supplies (3% capped at $20), and tax', async () => {
  const env = {};
  const estimate = await calculateGrokServiceEstimate(env, 'shop-1', {
    vehicle: { year: '2019', make: 'Ford', model: 'F-150' },
    complaint: 'Grinding noise when braking in the front',
    requestedServices: ['front brake pads and rotors'],
  }, { laborRate: 150, taxRate: 8.25 });

  assert.equal(estimate.vehicle, '2019 Ford F-150');
  assert.equal(estimate.laborRate, 150);
  // 1.8 hours * $150 = $270 labor, $265 parts
  assert.equal(estimate.laborHours, 1.8);
  assert.equal(estimate.labor, 270);
  assert.equal(estimate.parts, 265);
  // 3% of $270 = $8.10 shop supplies
  assert.equal(estimate.shopSupplies, 8.1);
  assert.equal(estimate.subtotal, 543.1);
  assert.equal(estimate.tax, 44.81);
  assert.equal(estimate.total, 587.91);
});

test('executeGrokShopTool save_call_intake_and_estimate saves Customer, Vehicle, Estimate, and Order in D1', async () => {
  const savedEntities = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            if (/INSERT INTO entities/.test(sql)) {
              savedEntities.push({
                shopId: args[0],
                entityType: args[1],
                entityId: args[2],
                record: JSON.parse(args[3]),
              });
            }
            return {
              async all() {
                if (/entity_id IN \(\?, \?\)/.test(sql)) {
                  return {
                    results: [
                      { entity_id: 'profile', data_json: JSON.stringify({ laborRate: 160 }) },
                      { entity_id: 'tax', data_json: JSON.stringify({ rate: 8.0 }) },
                    ],
                  };
                }
                return { results: [] };
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    },
  };

  const result = await executeGrokShopTool(env, 'shop-a', 'save_call_intake_and_estimate', {
    customer: {
      firstName: 'Maria',
      lastName: 'Gonzalez',
      phone: '+18065550144',
      email: 'maria@example.com',
      address: '402 Elm Ave',
      city: 'Lubbock',
      state: 'TX',
      zip: '79401',
    },
    vehicle: {
      year: '2021',
      make: 'Toyota',
      model: 'Camry',
      trim: 'SE',
      vin: '4T1G11AK5MU123456',
      mileage: '54200',
    },
    concern: {
      description: 'Water pump leaking coolant and engine running warm',
      lights: 'Check Engine Light',
      began: 'Yesterday',
    },
    requestedServices: ['Water pump replacement'],
    preferredAppointment: 'Tomorrow at 9:00 AM',
  });

  assert.equal(result.saved, true);
  assert.equal(result.customer, 'Maria Gonzalez');
  assert.equal(result.vehicle, '2021 Toyota Camry SE');
  assert.ok(result.estimateTotal > 0);
  assert.equal(savedEntities.length, 4);
  const types = savedEntities.map((e) => e.entityType).sort();
  assert.deepEqual(types, ['customers', 'estimates', 'orders', 'vehicles']);

  const savedOrder = savedEntities.find((e) => e.entityType === 'orders').record;
  assert.equal(savedOrder.source, 'grok_voice_call');
  assert.equal(savedOrder.intake.customer.firstName, 'Maria');
  assert.equal(savedOrder.intake.vehicle.vin, '4T1G11AK5MU123456');
  assert.equal(savedOrder.intake.aiFilledFields['vehicle.vin'], true);
  assert.equal(savedOrder.intake.aiFilledFields['concern.description'], true);
  const savedEstimate = savedEntities.find((e) => e.entityType === 'estimates').record;
  for (const record of [savedEstimate, savedOrder.estimate]) {
    assert.equal(record.laborRate, 160);
    assert.equal(record.taxRate, 8);
    assert.deepEqual(record.taxPolicy, { laborTaxable: false, feesTaxable: true });
    assert.ok(record.fees.length > 0);
    assert.equal(record.shopSupplies, savedEstimate.shopSupplies);
  }
  assert.equal(savedEstimate.taxRate, 8);
  assert.deepEqual(savedEstimate.taxPolicy, { laborTaxable: false, feesTaxable: true });
  assert.equal(savedEstimate.taxableSubtotal, savedOrder.estimate.taxableSubtotal);
  assert.deepEqual(savedEstimate.fees, savedOrder.estimate.fees);
  assert.equal(savedOrder.estimate.taxRate, 8);
  assert.deepEqual(savedOrder.estimate.taxPolicy, { laborTaxable: false, feesTaxable: true });
});

test('Twilio 8kHz mu-law and Grok 24kHz PCM16 transcode cleanly', () => {
  const originalPcm = 4096;
  const mulaw = pcm16ToMulawByte(originalPcm);
  const decodedPcm = mulawByteToPcm16(mulaw);
  assert.ok(Math.abs(decodedPcm - originalPcm) < 300);

  // 10 samples of 8kHz mu-law -> 30 samples (60 bytes) of 24kHz PCM16
  const mulawSamples = new Uint8Array(10).fill(pcm16ToMulawByte(2000));
  const mulawB64 = Buffer.from(mulawSamples).toString('base64');
  const pcm24kB64 = transcodeTwilioMulaw8kToGrokPcm24k(mulawB64);
  const pcm24kBuf = Buffer.from(pcm24kB64, 'base64');
  assert.equal(pcm24kBuf.byteLength, 60);

  // And back from 24kHz PCM16 (60 bytes) -> 10 bytes of 8kHz mu-law
  const roundTripMulawB64 = transcodeGrokPcm24kToTwilioMulaw8k(pcm24kB64);
  const roundTripBuf = Buffer.from(roundTripMulawB64, 'base64');
  assert.equal(roundTripBuf.byteLength, 10);
});

test('Twilio incoming voice webhook returns Connect Stream TwiML with verifiable token', async () => {
  const env = {
    XAI_API_KEY: 'xai-test-key-1234567890abcdef',
    INTEGRATION_ENCRYPTION_KEY: 'test-encryption-secret-key-for-stream',
    TWILIO_VERIFY_VOICE: '0',
  };
  const body = new URLSearchParams({
    From: '+18065550123',
    To: '+18065550999',
    CallSid: 'CA1234567890abcdef',
  });
  const req = new Request('https://www.shopcrank.com/api/voice/twilio/incoming/shop-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const res = await handleTwilioVoiceIncoming(req, env, 'shop-test');
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<Connect>/);
  const streamUrl = xml.match(/<Stream url="([^"]+)"/)?.[1];
  assert.ok(streamUrl);
  assert.doesNotMatch(streamUrl, /\?/, 'Twilio drops query strings from <Stream url>');
  const tokenMatch = streamUrl.match(/^wss:\/\/www\.shopcrank\.com\/api\/voice\/twilio\/stream\/shop-test\/([^/]+)$/);
  assert.ok(tokenMatch, streamUrl);
  const token = decodeURIComponent(tokenMatch[1]);
  const verified = await verifyGrokStreamToken(env, token, 'shop-test');
  assert.equal(verified.shopId, 'shop-test');
  assert.equal(verified.caller, '+18065550123');
  assert.equal(verified.callSid, 'CA1234567890abcdef');
  assert.equal(await verifyGrokStreamToken(env, token, 'other-shop'), null);
});

test('handleGrokClientSecret mints an ephemeral token from xAI without exposing XAI_API_KEY', async () => {
  const longLivedKey = 'xai-super-secret-long-lived-key-9999';
  let capturedAuth = '';
  const env = {
    XAI_API_KEY: longLivedKey,
  };
  const req = new Request('https://www.shopcrank.com/api/ai/voice/client-secret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: 'eve', callerPhone: '+18065550123' }),
  });

  const res = await handleGrokClientSecret(req, env, { shopId: 'shop-a', role: 'admin' }, {
    fetcher: async (url, init) => {
      assert.equal(url, 'https://api.x.ai/v1/realtime/client_secrets');
      capturedAuth = init.headers.Authorization;
      return Response.json({
        client_secret: { value: 'ephemeral_tok_abc123', expires_at: 1999999999 },
      });
    },
  });

  assert.equal(res.status, 200);
  assert.equal(capturedAuth, `Bearer ${longLivedKey}`);
  const payload = await res.json();
  assert.equal(payload.token, 'ephemeral_tok_abc123');
  assert.equal(payload.url, GROK_REALTIME_URL);
  assert.equal(payload.voice, 'eve');
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(longLivedKey));
});

test('extractGrokClientSecret reads the documented xAI { value } payload', () => {
  assert.equal(extractGrokClientSecret({ value: 'xai-realtime-client-secret-abc', expires_at: 1774274445 }), 'xai-realtime-client-secret-abc');
  assert.equal(extractGrokClientSecret({ client_secret: { value: 'nested-secret' } }), 'nested-secret');
  assert.equal(extractGrokClientSecret({ client_secret: 'string-secret' }), 'string-secret');
  assert.equal(extractGrokClientSecret({}), '');
  assert.match(grokClientSecretRejectionMessage({}, 401), /rejected this API key/i);
  assert.match(grokClientSecretRejectionMessage({ error: { message: 'insufficient credits' } }, 402), /insufficient credits/);
});

test('handleGrokClientSecret mints from the official xAI client_secrets response shape', async () => {
  const req = new Request('https://www.shopcrank.com/api/ai/voice/client-secret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: 'ara' }),
  });
  const res = await handleGrokClientSecret(req, { XAI_API_KEY: 'xai-live-key-1234567890abcd' }, { shopId: 'shop-a', role: 'admin' }, {
    fetcher: async () => Response.json({
      value: 'xai-realtime-client-secret-live',
      expires_at: 1774274445,
    }),
  });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.token, 'xai-realtime-client-secret-live');
  assert.equal(payload.voice, 'ara');
});

test('voice stream tokens never use the installer-shipped diagnostics secret and fail closed without a key', async () => {
  const leaked = { DIAGNOSTICS_CAPABILITY_SECRET: 'secret-extracted-from-an-installer' };
  await assert.rejects(() => signGrokStreamToken(leaked, { shopId: 'shop-test' }), /not configured/);
  const forged = await signGrokStreamToken({ DEV_AUTH_BYPASS: '1' }, { shopId: 'shop-test' });
  assert.equal(await verifyGrokStreamToken(leaked, forged, 'shop-test'), null, 'production refuses the dev fallback');
  const configured = { INTEGRATION_ENCRYPTION_KEY: 'prod-key', DIAGNOSTICS_CAPABILITY_SECRET: 'secret-extracted-from-an-installer' };
  const token = await signGrokStreamToken(configured, { shopId: 'shop-test' });
  assert.equal((await verifyGrokStreamToken(configured, token, 'shop-test')).shopId, 'shop-test');
  assert.equal(await verifyGrokStreamToken({ INTEGRATION_ENCRYPTION_KEY: 'secret-extracted-from-an-installer' }, token, 'shop-test'), null);
});
