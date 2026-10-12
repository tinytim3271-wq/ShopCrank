import { cloudflareConfig, storageKeys } from './shared/config.js';
import { escapeAttr, escapeHtml } from './shared/html.js';
import './modules/register.js';
import './modules/perf.js';
import './runtime/home.js';

window.__MECHPRO_CONFIG__ = { cloudflare: cloudflareConfig, storage: storageKeys };
window.__MECHPRO_HTML__ = { escapeAttr, escapeHtml };

const bootstrapHooks = {
  beforeLegacyAppMount: () => {},
  afterLegacyAppMount: () => {},
  registerFeatureModule: () => {},
};

window.__MECHPRO_BOOTSTRAP__ = { ...bootstrapHooks };
window.__MECHPRO_BOOTSTRAP_READY__ = (async () => {
  window.__MECHPRO_BOOTSTRAP__.beforeLegacyAppMount();
  try {
    await import('./runtime/legacy.js');
  } finally {
    window.__MECHPRO_BOOTSTRAP__.afterLegacyAppMount();
  }
})().catch((error) => {
  console.error('Legacy app bootstrap failed', error);
  throw error;
});
