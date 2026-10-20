/*
 * Cloudflare Turnstile for ShopCrank sign-in and sign-up forms.
 * Off until the Worker has TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY: /api/auth/config
 * then returns the site key and this renders the widget. Without a key, mount()
 * resolves to a widget whose token() is '' and the server doesn't ask for one.
 */
(function () {
  let configPromise = null;
  let scriptPromise = null;
  const noWidget = { token: () => '', reset: () => {} };

  function siteKey() {
    configPromise ||= fetch('/api/auth/config', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(response => (response.ok ? response.json() : {}))
      .then(config => String(config?.turnstileSiteKey || ''))
      .catch(() => '');
    return configPromise;
  }

  function loadScript() {
    scriptPromise ||= new Promise((resolve, reject) => {
      if (window.turnstile) return resolve();
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Turnstile could not load'));
      document.head.append(script);
    });
    return scriptPromise;
  }

  async function mount(container) {
    if (!container) return noWidget;
    const key = await siteKey();
    if (!key) return noWidget;
    try {
      await loadScript();
      const id = window.turnstile.render(container, { sitekey: key, action: 'sign-in' });
      return {
        token: () => window.turnstile.getResponse(id) || '',
        reset: () => window.turnstile.reset(id),
      };
    } catch {
      return noWidget;
    }
  }

  window.ShopCrankTurnstile = Object.freeze({ mount });
})();
