// Service Worker: offline-fähig + Empfang geteilter Dateien (Android „Teilen“)
const CACHE = 'ao-reader-v1.5.4';
const CORE = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/compat.js', './js/db.js', './js/zip.js', './js/epub.js', './js/pdf.js',
  './lib/pdfjs/pdf.js', './lib/pdfjs/pdf.worker.js', './lib/pdfjs2/pdf.js', './lib/pdfjs2/pdf.worker.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k !== 'sr-share') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Geteilte Dateien entgegennehmen
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const cache = await caches.open('sr-share');
        let i = 0;
        for (const f of form.getAll('books')) {
          if (!(f instanceof File)) continue;
          await cache.put(`./shared/${Date.now()}-${i++}`, new Response(f, {
            headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name) },
          }));
        }
      } catch (err) { /* ignorieren */ }
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Seitenaufrufe: App-Hülle aus dem Cache
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then((r) => r || fetch(e.request)));
    return;
  }

  // Alles andere: Cache zuerst, sonst Netz (und für später merken, z. B. PDF-Schriften)
  e.respondWith((async () => {
    const hit = await caches.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok && res.type === 'basic') {
      const c = await caches.open(CACHE);
      c.put(e.request, res.clone());
    }
    return res;
  })());
});
