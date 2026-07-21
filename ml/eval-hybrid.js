#!/usr/bin/env node
/* 하이브리드 봇 실전 평가 — hybrid(신경망+탐색) vs 기존 봇
 * 사용: node ml/eval-hybrid.js <weights.json> <상대: normal|hard> <seedStart> <seedEnd> [hybridMs=950] [oppHardMs=950]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, 'hybrid-bot.js'));

var wPath = process.argv[2];
var oppLevel = process.argv[3] || 'hard';
var seedStart = +process.argv[4] || 1;
var seedEnd = +process.argv[5] || 10;
var hyMs = +process.argv[6] || 950;
var oppMs = +process.argv[7] || 950;
var mode = process.argv[8] || 'value'; // value=가치롤아웃 | plus=챔피언+(휴리스틱 플레이아웃+프라이어+가지치기)
globalThis.__TICHU_HARD = { samples: 999999, budgetMs: oppMs };

var hy = HY.create(wPath);

function hyDecide(g, seat, hist) {
  if (g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    if (mode === 'plus') return hy.decidePlus(g, seat, hist, { budgetMs: hyMs });
    return hy.decide(g, seat, hist, { budgetMs: hyMs });
  }
  return B.botDecide(g, seat, 'normal'); // 선언·교환·소원·용 — 고수와 동일 휴리스틱
}

function playGame(seed, hyTeamA) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') { hist = []; g.apply({ type: 'next_round' }); continue; }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var isHy = (s % 2 === 0) === hyTeamA;
    var a = isHy ? hyDecide(g, s, hist) : B.botDecide(g, s, oppLevel);
    if (!a) throw new Error('no action');
    var r = g.apply(a);
    if (!r.ok) throw new Error('rejected ' + a.type + ' ' + r.error.code);
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
    if (++guard > 30000) throw new Error('guard');
  }
  return g.winnerTeam === (hyTeamA ? 'A' : 'B');
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
console.log('RESULT hybrid(' + hyMs + 'ms) vs ' + oppLevel + (oppLevel === 'hard' ? '(' + oppMs + 'ms)' : '') +
  ': games=' + games + ' hyWins=' + wins + ' rate=' + (100 * wins / games).toFixed(1) +
  '% elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
