/* ============================================================
   GameMoments — Service Worker
   Cache-first strategy for full offline support.
   Bump CACHE_NAME version string to force update on deploy.
   ============================================================ */

const CACHE_NAME = 'gamemoments-v1';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ── Install: pre-cache all app shell assets ── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll is atomic — any failure rolls back the install
      return cache.addAll(ASSETS).catch((err) => {
        // Icons may not exist yet; cache what we can
        console.warn('SW: Some assets failed to cache', err);
        return Promise.allSettled(
          ASSETS.map((url) => cache.add(url).catch(() => null))
        );
      });
    })
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

/* ── Activate: clean up old caches ── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

/* ── Fetch: cache-first, network fallback ── */
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for same-origin or relative assets
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      // Not in cache — try network, then cache the response
      return fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          return response;
        })
        .catch(() => {
          // Network failed and not in cache; return a minimal offline page
          if (event.request.headers.get('accept')?.includes('text/html')) {
            return caches.match('./index.html');
          }
        });
    })
  );
});
