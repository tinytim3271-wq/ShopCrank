import { cloudflareConfig, storageKeys } from './shared/config.js';
import { escapeAttr, escapeHtml } from './shared/html.js';
import './modules/register.js';
import './modules/perf.js';
import './runtime/home.js';

window.__SHOP_CRANK_CONFIG__ = { cloudflare: cloudflareConfig, storage: storageKeys };
window.__MECHPRO_CONFIG__ = window.__SHOP_CRANK_CONFIG__;
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
  const root = document.querySelector('#root');
  if (root && !root.innerHTML.trim()) {
    root.innerHTML = '<main class="login-screen"><section class="login-panel"><h1>Shop Crank could not open</h1><p>Reload the page. If this continues, clear site data for this host and sign in again.</p></section></main>';
  }
});
