const path = require('node:path');
const { fileURLToPath } = require('node:url');

const TRUSTED_ORIGINS = Object.freeze([
  'https://www.shopcrank.com',
  'https://shopcrank.com',
  'https://shopcrank-dispatch.pages.dev',
  'https://accounts.google.com',
]);

function parse(rawUrl) {
  try {
    return new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
}

/** True when a file: URL points at a file inside the packaged app folder. */
function isAppFile(url, appRoot, pathApi = path) {
  if (!url || url.protocol !== 'file:' || !appRoot) return false;
  let filePath;
  try {
    filePath = fileURLToPath(url, { windows: pathApi === path.win32 });
  } catch {
    return false;
  }
  const relative = pathApi.relative(pathApi.resolve(appRoot), pathApi.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !pathApi.isAbsolute(relative);
}

/**
 * Where the app window may navigate: the bundled app's own files, or the
 * ShopCrank sites (not in the offline USB demo).
 */
function isTrustedNavigation(rawUrl, { appRoot, demo = false, pathApi = path } = {}) {
  const url = parse(rawUrl);
  if (!url) return false;
  if (url.protocol === 'file:') return isAppFile(url, appRoot, pathApi);
  return demo !== true && url.protocol === 'https:' && TRUSTED_ORIGINS.includes(url.origin);
}

/**
 * What a pop-up may hand to the system (shell.openExternal). Only https pages on
 * the ShopCrank sites: a file: URL here would make Windows open or run that file.
 */
function canOpenExternally(rawUrl, { demo = false } = {}) {
  const url = parse(rawUrl);
  return Boolean(url) && demo !== true && url.protocol === 'https:' && TRUSTED_ORIGINS.includes(url.origin);
}

module.exports = { TRUSTED_ORIGINS, canOpenExternally, isTrustedNavigation };
