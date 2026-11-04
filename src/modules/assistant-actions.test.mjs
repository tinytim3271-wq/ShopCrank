import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantActionsHtml, bindAssistantActionButtons, isRunnableConfirmation, runConfirmedAction } from './assistant-actions.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const card = (extra = {}) => ({ kind: 'app_api_confirmation', method: 'POST', path: '/messaging/send', body: { to: '+18065550144', body: 'Ready' }, summary: 'Text Dana the truck is ready', reason: 'Reaches a customer', ...extra });

test('only plain API writes can be confirmed: never DELETE, sign-in, AI or odd paths', () => {
  assert.equal(isRunnableConfirmation(card()), true);
  assert.equal(isRunnableConfirmation(card({ method: 'DELETE' })), false);
  assert.equal(isRunnableConfirmation(card({ method: 'GET' })), false);
  assert.equal(isRunnableConfirmation(card({ path: '/auth/logout' })), false);
  assert.equal(isRunnableConfirmation(card({ path: '/ai/assistant' })), false);
  assert.equal(isRunnableConfirmation(card({ path: 'https://evil.example.com/x' })), false);
  assert.equal(isRunnableConfirmation(card({ path: '/entities/../auth' })), false);
  assert.equal(isRunnableConfirmation(card({ path: '/x"><img src=x>' })), false);
  assert.equal(isRunnableConfirmation({ ...card(), kind: 'other' }), false);
});

test('cards show what will happen, escape everything, and show the outcome', () => {
  const html = assistantActionsHtml([card({ summary: '<b>Text</b> Dana' })], 2, { escapeHtml: esc });
  assert.match(html, /data-assistant-confirm="2:0"/);
  assert.match(html, /data-assistant-dismiss="2:0"/);
  assert.match(html, /&#60;b&#62;Text&#60;\/b&#62; Dana/);
  assert.match(html, /POST \/messaging\/send/);
  assert.match(assistantActionsHtml([card({ status: 'done' })], 0, { escapeHtml: esc }), /Done/);
  assert.doesNotMatch(assistantActionsHtml([card({ status: 'done' })], 0, { escapeHtml: esc }), /data-assistant-confirm/);
  assert.equal(assistantActionsHtml([card({ method: 'DELETE' })], 0, { escapeHtml: esc }), '', 'a delete card is never rendered');
  assert.match(assistantActionsHtml([{ kind: 'open_screen', screen: 'orders', title: 'Work orders' }], 1, { escapeHtml: esc }), /data-assistant-screen="1:0"[^>]*>.*Open Work orders/);
  assert.match(assistantActionsHtml([{ kind: 'estimate_work_order_draft' }], 3), /data-assistant-draft="3:0"/);
});

test('sources list https links only', () => {
  const html = assistantActionsHtml([], 0, { escapeHtml: esc, sources: [{ title: 'Spec page', url: 'https://spec.example.com/camry' }, { title: 'bad', url: 'javascript:alert(1)' }, { url: 'http://plain.example.com' }] });
  assert.match(html, /Sources \(1\)/);
  assert.match(html, /href="https:\/\/spec.example.com\/camry"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /javascript|plain\.example/);
});

test('confirming runs the same API call with the user session and marks it done; a failure is shown', async () => {
  const calls = [];
  const result = await runConfirmedAction(card(), async (path, init) => { calls.push([path, init]); return { sent: true }; });
  assert.deepEqual(result, { sent: true });
  assert.deepEqual(calls, [['/messaging/send', { method: 'POST', body: JSON.stringify({ to: '+18065550144', body: 'Ready' }) }]]);
  await assert.rejects(runConfirmedAction(card({ method: 'DELETE' }), async () => {}), /cannot be run/);

  // Button wiring with a minimal DOM stand-in.
  const buttons = { '[data-assistant-confirm]': [{ dataset: { assistantConfirm: '0:0' } }], '[data-assistant-dismiss]': [{ dataset: { assistantDismiss: '0:1' } }], '[data-assistant-screen]': [{ dataset: { assistantScreen: '0:2' } }], '[data-assistant-draft]': [] };
  const root = { querySelectorAll: selector => buttons[selector] || [] };
  const conversation = [{ actions: [card(), card(), { kind: 'open_screen', screen: 'orders' }] }];
  const toasts = [];
  let rerenders = 0;
  let opened = null;
  bindAssistantActionButtons(root, { conversation, apiFetch: async () => { throw new Error('Twilio is not connected'); }, toast: text => toasts.push(text), rerender: () => { rerenders += 1; }, openScreen: action => { opened = action; } });
  await buttons['[data-assistant-confirm]'][0].onclick();
  assert.equal(conversation[0].actions[0].error, 'Twilio is not connected');
  assert.notEqual(conversation[0].actions[0].status, 'done');
  buttons['[data-assistant-dismiss]'][0].onclick();
  assert.equal(conversation[0].actions[1].status, 'dismissed');
  buttons['[data-assistant-screen]'][0].onclick();
  assert.equal(opened.screen, 'orders');
  assert.equal(rerenders, 2);
  bindAssistantActionButtons(root, { conversation, apiFetch: async () => ({ ok: true }), toast: text => toasts.push(text) });
  await buttons['[data-assistant-confirm]'][0].onclick();
  assert.equal(conversation[0].actions[0].status, 'done');
  assert.match(toasts.at(-1), /^Done: Text Dana/);
});
