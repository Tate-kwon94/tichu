#!/usr/bin/env node
/* 교환을 "손패마다" 고르면 고정 규칙보다 얼마나 더 벌 수 있는가 — 학습에 투자할 값어치의 상한.
 *
 * 승자의 저주를 반드시 피해야 한다: 후보 9개를 잡음 있는 추정으로 재서 최댓값을 고르면
 * '가장 좋은 것'이 아니라 '가장 운 좋은 것'이 뽑히고, 그 추정치는 체계적으로 부풀려진다.
 * → 고를 때 쓰는 세계(A)와 값을 매길 때 쓰는 세계(B)를 분리한다(홀드아웃).
 *   headroom = 평균_B[ argmax_A 후보의 값 ] − 평균_B[ 고정규칙 후보의 값 ]
 *
 * 사용: node ml/exch-headroom.js <딜수> [worldsA=400] [worldsB=400] [seedBase]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var NDEAL = +process.argv[2] || 60;
var WA = +process.argv[3] || 400;
var WB = +process.argv[4] || 400;
var SEED0 = +process.argv[5] || 950000;

function sp(id) { return C.isSpecial(id); }
function normalsAsc(h, ex) {
  var o = [];
  for (var i = 0; i < h.length; i++) if (!sp(h[i]) && (!ex || ex.indexOf(h[i]) < 0)) o.push(h[i]);
  return o;
}
/* 후보 교환 집합: 파트너에게 줄 카드 3종(최고·2등·3등) × 상대에게 줄 짝 3종.
 * 현행 keep(=최고 + 최저2장)이 항상 0번이라 '고정규칙 대비'를 바로 잴 수 있다. */
function candidates(hand) {
  var h = C.sortHand(hand), n = normalsAsc(h), out = [];
  var pOpts = [n[n.length - 1], n[n.length - 2], n[n.length - 3]].filter(Boolean);
  for (var pi = 0; pi < pOpts.length; pi++) {
    var rest = normalsAsc(h, [pOpts[pi]]);
    var oOpts = [[rest[0], rest[1]], [rest[0], rest[2]], [rest[1], rest[2]]];
    for (var oi = 0; oi < oOpts.length; oi++) {
      if (!oOpts[oi][0] || !oOpts[oi][1]) continue;
      out.push({ p: pOpts[pi], o: oOpts[oi] });
    }
  }
  return out;
}
function giveOf(seat, cand) {
  var g = {};
  g[(seat + 1) % 4] = cand.o[0];
  g[(seat + 3) % 4] = cand.o[1];
  g[C.partnerOf(seat)] = cand.p;
  return g;
}

/* 교환 국면에서 상대 세 자리의 패를 무작위 재분배한 세계를 만든다.
 * (determinize는 play 국면 가정이라 여기선 직접 만든다) */
function worldFrom(g0, seat, rnd) {
  var g = g0.clone();
  var mine = g.hands[seat].slice();
  var pool = C.makeDeck().filter(function (id) { return mine.indexOf(id) < 0; });
  for (var i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1)), t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  var k = 0;
  for (var s = 0; s < 4; s++) {
    if (s === seat) continue;
    g.hands[s] = C.sortHand(pool.slice(k, k + mine.length)); k += mine.length;
  }
  return g;
}
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function rollRound(g, seat, cand) {
  var guard = 0;
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0], a;
    if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      a = (s === seat) ? { type: 'submit_exchange', seat: s, give: giveOf(s, cand) }
                       : { type: 'submit_exchange', seat: s, give: B.botExchange(g, s) };
    } else a = B.botDecide(g, s, 'normal');
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var d = g.roundSummary.deltas;
  return (seat % 2 === 0) ? d.teamA - d.teamB : d.teamB - d.teamA;
}

// 교환 국면의 딜 모으기
var deals = [];
for (var seed = SEED0; deals.length < NDEAL && seed < SEED0 + 20000; seed++) {
  var g = new C.Game({ seed: seed, targetScore: 500 }), guard = 0;
  while (++guard < 200) {
    if (g.phase === 'exchange') break;
    var w = g.waitingOn(); if (!w.length) break;
    var a = B.botDecide(g, w[0], 'normal'); if (!a || !g.apply(a).ok) break;
  }
  if (g.phase === 'exchange') deals.push({ g: g.clone(), seat: 0 });
}
console.log('교환 국면 ' + deals.length + '개 · 선택세계 ' + WA + ' / 평가세계 ' + WB);

var gainOracle = 0, gainBest2 = 0, nOK = 0, t0 = Date.now(), nCand = [];
for (var di = 0; di < deals.length; di++) {
  var d0 = deals[di], cands = candidates(d0.g.hands[d0.seat]);
  if (cands.length < 2) continue;
  nCand.push(cands.length);
  var K = cands.length, mA = new Float64Array(K), mB = new Float64Array(K), okA = new Int32Array(K), okB = new Int32Array(K);
  var rndA = mulberry(12345 + di), rndB = mulberry(987654 + di);
  var wi, ci, v;
  for (wi = 0; wi < WA; wi++) {                       // 선택용 세계 (공통난수)
    var wA = worldFrom(d0.g, d0.seat, rndA);
    for (ci = 0; ci < K; ci++) { v = rollRound(wA.clone(), d0.seat, cands[ci]); if (v != null) { mA[ci] += v; okA[ci]++; } }
  }
  for (wi = 0; wi < WB; wi++) {                       // 평가용 세계 (독립)
    var wB = worldFrom(d0.g, d0.seat, rndB);
    for (ci = 0; ci < K; ci++) { v = rollRound(wB.clone(), d0.seat, cands[ci]); if (v != null) { mB[ci] += v; okB[ci]++; } }
  }
  var pick = 0;
  for (ci = 1; ci < K; ci++) if (okA[ci] && mA[ci] / okA[ci] > mA[pick] / okA[pick]) pick = ci;
  var fixedV = okB[0] ? mB[0] / okB[0] : 0;           // 후보 0 = 현행 keep 규칙
  var pickV = okB[pick] ? mB[pick] / okB[pick] : fixedV;
  // 참고: 평가세계에서의 진짜 최댓값(= 부풀려진 상한, 승자의 저주 포함)
  var bestB = fixedV;
  for (ci = 0; ci < K; ci++) if (okB[ci] && mB[ci] / okB[ci] > bestB) bestB = mB[ci] / okB[ci];
  gainOracle += pickV - fixedV;
  gainBest2 += bestB - fixedV;
  nOK++;
  if (nOK % 10 === 0) console.log('  ' + nOK + '/' + deals.length + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}
console.log('\n[' + nOK + '딜 · 후보 평균 ' + (nCand.reduce(function (a, b) { return a + b; }, 0) / nCand.length).toFixed(1) + '개]');
console.log('  손패별 최적 선택의 실이득  ' + (gainOracle / nOK).toFixed(2) + ' 점/라운드   → ' + (gainOracle / nOK * 0.72).toFixed(1) + '%p');
console.log('    (선택은 A세계, 값은 B세계 — 승자의 저주 제거)');
console.log('  같은 세계에서 최댓값(부풀림) ' + (gainBest2 / nOK).toFixed(2) + ' 점/라운드   ← 이 값과의 차이가 곧 저주의 크기');
console.log('\n  비교: 마작·개 보유 고정 규칙이 이미 +10.37 점/라운드를 벌었다.');
