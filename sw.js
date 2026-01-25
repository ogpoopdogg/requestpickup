// Name of the cache
const cacheName = 'eandc-pickup-cache-v1';

// Files to cache for offline use
const assetsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-512.png'
];

// Install event - cache files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(cacheName).then(cache => cache.addAll(assetsToCache))
  );
});

// Fetch event - serve cached files if offline
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(res => res || fetch(event.request))
  );
});
