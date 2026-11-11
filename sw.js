// Phone alerts. PUSH_APP_ID is the same Web app ID as in index.html; while it's empty, alerts are off.
const PUSH_APP_ID = '1:1067680083511:web:a8fa46c0621e74aabd19b2';
if (PUSH_APP_ID) {
  try {
    importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
    firebase.initializeApp({
      apiKey: 'AIzaSyAKmgoXA4m3cRTmxJq4aUyva5SVvFbTNqg',
      authDomain: 'eandccourier-36fcc.firebaseapp.com',
      databaseURL: 'https://eandccourier-36fcc-default-rtdb.firebaseio.com',
      projectId: 'eandccourier-36fcc',
      messagingSenderId: '1067680083511',
      appId: PUSH_APP_ID
    });
    // The dispatch app's functions send data-only alerts (title, body, tag, go); this shows them
    firebase.messaging().onBackgroundMessage((payload) => {
      const d = (payload && payload.data) || {};
      return self.registration.showNotification(d.title || 'E&C Courier', {
        body: d.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: d.tag || undefined, // a newer alert about the same pickup replaces the older one
        renotify: !!d.tag,
        data: { go: d.go || '' }
      });
    });
  } catch (err) {
    console.log('Phone alerts unavailable', err);
  }
}

// Tapping an alert opens the app (or brings it to the front) on that pickup or on Messages
self.addEventListener('notificationclick', (event) => {
  const go = (event.notification.data && event.notification.data.go) || '';
  if (!go && !(event.notification.data && 'go' in event.notification.data)) return; // not one of ours
  event.notification.close();
  const url = new URL(`./index.html${go ? `?go=${encodeURIComponent(go)}` : ''}`, self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { open.postMessage({ go }); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});

// Updated cache name to force the browser to recognize a change
const cacheName = 'eandc-pickup-cache-v6';

// Files to cache
const assetsToCache = [
  './',
  './customer.html',   // Ensures your form is cached
  './manifest.json',
  './icon-192.png',
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
    // Take control of open windows. The page itself decides whether to reload (see the controllerchange listener in index.html),
    // so a first visit is never reloaded and nobody loses a half-filled form.
    .then(() => self.clients.claim())
  );
});

// Fetch event - serve cached files if offline, otherwise fetch from network
self.addEventListener('fetch', event => {
  // HTML pages: always get the newest copy from the network (skipping the browser's HTTP cache),
  // save it for offline use, and only fall back to the saved copy when there is no connection
  const req = event.request;
  // Leave everything that isn't a plain GET to this site alone (Firebase, Google Maps, fonts, sign-in, POSTs).
  // The browser handles those directly, so a slow or long-running outside request can't get stuck in the service worker.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
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
