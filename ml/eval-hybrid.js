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
var hyTemp = +process.argv[9] || 1;    // 본 하이브리드의 프라이어 온도
globalThis.__TICHU_HARD = { samples: 999999, budgetMs: oppMs };

var hy = HY.create(wPath);
// 선언 신경망(있으면 하이브리드 측 그랜드/티츄 판단에 사용 — 배포 구성과 동일)
var DECL = require(path.join(__dirname, '..', 'shared', 'declare.js'));
var decl = null;
try { decl = DECL.load(path.join(__dirname, '..', 'shared', 'weights-declare.json')); } catch (e) {}
// 상대가 'hy:<weights>[:temp]'(챔피언+) 또는 'pu:<weights>[:c]'(PUCT)이면 봇끼리 대결(승단전)
var oppHy = null, oppHyTemp = 1, oppHyMode = 'plus', oppHyC = 1.0;
if (oppLevel.indexOf('hy:') === 0) {
  var parts = oppLevel.slice(3).split(':');
  oppHy = HY.create(parts[0]);
  if (parts[1]) oppHyTemp = +parts[1] || 1;
  oppLevel = 'hybrid';
} else if (oppLevel.indexOf('pu:') === 0) {
  var pp = oppLevel.slice(3).split(':');
  oppHy = HY.create(pp[0]); oppHyMode = 'puct';
  if (pp[1]) oppHyC = +pp[1] || 1.0;
  oppLevel = 'hybrid';
}

// 2단 후보 프로파일 — 주(main) 봇에만 켜지는 ①②③ 개선 (상대=동결 1단은 미적용).
// 사용: TICHU_CAND=declAdjust,holdValue,oppRead node eval-hybrid.js ...
var CAND = (process.env.TICHU_CAND || '').split(',').filter(Boolean);
function hasCand(f) { return CAND.indexOf(f) >= 0; }
function scoreCtx(g, seat) { return { my: g.scores[seat % 2], opp: g.scores[1 - (seat % 2)], tgt: g.targetScore }; }

function hyDecide(g, seat, hist) {
  var ctx = hasCand('declAdjust') ? scoreCtx(g, seat) : null; // ① 선언 위험조절
  if (decl && g.phase === 'grand' && !g.grandAnswered[seat]) {
    return { type: 'call_grand', seat: seat, call: decl.grand(g.hands[seat], ctx) };
  }
  if (decl && g.phase === 'play' && g.turnSeat === seat && !g.playedFirst[seat] &&
      !g.tichu[seat] && g.finished.indexOf(seat) < 0 && decl.tichu(g.hands[seat], ctx)) {
    return { type: 'call_tichu', seat: seat };
  }
  if (g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    var opts = { budgetMs: hyMs, temp: hyTemp, c: (+process.argv[10] || 1.5),
      holdValue: hasCand('holdValue'), oppRead: hasCand('oppRead') }; // ②③
    if (mode === 'puct') return hy.decidePuct(g, seat, hist, opts);
    if (mode === 'plus') return hy.decidePlus(g, seat, hist, opts);
    return hy.decide(g, seat, hist, opts);
  }
  return B.botDecide(g, seat, 'normal'); // 교환·소원·용 — 휴리스틱 유지
}
function oppHyDecide(g, seat, hist) {
  if (decl && g.phase === 'grand' && !g.grandAnswered[seat]) {
    return { type: 'call_grand', seat: seat, call: decl.grand(g.hands[seat]) };
  }
  if (decl && g.phase === 'play' && g.turnSeat === seat && !g.playedFirst[seat] &&
      !g.tichu[seat] && g.finished.indexOf(seat) < 0 && decl.tichu(g.hands[seat])) {
    return { type: 'call_tichu', seat: seat };
  }
  if (g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    if (oppHyMode === 'puct') return oppHy.decidePuct(g, seat, hist, { budgetMs: oppMs, c: oppHyC });
    return oppHy.decidePlus(g, seat, hist, { budgetMs: oppMs, temp: oppHyTemp });
  }
  return B.botDecide(g, seat, 'normal');
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
    var a = isHy ? hyDecide(g, s, hist)
      : (oppHy ? oppHyDecide(g, s, hist) : B.botDecide(g, s, oppLevel));
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
