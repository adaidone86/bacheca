const CACHE_NAME = 'bacheca-v1';
const URLS_TO_CACHE = [
  '/bacheca/',
  '/bacheca/index.html',
  '/bacheca/css/style.css',
  '/bacheca/js/script.js',
  '/bacheca/app/manifest.json'
];

// Installa il service worker e cache i file
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(URLS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Attiva il service worker e pulisci le cache vecchie
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Intercetta le richieste
self.addEventListener('fetch', event => {
  // Se è Firebase, usa sempre la rete
  if (event.request.url.includes('firebaseio.com')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          // Se offline, ritorna un errore placeholder
          return new Response(
            JSON.stringify({ error: 'Offline' }),
            { status: 503, statusText: 'Service Unavailable' }
          );
        })
    );
    return;
  }

  // Per gli altri file, usa cache first, fallback network
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) {
        return response;
      }
      return fetch(event.request).then(response => {
        // Cache successful responses
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
        return response;
      });
    }).catch(() => {
      // Fallback per pagina offline
      return caches.match('/bacheca/index.html');
    })
  );
});
