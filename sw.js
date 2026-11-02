// 오프라인 캐시: 캐시에 있으면 바로 보여주고, 뒤에서 새 버전을 받아 캐시를 갱신한다.
// 앱 파일을 바꾸면 VERSION을 올린다.
const VERSION = 'v1.0.0';
const CACHE = 'stampcam-' + VERSION;
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/camera.js',
  'js/counter.js',
  'js/save.js',
  'js/settings.js',
  'js/stamp.js',
  'js/storage.js',
  'js/zip.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('stampcam-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      return (await network) || new Response('오프라인입니다.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })
  );
});
