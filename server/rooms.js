/* 방·좌석·연결 수명주기 관리 — 메모리 보관, 서버 권위 게임 진행
 * 모든 액션은 도착 순서대로 동기 처리(Node 단일 스레드 = 자연 직렬화) */
'use strict';
var crypto = require('crypto');
var path = require('path');
var C = require('../shared/tichu-core.js');
var B = require('../shared/bots.js');
var STATS = require('./stats.js');
var GLOG = require('./gamelog.js');

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
// 3단 봇 — 승단전(CI 1,920게임 사전등록, +6.16±1.46 = 54.4%)을 통과한 동결 조합 그대로:
// swa13_18(RL 체크포인트 평균) 가중치 + 손패별 학습 교환(선형). 그 외 재료는 싣지 않는다
// (종반탐색·티츄가드·트리플보존은 측정에서 무효/음수 — 4단 이상 재료로만).
var super3Bot = null;
function getSuper3Bot() {
  if (!super3Bot) {
    var HY3 = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));
    super3Bot = HY3.create(path.join(__dirname, '..', 'shared', 'weights-super3.json'));
    console.log('[tichu] 3단 가중치 로드 완료');
  }
  return super3Bot;
}
var exch3 = null;                                   // 3단 학습 교환(선형) — 지연 로드
function getExch3() {
  if (!exch3) {
    var INF = require(path.join(__dirname, '..', 'shared', 'exchange-infer.js'));
    var w = JSON.parse(require('fs').readFileSync(
      path.join(__dirname, '..', 'shared', 'weights-exchange3.json'), 'utf8'));
    exch3 = INF.create(w);
  }
  return exch3;
}
// 4단 학습 교환(MLP) — 40만 딜 짝지음에서 3단 선형 대비 +1.03±0.15 (6.9σ)
var exch4 = null, exch4Failed = false;
function getExch4() {
  if (exch4 || exch4Failed) return exch4;
  /* 로드 실패는 반드시 여기서 삼킨다. 예외가 botAct 밖으로 나가면 그 방은 봇 타이머 없이
   * 영구 정지한다(botAct 진입부에서 clearBotTimer를 이미 한 뒤라 재스케줄 안전망보다 위에서 터진다).
   * 실패하면 null을 돌려 호출부가 3단 선형 → 2단 규칙 순으로 폴백하게 한다. */
  try {
    var INF4 = require(path.join(__dirname, '..', 'shared', 'exchange-infer.js'));
    var w4 = JSON.parse(require('fs').readFileSync(
      path.join(__dirname, '..', 'shared', 'weights-exchange4.json'), 'utf8'));
    exch4 = INF4.create(w4);
    console.log('[tichu] 4단 교환(MLP) 로드 완료');
  } catch (e) {
    exch4Failed = true;                       // 매 교환마다 재시도하지 않는다
    console.error('[tichu] 4단 교환 가중치 로드 실패 — 3단 선형으로 폴백:', e.message);
  }
  return exch4;
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

/* 전적 집계 — 사람 액션·봇 액션 두 경로가 모두 trackHist를 지나므로 여기 한 곳에서 훅한다.
 * 같은 라운드를 두 번 세지 않도록 roundSummary 객체 동일성으로 중복을 막는다. */
function recordStats(room, g) {
  if (!g.roundSummary || room.lastSummary === g.roundSummary) return;
  room.lastSummary = g.roundSummary;
  var names = [0, 1, 2, 3].map(function (s) {
    var p = room.seats[s];
    return (p && !p.isBot) ? p.name : null;      // 봇은 집계 제외
  });
  if (!names.some(Boolean)) return;              // 전원 봇이면 기록할 것 없음
  /* 같은 닉네임이 두 자리에 앉으면 한 사람으로 집계돼 승패·Elo가 이중 계산된다.
   * (같은 판에서 이기고 지는 것도 가능해 수치가 무의미해진다.) 그 판은 통째로 건너뛴다. */
  var seen = Object.create(null), dup = false;
  names.forEach(function (n) { if (n) { if (seen[n]) dup = true; seen[n] = 1; } });
  if (dup) { console.warn('[tichu] 같은 닉네임 중복 — 전적 집계 건너뜀', room.code); return; }
  // Elo용 봇 단수 — 봇 좌석은 고정 앵커로 쓰인다(방 전체가 같은 botLevel)
  var bots = [0, 1, 2, 3].map(function (s) {
    var p = room.seats[s];
    return (p && p.isBot) ? (room.botLevel || 'normal') : null;
  });
  try {
    STATS.recordRound(names, g.roundSummary);
    if (g.roundSummary.gameOver) STATS.recordGame(names, g.roundSummary.winnerTeam, bots);
  } catch (e) { console.error('[tichu] 전적 기록 실패', e.message); }
}

// 플레이 이력(라운드 내 최근 수) — 초고수 신경망 입력. 라운드 경계에서 리셋
function trackHist(room, act, g) {
  recordStats(room, g);
  GLOG.onAction(room, act, g);   // 기보 — 실패해도 게임에 영향 없음(내부 try)
  if (!room.playHist) room.playHist = [];
  if (act.type === 'next_round' || act.type === 'restart') {
    room.playHist = [];
    if (room._tmBank) room._tmBank.ms = 0;   // 시간배분 은행 — 라운드 넘겨 이월 금지
    return;
  }
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
        occupied: !!p,
        // 로비 전적 표기 — 사람 좌석만, 기록 없으면 null(첫 게임)
        stats: (p && !p.isBot) ? STATS.brief(p.name) : null
      };
    }),
    game: room.game ? room.game.viewFor(seat) : null,
    randomSeats: !!room.randomSeats,                          // 시작 시 무작위 배치 예약됨
    spectating: seat < 0,                                    // 나는 관전자인가
    spectators: (room.spectators || []).map(function (p) { return p.name; }),
    botTimer: room.botDeadline
      ? { seat: room.botSeat, msLeft: Math.max(0, room.botDeadline - now()) }
      : null
  };
}
function stateEnvelope(room, seat) {
  // version = 스냅샷 순번(전송 dedup용, 재접속·참석 변화에도 증가)
  // gver = 게임 상태 버전(성공한 게임 액션에만 증가) — 플레이 STALE 판정은 이것으로만
  return { type: 'room_state', version: room.version, gver: room.gver || 0, snapshot: snapshotFor(room, seat) };
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
  /* 관전자는 좌석 −1로 받는다 → viewFor(-1)이 you=null을 돌려주므로 손패가 원천적으로 안 나간다.
   * 같은 사무실에서 하는 게임이라 관전자가 패를 보면 알려줄 수 있다 — 구조로 막는다. */
  (room.spectators || []).forEach(function (p) {
    if (!p) return;
    if (p.conn) {
      try { p.conn.send(stateEnvelope(room, -1)); } catch (e) { /* 무시 */ }
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
  var prevSeat = room.botSeat, prevDeadline = room.botDeadline; // 대행 마감 보존용(아래 참조)
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
  //
  // 마감은 '남은 시간'이 아니라 '절대 시각'으로 관리한다. scheduleBots는 남의 재접속·절단마다
  // 불리는데(bindChannel/onDisconnect), 매번 now()+30초로 다시 잡으면 회선이 흔들리는 사람이
  // 있을 때 카운트다운이 영원히 0으로 되감겨 테이블이 통째로 멈춘다.
  if (dcSeat != null) {
    var keep = (prevSeat === dcSeat && prevDeadline && prevDeadline > now()) ? prevDeadline : null;
    room.botSeat = dcSeat;
    room.botDeadline = keep || (now() + TAKEOVER_MS);
    room.botTimer = setTimeout(function () { botAct(room, dcSeat); }, Math.max(0, room.botDeadline - now()));
  }
}
function botAct(room, seat) {
  clearBotTimer(room);
  var g = room.game;
  if (!g) return;
  if (g.waitingOn().indexOf(seat) < 0) { scheduleBots(room); return; }
  var p = room.seats[seat];
  var a = null;
  // 1단(super)·2단(super2)은 동결. 2단 = 1단 코드 그대로 + 교환에서 마작·개 보유(⑦).
  // 검증(2026-07-24): 950ms 240판 짝지음 +22.56점/라운드 → 점수차 66.2%. 사용자가 점수차 기준 확정.
  // 이득은 원투 완주 보너스에서 나온다(카드 점수 기여 −0.20). 1단(super) 경로는 한 줄도 건드리지 않음.
  var isDan4 = room.botLevel === 'super4';
  var isSuper = room.botLevel === 'super' || room.botLevel === 'super2' ||
                room.botLevel === 'super3' || isDan4;
  var isDan3 = room.botLevel === 'super3';
  /* 탐색량 — 단을 가르는 축(2026-07-28 사용자 결정 A안).
   * 코어 최적화로 같은 950ms에 시뮬이 3배 늘었는데 그대로 두면 전 단이 같이 강해져 계단이 사라진다.
   * 두 장치를 함께 쓴다:
   *   ① 예산: 4단만 2배(1900ms). 기기 속도와 무관하게 최소 2배 탐색이 보장된다.
   *   ② 상한: 1~3단은 종전 2000에 묶어 동결(빠른 기기에서 조용히 강해지는 것 방지).
   * 상한만으로는 부족하다 — Render 0.1 CPU에서는 캡보다 예산이 먼저 걸려(실측 810시뮬)
   * 3단·4단이 동일해진다. 그래서 예산 축이 필수다. */
  var DAN_REPCAP = isDan4 ? 1e9 : 2000;
  /* 4단 = 3단 정책 + 예산 3800ms. 승단전 2,880게임 3표본 풀링 +4.97±1.12 (53.6%),
   * 이질성 Q=3.55(임계 5.99) — 표본 일관. 기준 +4.17 통과.
   * 시간배분(tm)은 강도 기여가 0이지만(예산 위에서 −0.63) 체감 시간을 되사준다:
   * 3800ms 균등은 한 수 체감 4.5초, tm을 얹으면 중앙값 2.0초(현행 3단 1.7초와 비슷).
   * 초과 달성분(6000ms·카운팅 소원)은 5단 이상 재료로 보류(사용자 지시). */
  var DAN_BUDGET = isDan4 ? 3800 : 950;
  var DAN_TM = isDan4 ? { bank: (room._tmBank = room._tmBank || { ms: 0 }),
                          checkAt: 0.35, stopShare: 0.90, stopMargin: 0.55,
                          maxExtra: 0, hardCap: 5000 } : null;
  var superTichu = isSuper && p && p.isBot && g.phase === 'play' && g.turnSeat === seat &&
    !g.playedFirst[seat] && !g.tichu[seat] && getDeclare().tichu(g.hands[seat]);
  var heurTichu = !isSuper && p && p.isBot && room.botLevel !== 'easy' && g.phase === 'play' &&
    g.turnSeat === seat && !g.playedFirst[seat] && !g.tichu[seat] && B.botTichu(g.hands[seat]);
  if (superTichu || heurTichu) {
    a = { type: 'call_tichu', seat: seat };
  } else if (isSuper && g.phase === 'grand' && !g.grandAnswered[seat]) {
    a = { type: 'call_grand', seat: seat, call: getDeclare().grand(g.hands[seat]) }; // 선언 신경망(동결)
  } else if (room.botLevel === 'super2' && g.phase === 'exchange' && !g.exchangeGive[seat]) {
    a = { type: 'submit_exchange', seat: seat, give: B.botExchange(g, seat, { keepSpecials: true }) }; // ⑦ 2단 전용
  } else if (isDan4 && g.phase === 'exchange' && !g.exchangeGive[seat]) {
    // 4단 교환: MLP 랭커 — 40만 딜에서 3단 선형 대비 +1.03±0.15(6.9σ). 실패 시 3단 선형으로 폴백
    var e4 = getExch4();                                   // 실패 시 null
    a = { type: 'submit_exchange', seat: seat,
          give: (e4 && e4.give(g, seat)) || getExch3().give(g, seat) ||
                B.botExchange(g, seat, { keepSpecials: true }) };
  } else if (isDan3 && g.phase === 'exchange' && !g.exchangeGive[seat]) {
    // 3단 교환: 손패별 학습 교환(선형) — 게이트 +2.18±0.75, 후보 부족 시 2단 규칙 폴백
    a = { type: 'submit_exchange', seat: seat,
          give: getExch3().give(g, seat) || B.botExchange(g, seat, { keepSpecials: true }) };
  } else if ((isDan3 || isDan4) && g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    // 3·4단 플레이: 같은 swa 가중치 PUCT. 차이는 탐색 상한뿐 — 4단만 예산을 다 쓴다.
    a = getSuper3Bot().decidePuct(g, seat, room.playHist || [],
      { budgetMs: DAN_BUDGET, c: 1.0, repCap: DAN_REPCAP, tm: DAN_TM });
    /* 파트너 티츄 가드 — 사용자 보고("우리 팀이 티츄했을 때 봇이 참아야").
     * 원인은 결정화가 "선언=강한 패"를 모르는 것이다(실측: 기본 결정화에서 선언 좌석
     * 완주율 24%). 그래서 탐색 세계에선 파트너 티츄가 대부분 죽고 "어차피 죽을 티츄,
     * 내가 완주"가 합리가 된다 — 잘못된 믿음 위의 합리라 평가 개선이 아니라 하드 가드가 답이다.
     * 실측(좌석1 라지 강제 60라운드): 파트너 완주 임박 국면 15건 전부에서 가드가 개입.
     * 명시적 배신(파트너가 1등) 6.7%. */
    a = B.guardPartnerTichu(g, seat, a);
  } else if (isSuper && g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    a = getSuperBot().decidePuct(g, seat, room.playHist || [], { budgetMs: 950, c: 1.0, repCap: DAN_REPCAP });
    // 파트너 티츄 가드는 2단에 미적용 — 2단은 검증된 상태 그대로 동결(3·4단에만 적용)
  } else {
    // 초고수의 선언·교환(1단)·소원·용은 고수와 같은 휴리스틱(botDecide는 미지 레벨을 보통으로 처리)
    a = B.botDecide(g, seat, room.botLevel);
  }
  // 실패 경로에서도 반드시 재스케줄한다 — 안 하면 방이 영구 정지(복구 수단 없음).
  // 연속 실패는 보통봇으로 폴백하고, 그래도 안 되면 포기(무한 루프 방지).
  if (!a || !g.apply(a).ok) {
    if (a) console.error('[tichu] 봇 액션 거부', room.code, seat, a.type);
    room.botFail = (room.botFail || 0) + 1;
    if (room.botFail <= 3) {
      var fb = B.botDecide(g, seat, 'normal');           // 폴백: 가장 단순·안전한 결정
      if (fb && g.apply(fb).ok) {
        room.botFail = 0;
        room.gver++;
        trackHist(room, fb, g);
        room.lastActivity = now();
        scheduleBots(room);
        broadcast(room);
        return;
      }
      scheduleBots(room);                                 // 재시도
    } else {
      console.error('[tichu] 봇 연속 실패 — 방', room.code, '정지');
    }
    return;
  }
  room.botFail = 0;
  room.gver++;
  trackHist(room, a, g);
  room.lastActivity = now();
  scheduleBots(room);
  broadcast(room);
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
  // 관전자도 함께 풀어준다 — 안 그러면 지워진 방을 가리킨 채 로비로 못 돌아간다
  (room.spectators || []).forEach(function (p) {
    sendTo(p, { type: 'left_room', reason: reason || 'room_closed' });
    unbindPlayer(p);
  });
  room.spectators = [];
  rooms.delete(room.code);
}
/* 좌석 재배치 — arrange_seats(순서)와 start_game(예약된 무작위) 둘 다 쓴다.
 * 무작위는 사람이 아니라 **좌석 4칸**을 섞는다. 앞자리부터 몰아넣으면 2명일 때 늘
 * 좌석 0·1이 되는데 마주보는 자리가 한 팀이라 둘은 무조건 반대 팀으로 고정된다. */
function seatArrange(room, mode) {
  var occ = room.seats.filter(Boolean);
  if (occ.length < 2) return false;
  var hostPlayer = room.seats[room.hostSeat];   // 방장은 자리를 따라간다(번호가 아니라 사람)
  var slot = [0, 1, 2, 3];
  if (mode === 'random') {
    for (var ri = slot.length - 1; ri > 0; ri--) {          // Fisher-Yates
      var rj = crypto.randomInt(ri + 1), tmp = slot[ri]; slot[ri] = slot[rj]; slot[rj] = tmp;
    }
  } else {
    // 참가 순서 — 순번 없는 사람(방장·복귀자)은 0으로 보아 앞에 온다
    occ.sort(function (x, y) { return (x.joinSeq || 0) - (y.joinSeq || 0); });
  }
  room.seats = [null, null, null, null];
  occ.forEach(function (p2, idx) { var sn = slot[idx]; room.seats[sn] = p2; p2.seat = sn; });
  var hi = room.seats.indexOf(hostPlayer);
  if (hi >= 0) room.hostSeat = hi;
  fixHost(room);
  return true;
}

var MAX_SPECTATORS = 8;

/* 관전자로 앉힌다. 좌석은 −1 — 게임 액션은 전부 좌석 검사에서 막히고,
 * 브로드캐스트도 viewFor(-1)이라 손패가 나가지 않는다. */
function addSpectator(room, player) {
  if (!room.spectators) room.spectators = [];
  if (room.spectators.length >= MAX_SPECTATORS) return false;
  if (room.spectators.indexOf(player) < 0) room.spectators.push(player);
  player.roomCode = room.code;
  player.seat = -1;
  return true;
}
function removeSpectator(room, player) {
  if (!room || !room.spectators) return false;
  var i = room.spectators.indexOf(player);
  if (i < 0) return false;
  room.spectators.splice(i, 1);
  return true;
}

function leaveRoom(player, reason, notify) {
  var room = player.roomCode ? rooms.get(player.roomCode) : null;
  if (!room) { unbindPlayer(player); return; }
  if (player.seat === -1) {                    // 관전자는 좌석 정리 없이 빠진다
    removeSpectator(room, player);
    player.roomCode = null; player.seat = -1;
    unbindPlayer(player);
    broadcast(room);
    return;
  }
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
      gver: room ? (room.gver || 0) : 0,
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
        code: code, version: 0, gver: 0, game: null, hostSeat: 0, joinCounter: 0,
        seats: [player, null, null, null],
        createdAt: now(), lastActivity: now(),
        botTimer: null, botSeat: null, botDeadline: null,
        banned: [], // 강퇴된 세션 토큰 — 재입장 차단
        randomSeats: false, // 팀 무작위 배치 예약 — 시작 시점에 실행(대기실에선 안 섞는다)
        spectators: [] // 관전자(좌석 없음) — 손패는 절대 보내지 않는다
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
      if (a.spectate) {                        // 명시적 관전 입장
        if (a.name) player.name = sanitizeName(a.name);
        if (!addSpectator(r2, player)) return ackOf(a, null, err('ROOM_FULL', '관전 인원이 가득 찼습니다'));
        r2.lastActivity = now();
        broadcast(r2);
        return ackOf(a, r2, null);
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
        if (take2 < 0) {
          // 이어받을 자리가 없으면 관전으로 — 문 앞에서 돌려보내지 않는다
          if (a.name) player.name = sanitizeName(a.name);
          if (!addSpectator(r2, player)) return ackOf(a, null, err('ROOM_FULL', '관전 인원이 가득 찼습니다'));
          r2.lastActivity = now();
          broadcast(r2);
          return ackOf(a, r2, null);
        }
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
      if (free < 0) {
        if (a.name) player.name = sanitizeName(a.name);
        if (!addSpectator(r2, player)) return ackOf(a, null, err('ROOM_FULL', '방과 관전석이 모두 찼습니다'));
        r2.lastActivity = now();
        broadcast(r2);
        return ackOf(a, r2, null);
      }
      if (a.name) player.name = sanitizeName(a.name);
      r2.seats[free] = player;
      player.roomCode = code2;
      player.seat = free;
      player.joinSeq = ++r2.joinCounter;      // 자리 배정 '순서대로'용 참가 순번
      r2.lastActivity = now();
      broadcast(r2);
      return ackOf(a, r2, null);
    }
  }

  if (!room) return ackOf(a, null, err('ROOM_NOT_FOUND', '방에 입장한 상태가 아닙니다'));

  /* 관전자 — 좌석이 없으므로 게임·방 운영 액션은 전부 막는다.
   * 허용: 나가기, 채팅, 빈자리 착석. 나머지는 여기서 끊어 엔진까지 가지 않는다. */
  if (player.seat === -1) {
    if (a.type === 'take_seat') {
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '게임 중에는 앉을 수 없습니다'));
      var ss = a.seat | 0;
      if (ss < 0 || ss > 3 || room.seats[ss]) return ackOf(a, room, err('SEAT_TAKEN', '빈자리가 아닙니다'));
      removeSpectator(room, player);
      room.seats[ss] = player;
      player.seat = ss;
      player.joinSeq = ++room.joinCounter;
      fixHost(room);
      room.lastActivity = now();
      broadcast(room);
      return ackOf(a, room, null);
    }
    if (a.type === 'leave_room') { leaveRoom(player, 'left', true); return ackOf(a, null, null); }
    if (a.type !== 'chat') return ackOf(a, room, err('SPECTATOR', '관전 중에는 할 수 없습니다'));
  }

  var isHost = player.seat === room.hostSeat;

  switch (a.type) {
    case 'set_name':
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '게임 중에는 변경할 수 없습니다'));
      player.name = sanitizeName(a.name);
      broadcast(room);
      return ackOf(a, room, null);

    case 'arrange_seats': {
      // 팀 배정: 'order'(참가 순서) | 'random'(무작위). 마주 보는 자리가 한 팀이므로
      // 좌석 배열만 바꾸면 팀이 정해진다. 대기실에서 방장만.
      if (!isHost) return ackOf(a, room, err('NOT_HOST', '방장만 바꿀 수 있습니다'));
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '게임 중에는 바꿀 수 없습니다'));
      if (room.seats.filter(Boolean).length < 2) return ackOf(a, room, err('BAD_REQUEST', '사람이 부족합니다'));
      /* 무작위는 **게임 시작 때** 실행한다(사용자 지시). 대기실에서 즉시 섞으면
       * 방장이 마음에 드는 배치가 나올 때까지 다시 누를 수 있어 무작위가 아니게 된다.
       * 시작 전까지 결과를 못 보게 예약만 걸어 둔다. */
      if (a.mode === 'random') {
        room.randomSeats = true;
      } else {
        room.randomSeats = false;
        seatArrange(room, 'order');
      }
      room.lastActivity = now();
      broadcast(room);
      return ackOf(a, room, null);
    }

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
      // 게임 중 끊긴 사람을 봇으로 돌리는 것(클라 「봇으로 교체」)은 강퇴가 아니다 — 밴하지 않는다.
      // 밴하면 와이파이가 돌아와도 그 판 내내 못 들어온다(join_room의 KICKED 검사가 복귀 로직보다 앞).
      // 진짜 강퇴(대기실에서 내보내기)는 그대로 밴 유지.
      var isRecovery = !!room.game && !isConn(kp);
      if (!isRecovery) {
        room.banned = room.banned || [];
        if (room.banned.indexOf(kp.token) < 0) room.banned.push(kp.token);
        if (room.banned.length > 16) room.banned.shift();
      }
      leaveRoom(kp, isRecovery ? 'left' : 'kicked', true);
      return ackOf(a, rooms.get(room.code) ? room : null, null);
    }
    case 'start_game': {
      if (!isHost) return ackOf(a, room, err('NOT_HOST', '방장만 시작할 수 있습니다'));
      if (room.game) return ackOf(a, room, err('BAD_PHASE', '이미 시작되었습니다'));
      // 예약된 무작위 배치를 여기서 실행 — 봇으로 채우기 전이라 사람만 섞인다
      if (room.randomSeats) { seatArrange(room, 'random'); room.randomSeats = false; }
      for (var f = 0; f < 4; f++) if (!room.seats[f]) room.seats[f] = makeBot(f, room);
      var ts = (a.targetScore === 300 || a.targetScore === 500 || a.targetScore === 1000) ? a.targetScore : 1000;
      room.targetScore = ts;
      // 온라인 봇: 'super'(내부 키 유지) = 사용자 표기 "1단". 탐색은 950ms 시간컷 —
      // 봇 수마다 이벤트루프가 최대 그만큼 동기 정지한다(방 수 제한 아님, MAX_ROOMS=100).
      // 실사용(점심 소모임)에선 동시 봇게임이 드물어 허용; 트래픽이 늘면 워커 분리가 답.
      // 1단 = v6 신경망(폭2배) + PUCT(c=1.0) 하이브리드. v3-챔피언+ 직접 58.8%로 이겨 승격(고수950 대비 ~60%)
      // 악마(상대 패 열람)는 사람에게 불공정 → 제외
      room.botLevel = ['easy', 'normal', 'hard', 'super', 'super2', 'super3', 'super4'].indexOf(a.botLevel) >= 0 ? a.botLevel : 'normal';
      room.playHist = [];
      room.game = new C.Game({ targetScore: ts });
      room.gver++;
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
      var stamp = now();
      var chatEnv = { type: 'chat', seat: player.seat, name: player.name, text: txt, ts: stamp };
      /* 보낸 사람 본인에게는 mine을 붙여 보낸다. 관전자는 좌석이 전부 −1이라
       * 클라이언트가 좌석으로 "내 말"을 가리면 남의 관전자 말까지 '나'로 표시된다.
       * (좌석 플레이어는 좌석 비교로도 맞으므로 구클라이언트와도 호환된다.) */
      var mineEnv = { type: 'chat', seat: player.seat, name: player.name, text: txt, ts: stamp, mine: true };
      // 좌석 + 관전자 모두에게. 관전자는 좌석이 없어(-1) seats만 돌면 남의 말도,
      // 자기가 보낸 말도 못 받는다 — 채팅이 통째로 죽은 것처럼 보였다.
      room.seats.forEach(function (p) { sendTo(p, p === player ? mineEnv : chatEnv); });
      (room.spectators || []).forEach(function (p) { sendTo(p, p === player ? mineEnv : chatEnv); });
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
  // 판정 기준은 gver(게임상태 버전) — version은 재접속·참석 변화에도 올라 정당한 플레이를
  // 오거부했다(감사 #6). gver 없는 구클라이언트만 version 폴백.
  if (a.type === 'play_cards') {
    var stale = a.gver != null ? a.gver !== (room.gver || 0)
      : (a.version != null && a.version !== room.version);
    if (stale) {
      var cmb = Array.isArray(a.cards) ? C.identify(a.cards) : null;
      if (!cmb || !C.isBomb(cmb.type)) return ackOf(a, room, err('STALE_VERSION', '상태가 갱신되었습니다'));
    }
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
    /* 리롤 — 전원 재딜이라 다른 사람의 진행에 영향을 준다. 엔진이 단계·횟수를 검증하고,
     * 서버는 봇 타이머만 정리한다(재딜 후 라지 단계부터 다시 스케줄된다). */
    /* 패 다시 받기 — 팀 합의제(파트너도 눌러야 실행).
     * 파트너가 봇이면 물어볼 방법이 없으므로 자동 동의시킨다. 봇은 EV상 리롤을 원하지 않지만
     * (2,500딜 측정: 최악 패에서도 겨우 본전), 이건 전략이 아니라 사람의 체감을 푸는 장치라
     * 사람 쪽 판단에 맡기는 것이 맞다. */
    case 'reroll': {
      var mateSeat = (player.seat + 2) % 4;
      var mateP = room.seats[mateSeat];
      if (mateP && mateP.isBot && room.game && room.game.canReroll(mateSeat)) {
        room.game.apply({ type: 'reroll', seat: mateSeat });   // 봇 파트너 자동 동의
      }
      engineAction = { type: 'reroll', seat: player.seat };
      break;
    }
    case 'give_dragon': engineAction = { type: 'give_dragon', seat: player.seat, toSeat: a.toSeat | 0 }; break;
    case 'to_lobby': {
      // 한 판이 끝나면 대기실로 — 자리·팀을 다시 정하고 새로 시작할 수 있게 한다
      var hostP0 = room.seats[room.hostSeat];
      if (!(isHost || !isConn(hostP0))) return ackOf(a, room, err('NOT_HOST', '방장이 진행합니다'));
      if (!room.game || (room.game.phase !== 'gameEnd' && room.game.phase !== 'roundEnd')) {
        return ackOf(a, room, err('BAD_PHASE', '게임이 끝난 뒤에만 돌아갈 수 있습니다'));
      }
      clearBotTimer(room);
      room.game = null;
      room.playHist = [];
      room.lastSummary = null;
      // 봇 좌석은 비운다 — 대기실에서 사람이 앉거나 방장이 다시 추가한다
      for (var bi = 0; bi < 4; bi++) if (room.seats[bi] && room.seats[bi].isBot) room.seats[bi] = null;
      fixHost(room);
      room.gver++;
      room.lastActivity = now();
      broadcast(room);
      return ackOf(a, room, null);
    }

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
  room.gver++;
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
  _seatArrange: seatArrange,   // 테스트 전용 — 좌석 배치 분포 검사(e2e에서 60판 시작은 불가)
  attachWS: attachWS,
  handleHttp: handleHttp,
  findPlayer: findPlayer,
  attachSSE: attachSSE,
  detachSSE: detachSSE,
  attachPoll: attachPoll,
  startGC: startGC,
  stats: stats
};
