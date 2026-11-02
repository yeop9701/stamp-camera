// 오프라인 캐시.
// 인터넷이 되면 항상 서버에서 새로 받고(네트워크 우선), 안 되거나 느리면 캐시로 연다.
// GitHub Pages는 파일을 10분간 브라우저 캐시에 두라고(max-age=600) 보내므로,
// 받을 때 브라우저 캐시를 건너뛰어야(cache: 'no-cache' / 'reload') 옛 파일이 새 버전에 섞이지 않는다.
// 앱 파일을 바꾸면 VERSION을 올린다.
const VERSION = 'v1.2.1';
const CACHE = 'stampcam-' + VERSION;
const NETWORK_TIMEOUT_MS = 4000;
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
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
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
      const network = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      const timeout = new Promise((r) => setTimeout(() => r(null), NETWORK_TIMEOUT_MS));
      const res = await Promise.race([network, timeout]);
      if (res) return res;
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      return (await network) || new Response('오프라인입니다.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })
  );
});
