/* HTTP 계층 — 정적 서빙 + POST /action + SSE /events + long-poll /poll */
'use strict';
var fs = require('fs');
var path = require('path');
var rooms = require('./rooms.js');

var CLIENT_DIR = path.join(__dirname, '..', 'client');
var SHARED_DIR = path.join(__dirname, '..', 'shared');
var MAX_BODY = 16 * 1024;
var SSE_HEARTBEAT_MS = 15000;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function json(res, obj, status) {
  var body = JSON.stringify(obj);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function clientIp(req) {
  var xf = req.headers['x-forwarded-for']; // Render 등 프록시 뒤
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// ---------- 정적 파일 ----------
function serveStatic(req, res, pathname) {
  var base = CLIENT_DIR, rel;
  if (pathname.indexOf('/shared/') === 0) {
    base = SHARED_DIR;
    rel = pathname.slice('/shared/'.length);
  } else {
    rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  }
  rel = rel.split('?')[0];
  var fp = path.normalize(path.join(base, rel));
  if (fp.indexOf(base + path.sep) !== 0 && fp !== path.join(base, 'index.html')) {
    res.writeHead(403); res.end(); return;
  }
  var ext = path.extname(fp).toLowerCase();
  if (!MIME[ext]) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(fp, function (e, data) {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Cache-Control': 'no-cache', // 구버전 클라이언트 캐시 방지
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

// ---------- POST /action ----------
function handleAction(req, res) {
  var chunks = [], size = 0, aborted = false;
  req.on('data', function (d) {
    size += d.length;
    if (size > MAX_BODY) {
      aborted = true;
      json(res, { type: 'action_ack', ok: false, error: { code: 'BAD_REQUEST', message: '요청이 너무 큽니다' } }, 413);
      req.destroy();
      return;
    }
    chunks.push(d);
  });
  req.on('end', function () {
    if (aborted) return;
    var body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { body = null; }
    var out = rooms.handleHttp(body, clientIp(req));
    json(res, out);
  });
  req.on('error', function () { /* 무시 */ });
}

// ---------- SSE /events ----------
function handleEvents(req, res, query) {
  var token = query.token || '';
  var since = parseInt(query.since || '0', 10) || 0;
  if (!rooms.findPlayer(token)) { res.writeHead(403); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive'
  });
  // 재시도 간격 + 프록시 버퍼 무력화용 패딩
  res.write('retry: 3000\n');
  res.write(':' + new Array(2048).join(' ') + '\n\n');
  res.write('event: hb\ndata: {}\n\n');

  var ch = {
    kind: 'sse',
    send: function (obj) {
      var id = obj && obj.version != null ? 'id: ' + obj.version + '\n' : '';
      res.write(id + 'data: ' + JSON.stringify(obj) + '\n\n');
    },
    close: function () { try { res.end(); } catch (e) { /* 무시 */ } }
  };
  var hb = setInterval(function () {
    try { res.write('event: hb\ndata: {}\n\n'); } catch (e) { /* close에서 정리 */ }
  }, SSE_HEARTBEAT_MS);

  // Last-Event-ID 헤더가 있으면 그 버전 이후만
  var lei = parseInt(req.headers['last-event-id'] || '0', 10);
  if (lei > since) since = lei;

  if (!rooms.attachSSE(token, since, ch)) { clearInterval(hb); res.end(); return; }
  req.on('close', function () {
    clearInterval(hb);
    rooms.detachSSE(token, ch);
  });
}

// ---------- long-poll /poll ----------
function handlePoll(req, res, query) {
  var token = query.token || '';
  var since = parseInt(query.since || '0', 10) || 0;
  var done = false;
  function respond(obj) {
    if (done) return;
    done = true;
    json(res, obj);
  }
  req.on('close', function () { done = true; });
  rooms.attachPoll(token, since, respond);
}

/* 기보 — 전적(/stats)과 같은 위협 모델: 동료 내부용, 무인증.
 * 라운드가 끝난 손패는 이미 공개 정보라 노출해도 게임에 영향이 없다.
 *   /gamelog/status  수집 확인(버퍼 수·현재 키·KV 키 목록)
 *   /gamelog/recent  이번 부팅의 최근 기보 (JSONL) — 다시보기·수거용
 *   /gamelog/get?key= 과거 부팅 키의 기보 (JSONL, tichu:gamelog: 접두사만 허용) */
function handleGamelog(req, res, p, q) {
  var G = require('./gamelog.js');
  var KV = require('./kv.js');
  function json(code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
  function text(code, s) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); }
  if (p === '/gamelog/status') {
    var st = G.status();
    Promise.resolve(KV.enabled() ? KV.list('tichu:gamelog:') : null)
      .then(function (keys) { json(200, { buffered: st.buffered, key: st.key, kv: { enabled: KV.enabled(), keys: keys } }); })
      .catch(function (e) { json(200, { buffered: st.buffered, key: st.key, kv: { enabled: KV.enabled(), error: String(e && e.message).slice(0, 200) } }); });
    return;
  }
  if (p === '/gamelog/recent') {
    text(200, G.recent(+q.n || 50).map(function (r) { return JSON.stringify(r); }).join('\n'));
    return;
  }
  if (p === '/gamelog/get') {
    var key = String(q.key || '');
    if (key.indexOf('tichu:gamelog:') !== 0) { json(400, { error: 'tichu:gamelog: 키만 조회 가능' }); return; }
    Promise.resolve(KV.get(key))
      .then(function (v) { if (v == null) json(404, { error: '키 없음' }); else text(200, v); })
      .catch(function (e) { json(502, { error: String(e && e.message).slice(0, 200) }); });
    return;
  }
  json(404, { error: '알 수 없는 기보 경로' });
}

// ---------- 라우터 ----------
function handle(req, res) {
  var u;
  try { u = new URL(req.url || '/', 'http://local'); } catch (e) { res.writeHead(400); res.end(); return; }
  var p = u.pathname || '/';
  var q = {};
  u.searchParams.forEach(function (v, k) { q[k] = v; });
  if (req.method === 'GET' && p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.method === 'GET' && p === '/stats') {   // 전적 — 닉네임 기반, 인증 없음(동료 내부용)
    var S = require('./stats.js');
    // 자격증명 형태·오류 본문 같은 진단 세부는 비밀키를 아는 호출에만 (공개 엔드포인트)
    var diagOk = !!(process.env.TICHU_DIAG && q.diag === process.env.TICHU_DIAG);
    var body = JSON.stringify(q.name
      ? { detail: S.detail(String(q.name).slice(0, 12)) }
      : { board: S.board(20), persist: S.status(diagOk) });   // persist: 영구저장 상태(운영 확인용)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.method === 'GET' && p.indexOf('/gamelog/') === 0) { handleGamelog(req, res, p, q); return; }
  if (req.method === 'POST' && p === '/action') { handleAction(req, res); return; }
  if (req.method === 'GET' && p === '/events') { handleEvents(req, res, q); return; }
  if (req.method === 'GET' && p === '/poll') { handlePoll(req, res, q); return; }
  if (req.method === 'GET' || req.method === 'HEAD') { serveStatic(req, res, p); return; }
  res.writeHead(405); res.end();
}

module.exports = { handle: handle };
