/* Service worker: zorgt dat de app offline opent.
   Pas je een bestand aan? Hoog dan VERSIE op, anders blijven telefoons
   de oude versie uit hun cache serveren. */

var VERSIE = 'pakbon-v10';

var BESTANDEN = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', function (e) {
  // 'reload' dwingt verse kopieën af. GitHub Pages zet tien minuten cache op
  // de bestanden; zonder dit zou een nieuwe VERSIE de oude inhoud opslaan.
  e.waitUntil(
    caches.open(VERSIE).then(function (c) {
      return c.addAll(BESTANDEN.map(function (u) {
        return new Request(u, { cache: 'reload' });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (namen) {
      return Promise.all(namen.filter(function (n) { return n !== VERSIE; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // config.js eerst van het net: een gewijzigde OneDrive-link of pincode
  // moet direct doorkomen, ook zonder nieuwe VERSIE.
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var kopie = r.clone();
        caches.open(VERSIE).then(function (c) { c.put(e.request, kopie); });
        return r;
      }).catch(function () { return caches.match(e.request); })
    );
    return;
  }

  // De rest: eerst uit de cache, anders van het net.
  e.respondWith(
    caches.match(e.request).then(function (gevonden) {
      return gevonden || fetch(e.request).catch(function () {
        return caches.match('./index.html');
      });
    })
  );
});
