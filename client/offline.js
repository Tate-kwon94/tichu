/* 혼자 연습 모드 — 로컬 엔진 + 봇 3명, 서버 불필요, localStorage 이어하기 */
/* global TichuCore, TichuBots */
var OfflineSession = (function () {
'use strict';
var SAVE_KEY = 'tichu.solo';
var NAMES = ['나', '레오', '미나', '준'];

function create(handlers, resume, botLevel) {
  var C = TichuCore, B = TichuBots;
  botLevel = botLevel === 'easy' ? 'easy' : 'normal';
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
      if (botLevel !== 'easy' && game.phase === 'play' && game.turnSeat === s && !game.playedFirst[s] &&
          !game.tichu[s] && B.botTichu(game.hands[s])) {
        a = { type: 'call_tichu', seat: s };
      } else {
        a = B.botDecide(game, s, botLevel);
      }
      if (a) {
        var r = game.apply(a);
        if (!r.ok) { stopped = true; return; } // 봇 버그 방어 — 멈추고 사람이 새 게임
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
