/* 방·좌석·연결 수명주기 관리 — 메모리 보관, 서버 권위 게임 진행
 * 모든 액션은 도착 순서대로 동기 처리(Node 단일 스레드 = 자연 직렬화) */
'use strict';
var crypto = require('crypto');
var path = require('path');
var C = require('../shared/tichu-core.js');
var B = require('../shared/bots.js');

// 초고수 봇(신경망+탐색 하이브리드) — 첫 사용 시 가중치 로드(~3MB)
var superBot = null;
function getSuperBot() {
  if (!superBot) {
    var HY = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));
    superBot = HY.create(path.join(__dirname, '..', 'shared', 'weights-super.json'));
    console.log('[tichu] 초고수 가중치 로드 완료');
  }
  return superBot;
}
// 선언(티츄/라지) 신경망 — 66만 라운드 학습, EV 보정 임계
var declNet = null;
function getDeclare() {
  if (!declNet) {
    var DECL = require(path.join(__dirname, '..', 'shared', 'declare.js'));
    declNet = DECL.load(path.join(__dirname, '..', 'shared', 'weights-declare.json'));
  }
  return declNet;
}

// 플레이 이력(라운드 내 최근 수) — 초고수 신경망 입력. 라운드 경계에서 리셋
function trackHist(room, act, g) {
  if (!room.playHist) room.playHist = [];
  if (act.type === 'next_round' || act.type === 'restart') { room.playHist = []; return; }
  if (act.type === 'pass_turn') room.playHist.push({ s: act.seat, t: 'pass', r: 0, l: 0 });
  else if (act.type === 'play_cards') {
    var la = g.lastAction;
    if (la && la.combo) room.playHist.push({ s: act.seat, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
    else if (la && la.kind === 'dog') room.playHist.push({ s: act.seat, t: 'dog', r: 0, l: 1 });
  }
  if (g.phase === 'roundEnd' || g.phase === 'gameEnd') room.playHist = [];
  else if (room.playHist.length > 24) room.playHist.splice(0, room.playHist.length - 24);
}

var PROTO = 1;
var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 0/O/1/I/L 제외
var BOT_NAMES = ['봇 레오', '봇 미나', '봇 준', '봇 콩'];
var MAX_ROOMS = 100;
var MAX_PLAYERS = 4000;           // 세션(토큰) 총량 상한 — 메모리 DoS 방어
var CREATE_PER_MIN = 5;
var HELLO_NEW_PER_MIN = 40;       // IP당 신규 세션 생성 제한
var ORPHAN_SESSION_MS = 20 * 60 * 1000; // 방 없는 세션 GC (20분)
var LOBBY_DC_REMOVE_MS = 60000;   // 대기실 끊김 → 자리 비움
var TAKEOVER_MS = 30000;          // 게임 중 끊긴 사람 차례 → 봇 대행
var POLL_FRESH_MS = 70000;        // poll 클라이언트 생존 판정
var ROOM_IDLE_HUMANLESS_MS = 10 * 60 * 1000;
var ROOM_IDLE_MAX_MS = 2 * 60 * 60 * 1000;

var rooms = new Map();    // code → room
var players = new Map();  // token → player
var ipCreate = new Map(); // ip → [timestamps] (방 생성)
var ipHello = new Map();  // ip → [timestamps] (신규 세션)

// IP별 타임스탬프 버킷에 now를 기록하고 1분 내 횟수를 반환
function bump(map, ip, limit) {
  var b = (map.get(ip) || []).filter(function (t) { return now() - t < 60000; });
  if (b.length >= limit) { map.set(ip, b); return false; }
  b.push(now());
  map.set(ip, b);
  return true;
}

function now() { return Date.now(); }
function newToken() { return crypto.randomBytes(15).toString('base64url'); }
function newCode() {
  for (var t = 0; t < 50; t++) {
    var c = '';
    for (var i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomBytes(1)[0] % CODE_CHARS.length];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function sanitizeName(n) {
  // 제어문자(< U+0020)와 꺾쇠 제거 — 문자 비교 방식(정규식에 제어 바이트를 박지 않기 위함)
  var s = String(n || '').split('').filter(function (ch) { return ch >= ' ' && ch !== '<' && ch !== '>'; }).join('');
  return s.trim().slice(0, 12) || '플레이어';
}
function err(code, message) { return { code: code, message: message }; }
function ackOf(action, room, error) {
  return {
    type: 'action_ack',
    actionId: (action && action.actionId) || '',
    ok: !error,
    version: room ? room.version : 0,
    error: error || null
  };
}
function isConn(p) {
  if (!p) return false;
  if (p.isBot) return true;
  if (p.conn) return true;
  return now() - p.lastSeen < POLL_FRESH_MS;
}

// ---------- 스냅샷 ----------
function snapshotFor(room, seat) {
  return {
    mode: 'online',
    code: room.code,
    phase: room.game ? room.game.phase : 'lobby',
    hostSeat: room.hostSeat,
    youSeat: seat,
    roomSeats: room.seats.map(function (p, i) {
      return {
        seat: i,
        name: p ? p.name : '',
        isBot: !!(p && p.isBot),
        connected: isConn(p),
        occupied: !!p
      };
    }),
    game: room.game ? room.game.viewFor(seat) : null,
    botTimer: room.botDeadline
      ? { seat: room.botSeat, msLeft: Math.max(0, room.botDeadline - now()) }
      : null
  };
}
function stateEnvelope(room, seat) {
  return { type: 'room_state', version: room.version, snapshot: snapshotFor(room, seat) };
}

// ---------- 송신 ----------
function sendTo(p, envelope) {
  if (!p || p.isBot) return;
  if (p.conn) {
    try { p.conn.send(envelope); } catch (e) { /* 연결 정리 별도 처리 */ }
  } else {
    // poll 클라이언트: 상태는 pull로 가져가고, 이벤트성 메시지만 큐잉
    if (envelope.type !== 'room_state') {
      p.outbox.push(envelope);
      if (p.outbox.length > 20) {
        // 채팅부터 버림 — left_room 같은 중요 이벤트가 밀려나지 않게
        var di = -1;
        for (var oi = 0; oi < p.outbox.length; oi++) if (p.outbox[oi].type === 'chat') { di = oi; break; }
        p.outbox.splice(di >= 0 ? di : 0, 1);
      }
    }
  }
  flushPoll(p);
}
function flushPoll(p) {
  if (!p || !p.pollWaiter) return;
  var room = p.roomCode ? rooms.get(p.roomCode) : null;
  var w = p.pollWaiter;
  var msgs = p.outbox.splice(0);
  if (room && room.version > w.since) msgs.push(stateEnvelope(room, p.seat));
  if (!msgs.length) return;
  p.pollWaiter = null;
  clearTimeout(w.timer);
  w.respond({ messages: msgs });
}
function broadcast(room) {
  room.version++;
  room.seats.forEach(function (p, seat) {
    if (!p || p.isBot) return;
    if (p.conn) {
      try { p.conn.send(stateEnvelope(room, seat)); } catch (e) { /* 무시 */ }
    }
    flushPoll(p);
  });
}

// ---------- 봇/대행 스케줄 ----------
function clearBotTimer(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  room.botTimer = null;
  room.botSeat = null;
  room.botDeadline = null;
}
function scheduleBots(room) {
  clearBotTimer(room);
  var g = room.game;
  if (!g) return;
  if (g.phase === 'roundEnd' || g.phase === 'gameEnd') return; // 진행은 사람(방장) 몫
  var waiting = g.waitingOn();
  if (!waiting.length) return;
  // 1) 봇 차례
  var botSeat = null, dcSeat = null;
  waiting.forEach(function (s) {
    var p = room.seats[s];
    if (p && p.isBot && botSeat == null) botSeat = s;
    if (p && !p.isBot && !isConn(p) && dcSeat == null) dcSeat = s;
  });
  if (botSeat != null) {
    var delay = g.phase === 'play' ? 700 : 420;
    room.botTimer = setTimeout(function () { botAct(room, botSeat); }, delay);
    return;
  }
  // 2) 끊긴 사람 차례 → 30초 카운트다운 후 그 결정 1건만 대행
  if (dcSeat != null) {
    room.botSeat = dcSeat;
    room.botDeadline = now() + TAKEOVER_MS;
    room.botTimer = setTimeout(function () { botAct(room, dcSeat); }, TAKEOVER_MS);
  }
}
function botAct(room, seat) {
  clearBotTimer(room);
  var g = room.game;
  if (!g) return;
  if (g.waitingOn().indexOf(seat) < 0) { scheduleBots(room); return; }
  var p = room.seats[seat];
  var a = null;
  // 선언 신경망에 게임 점수 맥락 전달 (Phase 1: 뒤지면 도박, 앞서면 자제)
  var declCtx = { my: g.scores[seat % 2], opp: g.scores[1 - (seat % 2)], tgt: g.targetScore };
  var superTichu = room.botLevel === 'super' && p && p.isBot && g.phase === 'play' && g.turnSeat === seat &&
    !g.playedFirst[seat] && !g.tichu[seat] && getDeclare().tichu(g.hands[seat], declCtx);
  var heurTichu = room.botLevel !== 'super' && p && p.isBot && room.botLevel !== 'easy' && g.phase === 'play' &&
    g.turnSeat === seat && !g.playedFirst[seat] && !g.tichu[seat] && B.botTichu(g.hands[seat]);
  if (superTichu || heurTichu) {
    a = { type: 'call_tichu', seat: seat };
  } else if (room.botLevel === 'super' && g.phase === 'grand' && !g.grandAnswered[seat]) {
    a = { type: 'call_grand', seat: seat, call: getDeclare().grand(g.hands[seat], declCtx) }; // 선언 신경망
  } else if (room.botLevel === 'super' && g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    a = getSuperBot().decidePuct(g, seat, room.playHist || [], { budgetMs: 950, c: 1.0 });
  } else {
    // 초고수의 선언·교환·소원·용은 고수와 같은 휴리스틱(botDecide는 미지 레벨을 보통으로 처리)
    a = B.botDecide(g, seat, room.botLevel);
  }
  if (!a) return;
  var r = g.apply(a);
  if (r.ok) {
    trackHist(room, a, g);
    room.lastActivity = now();
    scheduleBots(room);
    broadcast(room);
  } else {
    console.error('[tichu] 봇 액션 거부', room.code, seat, a.type, r.error && r.error.code);
  }
}

// ---------- 방 생성/입장/퇴장 ----------
function makeBot(seat, room) {
  var used = room.seats.filter(Boolean).map(function (p) { return p.name; });
  var name = BOT_NAMES.find(function (n) { return used.indexOf(n) < 0; }) || ('봇 ' + (seat + 1));
  return { isBot: true, name: name, seat: seat };
}
function humansIn(room) {
  return room.seats.filter(function (p) { return p && !p.isBot; });
}
function fixHost(room) {
  var hp = room.seats[room.hostSeat];
  if (hp && !hp.isBot) return;
  var h = humansIn(room)[0];
  room.hostSeat = h ? h.seat : -1;
}
function unbindPlayer(p) {
  if (!p) return;
  p.roomCode = null;
  p.seat = -1;
  p.outbox = [];
  if (p.lobbyTimer) { clearTimeout(p.lobbyTimer); p.lobbyTimer = null; }
}
function destroyRoom(room, reason) {
  clearBotTimer(room);
  room.seats.forEach(function (p) {
    if (p && !p.isBot) {
      sendTo(p, { type: 'left_room', reason: reason || 'room_closed' });
      unbindPlayer(p);
    }
  });
  rooms.delete(room.code);
}
function leaveRoom(player, reason, notify) {
  var room = player.roomCode ? rooms.get(player.roomCode) : null;
  if (!room) { unbindPlayer(player); return; }
  var seat = player.seat;
  if (room.game) {
    room.seats[seat] = makeBot(seat, room);
    room.seats[seat].name = '봇(' + player.name + ')';
    // 이어받기는 세션 토큰으로만 — 이름은 표시용일 뿐 좌석 권리가 아님(스푸핑 방지)
    room.seats[seat].origToken = player.token;
    if (reason === 'kicked') room.seats[seat].kicked = true;
  } else {
    room.seats[seat] = null;
  }
  if (notify) sendTo(player, { type: 'left_room', reason: reason || 'left' });
  unbindPlayer(player);
  if (!humansIn(room).length) { destroyRoom(room, 'room_closed'); return; }
  fixHost(room);
  room.lastActivity = now();
  scheduleBots(room);
  broadcast(room);
}

// ---------- 연결 바인딩 ----------
function bindChannel(player, ch) {
  if (player.conn && player.conn !== ch) {
    var old = player.conn;
    try { old.send({ type: 'session_replaced' }); } catch (e) { /* 무시 */ }
    player.conn = null;
    try { old.close(); } catch (e) { /* 무시 */ }
  }
  player.conn = ch;
  player.lastSeen = now();
  player.disconnectedAt = null;
  // 끊긴 동안 쌓인 이벤트(채팅 등)를 새 연결로 배출 — poll 외 경로도 유실 방지
  var backlog = player.outbox.splice(0);
  backlog.forEach(function (env) { try { ch.send(env); } catch (e) { /* 무시 */ } });
  if (player.lobbyTimer) { clearTimeout(player.lobbyTimer); player.lobbyTimer = null; }
  var room = player.roomCode ? rooms.get(player.roomCode) : null;
  if (room) { scheduleBots(room); broadcast(room); }
}
function onDisconnect(player, ch) {
  if (player.conn !== ch) return; // 이미 다른 연결로 대체됨
  player.conn = null;
  player.disconnectedAt = now();
  var room = player.roomCode ? rooms.get(player.roomCode) : null;
  if (!room) return;
  if (!room.game) {
    // 대기실: 60초 후 자리 비움
    player.lobbyTimer = setTimeout(function () {
      if (!player.conn && player.roomCode === room.code && !room.game) leaveRoom(player, 'left', false);
    }, LOBBY_DC_REMOVE_MS);
  }
  scheduleBots(room);
  broadcast(room);
}

// ---------- hello ----------
function hello(opts) {
  var token = opts.token;
  var player = token ? players.get(token) : null;
  if (!player) {
    // 신규 세션만 제한 (기존 토큰 재접속은 항상 허용) — 익명 hello 폭주 메모리 DoS 방어
    if (players.size >= MAX_PLAYERS || !bump(ipHello, opts.ip || '', HELLO_NEW_PER_MIN)) {
      return { rejected: err('RATE_LIMITED', '접속이 혼잡합니다 — 잠시 후 다시 시도하세요') };
    }
    token = newToken();
    player = {
      token: token, name: sanitizeName(opts.name), ip: opts.ip || '',
      seat: -1, roomCode: null, isBot: false,
      conn: null, lastSeen: now(), disconnectedAt: null,
      recentActions: [], outbox: [], pollWaiter: null, lobbyTimer: null
    };
    players.set(token, player);
  } else {
    player.lastSeen = now();
    if (opts.name) {
      var room0 = player.roomCode ? rooms.get(player.roomCode) : null;
      if (!room0 || !room0.game) player.name = sanitizeName(opts.name);
    }
  }
  var room = player.roomCode ? rooms.get(player.roomCode) : null;
  return {
    player: player,
    welcome: {
      type: 'welcome',
      token: player.token,
      resumed: !!room,
      protocolVersion: PROTO,
      version: room ? room.version : 0,
      snapshot: room ? snapshotFor(room, player.seat) : null
    }
  };
}

// ---------- 액션 처리 ----------
function processAction(player, action) {
  player.lastSeen = now();
  if (!action || typeof action.type !== 'string') return ackOf(action, null, err('BAD_REQUEST', '잘못된 요청'));
  // 멱등: 같은 actionId 재전송 → 캐시된 ack
  if (action.actionId) {
    for (var i = 0; i < player.recentActions.length; i++) {
      if (player.recentActions[i].id === action.actionId) return player.recentActions[i].ack;
    }
  }
  var ack = handle(player, action);
  if (action.actionId) {
    player.recentActions.push({ id: action.actionId, ack: ack });
    if (player.recentActions.length > 32) player.recentActions.shift();
  }
  return ack;
}

function handle(player, a) {
  var room = player.roomCode ? rooms.get(player.roomCode) : null;

  switch (a.type) {
    case 'create_room': {
      // IP당 분당 생성 제한
      if (!bump(ipCreate, player.ip, CREATE_PER_MIN)) return ackOf(a, room, err('RATE_LIMITED', '잠시 후 다시 시도하세요'));
      if (rooms.size >= MAX_ROOMS) return ackOf(a, null, err('RATE_LIMITED', '서버에 방이 가득 찼습니다'));
      if (room) leaveRoom(player, 'left', false);
      var code = newCode();
      if (!code) return ackOf(a, null, err('RATE_LIMITED', '방 코드를 만들 수 없습니다'));
      if (a.name) player.name = sanitizeName(a.name);
      var r = {
        code: code, version: 0, game: null, hostSeat: 0,
        seats: [player, null, null, null],
        createdAt: now(), lastActivity: now(),
        botTimer: null, botSeat: null, botDeadline: null,
        banned: [] // 강퇴된 세션 토큰 — 재입장 차단
      };
      player.roomCode = code;
      player.seat = 0;
      rooms.set(code, r);
      broadcast(r);
      return ackOf(a, r, null);
    }
    case 'list_rooms': {
      // 홈 화면 방 목록 — 코드 입력 없이 골라 들어가게
      var list = [];
      rooms.forEach(function (r2) {
        if (list.length >= 30) return;
        list.push({
          code: r2.code,
          host: (r2.seats[r2.hostSeat] || {}).name || '?',
          occupied: r2.seats.filter(Boolean).length,
          humans: humansIn(r2).length,
          bots: r2.seats.filter(function (p) { return p && p.isBot; }).length,
          inGame: !!r2.game,
          target: r2.targetScore || null
        });
      });
      list.reverse(); // 최신 방 먼저
      var ackL = ackOf(a, room, null);
      ackL.rooms = list;
      return ackL;
    }
    case 'join_room': {
      var code2 = String(a.code || '').toUpperCase();
      var r2 = rooms.get(code2);
      if (!r2) return ackOf(a, null, err('ROOM_NOT_FOUND', '방을 찾을 수 없습니다: ' + code2));
      if (room && room !== r2) leaveRoom(player, 'left', false);
      if (player.roomCode === code2) { broadcast(r2); return ackOf(a, r2, null); }
      if (r2.banned && r2.banned.indexOf(player.token) >= 0) {
        return ackOf(a, null, err('KICKED', '이 방에서 강퇴되어 다시 들어갈 수 없습니다'));
      }
      if (r2.game) {
        // 게임 중 복귀: 봇이 대신하는 자리를 이어받음(팅김·실수 퇴장 복구).
        // 우선순위: 내 세션 토큰으로 전환된 자리(본인 확인) > 일반 봇 > 타인의 전환 자리.
        // 이름 일치는 좌석 권리가 아님 — 닉네임 스푸핑으로 남의 자리·손패를 탈취하는 것 방지.
        if (a.name) player.name = sanitizeName(a.name);
        var mySeat2 = -1, plainBot2 = -1, anyBot2 = -1;
        for (var b2 = 0; b2 < 4; b2++) {
          var occ2 = r2.seats[b2];
          if (occ2 && occ2.isBot) {
            if (anyBot2 < 0) anyBot2 = b2;
            if (plainBot2 < 0 && !occ2.origToken) plainBot2 = b2;
            if (occ2.origToken && occ2.origToken === player.token) { mySeat2 = b2; break; }
          }
        }
        var take2 = mySeat2 >= 0 ? mySeat2 : (plainBot2 >= 0 ? plainBot2 : anyBot2);
        if (take2 < 0) return ackOf(a, null, err('GAME_IN_PROGRESS', '게임 중이며 이어받을 봇 자리가 없습니다'));
        r2.seats[take2] = player;
        player.roomCode = code2;
        player.seat = take2;
        fixHost(r2);
        r2.lastActivity = now();
        scheduleBots(r2);
        broadcast(r2);
        return ackOf(a, r2, null);
      }
      var free = -1;
      for (var s = 0; s < 4; s++) if (!r2.seats[s]) { free = s; break; }
      if (free < 0) return ackOf(a, null, err('ROOM_FULL', '방이 가득 찼습니다'));
      if (a.name) player.name = sanitizeName(a.name);
      r2.seats[free] = player;
      player.roomCode = code2;
      player.seat = free;
      r2.lastActivity = now();
      broadcast(r2);
      return ackOf(a, r2, null);
    }
  }

  if (!room) return ackOf(a, null, err('ROOM_NOT_FOUND', '방에 입장한 상태가 아닙니다'));
  var isHost = player.seat === room.hostSeat;

  switch (a.type) {
    case 'set_name':
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '게임 중에는 변경할 수 없습니다'));
      player.name = sanitizeName(a.name);
      broadcast(room);
      return ackOf(a, room, null);

    case 'take_seat': {
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '게임 중에는 이동할 수 없습니다'));
      var t = a.seat | 0;
      if (t < 0 || t > 3) return ackOf(a, room, err('BAD_REQUEST', '좌석 오류'));
      if (room.seats[t]) return ackOf(a, room, err('SEAT_TAKEN', '이미 사용 중인 자리입니다'));
      var wasHost = player.seat === room.hostSeat;
      room.seats[player.seat] = null;
      room.seats[t] = player;
      player.seat = t;
      if (wasHost) room.hostSeat = t;
      broadcast(room);
      return ackOf(a, room, null);
    }
    case 'add_bot': {
      if (!isHost) return ackOf(a, room, err('NOT_HOST', '방장만 가능합니다'));
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '게임 중에는 불가합니다'));
      var bs = a.seat | 0;
      if (bs < 0 || bs > 3 || room.seats[bs]) return ackOf(a, room, err('SEAT_TAKEN', '빈자리가 아닙니다'));
      room.seats[bs] = makeBot(bs, room);
      broadcast(room);
      return ackOf(a, room, null);
    }
    case 'remove_bot': {
      if (!isHost) return ackOf(a, room, err('NOT_HOST', '방장만 가능합니다'));
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '게임 중에는 불가합니다'));
      var rs = a.seat | 0;
      if (!(room.seats[rs] && room.seats[rs].isBot)) return ackOf(a, room, err('BAD_REQUEST', '봇 자리가 아닙니다'));
      room.seats[rs] = null;
      broadcast(room);
      return ackOf(a, room, null);
    }
    case 'kick_player': {
      if (!isHost) return ackOf(a, room, err('NOT_HOST', '방장만 가능합니다'));
      var ks = a.seat | 0;
      var kp = room.seats[ks];
      if (!kp || kp.isBot || kp === player) return ackOf(a, room, err('BAD_REQUEST', '강퇴 대상이 아닙니다'));
      room.banned = room.banned || [];
      if (room.banned.indexOf(kp.token) < 0) room.banned.push(kp.token);
      if (room.banned.length > 16) room.banned.shift();
      leaveRoom(kp, 'kicked', true);
      return ackOf(a, rooms.get(room.code) ? room : null, null);
    }
    case 'start_game': {
      if (!isHost) return ackOf(a, room, err('NOT_HOST', '방장만 시작할 수 있습니다'));
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '이미 시작되었습니다'));
      for (var f = 0; f < 4; f++) if (!room.seats[f]) room.seats[f] = makeBot(f, room);
      var ts = (a.targetScore === 300 || a.targetScore === 500 || a.targetScore === 1000) ? a.targetScore : 1000;
      room.targetScore = ts;
      // 온라인 봇: 'super'(내부 키 유지) = 사용자 표기 "1단". 탐색은 950ms 시간컷(동시 1게임 전제)
      // 1단 = v6 신경망(폭2배) + PUCT(c=1.0) 하이브리드. v3-챔피언+ 직접 58.8%로 이겨 승격(고수950 대비 ~60%)
      // 악마(상대 패 열람)는 사람에게 불공정 → 제외
      room.botLevel = ['easy', 'normal', 'hard', 'super'].indexOf(a.botLevel) >= 0 ? a.botLevel : 'normal';
      room.playHist = [];
      room.game = new C.Game({ targetScore: ts });
      room.lastActivity = now();
      scheduleBots(room);
      broadcast(room);
      return ackOf(a, room, null);
    }
    case 'leave_room':
      leaveRoom(player, 'left', true);
      return ackOf(a, null, null);

    case 'chat': {
      if (typeof a.text !== 'string') return ackOf(a, room, err('BAD_REQUEST', '내용이 없습니다'));
      // C0/C1 제어문자·bidi 오버라이드 제거(표기 스푸핑 방지), 200자 제한
      var txt = a.text.split('').filter(function (ch) {
        var cc = ch.charCodeAt(0);
        return cc > 31 && (cc < 127 || cc > 159) && !(cc >= 8234 && cc <= 8238);
      }).join('').trim().slice(0, 200);
      if (!txt) return ackOf(a, room, err('BAD_REQUEST', '내용이 없습니다'));
      if (player.lastChatAt && now() - player.lastChatAt < 600) {
        return ackOf(a, room, err('RATE_LIMITED', '천천히 보내주세요'));
      }
      player.lastChatAt = now();
      var chatEnv = { type: 'chat', seat: player.seat, name: player.name, text: txt, ts: now() };
      room.seats.forEach(function (p) { sendTo(p, chatEnv); });
      room.lastActivity = now();
      return ackOf(a, room, null);
    }
  }

  // ---------- 게임 액션 ----------
  if (!room.game) return ackOf(a, room, err('BAD_PHASE', '게임이 시작되지 않았습니다'));
  var g = room.game;

  // 버전 검사: 어긋난 패스는 무시, 어긋난 플레이는 폭탄만 재검증 허용
  // 패스는 버전 게이트 없이 엔진 검증에 맡김 — 정당한 패스가 버전 지연(폭탄 끼어들기·업데이트 지연)으로
  // 조용히 거부되던 버그 해결. 엔진(_pass)이 차례·선두·소원을 어차피 재검증하므로 안전.
  if (a.type === 'play_cards' && a.version != null && a.version !== room.version) {
    var cmb = Array.isArray(a.cards) ? C.identify(a.cards) : null;
    if (!cmb || !C.isBomb(cmb.type)) return ackOf(a, room, err('STALE_VERSION', '상태가 갱신되었습니다'));
  }

  var engineAction = null;
  switch (a.type) {
    case 'call_grand': engineAction = { type: 'call_grand', seat: player.seat, call: !!a.call }; break;
    case 'call_tichu': engineAction = { type: 'call_tichu', seat: player.seat }; break;
    case 'submit_exchange': engineAction = { type: 'submit_exchange', seat: player.seat, give: a.give }; break;
    case 'play_cards':
      if (!Array.isArray(a.cards) || a.cards.length > 14) return ackOf(a, room, err('BAD_REQUEST', '카드 지정 오류'));
      engineAction = { type: 'play_cards', seat: player.seat, cards: a.cards, wish: a.wish };
      break;
    case 'pass_turn': engineAction = { type: 'pass_turn', seat: player.seat }; break;
    case 'give_dragon': engineAction = { type: 'give_dragon', seat: player.seat, toSeat: a.toSeat | 0 }; break;
    case 'next_round':
    case 'restart_game': {
      var hostP = room.seats[room.hostSeat];
      var hostOk = isHost || !isConn(hostP);
      if (!hostOk) return ackOf(a, room, err('NOT_HOST', '방장이 진행합니다'));
      engineAction = { type: a.type === 'next_round' ? 'next_round' : 'restart' };
      break;
    }
    default:
      return ackOf(a, room, err('BAD_REQUEST', '알 수 없는 액션: ' + a.type));
  }

  var res = g.apply(engineAction);
  if (!res.ok) return ackOf(a, room, res.error);
  trackHist(room, engineAction, g);
  room.lastActivity = now();
  scheduleBots(room);
  broadcast(room);
  return ackOf(a, room, null);
}

// ---------- 외부(전송 계층) 인터페이스 ----------
function attachWS(conn, req) {
  var ip = (req.socket && req.socket.remoteAddress) || '';
  var bound = null;
  var ch = {
    kind: 'ws',
    send: function (o) { conn.send(o); },
    close: function () { conn.close(1000); }
  };
  var helloTimer = setTimeout(function () { if (!bound) conn.close(1008); }, 10000);
  conn.onmessage = function (str) {
    if (str.length > 16 * 1024) { conn.close(1009); return; }
    var msg;
    try { msg = JSON.parse(str); } catch (e) { conn.close(1007); return; }
    if (!bound) {
      if (!msg || msg.type !== 'hello') { conn.close(1008); return; }
      clearTimeout(helloTimer);
      var h = hello({ token: msg.token, name: msg.name, ip: ip });
      if (h.rejected) { conn.close(1008); return; }
      bound = h.player;
      bindChannel(bound, ch);
      conn.send(h.welcome);
      return;
    }
    var ack = processAction(bound, msg);
    conn.send(ack);
  };
  conn.onclose = function () {
    clearTimeout(helloTimer);
    if (bound) onDisconnect(bound, ch);
  };
}

// HTTP POST /action 본문 처리 → 응답 envelope
function handleHttp(body, ip) {
  var action = body && body.action;
  if (!action || typeof action !== 'object') {
    return { type: 'action_ack', actionId: '', ok: false, version: 0, error: err('BAD_REQUEST', '잘못된 요청') };
  }
  if (action.type === 'hello') {
    var h = hello({ token: action.token || body.token, name: action.name, ip: ip });
    if (h.rejected) return { type: 'action_ack', actionId: '', ok: false, version: 0, error: h.rejected };
    return h.welcome;
  }
  var token = body.token || action.token;
  var player = token ? players.get(token) : null;
  if (!player) {
    return { type: 'action_ack', actionId: action.actionId || '', ok: false, version: 0, error: err('BAD_REQUEST', '세션이 없습니다 — 새로고침 해주세요') };
  }
  return processAction(player, action);
}

function findPlayer(token) { return token ? players.get(token) : null; }

function attachSSE(token, since, ch) {
  var player = players.get(token);
  if (!player) return false;
  bindChannel(player, ch);
  var room = player.roomCode ? rooms.get(player.roomCode) : null;
  if (room && room.version > (since || 0)) {
    try { ch.send(stateEnvelope(room, player.seat)); } catch (e) { /* 무시 */ }
  }
  return true;
}
function detachSSE(token, ch) {
  var player = players.get(token);
  if (player) onDisconnect(player, ch);
}

function attachPoll(token, since, respond) {
  var player = players.get(token);
  if (!player) { respond({ messages: [{ type: 'left_room', reason: 'room_closed' }] }); return; }
  player.lastSeen = now();
  if (player.pollWaiter) {
    var old = player.pollWaiter;
    player.pollWaiter = null;
    clearTimeout(old.timer);
    old.respond({ type: 'noop', version: since });
  }
  var room = player.roomCode ? rooms.get(player.roomCode) : null;
  var msgs = player.outbox.splice(0);
  if (room && room.version > (since || 0)) msgs.push(stateEnvelope(room, player.seat));
  if (msgs.length) { respond({ messages: msgs }); return; }
  var w = {
    since: since || 0,
    respond: respond,
    timer: setTimeout(function () {
      if (player.pollWaiter === w) {
        player.pollWaiter = null;
        respond({ type: 'noop', version: room ? room.version : 0 });
      }
    }, 25000)
  };
  player.pollWaiter = w;
}

// ---------- GC ----------
function startGC() {
  setInterval(function () {
    var t = now();
    rooms.forEach(function (room) {
      var humansConnected = humansIn(room).some(isConn);
      var lastSeen = Math.max.apply(null, humansIn(room).map(function (p) { return p.lastSeen; }).concat([room.lastActivity]));
      if ((!humansConnected && t - lastSeen > ROOM_IDLE_HUMANLESS_MS) || t - room.lastActivity > ROOM_IDLE_MAX_MS) {
        destroyRoom(room, 'room_closed');
        return;
      }
      // poll 클라이언트가 조용히 사라진 경우 봇 대행 재점검
      if (room.game && !room.botTimer) scheduleBots(room);
    });
    // 방 없는 오래된 세션 정리 (연결도 없고 20분 방치) — hello 폭주 잔재 회수
    players.forEach(function (p, token) {
      if (!p.roomCode && !p.conn && t - p.lastSeen > ORPHAN_SESSION_MS) players.delete(token);
    });
    // IP rate-limit 버킷도 만료분 정리 (맵 무한 증가 방지)
    [ipCreate, ipHello].forEach(function (map) {
      map.forEach(function (arr, ip) {
        var fresh = arr.filter(function (ts) { return t - ts < 60000; });
        if (fresh.length) map.set(ip, fresh); else map.delete(ip);
      });
    });
  }, 60000);
}

function stats() { return { rooms: rooms.size, players: players.size }; }

module.exports = {
  PROTO: PROTO,
  attachWS: attachWS,
  handleHttp: handleHttp,
  findPlayer: findPlayer,
  attachSSE: attachSSE,
  detachSSE: detachSSE,
  attachPoll: attachPoll,
  startGC: startGC,
  stats: stats
};
