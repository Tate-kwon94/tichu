#!/usr/bin/env node
/* RL 트립와이어 — 학습정책 vs 동결정책, 둘 다 raw 그리디 카드놓기(탐색 없음), 짝지은 라운드 점수차.
 *
 * 배포 봇은 PUCT지만 최종수≈프라이어 argmax(84%)라 raw 그리디 개선이 배포 강도에 ~1:1 전이.
 * raw는 PUCT보다 200배 빨라 매 세대 트립와이어로 적합(정밀 확인은 가끔 PUCT로).
 * 학습팀(0,2)=main, 상대(1,3)=frozen. 양팀 2단 환경(교환 keepSpecials, 선언 신경망). 딜당 짝지음.
 *
 * 사용: node ml/eval-raw.js <main.json> <frozen.json> <deals> [seedBase] [declare.json]
 * 출력: PAIR <점/라운드 평균> <SE>
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));

var mainNet = NET.load(process.argv[2]);
var frozNet = NET.load(process.argv[3]);
var NDEAL = +process.argv[4] || 2000;
var SEED0 = +process.argv[5] || 500000;
var declPath = process.argv[6];
var decl = null;
if (declPath) { try { decl = require(path.join(__dirname, '..', 'shared', 'declare.js')).load(declPath); } catch (e) {} }

function greedy(net, g, s, hist) {
  var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
  if (!gm.moves.length) return { type: 'pass_turn', seat: s };
  var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
  if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
  var pick = cands[cands.length === 1 ? 0 : net.pickRecord(net.makeRecord(g, s, cands, hist))];
  if (pick.t === 'pass') return { type: 'pass_turn', seat: s };
  var a = { type: 'play_cards', seat: s, cards: pick.c };
  if (pick.c.indexOf('MJ') >= 0) { var w = B.botWish(g.hands[s].filter(function (id) { return pick.c.indexOf(id) < 0; })); if (w) a.wish = w; }
  return a;
}

// mainIsA: true면 좌석0,2=main. 같은 딜을 양쪽으로 돌려 좌석효과도 상쇄.
function playRound(seed, mainIsA) {
  var g = new C.Game({ seed: seed, targetScore: 500 }), hist = [], guard = 0;
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0], a = null;
    var isMain = (s % 2 === 0) === mainIsA;
    if (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
      a = greedy(isMain ? mainNet : frozNet, g, s, hist);
    } else if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      a = { type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: true }) };
    } else if (decl && g.phase === 'grand' && !g.grandAnswered[s]) {
      a = { type: 'call_grand', seat: s, call: decl.grand(g.hands[s]) };
    } else if (decl && g.phase === 'play' && g.turnSeat === s && !g.playedFirst[s] &&
               !g.tichu[s] && g.finished.indexOf(s) < 0 && decl.tichu(g.hands[s])) {
      a = { type: 'call_tichu', seat: s };
    } else { a = B.botDecide(g, s, 'normal'); }
    if (!a || !g.apply(a).ok) return null;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
  }
  if (!g.roundSummary) return null;
  var d = g.roundSummary.deltas;
  return mainIsA ? (d.teamA - d.teamB) : (d.teamB - d.teamA);   // main 관점 점수차
}

var diffs = [], t0 = Date.now();
for (var i = 0; i < NDEAL; i++) {
  var v1 = playRound(SEED0 + i, true), v2 = playRound(SEED0 + i, false);
  if (v1 == null || v2 == null) continue;
  diffs.push((v1 + v2) / 2);                                    // 같은 딜 양측 평균 = 딜·좌석 운 상쇄
}
var n = diffs.length, m = diffs.reduce(function (a, b) { return a + b; }, 0) / n;
var sd = Math.sqrt(diffs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (n - 1));
console.log('PAIR ' + m.toFixed(3) + ' ' + (sd / Math.sqrt(n)).toFixed(3) + ' n=' + n +
            ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
