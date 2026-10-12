import { HttpError } from './http.mjs';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORIES = new Set(['technical', 'billing', 'onboarding', 'data_migration', 'feedback']);

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function rawSupportEmail({ from, to, ticket }) {
  const safeSubject = ticket.subject.replace(/[\r\n]/g, ' ');
  return [
    `From: MechPro Support <${from}>`,
    `To: ${to}`,
    `Reply-To: ${ticket.requesterEmail}`,
    `Subject: [${ticket.priority.toUpperCase()}] ${ticket.id}: ${safeSubject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Ticket: ${ticket.id}`,
    `Shop: ${ticket.shopId}`,
    `Category: ${ticket.category}`,
    `Requester: ${ticket.requesterEmail}`,
    '',
    ticket.description,
    '',
  ].join('\r\n');
}

async function cloudflareEmail(from, to, raw) {
  const { EmailMessage } = await import('cloudflare:email');
  return new EmailMessage(from, to, raw);
}

export function normalizeSupportTicket(input, context) {
  const subject = clean(input?.subject, 160);
  const description = clean(input?.description, 8000);
  const category = clean(input?.category || 'technical', 40).toLowerCase();
  const priority = clean(input?.priority || 'normal', 20).toLowerCase();
  const requesterEmail = clean(input?.email || context?.email, 254).toLowerCase();
  if (!subject || !description) throw new HttpError(400, 'Subject and description are required');
  if (!CATEGORIES.has(category)) throw new HttpError(400, 'Choose a valid support category');
  if (!['normal', 'urgent'].includes(priority)) throw new HttpError(400, 'Priority must be normal or urgent');
  if (!EMAIL_PATTERN.test(requesterEmail)) throw new HttpError(400, 'A valid contact email is required');
  return { subject, description, category, priority, requesterEmail };
}

export async function createSupportTicket(env, context, input) {
  const normalized = normalizeSupportTicket(input, context);
  const now = new Date().toISOString();
  const ticket = {
    id: `SUP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    shopId: context.shopId,
    createdBy: context.userId,
    ...normalized,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  await env.DB.prepare(`
    INSERT INTO support_tickets (
      id, shop_id, created_by, requester_email, category, subject, description,
      priority, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    ticket.id, ticket.shopId, ticket.createdBy, ticket.requesterEmail, ticket.category,
    ticket.subject, ticket.description, ticket.priority, ticket.status, now, now,
  ).run();

  const to = clean(env.SUPPORT_EMAIL_TO, 254);
  const from = clean(env.SUPPORT_EMAIL_FROM || env.AUTH_EMAIL_FROM, 254);
  let notification = 'not_configured';
  if (EMAIL_PATTERN.test(to) && EMAIL_PATTERN.test(from) && typeof env.EMAIL?.send === 'function') {
    try {
      const raw = rawSupportEmail({ from, to, ticket });
      const message = typeof env.EMAIL.createMessage === 'function'
        ? env.EMAIL.createMessage(from, to, raw)
        : await cloudflareEmail(from, to, raw);
      await env.EMAIL.send(message);
      notification = 'sent';
    } catch {
      notification = 'failed';
    }
  }
  return { ...ticket, notification };
}

export async function listSupportTickets(env, context) {
  const result = await env.DB.prepare(`
    SELECT id, requester_email, category, subject, priority, status, created_at, updated_at
    FROM support_tickets WHERE shop_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(context.shopId).all();
  return (result.results || []).map((row) => ({
    id: row.id,
    requesterEmail: row.requester_email,
    category: row.category,
    subject: row.subject,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
