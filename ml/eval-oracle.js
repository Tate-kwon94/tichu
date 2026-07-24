#!/usr/bin/env node
/* 오라클 가치망이 정말 플레이아웃보다 나은가 — 승단전 전에 결정적으로 판정.
 *
 * 방법: 실제 대국에서 뽑은 국면마다 플레이아웃 M회로 '참값'(그 세계의 기댓값)을 추정하고,
 *       (a) 가치망 1회 예측  (b) 플레이아웃 1표본  각각의 참값 대비 오차를 잰다.
 * 이게 핵심인 이유: PUCT의 Q는 말단 평가의 평균이므로, 말단 1회의 오차분산이 그대로
 *       "후보를 구분하는 데 몇 표본이 필요한가"로 이어진다.
 *
 * 사용: node ml/eval-oracle.js <oracle.json> [국면수=120] [M=200]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var OR = require(path.join(__dirname, '..', 'shared', 'oracle-value.js'));

var oracle = OR.load(process.argv[2]);
var NPOS = +process.argv[3] || 120;
var M = +process.argv[4] || 200;

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
  var v = (myEven ? d.teamA - d.teamB : d.teamB - d.teamA) / 100;
  return Math.max(-2, Math.min(2, v));
}

// 실제 대국을 돌며 완전정보 국면을 수집 (결정화 세계가 아니라 진짜 국면 — 분포는 같다)
var pos = [];
for (var seed = 1; pos.length < NPOS && seed < 20000; seed++) {
  var g = new C.Game({ seed: seed, targetScore: 500 }), guard = 0;
  while (!g.gameOver && ++guard < 3000 && pos.length < NPOS) {
    if (g.phase === 'roundEnd') { g.apply({ type: 'next_round' }); continue; }
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    var isPlay = (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0);
    var a = B.botDecide(g, s, 'normal'); if (!a || !g.apply(a).ok) break;
    if (isPlay && g.phase === 'play' && Math.random() < 0.04) pos.push({ g: g.clone(), seat: s });
  }
}
console.log('국면 ' + pos.length + '개 · 참값 추정 플레이아웃 ' + M + '회/국면');

var seN = 0, seP = 0, seC = 0, truth = [], nv = 0, t0 = Date.now();
for (var i = 0; i < pos.length; i++) {
  var p = pos[i], sum = 0, first = null;
  for (var k = 0; k < M; k++) {
    var v = playout(p.g.clone(), p.seat);
    if (k === 0) first = v;
    sum += v;
  }
  var mu = sum / M;
  var pred = Math.max(-2, Math.min(2, oracle.value(p.g, p.seat)));
  truth.push(mu); nv++;
  seN += (pred - mu) * (pred - mu);
  seP += (first - mu) * (first - mu);
  seC += mu * mu;                                   // 상수 0 예측기 (기준선)
  if ((i + 1) % 30 === 0) console.log('  ' + (i + 1) + '/' + pos.length + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}
var mseN = seN / nv, mseP = seP / nv, mseC = seC / nv;
var mu0 = truth.reduce(function (a, b) { return a + b; }, 0) / nv;
var varT = truth.reduce(function (a, b) { return a + (b - mu0) * (b - mu0); }, 0) / nv;

console.log('\n[참값(플레이아웃 ' + M + '회 평균) 대비 오차]');
console.log('  가치망 1회        MSE ' + mseN.toFixed(4) + '   RMSE ' + Math.sqrt(mseN).toFixed(3));
console.log('  플레이아웃 1표본  MSE ' + mseP.toFixed(4) + '   RMSE ' + Math.sqrt(mseP).toFixed(3));
console.log('  상수 0 예측       MSE ' + mseC.toFixed(4) + '   (기준선)');
console.log('  국면 간 참값 분산 ' + varT.toFixed(4) + '  ← 말단 평가가 구분해야 할 신호의 크기');
console.log('\n  ▶ 가치망 1회 = 플레이아웃 ' + (mseP / mseN).toFixed(1) + '회분의 정확도');
console.log('  ▶ 신호대잡음: 가치망 ' + (varT / mseN).toFixed(1) + '  vs  플레이아웃 ' + (varT / mseP).toFixed(2));
