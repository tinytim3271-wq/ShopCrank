// Grok Realtime Speech-to-Speech client & automotive intake auto-fill helper.
// Connects to wss://api.x.ai/v1/realtime?model=grok-voice-latest using ephemeral
// client secrets minted by POST /api/ai/voice/client-secret.

import { emptyIntakeDraft } from './intake-wizard.js';

export const GROK_TARGET_SAMPLE_RATE = 24000;
const PLAYBACK_LEAD_SECONDS = 0.15;
const CAPTURE_CHUNK_MS = 100;
const MAX_PREOPEN_CHUNKS = 30;

export const GROK_VOICE_OPTIONS = Object.freeze([
  { id: 'eve', label: 'Eve (Warm & Capable — Default)' },
  { id: 'ara', label: 'Ara (Upbeat & Friendly)' },
  { id: 'rex', label: 'Rex (Calm & Professional)' },
  { id: 'sal', label: 'Sal (Smooth & Balanced)' },
  { id: 'leo', label: 'Leo (Authoritative & Clear)' },
]);

/**
 * Stroked waveform SVG (16px) for idle voice button, and 4-bar animated waveform when active.
 * Microphone icon is reserved for dictation.
 */
export function grokWaveformButtonIcon(active = false, phase = 'idle') {
  if (!active) {
    return `<svg class="grok-waveform-svg" width="16" height="16" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="48" y1="96" x2="48" y2="160"/><line x1="88" y1="56" x2="88" y2="200"/><line x1="128" y1="32" x2="128" y2="224"/><line x1="168" y1="64" x2="168" y2="192"/><line x1="208" y1="96" x2="208" y2="160"/></svg>`;
  }
  return `<span class="grok-waveform-bars" data-phase="${phase}" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`;
}

export function grokPhasePlaceholder(phase = 'idle') {
  switch (phase) {
    case 'connecting':
      return 'Connecting…';
    case 'listening':
      return 'Listening…';
    case 'thinking':
      return 'Thinking…';
    case 'speaking':
      return 'Speaking…';
    default:
      return '';
  }
}

export function float32ToPcm16Base64(float32Samples, inputSampleRate = GROK_TARGET_SAMPLE_RATE, targetRate = GROK_TARGET_SAMPLE_RATE) {
  if (!float32Samples?.length) return '';
  let samples = float32Samples;
  if (inputSampleRate !== targetRate && inputSampleRate > 0) {
    const ratio = inputSampleRate / targetRate;
    const outLength = Math.max(1, Math.round(float32Samples.length / ratio));
    const resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const srcIdx = i * ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(float32Samples.length - 1, i0 + 1);
      const frac = srcIdx - i0;
      resampled[i] = float32Samples[i0] * (1 - frac) + float32Samples[i1] * frac;
    }
    samples = resampled;
  }
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, Math.round(int16), true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return globalThis.btoa(binary);
}

export function pcm16Base64ToFloat32(base64) {
  if (!base64) return new Float32Array(0);
  const binary = globalThis.atob(String(base64));
  const sampleCount = Math.floor(binary.length / 2);
  const bytes = new Uint8Array(sampleCount * 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    float32[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return float32;
}

/**
 * Merges a Grok tool output or intake payload into a Shop Crank Customer Intake Wizard draft.
 */
export function applyGrokCallToIntakeDraft(existingDraft = null, grokIntake = {}) {
  const base = structuredClone(existingDraft || emptyIntakeDraft());
  const source = grokIntake?.intakeDraft || grokIntake || {};
  base.aiFilledFields = { ...(base.aiFilledFields || {}), ...(source.aiFilledFields || {}) };

  const setIfPresent = (target, key, value, aiPath) => {
    const clean = String(value ?? '').trim();
    if (!clean) return;
    target[key] = clean;
    if (aiPath) base.aiFilledFields[aiPath] = true;
  };

  const cust = source.customer || {};
  setIfPresent(base.customer, 'firstName', cust.firstName, 'customer.firstName');
  setIfPresent(base.customer, 'lastName', cust.lastName, 'customer.lastName');
  setIfPresent(base.customer, 'phone', cust.phone, 'customer.phone');
  setIfPresent(base.customer, 'email', cust.email, 'customer.email');
  setIfPresent(base.customer, 'address', cust.address, 'customer.address');
  setIfPresent(base.customer, 'city', cust.city, 'customer.city');
  setIfPresent(base.customer, 'state', cust.state, 'customer.state');
  setIfPresent(base.customer, 'zip', cust.zip, 'customer.zip');

  const veh = source.vehicle || {};
  setIfPresent(base.vehicle, 'vin', veh.vin ? String(veh.vin).toUpperCase() : '', 'vehicle.vin');
  setIfPresent(base.vehicle, 'plate', veh.plate ? String(veh.plate).toUpperCase() : '', 'vehicle.plate');
  setIfPresent(base.vehicle, 'plateState', veh.plateState, 'vehicle.plateState');
  setIfPresent(base.vehicle, 'year', veh.year, 'vehicle.year');
  setIfPresent(base.vehicle, 'make', veh.make, 'vehicle.make');
  setIfPresent(base.vehicle, 'model', veh.model, 'vehicle.model');
  setIfPresent(base.vehicle, 'trim', veh.trim, 'vehicle.trim');
  setIfPresent(base.vehicle, 'engine', veh.engine, 'vehicle.engine');
  setIfPresent(base.vehicle, 'mileage', veh.mileage, 'vehicle.mileage');
  setIfPresent(base.vehicle, 'color', veh.color, 'vehicle.color');

  const concern = source.concern || {};
  setIfPresent(base.concern, 'description', concern.description, 'concern.description');
  setIfPresent(base.concern, 'began', concern.began, 'concern.began');
  setIfPresent(base.concern, 'frequency', concern.frequency, 'concern.frequency');
  setIfPresent(base.concern, 'lights', concern.lights, 'concern.lights');
  setIfPresent(base.concern, 'recentRepairs', concern.recentRepairs, 'concern.recentRepairs');
  setIfPresent(base.concern, 'towed', concern.towed, 'concern.towed');
  setIfPresent(base.concern, 'overheating', concern.overheating, 'concern.overheating');

  if (Array.isArray(source.estimate?.lines) && source.estimate.lines.length) {
    base.estimate.lines = source.estimate.lines.map((line) => ({
      type: line.type === 'part' ? 'part' : 'labor',
      description: String(line.description || line.service || '').trim(),
      quantity: Number(line.quantity || line.hours || 1),
      unitPrice: Number(line.unitPrice || 0),
      source: line.source || 'Grok Voice Estimate',
      aiFilled: true,
    }));
    base.aiFilledFields['estimate.lines'] = true;
  }

  base.savedAt = new Date().toISOString();
  return base;
}

export function createGrokVoiceSession({
  apiFetch,
  voice = '',
  callerPhone = '',
  greetAsReceptionist = false,
  onPhaseChange = () => {},
  onUserTranscript = () => {},
  onAssistantTranscript = () => {},
  onIntakeSaved = () => {},
  onEstimateCalculated = () => {},
  onError = () => {},
} = {}) {
  let ws = null;
  let audioCtx = null;
  let mediaStream = null;
  let sourceNode = null;
  let processorNode = null;
  let active = false;
  let phase = 'idle';
  let nextPlayTime = 0;
  const activeSources = new Set();
  const preOpenQueue = [];
  const userItemMap = new Map();
  let currentAssistantText = '';

  const setPhase = (next) => {
    if (phase === next) return;
    phase = next;
    onPhaseChange(phase);
  };

  const stopPlayback = () => {
    for (const src of activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped nodes
      }
    }
    activeSources.clear();
    if (audioCtx) {
      nextPlayTime = audioCtx.currentTime;
    }
  };

  const schedulePcmDelta = (base64Delta) => {
    if (!audioCtx || !active) return;
    const samples = pcm16Base64ToFloat32(base64Delta);
    if (!samples.length) return;
    const buffer = audioCtx.createBuffer(1, samples.length, GROK_TARGET_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (nextPlayTime < now + 0.02) {
      nextPlayTime = now + PLAYBACK_LEAD_SECONDS;
    }
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      if (activeSources.size === 0 && active && phase === 'speaking') {
        setPhase('listening');
      }
    };
  };

  const stop = () => {
    active = false;
    stopPlayback();
    try {
      processorNode?.disconnect();
      sourceNode?.disconnect();
    } catch {
      // ignore
    }
    processorNode = null;
    sourceNode = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    if (ws) {
      try {
        ws.close(1000, 'Client ended Grok Voice session');
      } catch {
        // ignore
      }
      ws = null;
    }
    if (audioCtx) {
      try {
        void audioCtx.close();
      } catch {
        // ignore
      }
      audioCtx = null;
    }
    setPhase('idle');
  };

  const sendTextTurn = (text) => {
    const clean = String(text || '').trim();
    if (!clean || !ws || ws.readyState !== globalThis.WebSocket.OPEN) return false;
    stopPlayback();
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: clean }],
      },
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    setPhase('thinking');
    return true;
  };

  const start = async () => {
    if (active) {
      stop();
      return;
    }
    active = true;
    setPhase('connecting');

    try {
      // Create AudioContext inside the user gesture (autoplay policy)
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextCtor({ sampleRate: GROK_TARGET_SAMPLE_RATE });
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // Start mic and token fetch in parallel
      const [stream, secretPayload] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: GROK_TARGET_SAMPLE_RATE,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
        apiFetch('/ai/voice/client-secret', {
          method: 'POST',
          body: JSON.stringify({ voice: voice || undefined, callerPhone: callerPhone || undefined }),
        }),
      ]);

      if (!active) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      mediaStream = stream;
      sourceNode = audioCtx.createMediaStreamSource(stream);
      const bufferSize = 2048;
      processorNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);

      let sampleAccumulator = [];
      let accumulatedCount = 0;
      const samplesPerChunk = Math.round((audioCtx.sampleRate * CAPTURE_CHUNK_MS) / 1000);

      processorNode.onaudioprocess = (audioEvent) => {
        if (!active) return;
        const inputData = audioEvent.inputBuffer.getChannelData(0);
        sampleAccumulator.push(new Float32Array(inputData));
        accumulatedCount += inputData.length;
        if (accumulatedCount < samplesPerChunk) return;

        const merged = new Float32Array(accumulatedCount);
        let offset = 0;
        for (const chunk of sampleAccumulator) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        sampleAccumulator = [];
        accumulatedCount = 0;

        const base64Audio = float32ToPcm16Base64(merged, audioCtx.sampleRate, GROK_TARGET_SAMPLE_RATE);
        if (!base64Audio) return;

        if (ws && ws.readyState === globalThis.WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: base64Audio,
          }));
        } else if (preOpenQueue.length < MAX_PREOPEN_CHUNKS) {
          preOpenQueue.push(base64Audio);
        }
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioCtx.destination);

      const wsUrl = secretPayload.url || 'wss://api.x.ai/v1/realtime?model=grok-voice-latest';
      ws = new globalThis.WebSocket(wsUrl, ['realtime', `xai-client-secret.${secretPayload.token}`]);

      ws.addEventListener('open', () => {
        if (!active || !ws) return;
        if (secretPayload.sessionUpdate) {
          ws.send(JSON.stringify(secretPayload.sessionUpdate));
        }
        while (preOpenQueue.length > 0) {
          const chunk = preOpenQueue.shift();
          ws.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: chunk,
          }));
        }
        setPhase('listening');
        if (greetAsReceptionist) {
          ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{
                type: 'input_text',
                text: '[A customer just called the shop phone line. Answer the phone warmly as Grok, the shop service advisor, and ask how you can help with their vehicle today.]',
              }],
            },
          }));
          ws.send(JSON.stringify({ type: 'response.create' }));
        }
      });

      ws.addEventListener('message', async (ev) => {
        if (!active) return;
        let event;
        try {
          event = JSON.parse(String(ev.data));
        } catch {
          return;
        }

        if (event.type === 'input_audio_buffer.speech_started') {
          stopPlayback();
          setPhase('listening');
          return;
        }

        if (event.type === 'input_audio_buffer.speech_stopped') {
          setPhase('thinking');
          return;
        }

        if (event.type === 'input_audio_buffer.committed' && event.item_id) {
          userItemMap.set(event.item_id, '');
          return;
        }

        if (
          event.type === 'conversation.item.input_audio_transcription.updated'
          || event.type === 'conversation.item.input_audio_transcription.completed'
        ) {
          const transcript = String(event.transcript || '').trim();
          if (transcript) {
            const isFinal = event.type.endsWith('.completed');
            userItemMap.set(event.item_id || 'latest', transcript);
            onUserTranscript(transcript, { itemId: event.item_id || 'latest', final: isFinal });
          }
          return;
        }

        if (event.type === 'response.created') {
          currentAssistantText = '';
          return;
        }

        if (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') {
          if (event.delta) {
            setPhase('speaking');
            schedulePcmDelta(event.delta);
          }
          return;
        }

        if (event.type === 'response.output_audio_transcript.delta' || event.type === 'response.audio_transcript.delta') {
          currentAssistantText += String(event.delta || '');
          onAssistantTranscript(currentAssistantText, { final: false });
          return;
        }

        if (event.type === 'response.output_audio_transcript.done' || event.type === 'response.audio_transcript.done') {
          const finalTranscript = String(event.transcript || currentAssistantText).trim();
          if (finalTranscript) {
            onAssistantTranscript(finalTranscript, { final: true });
          }
          currentAssistantText = '';
          return;
        }

        if (event.type === 'response.function_call_arguments.done') {
          const toolName = String(event.name || '');
          const callId = String(event.call_id || '');
          let args = {};
          try {
            args = JSON.parse(event.arguments || '{}');
          } catch {
            args = {};
          }
          try {
            const response = await apiFetch('/ai/voice/tool', {
              method: 'POST',
              body: JSON.stringify({ name: toolName, arguments: args, callerPhone }),
            });
            const toolResult = response?.result || {};
            if (toolName === 'calculate_service_estimate') {
              onEstimateCalculated(toolResult);
            }
            if (toolName === 'save_call_intake_and_estimate' && toolResult?.action) {
              onIntakeSaved(toolResult);
            }
            if (ws && ws.readyState === globalThis.WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: callId,
                  output: JSON.stringify(toolResult),
                },
              }));
              ws.send(JSON.stringify({ type: 'response.create' }));
            }
          } catch (toolErr) {
            if (ws && ws.readyState === globalThis.WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: callId,
                  output: JSON.stringify({ error: toolErr?.message || 'Tool execution failed' }),
                },
              }));
              ws.send(JSON.stringify({ type: 'response.create' }));
            }
          }
          return;
        }

        if (event.type === 'response.done') {
          if (activeSources.size === 0 && active) {
            setPhase('listening');
          }
        }
      });

      ws.addEventListener('close', () => {
        if (active) stop();
      });

      ws.addEventListener('error', () => {
        onError(new Error('Grok Realtime WebSocket connection interrupted'));
        if (active) stop();
      });
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      stop();
    }
  };

  return {
    start,
    stop,
    sendTextTurn,
    isActive: () => active,
    getPhase: () => phase,
  };
}
