#!/usr/bin/env node
/* 티츄 게임 서버 — 의존성 0, Node 18+
 * 실행: node server.js   (포트: 환경변수 PORT, 기본 8080) */
'use strict';
var http = require('http');
var os = require('os');
var transports = require('./server/transports.js');
var ws = require('./server/ws.js');
var rooms = require('./server/rooms.js');
var stats = require('./server/stats.js');

var PORT = parseInt(process.env.PORT || '8080', 10);

var server = http.createServer(function (req, res) {
  try {
    transports.handle(req, res);
  } catch (e) {
    console.error('[tichu] 요청 처리 오류:', e && e.stack || e);
    try { res.writeHead(500); res.end(); } catch (e2) { /* 무시 */ }
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

ws.attach(server, '/ws', function (conn, req) {
  try { rooms.attachWS(conn, req); } catch (e) {
    console.error('[tichu] WS 오류:', e && e.stack || e);
    try { conn.destroy(); } catch (e2) { /* 무시 */ }
  }
});

rooms.startGC();

// 어떤 예외도 프로세스를 죽이지 않게 (게임 서버 생존 우선)
process.on('uncaughtException', function (e) { console.error('[tichu] uncaughtException:', e && e.stack || e); });
process.on('unhandledRejection', function (e) { console.error('[tichu] unhandledRejection:', e); });

/* 종료 전 전적 플러시 — Render는 배포·유휴 절전 전에 SIGTERM을 보낸다.
 * 원격 저장은 비동기라 그냥 죽으면 마지막 게임이 날아간다. 늦어도 6초 뒤엔 종료. */
var closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log('[tichu] ' + sig + ' — 전적 저장 후 종료');
  /* KV 요청 타임아웃 8초 × 최대 2회 시도 = 16초. 안전망이 그보다 짧으면
   * 느린 날에는 플러시가 자기 안전망에 잘려 마지막 게임이 유실된다. */
  var hard = setTimeout(function () { process.exit(0); }, 20000);
  if (hard.unref) hard.unref();
  var glog = require('./server/gamelog.js');
  Promise.resolve(Promise.all([stats.flush(), glog.flush()]))
    .catch(function (e) { console.error('[tichu] 종료 플러시 실패:', e && e.message); })
    .then(function () { clearTimeout(hard); process.exit(0); });
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });

server.listen(PORT, '0.0.0.0', function () {
  console.log('티츄 서버 시작 — 포트 ' + PORT);
  console.log('접속 주소:');
  console.log('  http://localhost:' + PORT);
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (i) {
      if (i.family === 'IPv4' && !i.internal) console.log('  http://' + i.address + ':' + PORT + '  (같은 네트워크)');
    });
  });
});
