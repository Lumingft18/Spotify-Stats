// Minimal offline support: cache-first for hashed assets, network-first for the app shell.
const CACHE = 'ascolti-v2';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/index.html', '/manifest.webmanifest', '/icon.svg'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
const IMG = 'ascolti-covers-v1';
const COVER_HOSTS = /(^|\.)(scdn\.co|spotifycdn\.com)$/;
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Cover art: cache-first, so covers stay available offline and across different exports.
  if (e.request.method === 'GET' && COVER_HOSTS.test(url.hostname) && e.request.destination === 'image') {
    e.respondWith(
      caches.open(IMG).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch third-party requests
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          }),
      ),
    );
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
  }
});
