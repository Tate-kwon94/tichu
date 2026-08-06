#!/usr/bin/env node
/* 게임 중 복귀(봇 자리 이어받기) E2E
 * 시나리오: 2인+봇2 게임 → 철수 퇴장(봇(철수) 전환) → 낯선 사람은 일반 봇 자리,
 *           철수는 자기 자리로 복귀, 봇 자리 소진 시 입장 거부
 * 실행: node test/e2e-rejoin.js */
'use strict';
var spawn = require('child_process').spawn;
var path = require('path');

var PORT = 18082;
var BASE = 'http://127.0.0.1:' + PORT;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function wsConnect(name, token) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    // salt: 같은 토큰으로 재접속해도 actionId가 이전 접속과 안 겹치게 (멱등 캐시 충돌 방지)
    var salt = Math.random().toString(36).slice(2, 6);
    var st = { ws: ws, token: token || '', snap: null, version: 0, acks: {}, n: 0, salt: salt };
    var to = setTimeout(function () { reject(new Error('WS 타임아웃')); }, 5000);
    ws.onopen = function () {
      ws.send(JSON.stringify({ type: 'hello', token: st.token, name: name, protocolVersion: 1 }));
    };
    ws.onmessage = function (ev) {
      var m = JSON.parse(String(ev.data));
      st.log = st.log || [];
      st.log.push(m.type + (m.version != null ? ':' + m.version : ''));
      if (m.type === 'welcome') { clearTimeout(to); st.token = m.token; if (m.snapshot) { st.snap = m.snapshot; st.version = m.version; } resolve(st); }
      else if (m.type === 'room_state' && m.version > st.version) { st.version = m.version; st.snap = m.snapshot; }
      else if (m.type === 'action_ack') { st.acks[m.actionId] = m; }
    };
    ws.onerror = function () { clearTimeout(to); reject(new Error('WS 오류')); };
    st.send = function (a) {
      var id = name + '-' + salt + '-' + (++st.n);
      a.actionId = id;
      ws.send(JSON.stringify(a));
      return id;
    };
    st.sendWait = async function (a) {
      var id = st.send(a);
      for (var i = 0; i < 40; i++) { if (st.acks[id]) return st.acks[id]; await sleep(100); }
      throw new Error('ack 타임아웃: ' + a.type);
    };
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

    // 1) 영희(방장)+철수 입장, 나머지 봇으로 게임 시작
    var host = await wsConnect('영희');
    await host.sendWait({ type: 'create_room', name: '영희' });
    var code = host.snap.code;
    var chul = await wsConnect('철수');
    await chul.sendWait({ type: 'join_room', code: code, name: '철수' });
    if (chul.snap.youSeat !== 1) throw new Error('철수 좌석 기대 1, 실제 ' + chul.snap.youSeat);
    await host.sendWait({ type: 'start_game', targetScore: 300, botLevel: 'easy' });
    await sleep(300);
    if (!host.snap.game) throw new Error('게임 시작 실패');
    console.log('1) 2인+봇2 게임 시작 OK (코드 ' + code + ')');

    // 2) 철수 게임 중 퇴장 → 자리가 봇(철수)로 전환
    await chul.sendWait({ type: 'leave_room' });
    await sleep(300);
    var s1 = host.snap.roomSeats[1];
    if (!(s1 && s1.isBot && s1.name === '봇(철수)')) throw new Error('봇 전환 실패: ' + JSON.stringify(s1));
    console.log('2) 철수 퇴장 → 봇(철수) 전환 OK');

    // 3) 방 목록에 게임중+봇 수 노출 (이어받기 판단 근거)
    var minsu = await wsConnect('민수');
    var lr = await minsu.sendWait({ type: 'list_rooms' });
    var row = (lr.rooms || []).filter(function (r) { return r.code === code; })[0];
    if (!row || !row.inGame || row.bots !== 3) throw new Error('목록 정보 오류: ' + JSON.stringify(row));
    console.log('3) 방 목록 inGame+bots=3 OK');

    // 4) 낯선 민수 입장 → 봇(철수) 자리가 아니라 일반 봇 자리(2)로
    await minsu.sendWait({ type: 'join_room', code: code, name: '민수' });
    if (minsu.snap.youSeat !== 2) throw new Error('민수 좌석 기대 2(일반 봇), 실제 ' + minsu.snap.youSeat);
    console.log('4) 낯선 사람은 일반 봇 자리 OK (봇(철수) 자리 보존)');

    // 5) 닉네임 스푸핑(새 토큰 + 이름 "철수") → 남의 전환 자리(1)를 못 뺏고 일반 봇(3)으로
    var spoof = await wsConnect('철수');
    await spoof.sendWait({ type: 'join_room', code: code, name: '철수' });
    if (spoof.snap.youSeat !== 3) throw new Error('스푸퍼 좌석 기대 3(일반 봇), 실제 ' + spoof.snap.youSeat);
    console.log('5) 닉네임 스푸핑으로 남의 자리 탈취 불가 OK');

    // 6) 철수 본인 토큰으로 복귀 → 자기 자리(1) 이어받기
    var chul2 = await wsConnect('철수', chul.token);
    var ackJ = await chul2.sendWait({ type: 'join_room', code: code, name: '철수' });
    if (ackJ.error) throw new Error('철수 복귀 join 실패: ' + JSON.stringify(ackJ.error));
    await sleep(300);
    if (!chul2.snap) throw new Error('철수 복귀 후 스냅샷 미수신 — 수신log=' + JSON.stringify(chul2.log) + ' ackJ=' + JSON.stringify(ackJ));
    if (chul2.snap.youSeat !== 1) throw new Error('철수 복귀 좌석 기대 1, 실제 ' + chul2.snap.youSeat);
    if (chul2.snap.roomSeats[1].isBot) throw new Error('복귀 후에도 봇으로 표시됨');
    if (!chul2.snap.game) throw new Error('복귀 후 게임 스냅샷 없음');
    console.log('6) 본인 토큰으로 자기 자리 복귀 OK');

    // 7) 봇 자리 소진(전원 사람) 시 관전으로 입장 — 문 앞에서 돌려보내지 않는다
    var full = await wsConnect('또치');
    var ackF = await full.sendWait({ type: 'join_room', code: code, name: '또치' });
    if (ackF.error) throw new Error('만석 시 관전 입장 실패: ' + JSON.stringify(ackF.error));
    await sleep(200);
    var spec = full;
    if (!spec.snap.spectating) throw new Error('관전 상태가 아님');
    if (spec.snap.game && spec.snap.game.you) throw new Error('★ 관전자에게 손패가 노출됨');
    if ((spec.snap.spectators || []).indexOf('또치') < 0) throw new Error('관전자 목록에 없음');
    // 관전자는 게임 액션 불가
    var bad = await full.sendWait({ type: 'pass_turn' });
    if (!(bad.error && bad.error.code === 'SPECTATOR')) throw new Error('관전자 액션이 막히지 않음: ' + JSON.stringify(bad.error));
    console.log('7) 봇 자리 소진 시 관전 입장 + 손패 비노출 + 액션 차단 OK');

    // 8) 강퇴 → 같은 토큰 재입장 차단, 다른 사람은 그 자리 인수 가능
    await host.sendWait({ type: 'kick_player', seat: 2 });
    await sleep(200);
    var kicked = await wsConnect('민수', minsu.token);
    var ackK = await kicked.sendWait({ type: 'join_room', code: code, name: '민수' });
    if (!(ackK.error && ackK.error.code === 'KICKED')) throw new Error('강퇴 재입장 차단 실패: ' + JSON.stringify(ackK.error));
    var dooly = await wsConnect('둘리');
    await dooly.sendWait({ type: 'join_room', code: code, name: '둘리' });
    if (dooly.snap.youSeat !== 2) throw new Error('둘리 좌석 기대 2, 실제 ' + dooly.snap.youSeat);
    console.log('8) 강퇴 토큰 재입장 차단 + 타인 인수 OK');

    /* 9) 방이 사라질 때 관전자도 풀려나야 한다.
     * 예전엔 destroyRoom이 좌석만 정리해서, 관전자는 지워진 방을 가리킨 채
     * left_room도 못 받고 로비로 못 돌아가는 좀비가 됐다. */
    spec.log.length = 0;
    var seated = [host, chul2, dooly, spoof];
    for (var si = 0; si < seated.length; si++) {
      try { await seated[si].sendWait({ type: 'leave_room' }); } catch (e) { /* 이미 나갔으면 무시 */ }
    }
    await sleep(400);
    if (spec.log.indexOf('left_room') < 0) {
      throw new Error('★ 방 파괴 시 관전자가 left_room을 못 받음 — 수신log=' + JSON.stringify(spec.log));
    }
    console.log('9) 방 파괴 시 관전자도 해제 OK');

    console.log('REJOIN E2E PASSED');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally {
    server.kill();
  }
}

main();
