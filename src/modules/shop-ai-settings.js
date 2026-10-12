// Shop settings panel for the optional "bring your own Anthropic key" AI upgrade.
// Shops without a key use the included Cloudflare Workers AI.

export const ANTHROPIC_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';
export const SHOP_AI_PROMPT = 'Want higher-quality AI answers? Add your own Anthropic (Claude) API key. Usage is billed by Anthropic to your account, usually just pennies to a few dollars a month.';

const MASK = '\u2022\u2022\u2022\u2022';

export function shopAiStatusLabel(status = {}) {
  if (status.hasKey) return `Using Claude with your key ${status.maskedKey || MASK}`;
  return 'Using Cloudflare AI (included)';
}

export function shopAiPanelHtml(status = {}, { canManage = false, escapeHtml = value => String(value ?? ''), icon = () => '' } = {}) {
  const loading = !status.loaded;
  const keyError = Boolean(status.hasKey && status.status === 'key_error');
  const statusText = loading ? 'Checking AI provider...' : shopAiStatusLabel(status);
  const statusHtml = `<p class="shop-ai-status ${status.hasKey ? 'is-claude' : 'is-included'}" id="shop-ai-status">${icon(status.hasKey ? 'sparkles' : 'cloud', 14)} <strong>${escapeHtml(statusText)}</strong></p>`;
  const errorHtml = keyError
    ? `<p class="form-help shop-ai-error" role="alert">${escapeHtml(status.lastError || 'Your Claude key stopped working.')} Answers use Cloudflare AI until the key is fixed or replaced.</p>`
    : '';
  const unavailableHtml = status.unavailable ? '<p class="form-help">AI settings could not be loaded right now.</p>' : '';
  const removeButton = status.hasKey
    ? `<button class="secondary" type="button" id="shop-ai-remove-key">${icon('trash-2', 14)} Remove key</button>`
    : '';
  const form = canManage
    ? `<form class="form-grid" id="shop-ai-key-form" autocomplete="off"><label class="full">Anthropic API key<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="sk-ant-..." required/></label><div class="full"><button class="primary" type="submit">${icon('key-round', 14)} ${status.hasKey ? 'Replace key' : 'Save key'}</button>${removeButton}<small class="form-help">MechPro tests the key with a tiny request before saving. It is encrypted on the server and never shown again; only the last 4 characters are displayed.</small></div></form>`
    : '<p class="form-help">Only shop owners and admins can add or change the AI key.</p>';
  return `<section class="settings-panel shop-ai-settings" id="shop-ai-settings"><div class="statement-head"><div><div class="eyebrow">AI</div><h2>MechPro AI provider</h2><p>${escapeHtml(SHOP_AI_PROMPT)}</p><p><a href="${ANTHROPIC_CONSOLE_URL}" target="_blank" rel="noopener noreferrer">Get an Anthropic API key at console.anthropic.com</a></p></div>${icon('sparkles', 20)}</div>${statusHtml}${errorHtml}${unavailableHtml}${form}</section>`;
}