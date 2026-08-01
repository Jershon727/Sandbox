/**
 * Tiny app-shell service worker.
 *
 * The app earns its keep at a kitchen table with bad wifi, so it needs to open
 * offline. Strategy: try the network first with a short timeout, fall back to the
 * cache. That way a redeploy reaches phones on the very next load, and a phone
 * with no signal still opens and can keep score on its own.
 */

const CACHE = 'flip7-v15';

const SHELL = [
  '.',
  'index.html',
  'css/styles.css',
  'fonts/outfit-latin.woff2',
  'icon.svg',
  'manifest.webmanifest',
  'firebase-config.js',
  'js/main.js',
  'js/room.js',
  'js/odds.js',
  'js/engine.js',
  'js/ai.js',
  'js/dealer.js',
  'js/table.js',
  'js/store.js',
  'js/sync-local.js',
  'js/sync-relay.js',
  'relay-config.js',
  'js/scorer.js',
  'js/cards.js',
  'js/scoring.js',
  'js/rng.js',
  'js/sound.js',
  'js/fx.js',
  'js/views.js',
  'js/storage.js',
  'js/cardview.js',
  'js/avatar.js',
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

/** Fetch, but don't wait forever on a phone with one bar. */
function fetchWithin(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never answer the relay probe from cache. A stale "yes, there's a relay here"
  // would make the app offer online rooms it then can't connect to, which is the
  // exact failure the probe exists to prevent.
  if (url.pathname === '/health') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // Network first, so a redeploy reaches phones on the next load rather
        // than the one after it.
        const response = await fetchWithin(request, 2500);
        if (response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        // An unvisited URL with no network: hand back the shell so the app still
        // boots and can keep score offline.
        if (request.mode === 'navigate') {
          const shell = await cache.match('index.html');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })(),
  );
});
