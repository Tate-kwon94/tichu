/* 서비스워커 — 정적 자산 캐시(오프라인 혼자 연습), 네트워크 우선(업데이트 안전) */
var VERSION = 'tichu-v41';
/* 자산 URL에 ?v=를 붙인다 — Cloudflare가 원본의 no-cache를 max-age=14400(4시간)으로
 * 덮어써서, URL이 그대로면 배포 후에도 브라우저가 최대 4시간 구파일을 쓴다(실측).
 * index.html은 CF가 캐시하지 않으므로(DYNAMIC) 새 버전 URL이 즉시 전파된다.
 * 버전 표기는 세 곳(client/*.html의 ?v=, index.html의 __ASSET_V, 여기 VERSION/V)이며
 * test/version-sync.js가 일치를 강제한다 — __ASSET_V가 v34에 6번의 배포 동안 방치됐었다. */
var V = 'v=41';
/* 가중치 JSON은 배포 버전과 무관한 영구 캐시에 둔다(캐시 우선).
 * 종전엔 런타임에 받은 8MB 정책망이 VERSION 캐시에 들어가 배포마다 지워졌고,
 * 그래서 배포할 때마다 오프라인 4단이 "온라인에서 한 번 더" 상태로 리셋됐다.
 * 파일 내용이 바뀌면 파일명이나 ?v=를 바꿔야 한다(4단 정책망은 승단 규율상 동결). */
var WEIGHTS = 'tichu-weights';
var ASSETS = [
  './',
  'index.html',
  'style.css?' + V,
  'app.js?' + V,
  'transport.js?' + V,
  'offline.js?' + V,
  'strings.js?' + V,
  'shared/tichu-core.js?' + V,
  'shared/bots.js?' + V,
  'shared/net-infer.js?' + V,
  'shared/hybrid-bot.js?' + V,
  'shared/declare.js?' + V,
  'shared/endgame.js?' + V,
  'shared/exchange-feats.js?' + V,
  'shared/exchange-infer.js?' + V,
  'shared/weights-exchange4.json?' + V,   // 4단 교환 MLP(수 KB) — 정책망 8MB는 설치 시 받지 않는다
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/xlsx.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];
var LIVE = ['/ws', '/events', '/poll', '/action', '/healthz'];
var WEIGHT_RE = /\/shared\/weights-[^/]+\.json$/;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== WEIGHTS; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (LIVE.indexOf(url.pathname) >= 0) return; // 실시간 통신은 절대 가로채지 않음
  if (WEIGHT_RE.test(url.pathname)) {
    // 가중치: 캐시 우선. caches.match는 전 캐시를 보므로 설치 캐시의 exchange4도 잡힌다
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(WEIGHTS).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }
  e.respondWith(
    fetch(req, { cache: 'no-store' }).then(function (res) {
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
