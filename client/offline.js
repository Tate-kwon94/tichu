/* 혼자 연습 모드 — 로컬 엔진 + 봇 3명, 서버 불필요, localStorage 이어하기 */
/* global TichuCore, TichuBots, TichuEndgame */
var OfflineSession = (function () {
'use strict';
var SAVE_KEY = 'tichu.solo';
var NAMES = ['나', '레오', '미나', '준'];

function create(handlers, resume, botLevel, superHy, declNet, exchNet, exchNet4) {
  var C = TichuCore, B = TichuBots;
  // 새 단을 추가할 때 이 두 줄을 같이 고치지 않으면 조용히 하위 단으로 강등된다(3단 배포 때 겪음)
  botLevel = ['easy', 'normal', 'hard', 'super', 'super2', 'super3', 'super4'].indexOf(botLevel) >= 0 ? botLevel : 'normal';
  if (['super', 'super2', 'super3', 'super4'].indexOf(botLevel) >= 0 && !superHy) botLevel = 'hard'; // 가중치 미로드 시 안전 폴백
  var hist = []; // 라운드 내 플레이 이력 — 초고수 신경망 입력
  var tmBank = { ms: 0 };  // 시간배분 은행 — 라운드마다 리셋(이월하면 예산 총량 전제가 깨진다)
  function trackHist(a) {
    if (a.type === 'next_round' || a.type === 'restart') { hist = []; tmBank.ms = 0; return; }
    if (a.type === 'pass_turn') hist.push({ s: a.seat, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = game.lastAction;
      if (la && la.combo) hist.push({ s: a.seat, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: a.seat, t: 'dog', r: 0, l: 1 });
    }
    if (game.phase === 'roundEnd' || game.phase === 'gameEnd') hist = [];
    else if (hist.length > 24) hist.splice(0, hist.length - 24);
  }
  var game = null;
  if (resume) {
    try {
      var saved = localStorage.getItem(SAVE_KEY);
      if (saved) game = C.Game.fromJSON(JSON.parse(saved));
    } catch (e) { game = null; }
  }
  if (!game) game = new C.Game({ targetScore: 500 }); // 솔로 연습은 짧게
  var timer = null;
  var stopped = false;

  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(game.toJSON())); } catch (e) { /* 저장 실패 무시 */ }
  }
  function snapshot() {
    return {
      mode: 'offline',
      code: null,
      phase: game.phase,
      hostSeat: 0,
      youSeat: 0,
      roomSeats: NAMES.map(function (n, i) {
        return { seat: i, name: n, isBot: i !== 0, connected: true, occupied: true };
      }),
      game: game.viewFor(0),
      botTimer: null
    };
  }
  function emit() { handlers.onState(snapshot()); }

  // 봇 차례 자동 진행
  function pump() {
    clearTimeout(timer);
    if (stopped) return;
    var w = game.waitingOn().filter(function (s) { return s !== 0; });
    if (!w.length) return;
    var delay = game.phase === 'play' ? 650 : 360;
    timer = setTimeout(function () {
      if (stopped) return;
      var s = w[0];
      var a = null;
      // 1단(super)·2단(super2) 동결. 2단 = 1단 그대로 + 교환에서 마작·개 보유(⑦).
      var isDan4 = botLevel === 'super4';
      var isSuper = botLevel === 'super' || botLevel === 'super2' ||
                    botLevel === 'super3' || isDan4;
      var isDan3 = botLevel === 'super3';
      /* 탐색량 = 단을 가르는 축(서버 rooms.js와 같은 규칙).
       * ①예산: 4단만 2배(1800ms) — 기기 속도와 무관하게 최소 2배 보장
       * ②상한: 1~3단은 종전 2000에 묶어 동결 */
      var DAN_REPCAP = isDan4 ? 1e9 : 2000;
      /* 4단 = 3단 정책 + 예산 3800ms(승단전 2,880게임 +4.97±1.12 통과).
       * tm은 강도 기여 0이지만 체감을 4.5초→2.0초로 되사준다. */
      var DAN_BUDGET = isDan4 ? 3800 : 900;
      var DAN_TM = isDan4 ? { bank: tmBank, checkAt: 0.35, stopShare: 0.90,
                              stopMargin: 0.55, maxExtra: 0, hardCap: 5000 } : null;
      var mateDecl = game.tichu[(s + 2) % 4] > 0;   // 파트너 선언 시 봇은 안 부른다 (사용자 보고)
      var wantTichu = game.phase === 'play' && game.turnSeat === s && !game.playedFirst[s] && !game.tichu[s] &&
        !mateDecl &&
        (isSuper && declNet ? declNet.tichu(game.hands[s])
          : (botLevel !== 'easy' && !isSuper && B.botTichu(game.hands[s])));
      if (wantTichu) {
        a = { type: 'call_tichu', seat: s };
      } else if (isSuper && declNet && game.phase === 'grand' && !game.grandAnswered[s]) {
        a = { type: 'call_grand', seat: s, call: !mateDecl && declNet.grand(game.hands[s]) }; // 선언 신경망(동결) + 파트너 선언 게이트
      } else if (botLevel === 'super2' && game.phase === 'exchange' && !game.exchangeGive[s]) {
        a = { type: 'submit_exchange', seat: s, give: B.botExchange(game, s, { keepSpecials: true }) }; // ⑦ 2단 전용
      } else if (isDan4 && game.phase === 'exchange' && !game.exchangeGive[s]) {
        // 4단 교환: MLP(40만 딜에서 3단 선형 대비 +1.03±0.15).
        // 폴백 순서: MLP → 3단 선형 → 2단 규칙. app.js가 4단일 때 선형도 함께 받으므로
        // "직전에 3단을 했는지"에 따라 강도가 달라지지 않는다.
        var lg4 = exchNet4 ? exchNet4.give(game, s) : null;
        if (!lg4 && exchNet) lg4 = exchNet.give(game, s);
        a = { type: 'submit_exchange', seat: s, give: lg4 || B.botExchange(game, s, { keepSpecials: true }) };
      } else if (isDan3 && game.phase === 'exchange' && !game.exchangeGive[s]) {
        // 3단 교환: 손패별 학습 교환(선형, 게이트 +2.18±0.75) — 미로드·후보부족 시 2단 규칙
        var lg3 = exchNet ? exchNet.give(game, s) : null;
        a = { type: 'submit_exchange', seat: s, give: lg3 || B.botExchange(game, s, { keepSpecials: true }) };
      } else if ((isDan3 || isDan4) && game.phase === 'play' && game.turnSeat === s && game.finished.indexOf(s) < 0) {
        // 3·4단 플레이: 같은 swa 가중치 PUCT. 차이는 탐색 상한뿐 — 4단만 예산을 다 쓴다.
        a = superHy.decidePuct(game, s, hist, { budgetMs: DAN_BUDGET, c: 1.0, repCap: DAN_REPCAP, tm: DAN_TM });
        // 파트너 티츄 가드 — 서버(rooms.js)와 같은 처리. 혼자 연습에서도 봇 파트너가 티츄를 죽이면 안 된다
        a = B.guardPartnerTichu(game, s, a);
        a = B.guardDragonSingle(game, s, a);   // 용·봉황 낭비 절제 (rooms.js와 동일)
        a = B.guardPhoenixSingle(game, s, a);
      } else if (isSuper && game.phase === 'play' && game.turnSeat === s && game.finished.indexOf(s) < 0) {
        a = superHy.decidePuct(game, s, hist, { budgetMs: DAN_BUDGET, c: 1.0, repCap: DAN_REPCAP, tm: DAN_TM });
      } else {
        a = B.botDecide(game, s, isSuper ? 'normal' : botLevel);
      }
      if (a) {
        var r = game.apply(a);
        if (!r.ok) { stopped = true; return; } // 봇 버그 방어 — 멈추고 사람이 새 게임
        trackHist(a);
        persist();
        emit();
      }
      pump();
    }, delay);
  }

  function send(action) {
    var a = {};
    for (var k in action) a[k] = action[k];
    if (a.type !== 'next_round' && a.type !== 'restart') a.seat = 0;
    /* 혼자 연습은 파트너(좌석 2)가 항상 봇이다 — 팀 합의제 리롤이 성립하도록 자동 동의시킨다.
     * (서버 rooms.js와 같은 규칙: 봇에게 물어볼 방법이 없으니 사람 판단에 맡긴다) */
    if (a.type === 'reroll' && game.canReroll(2)) game.apply({ type: 'reroll', seat: 2 });
    if (a.type === 'restart_game') a.type = 'restart';
    var r = game.apply(a);
    if (handlers.onAck) handlers.onAck({ type: 'action_ack', actionId: a.actionId || '', ok: r.ok, error: r.error || null });
    if (r.ok) {
      trackHist(a);
      persist();
      emit();
      pump();
    }
  }

  function destroy() {
    stopped = true;
    clearTimeout(timer);
  }

  // 시작
  setTimeout(function () { emit(); pump(); }, 0);

  return { send: send, destroy: destroy, mode: 'offline' };
}

function hasSave() {
  try {
    var saved = localStorage.getItem(SAVE_KEY);
    if (!saved) return false;
    var j = JSON.parse(saved);
    return j && !j.gameOver;
  } catch (e) { return false; }
}
function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 무시 */ }
}

return { create: create, hasSave: hasSave, clearSave: clearSave };
})();
