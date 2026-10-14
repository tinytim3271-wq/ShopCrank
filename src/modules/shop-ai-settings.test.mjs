import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_CONSOLE_URL, GEMINI_CONSOLE_URL, SHOP_AI_PROMPT, shopAiPanelHtml, shopAiStatusLabel } from './shop-ai-settings.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

test('status label shows included Cloudflare AI or the masked provider key', () => {
  assert.equal(shopAiStatusLabel({ hasKey: false }), 'Using Gemini (included)');
  assert.equal(shopAiStatusLabel({ hasKey: true, provider: 'anthropic', maskedKey: '\u2022\u2022\u2022\u20221234' }), 'Using Claude with your key \u2022\u2022\u2022\u20221234');
  assert.equal(shopAiStatusLabel({ hasKey: true, provider: 'gemini', maskedKey: '\u2022\u2022\u2022\u2022ABCD' }), 'Using Gemini with your key \u2022\u2022\u2022\u2022ABCD');
});

test('panel shows provider controls, key form, and console link', () => {
  const html = shopAiPanelHtml({ loaded: true, hasKey: false }, { canManage: true, escapeHtml });
  assert.ok(html.includes(escapeHtml(SHOP_AI_PROMPT)));
  assert.ok(html.includes(`href="${GEMINI_CONSOLE_URL}"`));
  assert.match(html, /name="provider"/);
  assert.match(html, /Anthropic Claude/);
  assert.match(html, /Google Gemini/);
  assert.match(html, /id="shop-ai-key-form"/);
  assert.doesNotMatch(html, /shop-ai-remove-key/);
});

test('panel for a saved Anthropic key offers replace/remove and never renders a key value', () => {
  const html = shopAiPanelHtml({ loaded: true, hasKey: true, provider: 'anthropic', maskedKey: '\u2022\u2022\u2022\u2022WXYZ', status: 'active' }, { canManage: true, escapeHtml });
  assert.match(html, /Using Claude with your key \u2022\u2022\u2022\u2022WXYZ/);
  assert.match(html, /Replace key/);
  assert.match(html, /id="shop-ai-remove-key"/);
  assert.doesNotMatch(html, /value="sk-ant/);
});

test('panel for a saved Gemini key points at Google AI Studio', () => {
  const html = shopAiPanelHtml({ loaded: true, hasKey: true, provider: 'gemini', consoleUrl: GEMINI_CONSOLE_URL, maskedKey: '\u2022\u2022\u2022\u2022QWER', status: 'active' }, { canManage: true, escapeHtml });
  assert.match(html, /Using Gemini with your key \u2022\u2022\u2022\u2022QWER/);
  assert.ok(html.includes(`href="${GEMINI_CONSOLE_URL}"`));
});

test('non-admins see status only, and key errors are surfaced', () => {
  const html = shopAiPanelHtml({ loaded: true, hasKey: true, provider: 'gemini', maskedKey: '\u2022\u2022\u2022\u20221234', status: 'key_error', lastError: 'Your Gemini account is out of credits.' }, { canManage: false, escapeHtml });
  assert.doesNotMatch(html, /shop-ai-key-form/);
  assert.match(html, /Only shop owners and admins/);
  assert.match(html, /out of credits/);
  assert.match(html, /role="alert"/);
});
