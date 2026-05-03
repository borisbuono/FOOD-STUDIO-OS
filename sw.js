// Food Studio service worker — v2
// Strategy:
//   - HTML (navigation): network-first, fall back to cache; ensures updates pick up
//   - Static assets (PNG/JSON/JS/CSS): cache-first with stale-while-revalidate
//   - Supabase + /api/: pass-through (never cached, always live)
const STATIC_CACHE = 'fs-static-v2';
const HTML_CACHE = 'fs-html-v2';

const STATIC_ASSETS = [
  '/manifest.json',
  '/assets/food_studio_horizontal_600.png',
  '/assets/food_studio_vertical_white_480.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // Take over immediately so users get the new SW behaviour without closing tabs
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(c => c.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== STATIC_CACHE && k !== HTML_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pass-through: live data, never cache
  if (url.hostname.includes('supabase.co') ||
      url.pathname.startsWith('/api/') ||
      url.origin !== self.location.origin) {
    return;
  }

  // HTML / navigation requests → network-first (so app updates land on refresh)
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith(
      fetch(req).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(HTML_CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req).then(c => c || caches.match('/index.html')))
    );
    return;
  }

  // Static assets → cache-first, fetch in background to refresh next time
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(STATIC_CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Allow the app to ask for an immediate skipWaiting — used by an Update banner
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
