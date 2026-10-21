/** Canonical public hostname for ShopCrank on Cloudflare. */
export const CANONICAL_HOST = 'www.shopcrank.com';
export const APEX_HOST = 'shopcrank.com';
export const CANONICAL_ORIGIN = 'https://www.shopcrank.com';
export const DEFAULT_PAGES_ORIGIN = 'https://shopcrank-dispatch.pages.dev';
export const DEFAULT_AUTH_EMAIL_FROM = 'noreply@shopcrank.com';
export const HEALTHZ_SERVICE = 'shopcrank-cloudflare-api';
export const APP_SESSION_COOKIE = 'shopcrank_session';
export const DESKTOP_AUTH_SCHEME = 'shopcrank:';

/**
 * The host the app shipped under before the www.shopcrank.com cutover. It is
 * still live and still points at this Worker, so it has to redirect rather
 * than 404: sign-in links, bookmarked URLs, and old installer pages all
 * still point at it.
 */
export const LEGACY_HOST = 'www.yourcarguy806.com';
export const LEGACY_APEX_HOST = 'yourcarguy806.com';
export const LEGACY_HOSTS = Object.freeze([LEGACY_HOST, LEGACY_APEX_HOST]);

export function isApexHost(hostname) {
  return String(hostname || '') === APEX_HOST;
}

export function isLegacyHost(hostname) {
  return LEGACY_HOSTS.includes(String(hostname || ''));
}

export function apexToWwwRedirect(request) {
  const url = new URL(request.url);
  if (!isApexHost(url.hostname)) return null;
  url.hostname = CANONICAL_HOST;
  return new Response(null, {
    status: 301,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
  });
}

/**
 * Redirect the pre-cutover host to the canonical one, keeping path and query.
 * Runs before any API handling so an old sign-in link lands on the right host
 * instead of creating a session on the legacy one.
 */
export function legacyToCanonicalRedirect(request) {
  const url = new URL(request.url);
  if (!isLegacyHost(url.hostname)) return null;
  url.hostname = CANONICAL_HOST;
  url.protocol = 'https:';
  return new Response(null, {
    status: 301,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
  });
}
