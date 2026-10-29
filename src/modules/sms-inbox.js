/**
 * Two-way customer texting: group the Worker's message log into one
 * conversation per phone number and render the inbox on the Messaging page.
 */

export function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** E.164 for US/Canada numbers typed the way shops type them; other input is passed through. */
export function toE164(value) {
  const raw = String(value || '').trim();
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw;
}

function customerForPhone(customers, key) {
  return (customers || []).find(customer => phoneKey(customer.phone) === key) || null;
}

/**
 * @param {Array} messages  rows from GET /api/messaging/threads (newest first)
 * @param {Array} customers shop customers, used to name threads
 * @param {Record<string,string>} readAt phoneKey → ISO time the shop last opened the thread
 */
export function groupThreads(messages = [], customers = [], readAt = {}) {
  const threads = new Map();
  for (const message of messages) {
    const key = phoneKey(message.phone);
    if (!key) continue;
    if (!threads.has(key)) {
      const customer = customerForPhone(customers, key);
      threads.set(key, { key, phone: message.phone, customer: customer?.name || '', customerId: message.customerId || customer?.id || '', messages: [], unread: 0, lastAt: '' });
    }
    const thread = threads.get(key);
    thread.messages.push(message);
    if (!thread.customerId && message.customerId) thread.customerId = message.customerId;
    if (String(message.createdAt) > thread.lastAt) thread.lastAt = String(message.createdAt);
    if (message.direction === 'inbound' && String(message.createdAt) > String(readAt[key] || '')) thread.unread += 1;
  }
  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const last = thread.messages[thread.messages.length - 1];
    thread.preview = String(last?.body || '').slice(0, 90);
    const consent = thread.messages.filter(message => ['opt_out', 'opt_in'].includes(message.messageType));
    thread.optedOut = consent.length > 0 && consent[consent.length - 1].messageType === 'opt_out';
  }
  return [...threads.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function unreadCount(threads) {
  return threads.reduce((total, thread) => total + thread.unread, 0);
}

const TYPE_LABELS = Object.freeze({
  text_to_pay: 'Text-to-pay link',
  estimate: 'Estimate',
  reminder: 'Reminder',
  review_request: 'Review request',
  opt_out: 'Opted out (STOP)',
  opt_in: 'Opted back in',
});

export function smsInboxHtml({ threads = [], selectedKey = '', enabled = false, loading = false, error = '' }, { escapeHtml, escapeAttr = escapeHtml, icon = () => '', time = value => value } = {}) {
  if (!enabled) {
    return `<section class="messaging-panel sms-inbox"><div class="messaging-status idle">${icon('message-square', 17)}<div><strong>Two-way texting is not connected</strong><span>Texting and text-to-pay are included on every plan. Connect the shop's Twilio number below (or ask ShopCrank to provision one) and customer replies will appear here.</span></div></div></section>`;
  }
  const selected = threads.find(thread => thread.key === selectedKey) || threads[0] || null;
  const list = threads.map(thread => `<button type="button" class="sms-thread${thread === selected ? ' active' : ''}" data-sms-thread="${escapeAttr(thread.key)}"><strong>${escapeHtml(thread.customer || thread.phone)}</strong>${thread.unread ? `<span class="badge">${thread.unread}</span>` : ''}<small>${escapeHtml(thread.preview)}</small></button>`).join('');
  const bubbles = selected ? selected.messages.map(message => `<div class="sms-bubble ${message.direction === 'inbound' ? 'in' : 'out'}"><p>${escapeHtml(message.body)}</p><small>${escapeHtml(time(message.createdAt))}${TYPE_LABELS[message.messageType] ? ` · ${escapeHtml(TYPE_LABELS[message.messageType])}` : ''}${message.direction === 'outbound' && message.status ? ` · ${escapeHtml(message.status)}` : ''}</small></div>`).join('') : '';
  const composer = selected
    ? selected.optedOut
      ? `<p class="ops-note">${icon('ban', 14)} This customer replied STOP. ShopCrank won't text them until they reply START.</p>`
      : `<form id="sms-reply-form" class="sms-composer"><input type="hidden" name="to" value="${escapeAttr(selected.phone)}"/><input type="hidden" name="customerId" value="${escapeAttr(selected.customerId)}"/><textarea name="messageBody" maxlength="1600" rows="2" required placeholder="Reply to ${escapeAttr(selected.customer || selected.phone)}"></textarea><button class="primary" type="submit">${icon('send', 14)} Send</button></form>`
    : '';
  const start = `<form id="sms-new-form" class="sms-composer"><input name="to" required placeholder="Customer mobile number" autocomplete="off"/><textarea name="messageBody" maxlength="1600" rows="2" required placeholder="New text message"></textarea><button class="secondary" type="submit">${icon('message-square-plus', 14)} Start text</button></form>`;
  return `<section class="messaging-panel sms-inbox"><div class="statement-head"><div><div class="eyebrow">Two-way texting</div><h2>Customer texts</h2><p>Replies from customers land here. Texting and text-to-pay are included on every plan.</p></div>${icon('messages-square', 20)}</div>${error ? `<p class="login-error">${escapeHtml(error)}</p>` : ''}${loading && !threads.length ? '<p>Loading conversations…</p>' : ''}<div class="sms-inbox-grid"><div class="sms-thread-list">${list || '<p class="ops-note">No conversations yet.</p>'}</div><div class="sms-conversation">${bubbles || '<p class="ops-note">Pick a conversation or start a new text.</p>'}${composer}</div></div>${start}</section>`;
}
