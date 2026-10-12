import {
  buildAssistantSystemPrompt,
  calculateVoiceCost,
  loadShopPricing,
  loadVoiceShopContext,
  recordAiUsage,
  selectAnthropicModel,
} from './ai.mjs';
import { HttpError } from './http.mjs';

const DEEPGRAM_AGENT_URL = 'https://agent.deepgram.com/v1/agent/converse';
const INPUT_SAMPLE_RATE = 16000;
const LINEAR16_BYTES_PER_SAMPLE = 2;

export function buildDeepgramSettings(env, shopContext = [], pricing) {
  const route = selectAnthropicModel(env);
  const grounding = shopContext.length
    ? `\n\nCurrent read-only shop snapshot (may be incomplete or stale; say so and ask staff to verify when needed): ${JSON.stringify(shopContext)}`
    : '\n\nNo shop records were available for this session. Ask for the record or diagnostic data needed to answer accurately.';
  return {
    type: 'Settings',
    tags: ['mechpro', 'shop-assistant'],
    mip_opt_out: true,
    audio: {
      input: { encoding: 'linear16', sample_rate: INPUT_SAMPLE_RATE },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent: {
      listen: {
        provider: {
          type: 'deepgram',
          model: String(env.DEEPGRAM_LISTEN_MODEL || 'nova-3'),
          smart_format: true,
          language: 'en',
        },
      },
      think: {
        provider: { type: 'anthropic', model: route.model, temperature: 0.2 },
        endpoint: {
          url: 'https://api.anthropic.com/v1/messages',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
        },
        prompt: `${buildAssistantSystemPrompt(pricing, { allowEstimatePreparation: false })}

This is a spoken conversation. Keep the delivery natural, but do not sacrifice needed detail or accuracy. The snapshot is context, not proof that no other record exists. Voice tools for live record refresh are not available yet; explicitly ask the user to open or identify a record when the snapshot is insufficient.${grounding}`,
      },
      speak: {
        provider: {
          type: 'deepgram',
          version: 'v2',
          model: String(env.DEEPGRAM_SPEAK_MODEL || 'flux-kit-en'),
        },
      },
    },
  };
}

function safeClose(socket, code = 1011, reason = 'Voice session ended') {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // The peer may already be closed.
  }
}

export class AiVoiceSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      throw new HttpError(426, 'A WebSocket upgrade is required');
    }
    const shopId = request.headers.get('X-MechPro-Shop-Id');
    const userId = request.headers.get('X-MechPro-User-Id');
    if (!shopId || !userId) throw new HttpError(401, 'Authenticated shop context is required');
    if (!String(this.env.DEEPGRAM_API_KEY || '').trim() || !String(this.env.ANTHROPIC_API_KEY || '').trim()) {
      throw new HttpError(503, 'Voice AI is not configured');
    }

    const [upstreamResponse, shopContext, pricing] = await Promise.all([
      fetch(DEEPGRAM_AGENT_URL, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Token ${this.env.DEEPGRAM_API_KEY}`,
        },
      }),
      loadVoiceShopContext(this.env, shopId),
      loadShopPricing(this.env, shopId),
    ]);
    const upstream = upstreamResponse.webSocket;
    if (!upstream || upstreamResponse.status !== 101) {
      throw new HttpError(502, 'Deepgram Voice Agent is unavailable');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    upstream.accept();

    const settings = JSON.stringify(buildDeepgramSettings(this.env, shopContext, pricing));
    const model = selectAnthropicModel(this.env).model;
    let settingsSent = false;
    let inputAudioBytes = 0;
    let finalized = false;

    const finalize = async (reason) => {
      if (finalized) return;
      finalized = true;
      const voiceSeconds = inputAudioBytes / (INPUT_SAMPLE_RATE * LINEAR16_BYTES_PER_SAMPLE);
      const costs = calculateVoiceCost(this.env, voiceSeconds);
      try {
        await recordAiUsage(this.env, {
          shopId,
          userId,
          channel: 'voice',
          provider: 'deepgram',
          model,
          voiceSeconds,
          ...costs,
          metadata: {
            reason,
            metering: 'linear16_input_audio',
            anthropicTokenUsage: 'not_exposed_by_deepgram_voice_agent',
          },
        });
      } catch (error) {
        console.error(JSON.stringify({
          message: 'Voice usage metering failed',
          shopId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    };

    server.addEventListener('message', event => {
      if (event.data instanceof ArrayBuffer) inputAudioBytes += event.data.byteLength;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
    });
    server.addEventListener('close', event => {
      safeClose(upstream, event.code || 1000, event.reason || 'Client disconnected');
      this.state.waitUntil(finalize('client_closed'));
    });
    server.addEventListener('error', () => {
      safeClose(upstream);
      this.state.waitUntil(finalize('client_error'));
    });

    upstream.addEventListener('message', event => {
      if (!settingsSent && typeof event.data === 'string') {
        try {
          if (JSON.parse(event.data).type === 'Welcome') {
            upstream.send(settings);
            settingsSent = true;
          }
        } catch {
          // Forward malformed provider messages so the client can surface them.
        }
      }
      if (server.readyState === WebSocket.OPEN) server.send(event.data);
    });
    upstream.addEventListener('close', event => {
      safeClose(server, event.code || 1000, event.reason || 'Provider disconnected');
      this.state.waitUntil(finalize('provider_closed'));
    });
    upstream.addEventListener('error', () => {
      safeClose(server);
      this.state.waitUntil(finalize('provider_error'));
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
