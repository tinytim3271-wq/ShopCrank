import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGrokToTwilioTranscoder,
  createTwilioToGrokTranscoder,
  handleGrokTwilioBridge,
  mulawByteToPcm16,
  pcm16ToMulawByte,
} from '../src/grok-voice.mjs';

const GROK_RATE = 24000;

function tone(frequency, seconds, amplitude = 8000, rate = GROK_RATE) {
  const samples = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / rate));
  return samples;
}

const pcmBytes = samples => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
const decodeMulaw = base64 => Array.from(Buffer.from(base64, 'base64'), mulawByteToPcm16);

/** Splits bytes into deltas of uneven sizes, including odd byte counts, like a live stream. */
function unevenChunks(bytes, sizes = [1, 7, 481, 960, 3, 1201, 2, 4799]) {
  const chunks = [];
  for (let offset = 0, i = 0; offset < bytes.length; i += 1) {
    const size = sizes[i % sizes.length];
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

function streamGrokAudio(bytes, chunks = unevenChunks(bytes)) {
  const transcoder = createGrokToTwilioTranscoder();
  return chunks.flatMap(chunk => decodeMulaw(transcoder.push(Buffer.from(chunk).toString('base64'))));
}

function rms(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

test('Grok audio split across uneven deltas plays back at real-time length with no lost samples', () => {
  const bytes = pcmBytes(tone(1000, 1));
  const streamed = streamGrokAudio(bytes);
  assert.equal(streamed.length, 8000, 'one second at 24 kHz becomes exactly one second at 8 kHz');
  assert.deepEqual(streamed, streamGrokAudio(bytes, [bytes]), 'chunking does not change the audio');
});

test('Grok speech in the telephone band keeps its level after downsampling', () => {
  const streamed = streamGrokAudio(pcmBytes(tone(1000, 1)));
  const settled = streamed.slice(100);
  const ratio = rms(settled) / (8000 / Math.SQRT2);
  assert.ok(ratio > 0.9 && ratio < 1.1, `1 kHz level ratio ${ratio.toFixed(3)}`);
});

test('high-frequency Grok audio is filtered out instead of folding into the call audio', () => {
  for (const frequency of [5000, 6000, 9000]) {
    const settled = streamGrokAudio(pcmBytes(tone(frequency, 1))).slice(100);
    const ratio = rms(settled) / (8000 / Math.SQRT2);
    assert.ok(ratio < 0.05, `${frequency} Hz leaks at ${(ratio * 100).toFixed(1)}% of its level`);
  }
});

test('caller audio upsampled frame by frame matches one continuous conversion', () => {
  const caller = tone(440, 0.5, 6000, 8000);
  const mulaw = Buffer.from(Array.from(caller, pcm16ToMulawByte));
  const framed = createTwilioToGrokTranscoder();
  const pieces = [];
  for (let offset = 0; offset < mulaw.length; offset += 160) {
    pieces.push(Buffer.from(framed.push(mulaw.subarray(offset, offset + 160).toString('base64')), 'base64'));
  }
  const whole = Buffer.from(createTwilioToGrokTranscoder().push(mulaw.toString('base64')), 'base64');
  assert.equal(whole.length, caller.length * 3 * 2);
  assert.deepEqual(Buffer.concat(pieces), whole, '20 ms Twilio frames join without seams');
});

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
  }
  accept() { this.readyState = 1; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
}

test('the phone bridge forwards uneven Grok deltas to Twilio as continuous audio', async () => {
  const originals = { WebSocketPair: globalThis.WebSocketPair, WebSocket: globalThis.WebSocket, Response: globalThis.Response, error: console.error };
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
      super(init.status === 101 ? null : body, init.status === 101 ? { status: 200 } : init);
      if (init.status === 101) this.webSocket = init.webSocket;
    }
  };
  console.error = () => {};
  try {
    const upstream = new FakeSocket();
    const pending = [];
    await handleGrokTwilioBridge({
      env: {},
      state: { waitUntil: promise => pending.push(promise) },
      shopId: 'reliable-auto-services',
      apiKey: 'xai-test-key',
      fetcher: async () => ({ status: 101, webSocket: upstream }),
    });
    await Promise.all(pending);
    const twilioSide = pairs[0][1];
    twilioSide.emit('message', { data: JSON.stringify({ event: 'start', start: { streamSid: 'MZ-audio' } }) });

    const bytes = pcmBytes(tone(1000, 0.5));
    for (const chunk of unevenChunks(bytes)) {
      upstream.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.from(chunk).toString('base64') }) });
    }
    const media = twilioSide.sent.map(item => JSON.parse(item)).filter(item => item.event === 'media');
    assert.ok(media.every(item => item.streamSid === 'MZ-audio'));
    const played = media.flatMap(item => decodeMulaw(item.media.payload));
    assert.deepEqual(played, streamGrokAudio(bytes, [bytes]), 'Twilio receives the same audio as one clean conversion');
  } finally {
    Object.assign(globalThis, { WebSocketPair: originals.WebSocketPair, WebSocket: originals.WebSocket, Response: originals.Response });
    console.error = originals.error;
  }
});
