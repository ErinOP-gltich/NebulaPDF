/* NebulaPDF service worker: keeps the site and its tool libraries on the device, so it works offline.
   - The site's own files: fetched fresh when online (so new versions load at once), the saved copy when offline.
   - Libraries, fonts and OCR data from CDNs: their URLs carry a version and never change, so they're served from
     the saved copy and only downloaded the first time. */
const SHELL = 'nebula-shell';
const LIBS = 'nebula-libs';
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'tessdata.projectnaptha.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', 'manifest.webmanifest', 'assets/app-icons/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(LIBS).then(async cache => {
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      // always check with the server (never the browser's HTTP cache), so a new deploy is picked up at once
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      // offline: the saved copy; any page of the site falls back to the app itself
      return (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? cache.match('./') : Response.error());
    }
  })());
});
