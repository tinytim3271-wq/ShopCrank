import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { handleGrokTwilioBridge } from '../src/grok-voice.mjs';

const ENV = {
  XAI_API_KEY: 'xai-test-key-1234567890abcdef',
  INTEGRATION_ENCRYPTION_KEY: 'test-encryption-secret-key-for-stream',
  TWILIO_VERIFY_VOICE: '0',
};

function twilioSignature(authToken, url, params) {
  const data = url + [...params.keys()].sort().map(key => `${key}${params.get(key)}`).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

async function incomingTwiml(env, host = 'www.shopcrank.com') {
  const response = await worker.fetch(new Request(`https://${host}/api/voice/twilio/incoming/reliable-auto-services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+18065550123', CallSid: 'CA0123456789abcdef' }).toString(),
  }), env);
  assert.equal(response.status, 200);
  return response.text();
}

function streamUrlFrom(xml) {
  return xml.match(/<Stream url="([^"]+)"/)?.[1].replace(/&amp;/g, '&');
}

/** Replays the handshake Twilio makes: query strings are stripped from <Stream url>. */
function twilioHandshake(streamUrl) {
  const url = new URL(streamUrl.replace(/^wss:/, 'https:'));
  url.search = '';
  return new Request(url, { headers: { Upgrade: 'websocket' } });
}

function fakeVoiceSessions() {
  const calls = [];
  return {
    calls,
    binding: {
      newUniqueId: () => 'do-id',
      get: () => ({
        fetch: async (request) => {
          calls.push(request);
          return new Response('bridged', { status: 200 });
        },
      }),
    },
  };
}

test('the stream URL Twilio receives survives Twilio stripping the query string', async () => {
  const sessions = fakeVoiceSessions();
  const env = { ...ENV, AI_VOICE_SESSIONS: sessions.binding };
  const xml = await incomingTwiml(env);
  const streamUrl = streamUrlFrom(xml);
  assert.match(streamUrl, /^wss:\/\//);
  assert.doesNotMatch(streamUrl, /\?/);

  const response = await worker.fetch(twilioHandshake(streamUrl), env);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(sessions.calls.length, 1, 'the handshake reaches the voice Durable Object');
  const forwarded = sessions.calls[0].headers;
  assert.equal(forwarded.get('X-MechPro-Voice-Mode'), 'twilio-grok');
  assert.equal(forwarded.get('X-MechPro-Shop-Id'), 'reliable-auto-services');
  assert.equal(forwarded.get('X-MechPro-Caller-Phone'), '+18065550123');
  assert.equal(forwarded.get('X-MechPro-Call-Sid'), 'CA0123456789abcdef');
});

test('a stream token for one shop cannot open another shop\'s stream', async () => {
  const sessions = fakeVoiceSessions();
  const env = { ...ENV, AI_VOICE_SESSIONS: sessions.binding };
  const streamUrl = streamUrlFrom(await incomingTwiml(env));
  const forged = streamUrl.replace('/stream/reliable-auto-services/', '/stream/other-shop/');
  const response = await worker.fetch(twilioHandshake(forged), env);
  assert.equal(response.status, 401);
  assert.equal(sessions.calls.length, 0);
});

test('the TwiML falls back to speech when the stream ends and reports stream status', async () => {
  const xml = await incomingTwiml(ENV);
  assert.match(xml, /<\/Connect>\s*<Say>[^<]+<\/Say>\s*<\/Response>/);
  assert.match(
    xml,
    /statusCallback="https:\/\/www\.shopcrank\.com\/api\/voice\/twilio\/status\/reliable-auto-services" statusCallbackMethod="POST"/,
  );
});

test('apex-host Twilio callbacks are answered instead of redirected', async () => {
  const xml = await incomingTwiml(ENV, 'shopcrank.com');
  assert.match(streamUrlFrom(xml), /^wss:\/\/shopcrank\.com\/api\/voice\/twilio\/stream\/reliable-auto-services\//);
});

test('the voice status callback accepts signed POSTs and rejects everything else', async () => {
  const authToken = 'twilio-auth-token-0123456789';
  const url = 'https://www.shopcrank.com/api/voice/twilio/status/reliable-auto-services';
  const params = new URLSearchParams({
    CallSid: 'CA0123456789abcdef',
    StreamSid: 'MZ0123456789abcdef',
    StreamEvent: 'stream-error',
    StreamError: 'WebSocket handshake failed',
  });
  const env = { TWILIO_AUTH_TOKEN: authToken };
  const post = (signature) => worker.fetch(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: params.toString(),
  }), env);

  const originalError = console.error;
  const logged = [];
  console.error = (line) => logged.push(line);
  let ok;
  try {
    ok = await post(twilioSignature(authToken, url, params));
  } finally {
    console.error = originalError;
  }
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /<Response\/>/);
  assert.ok(logged.some(line => /stream-error/.test(line) && /WebSocket handshake failed/.test(line)));

  assert.equal((await post('bad-signature')).status, 401);
  const get = await worker.fetch(new Request(url), env);
  assert.equal(get.status, 405);
});

test('a call status callback (no StreamEvent) is acknowledged', async () => {
  const response = await worker.fetch(new Request('https://www.shopcrank.com/api/voice/twilio/status/reliable-auto-services', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: 'CA1', CallStatus: 'completed', CallDuration: '42' }).toString(),
  }), ENV);
  assert.equal(response.status, 200);
});

// --- Durable Object bridge, with minimal Workers WebSocket stand-ins ---

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    this.closedWith = null;
  }
  accept() { this.readyState = 1; }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    for (const fn of this.listeners.close || []) fn({ code, reason });
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
}

async function onUpstreamTool(upstream, message) {
  await Promise.all((upstream.listeners.message || []).map(fn => fn({ data: JSON.stringify(message) })));
}

function withWorkersRuntime(run) {
  const originals = {
    WebSocketPair: globalThis.WebSocketPair,
    WebSocket: globalThis.WebSocket,
    Response: globalThis.Response,
    error: console.error,
  };
  const BaseResponse = globalThis.Response;
  const pairs = [];
  globalThis.WebSocketPair = function WebSocketPair() {
    const pair = { 0: new FakeSocket(), 1: new FakeSocket() };
    pairs.push(pair);
    return pair;
  };
  globalThis.WebSocket = { OPEN: 1 };
  globalThis.Response = class extends BaseResponse {
    constructor(body, init = {}) {
      if (init.status !== 101) {
        super(body, init);
        return;
      }
      super(null, { status: 200 });
      Object.defineProperty(this, 'status', { value: 101 });
      this.webSocket = init.webSocket;
    }
  };
  console.error = () => {};
  return Promise.resolve(run(pairs)).finally(() => {
    globalThis.WebSocketPair = originals.WebSocketPair;
    globalThis.WebSocket = originals.WebSocket;
    globalThis.Response = originals.Response;
    console.error = originals.error;
  });
}

test('the bridge completes Twilio\'s handshake even when xAI rejects the upgrade', () => withWorkersRuntime(async (pairs) => {
  const pending = [];
  const response = await handleGrokTwilioBridge({
    env: {},
    state: { waitUntil: promise => pending.push(promise) },
    shopId: 'reliable-auto-services',
    apiKey: 'xai-bad-key',
    fetcher: async () => new Response('{"error":"invalid api key"}', { status: 401 }),
  });
  assert.equal(response.status, 101, 'Twilio gets a 101 instead of a handshake error');
  await Promise.all(pending);
  const twilioSide = pairs[0][1];
  assert.equal(twilioSide.closedWith?.code, 1011, 'the stream closes so Twilio plays the <Say> fallback');
}));

test('the bridge greets the caller once Twilio starts and xAI is connected', () => withWorkersRuntime(async (pairs) => {
  const upstream = new FakeSocket();
  let releaseUpstream;
  const upstreamReady = new Promise(resolve => { releaseUpstream = resolve; });
  const pending = [];
  const response = await handleGrokTwilioBridge({
    env: {},
    state: { waitUntil: promise => pending.push(promise) },
    shopId: 'reliable-auto-services',
    callerPhone: '+18065550123',
    apiKey: 'xai-test-key',
    fetcher: async (url, init) => {
      assert.equal(url, 'https://api.x.ai/v1/realtime?model=grok-voice-latest');
      assert.equal(init.headers.Upgrade, 'websocket');
      await upstreamReady;
      return { status: 101, webSocket: upstream };
    },
  });
  assert.equal(response.status, 101, 'the handshake does not wait on xAI');

  const twilioSide = pairs[0][1];
  twilioSide.emit('message', { data: JSON.stringify({ event: 'connected' }) });
  twilioSide.emit('message', { data: JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', customParameters: {} } }) });
  twilioSide.emit('message', { data: JSON.stringify({ event: 'media', media: { payload: 'f/9/' } }) });

  releaseUpstream();
  await Promise.all(pending);

  const sentTypes = upstream.sent.map(item => JSON.parse(item).type);
  assert.deepEqual(sentTypes, [
    'session.update',
    'input_audio_buffer.append',
    'conversation.item.create',
    'response.create',
  ]);
  assert.ok(JSON.parse(upstream.sent[1]).audio, 'buffered startup audio is forwarded to xAI');

  upstream.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(12).toString('base64') }) });
  const toTwilio = twilioSide.sent.map(item => JSON.parse(item));
  assert.equal(toTwilio.at(-1).event, 'media');
  assert.equal(toTwilio.at(-1).streamSid, 'MZ1');

  upstream.emit('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
  assert.deepEqual(JSON.parse(twilioSide.sent.at(-1)), { event: 'clear', streamSid: 'MZ1' }, 'barge-in clears playback');

  upstream.emit('message', { data: JSON.stringify({ type: 'constructor' }) });
  const sentBeforeTool = upstream.sent.length;
  await onUpstreamTool(upstream, {
    type: 'response.function_call_arguments.done',
    name: 'no_such_tool',
    call_id: 'call-1',
    arguments: '{}',
  });
  const toolReply = upstream.sent.slice(sentBeforeTool).map(item => JSON.parse(item));
  assert.equal(toolReply[0].item.type, 'function_call_output');
  assert.equal(toolReply[0].item.call_id, 'call-1');
  assert.equal(toolReply[1].type, 'response.create');

  twilioSide.emit('message', { data: JSON.stringify({ event: 'stop' }) });
  assert.equal(upstream.readyState, 3, 'hanging up closes the xAI session');
}));

test('the bridge closes Twilio when startup audio exceeds the buffer limit', () => withWorkersRuntime(async (pairs) => {
  const pending = [];
  const response = await handleGrokTwilioBridge({
    env: {},
    state: { waitUntil: promise => pending.push(promise) },
    shopId: 'reliable-auto-services',
    apiKey: 'xai-test-key',
    fetcher: () => new Promise(() => {}),
  });
  assert.equal(response.status, 101);

  const twilioSide = pairs[0][1];
  twilioSide.emit('message', {
    data: JSON.stringify({ event: 'media', media: { payload: 'A'.repeat(256 * 1024 + 1) } }),
  });
  assert.equal(twilioSide.closedWith?.code, 1011, 'Twilio plays the fallback after the startup buffer limit');
}));
