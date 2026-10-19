import { DEFAULT_PAGES_ORIGIN } from './production-host.mjs';
export { DEFAULT_PAGES_ORIGIN };

export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export function isApiRequest(request) {
  return isApiPath(new URL(request.url).pathname);
}

export const API_DOWNLOADS_PREFIX = '/api/downloads/';

export function isApiDownloadPath(pathname) {
  return pathname.startsWith(API_DOWNLOADS_PREFIX);
}

/**
 * Map /downloads/<file>.{exe,zip,apk} or /api/downloads/<file> to an R2 object key under downloads/.
 * Production only routes /api/* to the Worker, so public links must use /api/downloads/.
 * Returns null for HTML install pages and anything outside the allowlist.
 */
export function publicDownloadObjectKey(pathname) {
  const prefix = isApiDownloadPath(pathname) ? API_DOWNLOADS_PREFIX : '/downloads/';
  if (!pathname.startsWith(prefix)) return null;
  let name;
  try {
    name = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (!/^[\w.-]+\.(exe|zip|apk)$/i.test(name)) return null;
  return `downloads/${name}`;
}

export function pagesProxyUrl(requestUrl, pagesOrigin = DEFAULT_PAGES_ORIGIN) {
  const incoming = new URL(requestUrl);
  const origin = String(pagesOrigin || DEFAULT_PAGES_ORIGIN).replace(/\/$/, '');
  return new URL(`${incoming.pathname}${incoming.search}`, origin).href;
}
