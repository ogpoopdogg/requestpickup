// Updated cache name to force the browser to recognize a change
const cacheName = 'eandc-pickup-cache-v3';

// Files to cache
const assetsToCache = [
  './',
  './customer.html',   // Ensures your form is cached
  './manifest.json',
  './icon-512.png',
  './icon2.png'        // Caches the logo if you have it
];

// Install event - caches files and forces activation
self.addEventListener('install', event => {
  self.skipWaiting(); // Forces this new worker to take over immediately
  event.waitUntil(
    caches.open(cacheName).then(cache => {
      // Cache each file on its own (bypassing the browser's HTTP cache) so one missing file can't stop the update from installing
      return Promise.all(assetsToCache.map(url =>
        cache.add(new Request(url, { cache: 'reload' })).catch(err => console.log('Skipped caching', url, err))
      ));
    })
  );
});

// Activate event - CLEANS UP OLD CACHES (Fixes your "Client Portal" text issue)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (key !== cacheName) {
          console.log('Clearing old cache', key);
          return caches.delete(key);
        }
      })
    ))
    // Take control, then reload any open windows once so they switch to the latest HTML right away
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then(clients => Promise.all(clients.map(client => client.navigate(client.url).catch(() => {}))))
  );
  return self.clients.claim(); // Takes control of all open clients instantly
});

// Fetch event - serve cached files if offline, otherwise fetch from network
self.addEventListener('fetch', event => {
  // HTML pages: always get the newest copy from the network (skipping the browser's HTTP cache),
  // save it for offline use, and only fall back to the saved copy when there is no connection
  const req = event.request;
  const isHTML = req.method === 'GET' && (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html'));
  if (isHTML) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then(response => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(cacheName).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return response;
      }).catch(() =>
        caches.match(req, { ignoreSearch: true }).then(cached => cached || caches.match('./'))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
