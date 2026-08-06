// Service worker.
//
// Strategy:
//   code (JS/CSS/HTML) — network-first, cache only as an offline fallback
//   data/*.json        — network-first, so catalog changes show up immediately
//   everything else    — straight to the network (thumbnails, video files)
//
// Code is deliberately NOT served cache-first. ES modules have to be
// version-consistent with each other: if app.js is from one deploy and util.js
// from the next, the import fails at link time and the whole application stops
// executing — a blank page rather than a degraded one. Stale-while-revalidate
// guarantees that skew eventually happens, so the shell cache exists purely to
// keep the site usable offline, never to serve a live visitor a mixed bundle.
//
// Bump CACHE_VERSION on any release. `activate` deletes every cache that
// doesn't match, which is what un-sticks a browser holding an older bundle.

const CACHE_VERSION = 'ym-v3';
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
  './assets/js/upload.js',
  './assets/js/views/home.js',
  './assets/js/views/watch.js',
  './assets/js/views/channel.js',
  './assets/js/views/series.js',
  './assets/js/views/search.js',
  './assets/js/views/library.js',
  './assets/js/views/playlist.js',
  './assets/js/views/studio.js',
  './assets/js/views/upload.js',
  './assets/js/views/settings.js',
];

const isCode = (url) => /\.(?:js|mjs|css|html)$/.test(url.pathname) || url.pathname === '/';

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

// The page can ask to be cut loose entirely — see the recovery guard in
// index.html, which fires when a module fails to load.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'reset') return;
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
    event.source?.postMessage({ type: 'reset-done' });
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle our own origin — never intercept thumbnails or video files.
  if (url.origin !== self.location.origin) return;

  // Range requests (video seeking) must go straight to the network.
  if (request.headers.has('range')) return;

  // API responses are per-session and must never be cached or replayed — a
  // cached /api/auth/session would show the previous person's account.
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Navigations and code both come from the network when it's reachable.
  if (request.mode === 'navigate' || isCode(url)) {
    event.respondWith(networkFirst(request, SHELL_CACHE, { fallbackToShell: request.mode === 'navigate' }));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request, cacheName, { fallbackToShell = false } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Offline on a deep link — the app shell can still boot and route.
    if (fallbackToShell) {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
