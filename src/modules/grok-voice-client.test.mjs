import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGrokCallToIntakeDraft,
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
