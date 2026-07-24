#!/usr/bin/env node
/* 3단 RL 착수 전 결정적 게이트 — 카드놓기 정책에 헤드룸이 있는가. 학습 0.
 *
 * 논리: RL은 정책망을 개선한다. 배포 봇은 정책망이 84% 지배(최종수≈프라이어 argmax).
 * 따라서 "정책 argmax가 진짜 최선수보다 얼마나 나쁜가"가 RL이 딸 수 있는 상한이다.
 * 진짜 최선수 = 후보마다 깊은 결정화 플레이아웃(CRN)으로 평가한 argmax.
 *   swing = value(playout-best) − value(policy-argmax), 점/라운드.
 * swing이 작으면(≈3.6%p 미만) 정책이 이미 최적 → 정보포화(투시 47.5%)·탐색포화(4배 50%)와
 * 합쳐 카드놓기 천장 확정 → RL 착수 STOP.
 *
 * 승자의 저주 제거: '최선수'는 선택세계(A)로 고르고 값은 독립세계(B)로 잰다.
 * 정책 argmax는 정책이 정하므로 무편향(B로만 값 측정).
 *
 * 사용: node ml/gate-headroom.js <국면수> [worldsA=150] [worldsB=150] [seedBase]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));
var net = NET.load(path.join(__dirname, 'data', 'v6-weights.json'));

var NPOS = +process.argv[2] || 200;
var WA = +process.argv[3] || 150;
var WB = +process.argv[4] || 150;
var SEED0 = +process.argv[5] || 660000;

function candsOf(g, seat) {
  var gm = C.genMoves(g.hands[seat], g.currentCombo, g.wish);
  var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
  if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
  return cands;
}
function applyCand(g, seat, cand) {
  var a;
  if (cand.t === 'pass') a = { type: 'pass_turn', seat: seat };
  else {
    a = { type: 'play_cards', seat: seat, cards: cand.c };
    if (cand.c.indexOf('MJ') >= 0) {
      var wsh = B.botWish(g.hands[seat].filter(function (id) { return cand.c.indexOf(id) < 0; }));
      if (wsh) a.wish = wsh;
    }
  }
  return g.apply(a).ok;
}
function playout(sim, seat) {
  var myEven = seat % 2 === 0, guard = 0;
  while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd') {
    var w = sim.waitingOn(); if (!w.length) break;
    var a = B.botDecide(sim, w[0], 'normal'); if (!a) break;
    if (!sim.apply(a).ok) break;
    if (++guard > 2000) break;
  }
  if (!sim.roundSummary) return 0;
  var d = sim.roundSummary.deltas;
  return myEven ? d.teamA - d.teamB : d.teamB - d.teamA;   // 원점수(점/라운드) — 클립 안 함
}

// 정책 결정 국면 수집(후보 3+개인 곳만 — 헤드룸이 있으려면 선택지가 있어야)
var pos = [];
for (var seed = SEED0; pos.length < NPOS && seed < SEED0 + 60000; seed++) {
  var g = new C.Game({ seed: seed, targetScore: 500 }), hist = [], guard = 0;
  while (!g.gameOver && ++guard < 3000 && pos.length < NPOS) {
    if (g.phase === 'roundEnd') { hist = []; g.apply({ type: 'next_round' }); continue; }
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    if (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0 && candsOf(g, s).length >= 3 && Math.random() < 0.06) {
      pos.push({ g: g.clone(), seat: s, hist: hist.slice() });
    }
    var a = B.botDecide(g, s, 'normal'); if (!a || !g.apply(a).ok) break;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else { var la = g.lastAction; if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length }); }
  }
}
console.log('국면 ' + pos.length + '개 · 선택세계 ' + WA + ' / 평가세계 ' + WB);

var swingSum = 0, swingBest = 0, nOK = 0, t0 = Date.now(), swings = [];
for (var pi = 0; pi < pos.length; pi++) {
  var p = pos[pi], cands = candsOf(p.g, p.seat), K = cands.length;
  // 정책 argmax
  var probs = net.probsRecord(net.makeRecord(p.g, p.seat, cands, p.hist));
  var pidx = 0; for (var q = 1; q < K; q++) if (probs[q] > probs[pidx]) pidx = q;
  // 후보별 값: 선택세계 A(최선 고르기), 평가세계 B(무편향 값). 세계는 CRN(모든 후보 공유).
  var mA = new Float64Array(K), mB = new Float64Array(K), okA = new Int32Array(K), okB = new Int32Array(K);
  var wi, ci, v;
  for (wi = 0; wi < WA; wi++) {
    var dA = B.determinize(p.g, p.seat);
    for (ci = 0; ci < K; ci++) { var s1 = dA.clone(); if (!applyCand(s1, p.seat, cands[ci])) continue; mA[ci] += playout(s1, p.seat); okA[ci]++; }
  }
  for (wi = 0; wi < WB; wi++) {
    var dB = B.determinize(p.g, p.seat);
    for (ci = 0; ci < K; ci++) { var s2 = dB.clone(); if (!applyCand(s2, p.seat, cands[ci])) continue; mB[ci] += playout(s2, p.seat); okB[ci]++; }
  }
  var bestA = 0; for (ci = 1; ci < K; ci++) if (okA[ci] && mA[ci] / okA[ci] > (okA[bestA] ? mA[bestA] / okA[bestA] : -1e9)) bestA = ci;
  var vBest = okB[bestA] ? mB[bestA] / okB[bestA] : 0;
  var vPol = okB[pidx] ? mB[pidx] / okB[pidx] : 0;
  // 평가세계에서의 진짜 최댓값(부풀림 상한 — 승자의 저주 포함)
  var vBestB = -1e9; for (ci = 0; ci < K; ci++) if (okB[ci] && mB[ci] / okB[ci] > vBestB) vBestB = mB[ci] / okB[ci];
  var sw = vBest - vPol;
  swings.push(sw); swingSum += sw; swingBest += (vBestB - vPol); nOK++;
  if (nOK % 20 === 0) console.log('  ' + nOK + '/' + pos.length + ' (' + Math.round((Date.now() - t0) / 1000) + 's)  누적 swing ' + (swingSum / nOK).toFixed(2));
}
swings.sort(function (a, b) { return a - b; });
var mean = swingSum / nOK;
console.log('\n[' + nOK + '국면 · 카드놓기 헤드룸]');
console.log('  정책 argmax → 최선수 swing 평균  ' + mean.toFixed(2) + ' 점/라운드   → ' + (mean * 0.72).toFixed(1) + '%p');
console.log('  중앙값 ' + swings[nOK >> 1].toFixed(2) + '  (양수 국면 ' + (100 * swings.filter(function (x) { return x > 0.5; }).length / nOK).toFixed(0) + '%)');
console.log('  같은세계 최댓값(부풀림 상한) ' + (swingBest / nOK).toFixed(2) + ' 점/라운드');
console.log('\n  판정: RL이 딸 수 있는 카드놓기 상한 ≈ ' + (mean * 0.72).toFixed(1) + '%p (라운드당). 게임 승률로는 이보다 작음.');
console.log('  65%(=+15%p)에 필요한 폭 대비 ' + (mean * 0.72 >= 5 ? '충분 가능성 — GO' : '미달 — 카드놓기 천장 확정, STOP 권고'));
