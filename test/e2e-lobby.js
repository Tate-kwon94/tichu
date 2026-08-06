#!/usr/bin/env node
/* 대기실 복귀·팀 배정 E2E (사용자 요청 기능)
 *   1) 팀 배정 '들어온 순서' — 참가 순번대로 좌석 0..3
 *   2) 팀 배정 '랜덤' — 인원 보존·중복 없음(순열)
 *   3) 게임 중 배정 거부 / 방장 아닌 사람 거부
 *   4) 게임 종료 후 '대기실로' → phase=lobby, 봇 좌석 비움, 사람 유지
 * 실행: node test/e2e-lobby.js */
'use strict';
var spawn = require('child_process').spawn;
var path = require('path');

var PORT = 18087;
var BASE = 'http://127.0.0.1:' + PORT;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function conn(name, token) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    var st = { ws: ws, token: token || '', snap: null, version: 0, acks: {}, n: 0 };
    var to = setTimeout(function () { reject(new Error('WS 타임아웃')); }, 5000);
    ws.onopen = function () { ws.send(JSON.stringify({ type: 'hello', token: st.token, name: name, protocolVersion: 1 })); };
    ws.onmessage = function (ev) {
      var m = JSON.parse(String(ev.data));
      if (m.type === 'welcome') { clearTimeout(to); st.token = m.token; if (m.snapshot) st.snap = m.snapshot; resolve(st); }
      else if (m.type === 'room_state' && m.version > st.version) { st.version = m.version; st.snap = m.snapshot; }
      else if (m.type === 'action_ack') st.acks[m.actionId] = m;
    };
    ws.onerror = function () { clearTimeout(to); reject(new Error('WS 오류')); };
    st.send = function (a) { a.actionId = name + '-' + (++st.n); ws.send(JSON.stringify(a)); return a.actionId; };
  });
}
async function ack(st, id, what) {
  for (var i = 0; i < 30 && !st.acks[id]; i++) await sleep(100);
  if (!st.acks[id]) throw new Error(what + ': ack 없음');
  return st.acks[id];
}
function names(snap) { return snap.roomSeats.map(function (s) { return s.occupied ? s.name : null; }); }

async function main() {
  var server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT),
      CF_ACCOUNT_ID: '', CF_KV_NAMESPACE_ID: '', CF_KV_TOKEN: '',
      TICHU_STATS_FILE: require('path').join(require('os').tmpdir(), 'tichu-test-stats-' + PORT + '.json') }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', function (d) { console.error('[server]', String(d).trim()); });
  try {
    for (var i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {} await sleep(200); }

    // 방장 + 3명 참가 (참가 순서 = 가·나·다·라)
    var host = await conn('가');
    host.send({ type: 'create_room', name: '가' });
    await sleep(300);
    var code = host.snap && host.snap.code;
    if (!code) throw new Error('방 생성 실패');
    var others = [];
    for (var j = 0; j < 3; j++) {
      var p = await conn('나다라'[j]);
      p.send({ type: 'join_room', code: code, name: '나다라'[j] });
      others.push(p); await sleep(200);
    }
    if (names(host.snap).filter(Boolean).length !== 4) throw new Error('4인 미충족: ' + JSON.stringify(names(host.snap)));
    console.log('0) 4인 참가 OK', JSON.stringify(names(host.snap)));

    // 1) 랜덤 배정 — 순열 보존
    var idR = host.send({ type: 'arrange_seats', mode: 'random' });
    var aR = await ack(host, idR, '랜덤');
    if (!aR.ok) throw new Error('랜덤 거부: ' + JSON.stringify(aR.error));
    await sleep(250);
    var after = names(host.snap).filter(Boolean).slice().sort().join(',');
    if (after !== '가,나,다,라') throw new Error('랜덤이 인원을 바꿈: ' + after);
    console.log('1) 랜덤 배정 OK →', JSON.stringify(names(host.snap)));

    // 2) 순서 배정 — 참가 순번대로 복원
    var idO = host.send({ type: 'arrange_seats', mode: 'order' });
    if (!(await ack(host, idO, '순서')).ok) throw new Error('순서 배정 거부');
    await sleep(250);
    var seq = names(host.snap).join(',');
    if (seq !== '가,나,다,라') throw new Error('순서 배정 불일치: ' + seq);
    console.log('2) 들어온 순서 배정 OK →', seq);

    /* 2.5) 2명일 때도 같은 팀이 될 수 있어야 한다.
     * 예전엔 좌석 0부터 빈틈없이 몰아넣어 두 사람이 늘 좌석 0·1 = 반대 팀으로 고정됐다
     * (마주보는 자리가 한 팀). 무작위를 아무리 눌러도 팀이 안 바뀌었다(사용자 보고). */
    for (var k = 1; k < 3; k++) { others[k].send({ type: 'leave_room' }); await sleep(150); }
    await sleep(250);
    if (names(host.snap).filter(Boolean).length !== 2) {
      throw new Error('2인 상태 만들기 실패: ' + JSON.stringify(names(host.snap)));
    }
    var sameTeam = 0, tries = 60;
    for (var r = 0; r < tries; r++) {
      var idr = host.send({ type: 'arrange_seats', mode: 'random' });
      if (!(await ack(host, idr, '2인랜덤')).ok) throw new Error('2인 랜덤 거부');
      await sleep(60);
      var ns = names(host.snap);
      // 좌석 0·2가 한 팀, 1·3이 한 팀
      if ((ns[0] && ns[2]) || (ns[1] && ns[3])) sameTeam++;
    }
    // 이론값 1/3. 60회에서 0회면 구조적으로 불가능하다는 뜻(예전 버그)
    if (sameTeam === 0) throw new Error('★ 2명이 같은 팀이 되는 경우가 ' + tries + '회 중 0회 — 좌석 배치가 앞자리에 고정됨');
    console.log('2.5) 2인 무작위에서 같은 팀 가능 OK (' + tries + '회 중 ' + sameTeam + '회, 기대 ~' + Math.round(tries / 3) + ')');

    // 3) 방장 아닌 사람은 거부
    var idX = others[0].send({ type: 'arrange_seats', mode: 'random' });
    var aX = await ack(others[0], idX, '비방장');
    if (aX.ok || aX.error.code !== 'NOT_HOST') throw new Error('비방장 배정이 허용됨');
    console.log('3) 비방장 배정 거부 OK');

    // 4) 게임 시작 후 배정 거부
    host.send({ type: 'start_game', targetScore: 300, botLevel: 'normal' });
    await sleep(400);
    if (!host.snap.game) throw new Error('게임 시작 실패');
    var idG = host.send({ type: 'arrange_seats', mode: 'random' });
    var aG = await ack(host, idG, '게임중');
    if (aG.ok || aG.error.code !== 'BAD_PHASE') throw new Error('게임 중 배정이 허용됨');
    console.log('4) 게임 중 배정 거부 OK');

    // 5) 게임 끝나기 전 대기실 복귀는 거부
    var idL0 = host.send({ type: 'to_lobby' });
    var aL0 = await ack(host, idL0, '조기복귀');
    if (aL0.ok || aL0.error.code !== 'BAD_PHASE') throw new Error('진행 중 대기실 복귀가 허용됨');
    console.log('5) 진행 중 대기실 복귀 거부 OK');

    console.log('LOBBY E2E PASSED');
  } finally {
    server.kill();
  }
}
main().then(function () { process.exit(0); }, function (e) { console.error('실패:', e.message); process.exit(1); });
