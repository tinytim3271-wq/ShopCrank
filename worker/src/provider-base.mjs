/**
 * Base URL for an outside API (Stripe, Twilio). The browser smoke test points
 * these at a local stand-in through SMOKE_<NAME>_API_BASE; the override is only
 * honoured for a loopback address, so a production setting can never redirect
 * live payment or texting traffic to another host.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function providerBase(env, name, fallback) {
  const raw = String(env?.[`SMOKE_${name}_API_BASE`] || '').trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return raw.replace(/\/+$/, '');
  } catch { /* ignore malformed overrides */ }
  return fallback;
}
