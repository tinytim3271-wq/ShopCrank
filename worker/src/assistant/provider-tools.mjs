// Tool calling for every assistant provider. Claude, Gemini and Cloudflare
// Workers AI each describe tools and tool calls differently; these helpers turn
// the one tool list (tools.mjs) into each format and collect what tool results
// mean for the chat screen (cards, videos, sources, denials).

// Gemini takes an OpenAPI subset: no additionalProperties/default, and an
// object needs named properties, so a free-form object becomes JSON text.
const GEMINI_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'minimum', 'maximum', 'nullable', 'format']);

export function toGeminiSchema(schema = {}) {
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  if (schema.type === 'object' && !Object.keys(schema.properties || {}).length) {
    return { type: 'string', description: `${schema.description ? `${schema.description} ` : ''}Send it as JSON text.` };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_KEYS.has(key)) continue;
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toGeminiSchema(child)]));
    else if (key === 'items') out.items = toGeminiSchema(value);
    else out[key] = value;
  }
  if (out.required && out.properties) out.required = out.required.filter(name => name in out.properties);
  if (out.required && !out.required.length) delete out.required;
  return out;
}

/** tools.mjs list (anthropic format: name, description, input_schema) → Gemini tools field. */
export function geminiTools(tools = []) {
  if (!tools.length) return [];
  return [{
    functionDeclarations: tools.map(tool => {
      const parameters = toGeminiSchema(tool.input_schema || tool.parameters || {});
      return {
        name: tool.name,
        description: tool.description,
        ...(parameters.type === 'object' && Object.keys(parameters.properties || {}).length ? { parameters } : {}),
      };
    }),
  }];
}

/** Gemini function calls in a candidate: [{ name, args, id? }]. */
export function geminiFunctionCalls(response = {}) {
  return (response?.candidates?.[0]?.content?.parts || [])
    .filter(part => part?.functionCall?.name)
    .map(part => ({ name: part.functionCall.name, args: part.functionCall.args || {}, ...(part.functionCall.id ? { id: part.functionCall.id } : {}) }));
}

/** Workers AI ("traditional" function calling): { name, description, parameters }. */
export function workersAiTools(tools = []) {
  return tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} } }));
}

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')) || {}; } catch { return {}; }
}

/**
 * Tool calls from a Workers AI result. Models return them in tool_calls; some
 * Llama replies put one JSON call in the text instead, which is accepted only
 * when it names a known tool.
 */
export function workersAiToolCalls(result, knownNames = new Set()) {
  const calls = Array.isArray(result?.tool_calls) ? result.tool_calls : [];
  if (calls.length) {
    return calls
      .map(call => ({ name: call.name || call.function?.name, args: parseArgs(call.arguments ?? call.function?.arguments ?? call.parameters) }))
      .filter(call => call.name);
  }
  const text = typeof result?.response === 'string' ? result.response.trim() : '';
  if (!text.startsWith('{') || !text.endsWith('}')) return [];
  try {
    const parsed = JSON.parse(text);
    const name = parsed.name || parsed.function;
    if (!knownNames.has(name)) return [];
    return [{ name, args: parseArgs(parsed.parameters ?? parsed.arguments) }];
  } catch {
    return [];
  }
}

const MEDIA_KINDS = new Set(['youtube_search_results', 'youtube_player']);
const ACTION_KINDS = new Set(['estimate_work_order_draft', 'app_api_confirmation', 'open_screen']);

export function createToolBag() {
  return { actions: [], media: [], citations: [], accessDenied: [], sources: [], toolCalls: 0 };
}

/** Note what one tool result means for the screen (cards, videos, sources, denials). */
export function recordToolResult(bag, name, result = {}) {
  bag.toolCalls += 1;
  if (!result || typeof result !== 'object') return;
  if (ACTION_KINDS.has(result.kind) || result.requiresUserReview) bag.actions.push(result);
  if (MEDIA_KINDS.has(result.kind)) bag.media.push(result);
  if (Array.isArray(result.citations)) bag.citations.push(...result.citations);
  if (result.denied) bag.accessDenied.push({ tool: name, message: result.message });
  if (name === 'search_web' && Array.isArray(result.results)) bag.sources.push(...result.results.map(item => ({ title: item.title, url: item.url })));
  if (name === 'read_web_page' && result.url && !result.error) bag.sources.push({ title: result.title || result.url, url: result.url });
}

/** Fields a finished turn adds for the chat screen. */
export function toolBagFields(bag, dedupeCitations = list => list) {
  const seen = new Set();
  const sources = bag.sources.filter(item => item.url && !seen.has(item.url) && seen.add(item.url)).slice(0, 10);
  return {
    actions: bag.actions,
    ...(bag.citations.length ? { citations: dedupeCitations(bag.citations) } : {}),
    ...(bag.accessDenied.length ? { accessDenied: bag.accessDenied } : {}),
    ...(bag.media.length ? { media: bag.media } : {}),
    ...(sources.length ? { sources } : {}),
  };
}

/** Tool results go back to the model as text; keep them inside a provider's limits. */
export function toolResultText(result, max = 16_000) {
  const text = JSON.stringify(result ?? null);
  return text.length > max ? `${text.slice(0, max)}…(cut)` : text;
}
