#!/usr/bin/env node
/* 파일럿 신경망 실전 평가 — 신경망 봇 vs 기존 봇 (좌석 스왑, 시드 고정)
 * 사용: node ml/eval-net.js <weights.json> <상대: normal|hard> <seedStart> <seedEnd> [hardBudgetMs=80]
 * 신경망은 플레이 결정만 담당, 선언·교환·소원·용은 고수와 같은 휴리스틱 사용.
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, 'net-infer.js'));

var wPath = process.argv[2];
var oppLevel = process.argv[3] || 'normal';
var seedStart = +process.argv[4] || 1;
var seedEnd = +process.argv[5] || 20;
var hardBudget = +process.argv[6] || 80;
globalThis.__TICHU_HARD = { samples: 999999, budgetMs: hardBudget };

var net = NET.load(wPath);
// 상대가 'net:<weights.json>'이면 신경망끼리 직접 대결 (CPU 경합과 무관한 공정 비교)
var oppNet = null;
if (oppLevel.indexOf('net:') === 0) { oppNet = NET.load(oppLevel.slice(4)); oppLevel = 'net'; }

function netDecide(g, seat, hist, which) {
  var N = which === 'opp' ? oppNet : net;
  if (g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    var gm = C.genMoves(g.hands[seat], g.currentCombo, g.wish);
    if (!gm.moves.length) return { type: 'pass_turn', seat: seat };
    var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
    if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
    var idx = cands.length === 1 ? 0 : N.pickRecord(N.makeRecord(g, seat, cands, hist));
    var pick = cands[idx];
    if (pick.t === 'pass') return { type: 'pass_turn', seat: seat };
    var a = { type: 'play_cards', seat: seat, cards: pick.c };
    if (pick.c.indexOf('MJ') >= 0) {
      var wsh = B.botWish(g.hands[seat].filter(function (id) { return pick.c.indexOf(id) < 0; }));
      if (wsh) a.wish = wsh;
    }
    return a;
  }
  return B.botDecide(g, seat, 'normal'); // 선언·교환·소원·용 — 고수와 동일한 휴리스틱
}

function playGame(seed, netTeamA) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') { hist = []; g.apply({ type: 'next_round' }); continue; }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var isNet = (s % 2 === 0) === netTeamA;
    var a = isNet ? netDecide(g, s, hist)
      : (oppNet ? netDecide(g, s, hist, 'opp') : B.botDecide(g, s, oppLevel));
    if (!a) throw new Error('no action');
    var r = g.apply(a);
    if (!r.ok) throw new Error('rejected ' + a.type + ' ' + r.error.code);
    // 이력 축적 — gen-teacher.js와 동일 규칙
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
    if (++guard > 30000) throw new Error('guard');
  }
  return g.winnerTeam === (netTeamA ? 'A' : 'B');
}

var wins = 0, games = 0, t0 = Date.now();
for (var seed = seedStart; seed <= seedEnd; seed++) {
  [true, false].forEach(function (side) {
    try {
      games++;
      if (playGame(seed, side)) wins++;
    } catch (e) {
      games--;
      console.error('seed', seed, 'FAIL', e.message);
    }
  });
}
console.log('RESULT vs ' + oppLevel + (oppLevel === 'hard' ? '(' + hardBudget + 'ms)' : '') +
  ': games=' + games + ' netWins=' + wins + ' rate=' + (100 * wins / games).toFixed(1) +
  '% elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
