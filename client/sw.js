/* 서비스워커 — 정적 자산 캐시(오프라인 혼자 연습), 네트워크 우선(업데이트 안전) */
var VERSION = 'tichu-v22';
var ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'transport.js',
  'offline.js',
  'strings.js',
  'shared/tichu-core.js',
  'shared/bots.js',
  'shared/net-infer.js',
  'shared/hybrid-bot.js',
  'shared/declare.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/xlsx.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];
var LIVE = ['/ws', '/events', '/poll', '/action', '/healthz'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (LIVE.indexOf(url.pathname) >= 0) return; // 실시간 통신은 절대 가로채지 않음
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./');
        return new Response('', { status: 504 });
      });
    })
  );
});
