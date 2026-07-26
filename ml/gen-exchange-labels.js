#!/usr/bin/env node
/* 학습 교환 라벨 생성 — 손패마다 후보 9종의 EV를 오라클(세계 샘플 평균)로 채점해 JSONL로 남긴다.
 *
 * exch-headroom.js와 같은 채점 코어이되 두 가지가 다르다:
 *   ① 상대·파트너 봇도 keepSpecials 교환(2단 생태계) — 배포 환경과 맞춘다.
 *      (exch-headroom은 상대가 1단식 교환이라 세계 분포가 배포와 어긋났다)
 *   ② 홀드아웃(A/B 분리)을 하지 않는다 — 그건 '이득 추정'의 승자의 저주 제거용이고,
 *      라벨은 그냥 가장 정확한 argmax가 필요하므로 전 세계를 합쳐 쓴다.
 *      이득 검증은 학습 후 eval-exchange 짝지음(독립 시드)이 담당한다.
 *
 * 출력(JSONL): {"h":[14장 id],"k":최선후보,"n":후보수,"ev":[후보별 EV],"g":EV[k]-EV[0]}
 *   후보 0 = 현행 keep 규칙(파트너 최고 + 상대 최저 2장)이라 g가 곧 개선 여지다.
 *
 * 사용: node ml/gen-exchange-labels.js <딜수> <seedBase> [worlds=600] > out.jsonl
 * 샤딩: seedBase를 바꿔 병렬 실행, cat으로 합침.
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var NDEAL = +process.argv[2] || 100;
var SEED0 = +process.argv[3] || 970000;
var NW = +process.argv[4] || 600;

function sp(id) { return C.isSpecial(id); }
function normalsAsc(h, ex) {
  var o = [];
  for (var i = 0; i < h.length; i++) if (!sp(h[i]) && (!ex || ex.indexOf(h[i]) < 0)) o.push(h[i]);
  return o;
}
/* exch-headroom.js와 동일한 후보 9종: 파트너에 최고/2등/3등 × 상대에 남은 최저 짝 3종.
 * 특수카드는 후보에서 배제 = 전 후보가 keepSpecials 준수. 0번 = 현행 keep. */
function candidates(hand) {
  var h = C.sortHand(hand), n = normalsAsc(h), out = [], seen = {};
  // 랭크 3장+ 보유 카드 집합 — 트리플 보존 후보용(사용자 피드백: 낮은 트리플은 폭탄 잠재라 안 나눔)
  var cnt = {};
  n.forEach(function (id) { cnt[C.rankOf(id)] = (cnt[C.rankOf(id)] || 0) + 1; });
  var nonTriple = n.filter(function (id) { return cnt[C.rankOf(id)] < 3; });
  var pOpts = [n[n.length - 1], n[n.length - 2], n[n.length - 3]].filter(Boolean);
  function push(p, o) {
    if (!p || !o[0] || !o[1] || o[0] === o[1] || o[0] === p || o[1] === p) return;
    var key = p + '|' + o[0] + '|' + o[1];
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ p: p, o: o });
  }
  for (var pi = 0; pi < pOpts.length; pi++) {
    var rest = normalsAsc(h, [pOpts[pi]]);
    var oOpts = [[rest[0], rest[1]], [rest[0], rest[2]], [rest[1], rest[2]]];
    for (var oi = 0; oi < oOpts.length; oi++) push(pOpts[pi], oOpts[oi]);
    // 트리플 보존 변형: 트리플 구성원을 건너뛴 최저 2장
    var restNT = nonTriple.filter(function (id) { return id !== pOpts[pi]; });
    push(pOpts[pi], [restNT[0], restNT[1]]);
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
                       : { type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: true }) };
    } else a = B.botDecide(g, s, 'normal');
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var d = g.roundSummary.deltas;
  return (seat % 2 === 0) ? d.teamA - d.teamB : d.teamB - d.teamA;
}

var made = 0, t0 = Date.now();
for (var seed = SEED0; made < NDEAL && seed < SEED0 + NDEAL * 4; seed++) {
  var g0 = new C.Game({ seed: seed, targetScore: 500 }), guard = 0;
  while (++guard < 200) {
    if (g0.phase === 'exchange') break;
    var w0 = g0.waitingOn(); if (!w0.length) break;
    var a0 = B.botDecide(g0, w0[0], 'normal'); if (!a0 || !g0.apply(a0).ok) break;
  }
  if (g0.phase !== 'exchange') continue;

  var seat = 0;
  var cands = candidates(g0.hands[seat]);
  if (cands.length < 2) continue;
  var K = cands.length, sum = new Float64Array(K), ok = new Int32Array(K);
  var rnd = mulberry(1234567 + seed);
  for (var wi = 0; wi < NW; wi++) {
    var wld = worldFrom(g0, seat, rnd);                // 공통난수 — 후보 간 비교에서 세계 차이 제거
    for (var ci = 0; ci < K; ci++) {
      var v = rollRound(wld.clone(), seat, cands[ci]);
      if (v != null) { sum[ci] += v; ok[ci]++; }
    }
  }
  var ev = [], best = 0;
  for (var ci2 = 0; ci2 < K; ci2++) {
    ev.push(ok[ci2] ? +(sum[ci2] / ok[ci2]).toFixed(3) : -9999);
    if (ev[ci2] > ev[best]) best = ci2;
  }
  console.log(JSON.stringify({ h: C.sortHand(g0.hands[seat]), k: best, n: K, ev: ev, g: +(ev[best] - ev[0]).toFixed(3) }));
  made++;
  if (made % 50 === 0) console.error('  ' + made + '/' + NDEAL + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}
console.error('라벨 ' + made + '개 완료 (' + Math.round((Date.now() - t0) / 1000) + 's)');
