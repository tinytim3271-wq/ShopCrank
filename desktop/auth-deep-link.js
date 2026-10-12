'use strict';

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function resolveAuthDeepLink(rawUrl, appUrl) {
  try {
    const deepLink = new URL(rawUrl);
    if (deepLink.protocol !== 'shopcrank:' || deepLink.hostname !== 'auth') return '';
    const token = String(deepLink.searchParams.get('token') || '');
    if (!TOKEN_PATTERN.test(token)) return '';
    const callback = new URL('/api/auth/callback', appUrl);
    callback.searchParams.set('token', token);
    return callback.toString();
  } catch {
    return '';
  }
}

module.exports = { resolveAuthDeepLink };
