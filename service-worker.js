const CACHE_NAME = 'shopcrank-shell-v35';
const SHELL_FILES = [
  './',
  './index.html',
  './diagnostics-ui.js',
  './styles.css',
  './theme.css',
  './manifest.webmanifest',
  './assets/brand/logo-icon-192.png',
  './assets/brand/logo-icon-512.png',
  './assets/vendor/lucide.min.js',
  './assets/vendor/dompurify.min.js',
  './assets/fonts/fonts.css',
  './assets/fonts/dm-sans-latin-400-normal.woff2',
  './assets/fonts/dm-sans-latin-500-normal.woff2',
  './assets/fonts/dm-sans-latin-600-normal.woff2',
  './assets/fonts/dm-sans-latin-700-normal.woff2',
  './assets/fonts/barlow-condensed-latin-500-normal.woff2',
  './assets/fonts/barlow-condensed-latin-600-normal.woff2',
  './assets/fonts/barlow-condensed-latin-700-normal.woff2',
  './assets/fonts/jetbrains-mono-latin-500-normal.woff2',
  './assets/fonts/jetbrains-mono-latin-600-normal.woff2',
];

// Installers and API calls must reach the network untouched: a navigation to
// an installer would otherwise be cloned into the cache as the app shell.
function bypassesServiceWorker(pathname) {
  // API reads are live data (license status, revocations); never answer them from cache.
  return pathname === '/api' || pathname.startsWith('/api/')
    || /^\/downloads\/[^/]+\.(exe|zip|apk)$/i.test(pathname);
}

function isImmutableAsset(pathname) {
  return /^\/assets\/.+-[A-Za-z0-9_-]{6,}\.(js|css)$/.test(pathname)
    || pathname.endsWith('.woff2');
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache shell assets except app.js so deploys are not sticky behind SW.
    await cache.addAll(SHELL_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (bypassesServiceWorker(url.pathname)) return;

  // Always network-first for the main app bundle — never long-cache app.js.
  if (url.pathname.endsWith('/app.js') || url.pathname.endsWith('app.js')) {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(() => caches.match(request).then(cached => cached || new Response('', { status: 503, statusText: 'Offline' }))),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok && (response.headers.get('Content-Type') || '').includes('text/html')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => {
        const network = fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        }).catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  // Scripts and styles: network-first so deploys pick up quickly; cache only as offline fallback.
  if (['script', 'style'].includes(request.destination)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || new Response('', { status: 503, statusText: 'Offline' })),
    );
    return;
  }

  // Fonts and static assets: stale-while-revalidate (cache for offline, refresh in background).
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
