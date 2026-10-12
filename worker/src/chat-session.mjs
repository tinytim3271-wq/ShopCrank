import {
  recordAiUsage,
  runAnthropicTurn,
  usageCostsForResult,
} from './ai.mjs';
import { HttpError, json, requestJson } from './http.mjs';

const MAX_STORED_MESSAGES = 20;

export class AiChatSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      return await this.handleTurn(request);
    } catch (error) {
      // Errors thrown inside a Durable Object lose their HttpError status at the
      // stub boundary, so return them as JSON the Worker can pass through.
      if (error instanceof HttpError) return json({ message: error.message }, error.status);
      console.error(JSON.stringify({ message: 'AI chat session failed', error: String(error?.message || error).slice(0, 300) }));
      return json({ message: 'The MechPro assistant is unavailable' }, 500);
    }
  }

  async handleTurn(request) {
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const shopId = request.headers.get('X-MechPro-Shop-Id');
    const userId = request.headers.get('X-MechPro-User-Id');
    const sessionId = request.headers.get('X-MechPro-Ai-Session-Id');
    if (!shopId || !userId || !sessionId) throw new HttpError(401, 'Authenticated shop context is required');

    const ownerShopId = await this.state.storage.get('shopId');
    if (ownerShopId && ownerShopId !== shopId) throw new HttpError(403, 'Chat session belongs to another shop');
    if (!ownerShopId) await this.state.storage.put('shopId', shopId);

    const body = await requestJson(request);
    const message = String(body.message || '').trim().slice(0, 4000);
    if (!message) throw new HttpError(400, 'A message is required');
    const storedHistory = await this.state.storage.get('history');
    const history = Array.isArray(storedHistory) && storedHistory.length
      ? storedHistory
      : Array.isArray(body.history) ? body.history : [];
    const result = await runAnthropicTurn(this.env, {
      shopId,
      message,
      history,
      requestedModel: body.model,
      autoEscalate: body.autoEscalate === true,
    });
    const costs = usageCostsForResult(this.env, result);
    await recordAiUsage(this.env, {
      shopId,
      userId,
      channel: 'text',
      provider: result.provider || 'anthropic',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ...costs,
      metadata: {
        routingReason: result.routingReason,
        sessionId,
        source: 'assistant',
        keySource: result.keySource || null,
        ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom, failureKind: result.failureKind } : {}),
      },
    });
    const nextHistory = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: result.text },
    ].slice(-MAX_STORED_MESSAGES);
    await this.state.storage.put('history', nextHistory);
    await this.state.storage.put('updatedAt', new Date().toISOString());
    return json({
      message: result.text,
      actions: result.actions,
      model: result.model,
      modelFamily: result.family,
      routingReason: result.routingReason,
      sessionId,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      provider: result.provider,
      keySource: result.keySource || null,
      ...(result.notice ? { notice: result.notice } : {}),
    });
  }
}
