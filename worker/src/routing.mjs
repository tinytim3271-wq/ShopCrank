export const DEFAULT_PAGES_ORIGIN = 'https://mechpro-dispatch.pages.dev';

export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export function isApiRequest(request) {
  return isApiPath(new URL(request.url).pathname);
}

/**
 * Map /downloads/<file>.{exe,zip,apk} to an R2 object key under downloads/.
 * Returns null for HTML install pages and anything outside the allowlist.
 */
export function publicDownloadObjectKey(pathname) {
  if (!pathname.startsWith('/downloads/')) return null;
  const name = decodeURIComponent(pathname.slice('/downloads/'.length));
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (!/^[\w.-]+\.(exe|zip|apk)$/i.test(name)) return null;
  return `downloads/${name}`;
}

export function pagesProxyUrl(requestUrl, pagesOrigin = DEFAULT_PAGES_ORIGIN) {
  const incoming = new URL(requestUrl);
  const origin = String(pagesOrigin || DEFAULT_PAGES_ORIGIN).replace(/\/$/, '');
  return new URL(`${incoming.pathname}${incoming.search}`, origin).href;
}
