import test from 'node:test';
import assert from 'node:assert/strict';
import { groupThreads, phoneKey, smsInboxHtml, toE164, unreadCount } from './sms-inbox.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

const messages = [
  { id: '4', phone: '+18065550101', direction: 'inbound', body: 'Yes go ahead', createdAt: '2026-10-29T15:04:00Z', messageType: 'message' },
  { id: '3', phone: '+18065550101', direction: 'outbound', body: 'Pay here https://pay', createdAt: '2026-10-29T15:00:00Z', messageType: 'text_to_pay', status: 'sent' },
  { id: '2', phone: '+18065550199', direction: 'inbound', body: 'STOP', createdAt: '2026-10-28T10:00:00Z', messageType: 'opt_out' },
  { id: '1', phone: '+18065550101', direction: 'inbound', body: 'Is my truck ready?', createdAt: '2026-10-29T14:00:00Z', messageType: 'message' },
];
const customers = [{ id: 'c1', name: 'Alice Brooks', phone: '(806) 555-0101' }];

test('phone numbers group by their last ten digits and normalize to E.164', () => {
  assert.equal(phoneKey('+1 (806) 555-0101'), '8065550101');
  assert.equal(toE164('806-555-0101'), '+18065550101');
  assert.equal(toE164('1 806 555 0101'), '+18065550101');
  assert.equal(toE164('+447700900123'), '+447700900123');
});

test('messages become one conversation per customer, newest first, oldest message first inside', () => {
  const threads = groupThreads(messages, customers, { '8065550101': '2026-10-29T14:30:00Z' });
  assert.deepEqual(threads.map(thread => thread.key), ['8065550101', '8065550199']);
  const alice = threads[0];
  assert.equal(alice.customer, 'Alice Brooks');
  assert.equal(alice.customerId, 'c1');
  assert.deepEqual(alice.messages.map(message => message.id), ['1', '3', '4']);
  assert.equal(alice.unread, 1, 'only inbound messages after the read mark count');
  assert.equal(alice.preview, 'Yes go ahead');
  assert.equal(threads[1].optedOut, true);
  assert.equal(unreadCount(threads), 2);
});

test('a later START reopens texting after STOP', () => {
  const [thread] = groupThreads([
    { phone: '+18065550199', direction: 'inbound', body: 'STOP', createdAt: '2026-10-28T10:00:00Z', messageType: 'opt_out' },
    { phone: '+18065550199', direction: 'inbound', body: 'START', createdAt: '2026-10-28T11:00:00Z', messageType: 'opt_in' },
  ]);
  assert.equal(thread.optedOut, false);
});

test('inbox renders replies, escapes customer text, and blocks replies to opted-out numbers', () => {
  const threads = groupThreads([...messages, { phone: '+18065550101', direction: 'inbound', body: '<img src=x onerror=alert(1)>', createdAt: '2026-10-29T16:00:00Z' }], customers);
  const html = smsInboxHtml({ enabled: true, threads }, { escapeHtml });
  assert.match(html, /id="sms-reply-form"/);
  assert.match(html, /Text-to-pay link/);
  assert.doesNotMatch(html, /<img src=x/);
  const stopped = smsInboxHtml({ enabled: true, threads, selectedKey: '8065550199' }, { escapeHtml });
  assert.doesNotMatch(stopped, /id="sms-reply-form"/);
  assert.match(stopped, /replied STOP/);
  assert.doesNotMatch(html, /name="(name|body|method)"/, 'sanitizer-safe field names only');
});

test('disconnected shops see that texting is included on every plan', () => {
  assert.match(smsInboxHtml({ enabled: false }, { escapeHtml }), /included on every plan/);
});
