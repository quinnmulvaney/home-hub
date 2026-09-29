// Offline support. App files: network-first (so updates show up right away),
// falling back to cache when offline. Firebase SDK files: cache-first (URLs are versioned).
// Firestore/Auth API traffic is never touched — the Firebase SDK handles its own offline cache.
const CACHE = 'home-hub-v9';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/store.js', 'js/importer.js', 'js/merchant.js', 'js/util.js', 'js/firebase-config.js',
  'js/stats.js', 'js/charts.js', 'js/alerts.js', 'js/sortable.js', 'js/countdown.js',
  'js/modules/home.js', 'js/modules/budget.js', 'js/modules/goals.js', 'js/modules/wedding.js', 'js/modules/settings.js', 'js/modules/placeholder.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }) // revalidate so edits show up immediately
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
  } else if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
  }
});

// ---------- push notifications (spending-limit alerts sent by the bank-sync job) ----------

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'Home Hub', body: e.data ? e.data.text() : '' }; }
  const d = { ...(p.notification || {}), ...(p.data || {}) };
  e.waitUntil(self.registration.showNotification(d.title || 'Home Hub', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'homehub',
    data: { url: d.url || './#/budget' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if ('focus' in w) { w.navigate?.(target); return w.focus(); }
    return self.clients.openWindow(target);
  }));
});
