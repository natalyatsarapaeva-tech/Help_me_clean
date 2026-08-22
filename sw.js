/* «Наведи и убери» — service worker (офлайн-оболочка, перенос Twin sw.js).
 * Network-first для всего своего origin: свежий код всегда из сети, кэш —
 * офлайн-фолбэк. Cross-origin (Firestore, Storage, Worker) — мимо кэша.
 * Поднимай CACHE при выкатке, чтобы старый кэш сбрасывался.
 */
const CACHE = 'tidy-v9';
const ASSETS = [
  './', './index.html', './home.html', './children.html', './scan.html', './reference.html', './cards.html', './collection.html', './rewards.html', './shop.html',
  './styles.css', './pwa.js', './manifest.json',
  './js/firebase.js', './js/store.js', './js/family-core.js',
  './js/pin.js', './js/profile-core.js', './js/image.js', './js/ai.js', './js/round-core.js', './js/camera.js', './js/cards-core.js', './js/shop-core.js', './js/limits-core.js', './js/bonus-core.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) =>
      r || (req.mode === 'navigate' || req.destination === 'document'
        ? caches.match('./index.html') : undefined))),
  );
});
