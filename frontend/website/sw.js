const CACHE_NAME = 'ticktock-cache-v9';
const ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/styles.css',
  '/app.js',
  '/app-version.js',
  '/icons/logo.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
  '/manifest.json'
];
// Optional assets that may not always exist locally (exist in production). Cache best-effort.
const OPTIONAL_ASSETS = [
  '/config.js',
  '/version.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache core assets (fail install if these fail)
    await cache.addAll(ASSETS);
    // Try to cache optional assets, but ignore failures (e.g., in local dev)
    await Promise.all(OPTIONAL_ASSETS.map(p => cache.add(p).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Support immediate activation when told by the page
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Intercept only same-origin requests
  if (url.origin !== location.origin) return;

  // Special-case PWA icons: if origin serves wrong content-type or fails, return a tiny valid PNG
  const pathname = url.pathname || '';
  if (req.method === 'GET' && (pathname === '/icons/icon-192.png' || pathname === '/icons/icon-512.png')) {
    e.respondWith((async () => {
      const fromCache = await caches.match(req).catch(() => null);
      if (fromCache) return fromCache;
      try {
        const resp = await fetch(req);
        const ct = (resp.headers && resp.headers.get('content-type')) || '';
        if (resp.ok && ct.startsWith('image/')) return resp;
      } catch (_) {}
      // Fallback 1x1 transparent PNG
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ajQ3e8AAAAASUVORK5CYII=';
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' } });
    })());
    return;
  }

  // Navigation requests: try network first, fall back to cached offline page (keeps app styling)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // For scripts and styles: network-first to ensure latest on every load, fallback to cache offline
  if (req.destination === 'script' || req.destination === 'style') {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first, then network; provide safe fallbacks on failure to avoid uncaught rejections
  e.respondWith(
    caches.match(req).then(resp => resp || fetch(req)).catch(() => {
      const path = url.pathname || '';
      if (req.destination === 'script' && path.endsWith('/config.js')) {
        return new Response("window.RUNTIME_CONFIG=Object.assign({},window.RUNTIME_CONFIG||{},{BACKEND_URL:''});", { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
      }
      if (req.destination === 'script' && path.endsWith('/app-version.js')) {
        return new Response("window.APP_VERSION='offline';", { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
      }
      if (req.destination === 'document') {
        return caches.match('/offline.html');
      }
      return new Response('', { status: 504, statusText: 'Offline' });
    })
  );
});

// Handle push messages sent from the backend
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'Task Reminder';
  const body = data.body || 'You have a task due.';
  const options = {
    body,
    icon: data.icon || '/icons/logo.svg',
    badge: data.badge || '/icons/logo.svg',
    tag: data.taskId ? `task-${data.taskId}` : undefined,
    data,
    requireInteraction: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = new URL('/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
      for (const client of clientsArr) {
        if ('focus' in client) {
          client.focus();
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});
