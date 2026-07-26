#!/usr/bin/env node
/* KV 영구저장 E2E — 진짜 Cloudflare 대신 CF API를 흉내 내는 가짜 서버로 검증한다.
 * (자격증명 없이도 클라이언트·하이드레이션·플러시 로직을 고정할 수 있다.)
 *
 * 검증:
 *   1) 키 없음(404) → 빈 상태로 시작
 *   2) 게임 기록 → 종료 플러시 시 KV PUT (multipart 또는 원시 본문)
 *   3) 새 프로세스가 KV에서 복원 (파일이 비어 있어도)
 *   4) 부팅 중(하이드레이션 지연) 도착한 기록이 유실되지 않음
 *   5) KV 장애(500)여도 서버가 죽지 않고 파일로 계속
 * 실행: node test/e2e-kv.js */
'use strict';
var http = require('http');
var fork = require('child_process').fork;
var path = require('path');
var fs = require('fs');

var ROOT = path.join(__dirname, '..');
var PORT = 18085;
var store = Object.create(null);   // 가짜 KV
var mode = 'ok';                   // 'ok' | 'fail' | 'slow'
var putCount = 0;

/* CF의 PUT 본문 파싱 — multipart면 value 파트를, 아니면 본문 전체를 값으로 본다. */
function parseValue(buf, ctype) {
  var body = buf.toString('utf8');
  if (ctype && ctype.indexOf('multipart/form-data') >= 0) {
    var m = /name="value"[^]*?\r\n\r\n([^]*?)\r\n--/.exec(body);
    if (!m) throw new Error('multipart에 value 파트 없음');
    return m[1];
  }
  return body;
}

var kvServer = http.createServer(function (req, res) {
  var m = /\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/.exec(req.url);
  if (!m) { res.writeHead(404); res.end('no route'); return; }
  if ((req.headers.authorization || '') !== 'Bearer test-token') { res.writeHead(403); res.end('bad token'); return; }
  var key = decodeURIComponent(m[3]);

  if (req.method === 'GET') {
    if (mode === 'fail') { res.writeHead(500); res.end('boom'); return; }
    var send = function () {
      if (store[key] == null) { res.writeHead(404); res.end('{"success":false}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(store[key]);
    };
    if (mode === 'slow') setTimeout(send, 1200); else send();
    return;
  }
  if (req.method === 'PUT') {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      if (mode === 'fail') { res.writeHead(500); res.end('boom'); return; }
      try {
        store[key] = parseValue(Buffer.concat(chunks), req.headers['content-type']);
        putCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }
  res.writeHead(405); res.end();
});

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* 서버 프로세스를 띄우고 한 판을 끝까지 진행시킨 뒤 SIGTERM으로 내린다.
 * 게임 진행은 별도 스크립트 없이 stats 모듈을 직접 부르는 하네스 프로세스로 대체 —
 * 여기서 검증할 것은 게임 규칙이 아니라 저장 경로다. */
function runHarness(env, script) {
  return new Promise(function (resolve, reject) {
    var child = fork(path.join(__dirname, 'kv-harness.js'), [script], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    var out = '';
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { out += d; });
    child.on('exit', function (code) {
      if (code !== 0) reject(new Error('하네스 종료 코드 ' + code + '\n' + out));
      else resolve(out);
    });
  });
}

var ENV = {
  CF_ACCOUNT_ID: 'acct', CF_KV_NAMESPACE_ID: 'ns', CF_KV_TOKEN: 'test-token',
  CF_API_BASE: 'http://127.0.0.1:' + PORT, CF_KV_KEY: 'tichu:test'
};

async function main() {
  await new Promise(function (r) { kvServer.listen(PORT, '127.0.0.1', r); });
  var dataFile = path.join(ROOT, 'data', 'stats.json');
  var backup = null;
  try { backup = fs.readFileSync(dataFile); } catch (e) {}
  try { fs.unlinkSync(dataFile); } catch (e) {}

  try {
    // 1·2) 빈 KV에서 시작 → 기록 → 플러시로 PUT
    var out1 = await runHarness(ENV, 'record');
    if (out1.indexOf('KV에 전적 없음') < 0) throw new Error('1) 404 경로 미확인:\n' + out1);
    if (!store['tichu:test']) throw new Error('2) 플러시가 KV에 쓰지 않음:\n' + out1);
    var saved = JSON.parse(store['tichu:test']);
    if (!saved['권'] || saved['권'].games !== 1) throw new Error('2) 저장 내용 이상: ' + store['tichu:test'].slice(0, 200));
    console.log('1) 빈 KV(404) 시작 OK');
    console.log('2) 종료 플러시 → KV 저장 OK (games=' + saved['권'].games + ', elo=' + Math.round(saved['권'].elo) + ')');

    // 3) 새 프로세스가 KV에서 복원 — 로컬 파일은 지운 상태
    try { fs.unlinkSync(dataFile); } catch (e) {}
    var out3 = await runHarness(ENV, 'read');
    if (out3.indexOf('전적 로드 1명 (KV)') < 0) throw new Error('3) KV 복원 실패:\n' + out3);
    if (out3.indexOf('READ games=1') < 0) throw new Error('3) 복원 내용 불일치:\n' + out3);
    console.log('3) 새 프로세스가 KV에서 복원 OK (디스크 초기화 시나리오)');

    // 4) 하이드레이션이 느려도 그 사이 기록이 유실되지 않음
    mode = 'slow';
    try { fs.unlinkSync(dataFile); } catch (e) {}
    var out4 = await runHarness(ENV, 'racy');
    mode = 'ok';
    if (out4.indexOf('부팅 중 도착한 기록') < 0) throw new Error('4) 지연 기록이 큐를 타지 않음:\n' + out4);
    var after = JSON.parse(store['tichu:test']);
    if (!after['권'] || after['권'].games !== 2) {
      throw new Error('4) 부팅 중 기록 유실 — games=' + (after['권'] && after['권'].games) + ' (기대 2)');
    }
    console.log('4) 하이드레이션 중 도착한 기록 보존 OK (누적 games=2)');

    // 5) KV 장애여도 죽지 않고 파일로 계속
    mode = 'fail';
    try { fs.unlinkSync(dataFile); } catch (e) {}
    var out5 = await runHarness(ENV, 'record');
    mode = 'ok';
    if (out5.indexOf('KV 복원 실패') < 0) throw new Error('5) 장애 로그 없음:\n' + out5);
    if (out5.indexOf('RECORDED') < 0) throw new Error('5) 장애 시 기록이 멈춤:\n' + out5);
    if (!fs.existsSync(dataFile)) throw new Error('5) 파일 폴백 저장 안 됨');
    console.log('5) KV 장애 시 파일 폴백 + 서버 생존 OK');

    console.log('KV E2E PASSED');
  } finally {
    kvServer.close();
    try { fs.unlinkSync(dataFile); } catch (e) {}
    if (backup) { try { fs.writeFileSync(dataFile, backup); } catch (e) {} }
  }
}

main().then(function () { process.exit(0); }, function (e) { console.error('실패:', e.message); process.exit(1); });
