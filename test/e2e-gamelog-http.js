#!/usr/bin/env node
/* 기보 HTTP 엔드포인트 E2E — 서버 프로세스도 소켓도 없이 in-process로 검증한다.
 * (라우터 handle()에 모의 req/res, KV는 globalThis.fetch 스텁으로 CF를 흉내.)
 *
 * 검증:
 *   1) 실기보 재생을 onAction에 흘리면 라운드 봉인 → /gamelog/recent에 나타남
 *   2) /gamelog/status가 버퍼 수 + KV 키 목록(list)을 반환
 *   3) /gamelog/get이 KV 값을 반환, tichu:gamelog: 외 키는 400
 * 실행: node test/e2e-gamelog-http.js */
'use strict';
var path = require('path');
var os = require('os');
var fs = require('fs');

process.env.CF_ACCOUNT_ID = 'ab'.repeat(16);
process.env.CF_KV_NAMESPACE_ID = 'cd'.repeat(16);
process.env.CF_KV_TOKEN = 'A-'.repeat(20);
process.env.TICHU_GAMELOG_FILE = path.join(os.tmpdir(), 'tichu-glog-e2e-' + process.pid + '.jsonl');

var fakeStore = { 'tichu:gamelog:20260101:111': '{"live":false,"room":"OLD1"}' };

/* CF API를 흉내 내는 fetch 스텁 — kv.js가 쓰는 두 경로(keys 나열, values 읽기)만 */
globalThis.fetch = async function (url) {
  var u = new URL(String(url));
  function resp(code, body) {
    return { ok: code >= 200 && code < 300, status: code,
      text: async function () { return body; }, json: async function () { return JSON.parse(body); } };
  }
  if (/\/keys$/.test(u.pathname)) {
    var pre = u.searchParams.get('prefix') || '';
    var names = Object.keys(fakeStore).filter(function (k) { return k.indexOf(pre) === 0; });
    return resp(200, JSON.stringify({ success: true, result: names.map(function (n) { return { name: n }; }) }));
  }
  var m = /\/values\/(.+)$/.exec(u.pathname);
  if (m) {
    var key = decodeURIComponent(m[1]);
    if (fakeStore[key] == null) return resp(404, '{"errors":[{"message":"key not found"}]}');
    return resp(200, fakeStore[key]);
  }
  return resp(500, '{}');
};

var ROOT = path.join(__dirname, '..');
var GR = require(path.join(ROOT, 'ml', 'gamelog-replay.js'));
var glog = require(path.join(ROOT, 'server', 'gamelog.js'));
var transports = require(path.join(ROOT, 'server', 'transports.js'));
var C = require(path.join(ROOT, 'shared', 'tichu-core.js'));

/* 모의 요청 — handle()이 쓰는 필드만 */
function call(url) {
  return new Promise(function (resolve) {
    var res = {
      writeHead: function (code, h) { this.code = code; this.headers = h || {}; },
      end: function (body) { resolve({ code: this.code, body: body == null ? '' : String(body) }); }
    };
    transports.handle({ method: 'GET', url: url, headers: {} }, res);
  });
}

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

async function main() {
  // 1) 실기보 한 라운드를 onAction에 흘린다 (rooms.js와 같은 "적용 후" 시점)
  var rec = GR.load(path.join(ROOT, 'data', 'gamelog.jsonl'))[0];
  var room = { code: 'TEST', botLevel: 'super3',
    seats: [{ name: '권', isBot: false }, { name: 'b1', isBot: true }, { name: 'b2', isBot: true }, { name: 'b3', isBot: true }] };
  var g = new C.Game({ seed: 1, targetScore: 100000 });
  g.hands = rec.hands0.map(function (h) { return h.slice(0, 8); });
  g._restDeck = [];
  rec.hands0.forEach(function (h) { g._restDeck = g._restDeck.concat(h.slice(8)); });
  for (var i = 0; i < rec.acts.length; i++) {
    var a = GR.decompact(rec.acts[i]);
    var r = g.apply(a);
    if (!r.ok) { fail('재생 적용 실패 @' + i); break; }
    glog.onAction(room, a, g);
  }
  if (glog.status().buffered === 1) pass('라운드 봉인 → 버퍼 1'); else fail('버퍼 기대 1, 실제 ' + glog.status().buffered);

  // 2) /gamelog/recent
  var rr = await call('/gamelog/recent?n=5');
  var lines = rr.body.split('\n').filter(Boolean);
  if (rr.code === 200 && lines.length === 1 && JSON.parse(lines[0]).room === 'TEST') pass('/gamelog/recent 1건 (room TEST)');
  else fail('/gamelog/recent: ' + rr.code + ' ' + rr.body.slice(0, 80));

  // 3) /gamelog/status — KV 키 목록 포함
  var rs = await call('/gamelog/status');
  var js = JSON.parse(rs.body);
  if (rs.code === 200 && js.buffered === 1 && js.kv && js.kv.enabled && Array.isArray(js.kv.keys) && js.kv.keys.indexOf('tichu:gamelog:20260101:111') >= 0)
    pass('/gamelog/status 버퍼+KV 키 목록');
  else fail('/gamelog/status: ' + rs.body.slice(0, 160));

  // 4) /gamelog/get — 허용 키 / 금지 키
  var rg = await call('/gamelog/get?key=' + encodeURIComponent('tichu:gamelog:20260101:111'));
  if (rg.code === 200 && /OLD1/.test(rg.body)) pass('/gamelog/get KV 값 반환'); else fail('/gamelog/get: ' + rg.code);
  var rb = await call('/gamelog/get?key=' + encodeURIComponent('tichu:stats:v1'));
  if (rb.code === 400) pass('/gamelog/get 접두사 제한 (400)'); else fail('접두사 제한 실패: ' + rb.code);

  try { fs.unlinkSync(process.env.TICHU_GAMELOG_FILE); } catch (e) { /* 무시 */ }
  console.log(process.exitCode ? '실패 있음' : '전체 통과');
}

main().catch(function (e) { console.error(e); process.exit(1); });
