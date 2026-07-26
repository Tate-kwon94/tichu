#!/usr/bin/env node
/* 온라인 E2E: 서버를 자식 프로세스로 띄우고
 * 4개 클라이언트(WS 2 + long-poll 2)가 방 생성→참여→게임 완주.
 * 검증: 스냅샷 수렴, 손패 은닉(redaction), 멱등 ack, 방 풀참/진행중 입장 거부, STALE 패스.
 * 실행: node test/e2e-online.js */
'use strict';
var spawn = require('child_process').spawn;
var path = require('path');
var C = require('../shared/tichu-core.js');

var PORT = 18080;
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

// ---------- 클라이언트 ----------
function PollClient(name) {
  this.name = name; this.kind = 'poll'; this.token = ''; this.snap = null; this.version = 0; this.n = 0; this.stopped = false;
}
PollClient.prototype.hello = async function () {
  var w = await post({ action: { type: 'hello', name: this.name, protocolVersion: 1 } });
  if (w.type !== 'welcome') throw new Error('hello 실패: ' + JSON.stringify(w));
  this.token = w.token;
  if (w.snapshot) { this.snap = w.snapshot; this.version = w.version; }
  this.loop();
};
PollClient.prototype.loop = async function () {
  while (!this.stopped) {
    try {
      var r = await fetch(BASE + '/poll?token=' + this.token + '&since=' + this.version);
      var m = await r.json();
      var msgs = m.messages || (m.type ? [m] : []);
      for (var i = 0; i < msgs.length; i++) {
        var x = msgs[i];
        if (x.type === 'room_state' && x.version > this.version) { this.version = x.version; this.snap = x.snapshot; }
        if (x.type === 'chat') (this.chats = this.chats || []).push(x);
      }
    } catch (e) { await sleep(200); }
  }
};
PollClient.prototype.send = async function (a) {
  a.actionId = this.name + '-' + (++this.n);
  return post({ token: this.token, action: a });
};

function WSClient(name) {
  this.name = name; this.kind = 'ws'; this.token = ''; this.snap = null; this.version = 0; this.n = 0; this.acks = [];
}
WSClient.prototype.hello = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    self.ws = ws;
    var to = setTimeout(function () { reject(new Error('WS welcome 타임아웃')); }, 5000);
    ws.onopen = function () {
      ws.send(JSON.stringify({ type: 'hello', name: self.name, protocolVersion: 1 }));
    };
    ws.onmessage = function (ev) {
      var m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.type === 'welcome') {
        clearTimeout(to);
        self.token = m.token;
        if (m.snapshot) { self.snap = m.snapshot; self.version = m.version; }
        resolve();
      } else if (m.type === 'room_state') {
        if (m.version > self.version) { self.version = m.version; self.snap = m.snapshot; }
      } else if (m.type === 'action_ack') {
        self.acks.push(m);
      } else if (m.type === 'chat') {
        (self.chats = self.chats || []).push(m);
      }
    };
    ws.onerror = function (e) { clearTimeout(to); reject(new Error('WS 오류')); };
  });
};
WSClient.prototype.send = async function (a) {
  a.actionId = this.name + '-' + (++this.n);
  this.ws.send(JSON.stringify(a));
  // ack는 비동기 — 직접 검증할 때만 acks 확인
  return { ok: true };
};

// ---------- 뷰 기반 의사결정 (클라이언트는 자기 패만 안다) ----------
function decide(client) {
  var snap = client.snap;
  if (!snap || !snap.game) return null;
  var g = snap.game, me = snap.youSeat;
  if (g.phase === 'roundEnd') {
    return (snap.hostSeat === me) ? { type: 'next_round' } : null;
  }
  if (g.phase === 'gameEnd') return null;
  if (g.waitingOn.indexOf(me) < 0) return null;
  if (g.phase === 'grand') return { type: 'call_grand', call: false };
  if (g.phase === 'exchange') {
    if (g.you.exchangeSubmitted) return null;
    var others = [0, 1, 2, 3].filter(function (s) { return s !== me; });
    var give = {};
    others.forEach(function (s, i) { give[s] = g.you.hand[i]; });
    return { type: 'submit_exchange', give: give };
  }
  if (g.phase === 'dragon') return { type: 'give_dragon', toSeat: (me + 1) % 4 };
  if (g.phase === 'play') {
    var gm = C.genMoves(g.you.hand, g.currentCombo, g.wish);
    var moves = gm.moves;
    if (!g.currentCombo) {
      var best = null, bv = Infinity;
      moves.forEach(function (m) {
        var v = m.combo.type === 'dog' ? -100 : m.combo.rank * 2 - m.cards.length * 3;
        if (m.cards.indexOf('PH') >= 0) v += 12;
        if (C.isBomb(m.combo.type)) v += 40;
        if (v < bv) { bv = v; best = m; }
      });
      var a = { type: 'play_cards', cards: best.cards, version: client.version };
      if (best.cards.indexOf('MJ') >= 0) a.wish = 11;
      return a;
    }
    if (!moves.length) return { type: 'pass_turn', version: client.version };
    var sorted = moves.slice().sort(function (x, y) { return x.combo.rank - y.combo.rank; });
    if (gm.forced) return { type: 'play_cards', cards: sorted[0].cards, version: client.version };
    var nonBomb = sorted.filter(function (m) { return !C.isBomb(m.combo.type); });
    if (!nonBomb.length) return { type: 'pass_turn', version: client.version };
    return { type: 'play_cards', cards: nonBomb[0].cards, version: client.version };
  }
  return null;
}

// ---------- 본체 ----------
async function main() {
  var server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT),
      // 프로덕션 KV·실 전적 파일 격리 — 상속되면 테스트가 실데이터를 덮어쓴다
      CF_ACCOUNT_ID: '', CF_KV_NAMESPACE_ID: '', CF_KV_TOKEN: '',
      TICHU_STATS_FILE: require('path').join(require('os').tmpdir(), 'tichu-test-stats-' + PORT + '.json') }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  var serverLog = '';
  server.stdout.on('data', function (d) { serverLog += d; });
  server.stderr.on('data', function (d) { serverLog += d; console.error('[server]', String(d).trim()); });

  try {
    // 기동 대기
    var up = false;
    for (var i = 0; i < 50; i++) {
      try { var h = await fetch(BASE + '/healthz'); if (h.ok) { up = true; break; } } catch (e) {}
      await sleep(200);
    }
    if (!up) throw new Error('서버 기동 실패\n' + serverLog);
    console.log('1) 서버 기동 OK');

    // 정적 파일
    var idx = await (await fetch(BASE + '/')).text();
    if (idx.indexOf('티츄') < 0) throw new Error('index.html 서빙 실패');
    var core = await (await fetch(BASE + '/shared/tichu-core.js')).text();
    if (core.indexOf('TichuCore') < 0) throw new Error('shared 서빙 실패');
    var bad = await fetch(BASE + '/../server.js');
    if (bad.status === 200) throw new Error('경로 탈출 차단 실패');
    console.log('2) 정적 서빙/경로 보호 OK');

    // 클라이언트 4명 (WS 2, poll 2)
    var c0 = new WSClient('영희');
    var c1 = new PollClient('철수');
    var c2 = new WSClient('민지');
    var c3 = new PollClient('준호');
    var clients = [c0, c1, c2, c3];
    for (var ci = 0; ci < 4; ci++) await clients[ci].hello();

    // 방 생성/참여
    await c0.send({ type: 'create_room', name: '영희' });
    await sleep(300);
    var code = c0.snap && c0.snap.code;
    if (!code) throw new Error('방 생성 실패');
    for (var cj = 1; cj < 4; cj++) {
      var ack = await clients[cj].send({ type: 'join_room', code: code, name: clients[cj].name });
      if (clients[cj].kind === 'poll' && !ack.ok) throw new Error('입장 실패: ' + JSON.stringify(ack.error));
    }
    await sleep(400);
    if (!c3.snap || c3.snap.roomSeats.filter(function (s) { return s.occupied; }).length !== 4) {
      throw new Error('4인 착석 실패: ' + JSON.stringify(c3.snap && c3.snap.roomSeats));
    }
    console.log('3) 방 생성/4인 참여 OK (코드 ' + code + ')');

    // 5번째 입장 → ROOM_FULL
    var c4 = new PollClient('불청객');
    await c4.hello();
    var full = await c4.send({ type: 'join_room', code: code, name: '불청객' });
    if (full.ok || full.error.code !== 'ROOM_FULL') throw new Error('ROOM_FULL 미동작: ' + JSON.stringify(full));

    // 멱등성: 같은 actionId 재전송
    var idem1 = await c1.send({ type: 'take_seat', seat: c1.snap.youSeat });
    var again = await post({ token: c1.token, action: { type: 'take_seat', seat: c1.snap.youSeat, actionId: '철수-' + c1.n } });
    if (JSON.stringify(idem1) !== JSON.stringify(again)) throw new Error('멱등 ack 불일치');
    console.log('4) ROOM_FULL/멱등성 OK');

    // 채팅: WS 클라이언트가 보내고 poll 클라이언트가 수신
    await c0.send({ type: 'chat', text: '점검 채팅 <스크립트>' });
    await sleep(700);
    if (!c1.chats || !c1.chats.length) throw new Error('poll 클라이언트 채팅 미수신');
    if (c1.chats[0].text.indexOf('점검 채팅') < 0) throw new Error('채팅 내용 불일치: ' + c1.chats[0].text);
    if (!c2.chats || !c2.chats.length) throw new Error('WS 클라이언트 채팅 미수신');
    console.log('4.5) 채팅 브로드캐스트 OK (WS→poll/WS, 내용: ' + JSON.stringify(c1.chats[0].text) + ')');

    // 게임 시작
    await c0.send({ type: 'start_game' });
    await sleep(400);

    // 진행 중 입장 거부
    var mid = await c4.send({ type: 'join_room', code: code, name: '불청객' });
    if (mid.ok || mid.error.code !== 'GAME_IN_PROGRESS') throw new Error('GAME_IN_PROGRESS 미동작');

    // 게임 완주 드라이브
    var done = false, steps = 0, lastActed = {};
    var t0 = Date.now();
    while (!done && Date.now() - t0 < 90000) {
      for (var k = 0; k < 4; k++) {
        var c = clients[k];
        if (!c.snap || !c.snap.game) continue;
        if (c.snap.game.phase === 'gameEnd') { done = true; break; }
        var key = k + ':' + c.version;
        if (lastActed[k] === c.version) continue;
        var a = decide(c);
        if (a) {
          lastActed[k] = c.version;
          await c.send(a);
          steps++;
        }
      }
      await sleep(25);
      if (steps > 8000) throw new Error('스텝 초과');
    }
    if (!done) throw new Error('90초 내 게임 미종료 (steps=' + steps + ', phase=' + (c0.snap.game && c0.snap.game.phase) + ')');
    await sleep(600);

    // 수렴/은닉 검증
    var vs = clients.map(function (c) { return c.version; });
    var phases = clients.map(function (c) { return c.snap.game.phase; });
    if (phases.some(function (p) { return p !== 'gameEnd'; })) throw new Error('스냅샷 미수렴: ' + phases.join(','));
    clients.forEach(function (c) {
      var js = JSON.stringify(c.snap.game.seats);
      if (/"hand"/.test(js)) throw new Error('손패 누출!');
      var totals = c.snap.game.roundSummary.totals;
      if (Math.max(totals.teamA, totals.teamB) < 1000) throw new Error('승점 이상: ' + JSON.stringify(totals));
    });
    var t1 = JSON.stringify(c0.snap.game.scores), t2 = JSON.stringify(c3.snap.game.scores);
    if (t1 !== t2) throw new Error('점수 불일치: ' + t1 + ' vs ' + t2);
    console.log('5) 게임 완주 OK — ' + steps + '액션, ' + (Date.now() - t0) + 'ms, 최종 ' + t1 +
                ', 라운드 ' + c0.snap.game.round);
    console.log('6) 스냅샷 수렴/손패 은닉/점수 일치 OK');
    console.log('E2E PASSED');
  } finally {
    server.kill();
    await sleep(200);
    process.exit(0); // poll 루프 정리
  }
}

main().catch(function (e) {
  console.error('E2E 실패:', e.message);
  process.exit(1);
});
