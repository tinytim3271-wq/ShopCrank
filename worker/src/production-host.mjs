/** Canonical public hostname for Shop Crank on Cloudflare. */
export const CANONICAL_HOST = 'www.shopcrank.com';
export const APEX_HOST = 'shopcrank.com';
export const CANONICAL_ORIGIN = 'https://www.shopcrank.com';
export const DEFAULT_PAGES_ORIGIN = 'https://shopcrank-dispatch.pages.dev';
export const DEFAULT_AUTH_EMAIL_FROM = 'noreply@shopcrank.com';
export const HEALTHZ_SERVICE = 'shopcrank-cloudflare-api';
export const APP_SESSION_COOKIE = 'shopcrank_session';
export const DESKTOP_AUTH_SCHEME = 'shopcrank:';

export function isApexHost(hostname) {
  return String(hostname || '') === APEX_HOST;
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
