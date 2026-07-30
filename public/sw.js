/**
 * Tiny app-shell service worker.
 *
 * The score helper earns its keep at a kitchen table with bad wifi, so the app
 * needs to open offline. Strategy: serve the cached shell immediately, then
 * quietly refresh it in the background.
 */

const CACHE = 'flip7-v2';

const SHELL = [
  '.',
  'index.html',
  'css/styles.css',
  'icon.svg',
  'manifest.webmanifest',
  'firebase-config.js',
  'js/main.js',
  'js/room.js',
  'js/store.js',
  'js/sync-local.js',
  'js/scorer.js',
  'js/cards.js',
  'js/scoring.js',
  'js/rng.js',
  'js/sound.js',
  'js/fx.js',
  'js/views.js',
  'js/storage.js',
  'js/cardview.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
