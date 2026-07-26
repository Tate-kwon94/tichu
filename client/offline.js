/* 혼자 연습 모드 — 로컬 엔진 + 봇 3명, 서버 불필요, localStorage 이어하기 */
/* global TichuCore, TichuBots, TichuEndgame */
var OfflineSession = (function () {
'use strict';
var SAVE_KEY = 'tichu.solo';
var NAMES = ['나', '레오', '미나', '준'];

function create(handlers, resume, botLevel, superHy, declNet) {
  var C = TichuCore, B = TichuBots;
  botLevel = ['easy', 'normal', 'hard', 'devil', 'super', 'super2', 'super3'].indexOf(botLevel) >= 0 ? botLevel : 'normal';
  if ((botLevel === 'super' || botLevel === 'super2' || botLevel === 'super3') && !superHy) botLevel = 'hard'; // 가중치 미로드 시 안전 폴백
  var hist = []; // 라운드 내 플레이 이력 — 초고수 신경망 입력
  function trackHist(a) {
    if (a.type === 'next_round' || a.type === 'restart') { hist = []; return; }
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
      var isSuper = botLevel === 'super' || botLevel === 'super2' || botLevel === 'super3';
      var isDan3 = botLevel === 'super3';
      var wantTichu = game.phase === 'play' && game.turnSeat === s && !game.playedFirst[s] && !game.tichu[s] &&
        (isSuper && declNet ? declNet.tichu(game.hands[s])
          : (botLevel !== 'easy' && !isSuper && B.botTichu(game.hands[s])));
      if (wantTichu) {
        a = { type: 'call_tichu', seat: s };
      } else if (isSuper && declNet && game.phase === 'grand' && !game.grandAnswered[s]) {
        a = { type: 'call_grand', seat: s, call: declNet.grand(game.hands[s]) }; // 선언 신경망(동결)
      } else if (botLevel === 'super2' && game.phase === 'exchange' && !game.exchangeGive[s]) {
        a = { type: 'submit_exchange', seat: s, give: B.botExchange(game, s, { keepSpecials: true }) }; // ⑦ 2단 전용
      } else if (isDan3 && game.phase === 'exchange' && !game.exchangeGive[s]) {
        // 3단 교환: ⑦ + 트리플 보존(게이트 +1.25±0.31)
        a = { type: 'submit_exchange', seat: s, give: B.botExchange(game, s, { keepSpecials: true, keepTriples: true }) };
      } else if (isDan3 && game.phase === 'play' && game.turnSeat === s && game.finished.indexOf(s) < 0) {
        // 3단: 종반 완전탐색 → PUCT → 파트너 티츄 가드 (승단전 통과 조합 그대로)
        a = null;
        if (typeof TichuEndgame !== 'undefined' && TichuEndgame.maxHand(game) <= 4) {
          a = TichuEndgame.endgameMove(game, s, { K: 12, nodeCap: 6000 });
        }
        if (!a) a = superHy.decidePuct(game, s, hist, { budgetMs: 900, c: 1.0 });
        a = B.guardPartnerTichu(game, s, a);
      } else if (isSuper && game.phase === 'play' && game.turnSeat === s && game.finished.indexOf(s) < 0) {
        a = superHy.decidePuct(game, s, hist, { budgetMs: 900, c: 1.0 });
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
