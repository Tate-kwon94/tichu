#!/usr/bin/env node
/* STALE 게이트 E2E: 플레이 거부는 gver(게임상태 버전)로만 판정하는지 검증 (감사 #6)
 * - version(전송 순번)은 재접속·참석 변화에도 올라가므로, version만 어긋난 플레이는 통과해야 함
 * - gver가 어긋난 플레이는 STALE_VERSION으로 거부
 * - gver 없는 구클라이언트는 version 폴백 유지(하위호환)
 * 실행: node test/e2e-staleplay.js */
'use strict';
var spawn = require('child_process').spawn;
var path = require('path');

var PORT = 18083;
var BASE = 'http://127.0.0.1:' + PORT;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function wsConnect(name, token) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    var st = { ws: ws, token: token || '', snap: null, version: 0, gver: 0, acks: {}, n: 0 };
    var to = setTimeout(function () { reject(new Error('WS 타임아웃')); }, 5000);
    ws.onopen = function () {
      ws.send(JSON.stringify({ type: 'hello', token: st.token, name: name, protocolVersion: 1 }));
    };
    ws.onmessage = function (ev) {
      var m = JSON.parse(String(ev.data));
      if (m.type === 'welcome') {
        clearTimeout(to); st.token = m.token;
        if (m.snapshot) { st.snap = m.snapshot; st.version = m.version; st.gver = m.gver || 0; }
        resolve(st);
      } else if (m.type === 'room_state' && m.version > st.version) {
        st.version = m.version; st.snap = m.snapshot;
        if (m.gver != null) st.gver = m.gver;
      } else if (m.type === 'action_ack') {
        st.acks[m.actionId] = m;
      }
    };
    ws.onerror = function () { clearTimeout(to); reject(new Error('WS 오류')); };
    st.send = function (a) { a.actionId = name + '-' + (++st.n); ws.send(JSON.stringify(a)); return a.actionId; };
    return st;
  });
}

async function expectAck(st, id, what) {
  for (var i = 0; i < 20 && !st.acks[id]; i++) await sleep(100);
  if (!st.acks[id]) throw new Error(what + ': ack 없음');
  return st.acks[id];
}

async function main() {
  var server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', function (d) { console.error('[server]', String(d).trim()); });
  try {
    for (var i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {}
      await sleep(200);
    }

    // 4인 전원 사람 — 아무도 그랜드에 응답하지 않으면 게임 상태가 정지되어 gver 고정
    var a = await wsConnect('가');
    a.send({ type: 'create_room', name: '가' });
    await sleep(300);
    var code = a.snap && a.snap.code;
    if (!code) throw new Error('방 생성 실패');
    var others = [];
    for (var j = 0; j < 3; j++) {
      var p = await wsConnect('나다라'[j]);
      p.send({ type: 'join_room', code: code, name: '나다라'[j] });
      others.push(p);
      await sleep(200);
    }
    a.send({ type: 'start_game' });
    await sleep(400);
    if (!a.snap.game || a.snap.game.phase !== 'grand') throw new Error('게임 시작 실패');
    var gver0 = a.gver;
    if (!(gver0 > 0)) throw new Error('welcome/room_state에 gver 없음: ' + gver0);
    console.log('1) 4인 게임 시작, gver=' + gver0 + ' version=' + a.version + ' OK');

    // 재접속으로 version만 급증시킨다 (게임 상태 불변 → gver 불변)
    for (var k = 0; k < 3; k++) {
      var o = others[k];
      o.ws.close();
      await sleep(150);
      others[k] = await wsConnect('나다라'[k], o.token);
      await sleep(150);
    }
    await sleep(300);
    if (a.gver !== gver0) throw new Error('재접속이 gver를 올림: ' + a.gver);
    console.log('2) 재접속 3회 후 version=' + a.version + ' gver=' + a.gver + ' (게임상태 불변) OK');

    var hand = (a.snap.game.you && a.snap.game.you.hand) || [];
    if (!hand.length) throw new Error('손패 없음');
    var card = hand[0];

    // (A) version 어긋남 + gver 일치 → 게이트 통과 (엔진이 단계 오류로 거부해도 STALE은 아니어야)
    var id1 = a.send({ type: 'play_cards', cards: [card], version: 1, gver: gver0 });
    var ack1 = await expectAck(a, id1, 'A');
    if (ack1.error && ack1.error.code === 'STALE_VERSION') throw new Error('A 실패: version 급증만으로 STALE 거부(버그 재현)');
    console.log('3) version 어긋남+gver 일치 → STALE 아님 (' + (ack1.error ? ack1.error.code : 'ok') + ') OK');

    // (B) gver 어긋남 → STALE 거부
    var id2 = a.send({ type: 'play_cards', cards: [card], version: a.version, gver: gver0 + 99 });
    var ack2 = await expectAck(a, id2, 'B');
    if (!ack2.error || ack2.error.code !== 'STALE_VERSION') throw new Error('B 실패: gver 어긋남이 STALE이 아님: ' + JSON.stringify(ack2.error));
    console.log('4) gver 어긋남 → STALE_VERSION 거부 OK');

    // (C) 구클라이언트(gver 없음) + version 어긋남 → 기존대로 STALE (하위호환)
    var id3 = a.send({ type: 'play_cards', cards: [card], version: 1 });
    var ack3 = await expectAck(a, id3, 'C');
    if (!ack3.error || ack3.error.code !== 'STALE_VERSION') throw new Error('C 실패: 구클라 version 폴백 상실: ' + JSON.stringify(ack3.error));
    console.log('5) 구클라이언트 version 폴백 유지 OK');

    console.log('STALEPLAY E2E PASSED');
  } finally {
    server.kill();
  }
}

main().then(function () { process.exit(0); }, function (e) { console.error('실패:', e.message); process.exit(1); });
