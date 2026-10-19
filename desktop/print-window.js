'use strict';

function isPrintPopupUrl(rawUrl) {
  const value = String(rawUrl || '');
  if (!value || value === 'about:blank') return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'about:' || protocol === 'blob:';
  } catch {
    return false;
  }
}

module.exports = { isPrintPopupUrl };
