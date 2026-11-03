/*
 * Ambassador referral capture for shopcrank.com pages and the app.
 * Landing with ?ref=CODE (an ambassador's own link) stores the code for 90 days
 * in localStorage and the sc_ref cookie, so signup, Google sign-in, and Stripe
 * checkout can credit the ambassador. ?ref=CODE&src=referral marks an indirect
 * referral. The most recent link wins until the shop signs up; after that the
 * Worker keeps the first ambassador credited.
 */
(function () {
  const STORAGE_KEY = 'shopcrank-ref-v1';
  const MAX_AGE_DAYS = 90;
  const SOURCES = ['ambassador_site', 'ambassador_referral'];

  function normalize(code) {
    const value = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /^[A-Z0-9]{4,16}$/.test(value) ? value : '';
  }

  function writeCookie(name, value, days) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.round(days * 86400)}; SameSite=Lax${secure}`;
  }

  function set(code, source) {
    const normalized = normalize(code);
    if (!normalized) return null;
    const entry = { code: normalized, source: SOURCES.includes(source) ? source : 'ambassador_site', capturedAt: new Date().toISOString() };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entry)); } catch { /* private mode */ }
    writeCookie('sc_ref', entry.code, MAX_AGE_DAYS);
    writeCookie('sc_ref_src', entry.source, MAX_AGE_DAYS);
    return entry;
  }

  function get() {
    try {
      const entry = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (entry?.code && Date.now() - Date.parse(entry.capturedAt) < MAX_AGE_DAYS * 86400000) return entry;
    } catch { /* fall through to the cookie */ }
    const cookie = Object.fromEntries(document.cookie.split(';').map(part => part.trim().split('=')).filter(([key]) => key));
    const code = normalize(decodeURIComponent(cookie.sc_ref || ''));
    return code ? { code, source: SOURCES.includes(cookie.sc_ref_src) ? cookie.sc_ref_src : 'ambassador_site' } : null;
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    writeCookie('sc_ref', '', 0);
    writeCookie('sc_ref_src', '', 0);
  }

  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('ref') || params.get('amb');
  if (fromUrl) set(fromUrl, params.get('src') === 'referral' ? 'ambassador_referral' : 'ambassador_site');

  // Keep ?ref on internal links so the code survives a hop to /signup without storage.
  if (fromUrl) {
    document.addEventListener('DOMContentLoaded', () => {
      const entry = get();
      if (!entry) return;
      for (const link of document.querySelectorAll('a[href^="/signup"], a[href^="/login"], a[href^="/pricing"], a[href^="/founding"]')) {
        const url = new URL(link.getAttribute('href'), location.origin);
        if (!url.searchParams.has('ref')) url.searchParams.set('ref', entry.code);
        if (entry.source === 'ambassador_referral' && !url.searchParams.has('src')) url.searchParams.set('src', 'referral');
        link.setAttribute('href', `${url.pathname}${url.search}${url.hash}`);
      }
    });
  }

  window.ShopCrankReferral = { get, set, clear, normalize };
})();
