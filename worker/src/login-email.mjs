import { HttpError, json, parseJson } from './http.mjs';
import { constantTimeEqual } from './security.mjs';

const DEFAULT_FROM = 'noreply@yourcarguy806.com';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loginText(loginUrl) {
  return [
    'Sign in to MechPro by opening this link:',
    '',
    loginUrl,
    '',
    'This link expires in 15 minutes. If you did not request it, ignore this email.',
    '',
  ].join('\n');
}

async function hashValue(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canSendLoginEmail(env) {
  return typeof env.EMAIL?.send === 'function';
}

const UNSENDABLE_CODES = new Set([
  'E_RECIPIENT_NOT_ALLOWED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_SENDER_NOT_VERIFIED',
]);

export function signInDeliveryFailure(error) {
  if (error instanceof HttpError) return error;
  const code = String(error?.code || '');
  console.error(JSON.stringify({
    message: 'sign-in email rejected',
    code: code || 'unknown',
  }));
  if (UNSENDABLE_CODES.has(code)) {
    return new HttpError(
      502,
      'That address cannot receive a MechPro sign-in link yet. Email Sending is turned off for yourcarguy806.com, so only an address already verified in Cloudflare can be used.',
    );
  }
  if (code) return new HttpError(502, `Unable to deliver the sign-in email (${code}).`);
  return new HttpError(502, 'Unable to deliver the sign-in email');
}

export async function deliverLoginEmail(env, { email, loginUrl }) {
  if (!canSendLoginEmail(env)) throw new HttpError(503, 'Email delivery is not configured on this Worker');
  const from = String(env.AUTH_EMAIL_FROM || DEFAULT_FROM).trim();
  if (!EMAIL_PATTERN.test(from)) throw new HttpError(503, 'AUTH_EMAIL_FROM is not a valid sender address');
  await env.EMAIL.send({
    to: email,
    from,
    subject: 'Sign in to MechPro',
    text: loginText(loginUrl),
  });
}

function requireDeliverySecret(request, env) {
  const expected = String(env.AUTH_EMAIL_WEBHOOK_SECRET || '');
  if (!expected) throw new HttpError(503, 'Email delivery secret is not configured');
  const header = request.headers.get('Authorization') || '';
  const provided = /^Bearer\s+(\S+)$/i.exec(header)?.[1] || '';
  if (!constantTimeEqual(provided, expected)) throw new HttpError(401, 'Invalid email delivery credentials');
}

function allowedHosts(request, env) {
  const hosts = new Set([new URL(request.url).host]);
  for (const origin of String(env.ALLOWED_ORIGINS || '').split(',')) {
    const trimmed = origin.trim();
    if (!trimmed) continue;
    try {
      hosts.add(new URL(trimmed).host);
    } catch {
      // Ignore malformed configured origins.
    }
  }
  return hosts;
}

function signInLink(value, request, env) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new HttpError(400, 'loginUrl must be an https sign-in link');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/api/auth/callback') {
    throw new HttpError(400, 'loginUrl must be an https sign-in link');
  }
  if (!url.searchParams.get('token') || !allowedHosts(request, env).has(url.host)) {
    throw new HttpError(400, 'loginUrl must be an https sign-in link');
  }
  return url;
}

async function assertPendingLogin(env, email, loginUrl) {
  const tokenHash = await hashValue(loginUrl.searchParams.get('token'));
  const row = await env.DB.prepare(
    'SELECT email FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
  ).bind(tokenHash, new Date().toISOString()).first();
  if (!row || String(row.email || '').trim().toLowerCase() !== email) {
    throw new HttpError(400, 'loginUrl must be an https sign-in link');
  }
}

export async function handleSendLogin(request, env) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireDeliverySecret(request, env);
  const body = parseJson(await request.text() || '{}');
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const loginUrl = signInLink(body.loginUrl, request, env);
  await assertPendingLogin(env, email, loginUrl);
  try {
    await deliverLoginEmail(env, { email, loginUrl: loginUrl.toString() });
  } catch (error) {
    throw signInDeliveryFailure(error);
  }
  return json({ ok: true }, 202);
}
