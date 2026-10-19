// Shop settings panel for included Gemini plus optional provider override keys.

export const ANTHROPIC_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';
export const GEMINI_CONSOLE_URL = 'https://aistudio.google.com/app/apikey';
export const SHOP_AI_PROMPT = 'Gemini is included with your Shop Crank subscription. If you prefer, you can switch this shop to your own Claude (Anthropic) or Gemini key at any time.';

const MASK = '\u2022\u2022\u2022\u2022';

function providerOf(status = {}) {
  if (status.hasKey) return String(status.provider || 'gemini').toLowerCase();
  return String(status.includedProvider || 'gemini').toLowerCase();
}

function providerLabel(provider) {
  return provider === 'gemini' ? 'Gemini' : 'Claude';
}

function providerConsoleUrl(provider) {
  return provider === 'gemini' ? GEMINI_CONSOLE_URL : ANTHROPIC_CONSOLE_URL;
}

export function shopAiStatusLabel(status = {}) {
  const provider = providerOf(status);
  if (status.hasKey) {
    return `Using ${providerLabel(provider)} with your key ${status.maskedKey || MASK}`;
  }
  if (provider === 'gemini') return 'Using Gemini (included)';
  if (provider === 'anthropic') return 'Using Claude (included)';
  return 'Using Cloudflare AI (included)';
}

export function shopAiPanelHtml(status = {}, { canManage = false, escapeHtml = value => String(value ?? ''), icon = () => '' } = {}) {
  const loading = !status.loaded;
  const activeProvider = providerOf(status);
  const keyError = Boolean(status.hasKey && status.status === 'key_error');
  const statusText = loading ? 'Checking AI provider...' : shopAiStatusLabel(status);
  const statusHtml = `<p class="shop-ai-status ${status.hasKey ? 'is-claude' : 'is-included'}" id="shop-ai-status">${icon(status.hasKey ? 'sparkles' : 'cloud', 14)} <strong>${escapeHtml(statusText)}</strong></p>`;
  const providerErrorLabel = providerLabel(activeProvider);
  const errorHtml = keyError
    ? `<p class="form-help shop-ai-error" role="alert">${escapeHtml(status.lastError || `Your ${providerErrorLabel} key stopped working.`)} Answers use Cloudflare AI until the key is fixed or replaced.</p>`
    : '';
  const unavailableHtml = status.unavailable ? '<p class="form-help">AI settings could not be loaded right now.</p>' : '';
  const removeButton = status.hasKey
    ? `<button class="secondary" type="button" id="shop-ai-remove-key">${icon('trash-2', 14)} Remove key</button>`
    : '';
  const selectedProvider = activeProvider === 'anthropic' ? 'anthropic' : 'gemini';
  const selectedConsoleUrl = providerConsoleUrl(selectedProvider);
  const providerOptions = `<label class="full">AI provider<select name="provider" required><option value="anthropic"${selectedProvider === 'anthropic' ? ' selected' : ''}>Anthropic Claude</option><option value="gemini"${selectedProvider === 'gemini' ? ' selected' : ''}>Google Gemini</option></select></label>`;
  const form = canManage
    ? `<form class="form-grid" id="shop-ai-key-form" autocomplete="off">${providerOptions}<label class="full">API key<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${selectedProvider === 'gemini' ? 'AIza...' : 'sk-ant-...'}" required/></label><label class="full">Model (optional)<input name="model" type="text" spellcheck="false" placeholder="${selectedProvider === 'gemini' ? 'gemini-3.8-flash' : 'claude-sonnet-5'}"/></label><div class="full"><button class="primary" type="submit">${icon('key-round', 14)} ${status.hasKey ? 'Replace key' : 'Save key'}</button>${removeButton}<small class="form-help">Shop Crank tests the key with a tiny request before saving. It is encrypted on the server and never shown again; only the last 4 characters are displayed.</small></div></form>`
    : '<p class="form-help">Only shop owners and admins can add or change the AI key.</p>';
  return `<section class="settings-panel shop-ai-settings" id="shop-ai-settings"><div class="statement-head"><div><div class="eyebrow">AI</div><h2>Shop Crank AI provider</h2><p>${escapeHtml(SHOP_AI_PROMPT)}</p><p><a href="${status.consoleUrl || selectedConsoleUrl}" target="_blank" rel="noopener noreferrer">Get an API key for ${selectedProvider === 'gemini' ? 'Google Gemini at aistudio.google.com' : 'Anthropic at console.anthropic.com'}</a></p></div>${icon('sparkles', 20)}</div>${statusHtml}${errorHtml}${unavailableHtml}${form}</section>`;
}
