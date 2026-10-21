'use strict';

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function findAuthDeepLink(argv) {
  const text = (argv || []).map(value => String(value).trim().replace(/^"|"$/g, '')).join(' ');
  const match = text.match(/shopcrank:[^\s'"]+/i);
  return match ? match[0] : '';
}

function resolveAuthDeepLink(rawUrl, appUrl) {
  try {
    const deepLink = new URL(String(rawUrl || '').trim().replace(/^"|"$/g, ''));
    if (deepLink.protocol !== 'shopcrank:') return '';
    const path = deepLink.pathname.replace(/^\/+|\/+$/g, '');
    if (deepLink.hostname !== 'auth' && path !== 'auth') return '';
    const token = String(deepLink.searchParams.get('token') || '').trim().toLowerCase();
    if (!TOKEN_PATTERN.test(token)) return '';
    const callback = new URL('/api/auth/callback', appUrl);
    callback.searchParams.set('token', token);
    return callback.toString();
  } catch {
    return '';
  }
}

module.exports = { findAuthDeepLink, resolveAuthDeepLink };
