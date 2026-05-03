// Food Studio service worker — minimal install + offline shell
const SHELL_CACHE = 'fs-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/assets/food_studio_horizontal_600.png',
  '/assets/food_studio_vertical_white_480.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Pass-through for Supabase, /api, and cross-origin: don't cache live data
  if (url.hostname.includes('supabase.co') ||
      url.pathname.startsWith('/api/') ||
      url.origin !== self.location.origin) {
    return; // browser default
  }
  // Cache-first for shell assets, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached =>
      cached || fetch(event.request).then(resp => {
        // Stash successful GET responses for next visit
        if (event.request.method === 'GET' && resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match('/index.html'))
    )
  );
});
