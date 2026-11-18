// Service Worker della Bacheca
//
// Strategia: PRIMA LA RETE per i file dell'app (HTML, JS, CSS, config, descrizioni):
// se c'è connessione si usa sempre la versione nuova (così gli aggiornamenti arrivano subito)
// e se ne salva una copia; senza connessione si usa l'ultima copia salvata.
// Le richieste verso altri domini (Firebase, gstatic, cdnjs) non vengono toccate:
// i dati arrivano sempre da Firebase in tempo reale.
//
// Cambiando CACHE_NAME le copie vecchie vengono cancellate all'attivazione.

const CACHE_NAME = 'bacheca-v4';

// File salvati all'installazione, così l'app si apre anche offline.
// Percorsi relativi alla posizione di sw.js: funziona in qualsiasi cartella.
const APP_FILES = [
  './',
  './index.html',
  './config.js',
  './js/script.js',
  './css/style-desktop.css',
  './css/style-mobile.css',
  './manifest.json',
  './descrizioni/versione',
  './descrizioni/titolo',
  './descrizioni/info',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Un file mancante non deve bloccare l'installazione (cache.addAll fallirebbe tutto)
      Promise.all(APP_FILES.map(url =>
        cache.add(url).catch(error => console.warn('SW: file non salvato', url, error))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  // Solo le letture dei file dell'app: niente POST, niente altri domini
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request, { ignoreSearch: true }).then(cached =>
          // Offline e file mai salvato: per le pagine si apre la bacheca
          cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error())
        )
      )
  );
});
