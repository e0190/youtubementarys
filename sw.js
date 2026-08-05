// Service worker.
//
// Strategy:
//   app shell  — cache-first, refreshed in the background (stale-while-revalidate)
//   data/*.json — network-first, so catalog edits show up immediately, with the
//                 cached copy as an offline fallback
//   everything else (YouTube, thumbnails, video files) — straight to the network
//
// Bump CACHE_VERSION whenever the shell files change, or clients will keep
// serving the old bundle.

const CACHE_VERSION = 'ym-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/img/favicon.svg',
  './assets/js/app.js',
  './assets/js/config.js',
  './assets/js/util.js',
  './assets/js/api.js',
  './assets/js/auth.js',
  './assets/js/store.js',
  './assets/js/sync.js',
  './assets/js/router.js',
  './assets/js/player.js',
  './assets/js/components.js',
  './assets/js/miniplayer.js',
  './assets/js/views/home.js',
  './assets/js/views/watch.js',
  './assets/js/views/channel.js',
  './assets/js/views/series.js',
  './assets/js/views/search.js',
  './assets/js/views/library.js',
  './assets/js/views/playlist.js',
  './assets/js/views/studio.js',
  './assets/js/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the whole install if any single file 404s; add individually
    // so one stale path can't brick the worker.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => !key.startsWith(CACHE_VERSION))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle our own origin — never intercept YouTube, thumbnails or media.
  if (url.origin !== self.location.origin) return;

  // Range requests (video seeking) must go straight to the network.
  if (request.headers.has('range')) return;

  // API responses are per-session and must never be cached or replayed — a
  // cached /api/auth/session would show the previous person's account.
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigations always resolve to the app shell — the hash carries the route.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      return cached || fetch(request);
    })());
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
