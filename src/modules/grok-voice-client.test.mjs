import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGrokCallToIntakeDraft,
  createGrokVoiceSession,
  float32ToPcm16Base64,
  grokPhasePlaceholder,
  grokWaveformButtonIcon,
  pcm16Base64ToFloat32,
} from './grok-voice-client.js';
import { emptyIntakeDraft } from './intake-wizard.js';

test('grokWaveformButtonIcon renders stroked SVG when idle and 4-bar waveform when active', () => {
  const idle = grokWaveformButtonIcon(false, 'idle');
  assert.match(idle, /<svg class="grok-waveform-svg"/);
  assert.match(idle, /stroke="currentColor"/);

  const live = grokWaveformButtonIcon(true, 'speaking');
  assert.match(live, /class="grok-waveform-bars"/);
  assert.match(live, /data-phase="speaking"/);
  assert.equal((live.match(/<span><\/span>/g) || []).length, 4);
});

test('grokPhasePlaceholder matches voice phase labels', () => {
  assert.equal(grokPhasePlaceholder('connecting'), 'Connecting…');
  assert.equal(grokPhasePlaceholder('listening'), 'Listening…');
  assert.equal(grokPhasePlaceholder('thinking'), 'Thinking…');
  assert.equal(grokPhasePlaceholder('speaking'), 'Speaking…');
  assert.equal(grokPhasePlaceholder('idle'), '');
});

test('float32ToPcm16Base64 and pcm16Base64ToFloat32 round-trip 24kHz audio', () => {
  const input = new Float32Array([0, 0.5, -0.5, 0.25, -0.25]);
  const b64 = float32ToPcm16Base64(input, 24000, 24000);
  const output = pcm16Base64ToFloat32(b64);
  assert.equal(output.length, input.length);
  for (let i = 0; i < input.length; i += 1) {
    assert.ok(Math.abs(output[i] - input[i]) < 0.001);
  }
});

test('applyGrokCallToIntakeDraft fills customer, vehicle, concern, and estimate lines with AI badges', () => {
  const draft = applyGrokCallToIntakeDraft(emptyIntakeDraft(), {
    customer: {
      firstName: 'Jake',
      lastName: 'Miller',
      phone: '+18065550188',
      email: 'jake@example.com',
    },
    vehicle: {
      year: '2018',
      make: 'Ram',
      model: '1500',
      vin: '1c6rr7lt0js123456',
      mileage: '88500',
    },
    concern: {
      description: 'Alternator not charging, battery light on',
      lights: 'Battery warning light',
    },
    estimate: {
      lines: [
        { type: 'labor', description: 'Alternator Replacement', quantity: 1.4, unitPrice: 140 },
      ],
    },
  });

  assert.equal(draft.customer.firstName, 'Jake');
  assert.equal(draft.customer.lastName, 'Miller');
  assert.equal(draft.customer.phone, '+18065550188');
  assert.equal(draft.vehicle.vin, '1C6RR7LT0JS123456');
  assert.equal(draft.vehicle.year, '2018');
  assert.equal(draft.vehicle.make, 'Ram');
  assert.equal(draft.vehicle.model, '1500');
  assert.equal(draft.concern.description, 'Alternator not charging, battery light on');
  assert.equal(draft.estimate.lines.length, 1);
  assert.equal(draft.aiFilledFields['vehicle.vin'], true);
  assert.equal(draft.aiFilledFields['concern.description'], true);
  assert.equal(draft.aiFilledFields['estimate.lines'], true);
});

for (const greetAsReceptionist of [false, true]) {
  for (const fallback of [false, true]) {
    test(`voice client uses the same ${greetAsReceptionist ? 'front desk' : 'tech assistant'} persona for secret and tool calls${fallback ? ' after mic fallback' : ''}`, async (t) => {
      const originals = Object.fromEntries(['window', 'navigator', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      t.after(() => {
        for (const [key, descriptor] of Object.entries(originals)) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      });
      const node = () => ({ connect() {}, disconnect() {} });
      class AudioContext {
        state = 'running';
        sampleRate = 24000;
        createMediaStreamSource() { return node(); }
        createScriptProcessor() { return node(); }
        async close() {}
      }
      const sockets = [];
      class Socket {
        static OPEN = 1;
        readyState = 1;
        sent = [];
        listeners = {};
        constructor() { sockets.push(this); }
        addEventListener(type, listener) { this.listeners[type] = listener; }
        send(message) { this.sent.push(JSON.parse(message)); }
        close() {}
      }
      let micAttempts = 0;
      const track = { stop() {} };
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext } });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
        async getUserMedia() {
          if (fallback && micAttempts++ === 0) {
            const error = new Error('device constraint');
            error.name = 'OverconstrainedError';
            throw error;
          }
          return { getTracks: () => [track] };
        },
      } } });
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
      const requests = [];
      const session = createGrokVoiceSession({
        greetAsReceptionist,
        callerPhone: '+18065550123',
        apiFetch: async (path, options) => {
          requests.push({ path, body: JSON.parse(options.body) });
          return path.endsWith('client-secret') ? { token: 'test-ephemeral-token' } : { result: { available: true } };
        },
        onError: error => assert.fail(error.message),
      });
      await session.start();
      assert.equal(session.isActive(), true);
      sockets[0].listeners.open();
      await sockets[0].listeners.message({ data: JSON.stringify({ type: 'response.function_call_arguments.done', name: 'get_shop_hours_and_directions', call_id: 'tool-1', arguments: '{}' }) });
      session.stop();
      const persona = greetAsReceptionist ? 'front_desk' : 'tech_assistant';
      assert.equal(requests.filter(request => request.path.endsWith('client-secret')).length, fallback ? 2 : 1);
      assert.equal(requests.filter(request => request.path.endsWith('/tool')).length, 1);
      assert.ok(requests.every(request => request.body.persona === persona));
      assert.equal(sockets[0].sent.some(message => message.type === 'response.create'), true);
    });
  }
}
