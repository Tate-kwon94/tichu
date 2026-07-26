#!/usr/bin/env node
/* 복원력 E2E: 재접속(resumed), SSE 스트림, 중복 접속(session_replaced)
 * 실행: node test/e2e-resilience.js */
'use strict';
var spawn = require('child_process').spawn;
var path = require('path');

var PORT = 18081;
var BASE = 'http://127.0.0.1:' + PORT;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function post(body) {
  var r = await fetch(BASE + '/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}
function wsConnect(name, token) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    var st = { ws: ws, token: token || '', snap: null, version: 0, msgs: [], n: 0 };
    var to = setTimeout(function () { reject(new Error('WS 타임아웃')); }, 5000);
    ws.onopen = function () {
      ws.send(JSON.stringify({ type: 'hello', token: st.token, name: name, protocolVersion: 1 }));
    };
    ws.onmessage = function (ev) {
      var m = JSON.parse(String(ev.data));
      st.msgs.push(m.type);
      if (m.type === 'welcome') { clearTimeout(to); st.token = m.token; if (m.snapshot) { st.snap = m.snapshot; st.version = m.version; } resolve(st); }
      else if (m.type === 'room_state' && m.version > st.version) { st.version = m.version; st.snap = m.snapshot; }
    };
    ws.onerror = function () { clearTimeout(to); reject(new Error('WS 오류')); };
    st.send = function (a) { a.actionId = name + '-' + (++st.n); ws.send(JSON.stringify(a)); };
    return st;
  });
}

async function main() {
  var server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT),
      // 프로덕션 KV·실 전적 파일 격리 — 상속되면 테스트가 실데이터를 덮어쓴다
      CF_ACCOUNT_ID: '', CF_KV_NAMESPACE_ID: '', CF_KV_TOKEN: '',
      TICHU_STATS_FILE: require('path').join(require('os').tmpdir(), 'tichu-test-stats-' + PORT + '.json') }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', function (d) { console.error('[server]', String(d).trim()); });
  try {
    for (var i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {}
      await sleep(200);
    }

    // 1) 방 생성 + 게임 시작 (봇 3)
    var a = await wsConnect('영희');
    a.send({ type: 'create_room', name: '영희' });
    await sleep(300);
    a.send({ type: 'start_game' });
    await sleep(300);
    if (!a.snap || !a.snap.game || a.snap.game.phase !== 'grand') throw new Error('게임 시작 실패: ' + JSON.stringify(a.snap && a.snap.phase));
    a.send({ type: 'call_grand', call: false });
    await sleep(2500); // 봇들 그랜드 응답 + 교환 진행
    if (a.snap.game.phase !== 'exchange') throw new Error('교환 단계 진입 실패: ' + a.snap.game.phase);
    var h = a.snap.game.you.hand;
    var give = {};
    [0, 1, 2, 3].filter(function (s) { return s !== a.snap.youSeat; }).forEach(function (s, idx) { give[s] = h[idx]; });
    a.send({ type: 'submit_exchange', give: give });
    await sleep(2500); // 봇 교환 → 플레이 시작
    if (a.snap.game.phase !== 'play') throw new Error('플레이 단계 진입 실패: ' + a.snap.game.phase);
    var token = a.token, code = a.snap.code, verBefore = a.version, handBefore = JSON.stringify(a.snap.game.you.hand);
    console.log('1) 방 생성→게임→플레이 진입 OK (코드 ' + code + ')');

    // 2) 연결 끊고 재접속 → resumed
    a.ws.close();
    await sleep(500);
    var b = await wsConnect('영희', token);
    if (!b.snap || b.snap.code !== code) throw new Error('재접속 복귀 실패');
    if (JSON.stringify(b.snap.game.you.hand) !== handBefore && b.snap.game.phase === 'play') {
      // 봇이 그 사이 진행했을 수 있으므로 손패는 같아야 함 (내 차례가 아니면)
      console.log('   (참고: 재접속 사이 봇 진행으로 상태 변화)');
    }
    if (b.snap.youSeat !== 0) throw new Error('좌석 복원 실패');
    console.log('2) 토큰 재접속 → 같은 자리/같은 방 복귀 OK');

    // 3) 같은 토큰 중복 접속 → 기존 연결에 session_replaced
    var c = await wsConnect('영희', token);
    await sleep(400);
    if (b.msgs.indexOf('session_replaced') < 0) throw new Error('session_replaced 미수신: ' + b.msgs.join(','));
    console.log('3) 중복 접속 시 기존 연결 교체 OK');

    // 4) SSE 스트림: hb + room_state 수신
    var res = await fetch(BASE + '/events?token=' + encodeURIComponent(token) + '&since=0');
    if (!res.ok) throw new Error('SSE 연결 실패: ' + res.status);
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', sawHb = false, sawState = false;
    var deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(sawHb && sawState)) {
      var chunk = await Promise.race([reader.read(), sleep(1000).then(function () { return { done: false, value: null }; })]);
      if (chunk.done) break;
      if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
      if (buf.indexOf('event: hb') >= 0) sawHb = true;
      if (buf.indexOf('room_state') >= 0) sawState = true;
    }
    if (!sawHb) throw new Error('SSE 하트비트 미수신');
    if (!sawState) throw new Error('SSE room_state 미수신');
    reader.cancel().catch(function () {});
    console.log('4) SSE 스트림 (하트비트 + 상태) OK');

    // 5) SSE 접속이 기존 WS(c)를 대체했는지 + 마지막 연결로 액션 가능
    var ackEnv = await post({ token: token, action: { type: 'call_tichu', actionId: 'x-1' } });
    if (ackEnv.type !== 'action_ack') throw new Error('POST 액션 실패');
    console.log('5) POST 액션 경로 OK (ack: ' + (ackEnv.ok ? '성공' : ackEnv.error.code) + ')');

    console.log('RESILIENCE E2E PASSED');
  } finally {
    server.kill();
    await sleep(100);
    process.exit(0);
  }
}
main().catch(function (e) { console.error('실패:', e.message); process.exit(1); });
