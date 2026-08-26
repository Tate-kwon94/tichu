#!/usr/bin/env node
/* 믿음 결정화 평가 — 학습된 사후분포로 결정화했을 때 배치 정확도(실효 PIN)를 잰다.
 *
 * 판정 기준(사전 등록): PIN 곡선상
 *   실효 PIN 0.25 ≈ +2.4점 / 0.5 ≈ +5.6점(승단 기준 초과)
 * 균일 결정화의 실측 기준선은 정확도 41.3%(실효 0.119).
 * 학습 모델이 실효 0.2를 넘기면 본격 투자(큰 모델·실물 승단전) 가치가 있다.
 *
 * 방식: 새 시드 자가대전에서 표본 국면을 뽑아
 *   ① 균일 determinize ② 사후분포 결정화(용량 제약 순차 가중 샘플링)
 * 를 각 N회 돌려 "상대 카드가 진짜 좌석에 놓인 비율"을 비교한다.
 *
 * 사용: node ml/belief-eval.js <weights.json> [게임수=60] [표본율=0.05] [시드=120000]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var W = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).w;
var NGAME = +process.argv[3] || 60;
var RATE = +process.argv[4] || 0.05;
var SEED0 = +process.argv[5] || 120000;
var REP = 8;

function rankOfSafe(id) { return C.isSpecial(id) ? (id === 'DR' ? 15 : id === 'PH' ? 14.5 : id === 'MJ' ? 1 : 0) : C.rankOf(id); }
function feat(g, v, s, c, st) {
  var r = rankOfSafe(c);
  var hi = r >= 11 ? 1 : 0, lo = (r > 0 && r <= 7) ? 1 : 0;
  var decl = (g.tichu[s] > 0 && g.finished.indexOf(s) < 0) ? 1 : 0;
  var gave = (g.exchangeGive[v] && g.exchangeGive[v][s] === c) ? 1 : 0;
  var passedBelow = (st.passLow[s] != null && !C.isSpecial(c) && r > st.passLow[s]) ? 1 : 0;
  var wishNo = (st.wishNo[s] && !C.isSpecial(c) && st.wishNo[s][r]) ? 1 : 0;
  var mean = st.playSum[s] ? st.playSum[s] / st.playCnt[s] / 14 : 0.5;
  return [g.hands[s].length / 14, gave, decl * hi, decl * lo,
    decl * (c === 'DR' ? 1 : 0), decl * (c === 'PH' ? 1 : 0),
    passedBelow, wishNo, mean * hi, mean * lo, (g.playedFirst[s] ? 0 : 1) * hi];
}
function dot(w, f) { var t = 0; for (var i = 0; i < w.length; i++) t += w[i] * f[i]; return t; }

/* 사후분포 결정화 — 카드를 무작위 순서로, P(seat)×잔여용량 가중 배정 */
function beliefDeterminize(g, v, st) {
  var opp = [0, 1, 2, 3].filter(function (t) { return t !== v; });
  var cards = [];
  opp.forEach(function (os) { g.hands[os].forEach(function (c) { cards.push(c); }); });
  var cap = {}; opp.forEach(function (os) { cap[os] = g.hands[os].length; });
  var assign = {};
  // 확률 계산은 카드별 1회
  var probs = {};
  cards.forEach(function (c) {
    var z = opp.map(function (s2) { return dot(W, feat(g, v, s2, c, st)); });
    var m = Math.max.apply(null, z);
    var e = z.map(function (x) { return Math.exp(x - m); });
    var sum = e[0] + e[1] + e[2];
    probs[c] = [e[0] / sum, e[1] / sum, e[2] / sum];
  });
  // 무작위 순서 배정
  var order = cards.slice();
  for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t2 = order[i]; order[i] = order[j]; order[j] = t2; }
  order.forEach(function (c) {
    var p = probs[c].map(function (x, k) { return x * (cap[opp[k]] > 0 ? 1 : 0); });
    var s3 = p[0] + p[1] + p[2];
    var pick;
    if (s3 <= 0) { pick = opp.filter(function (o2) { return cap[o2] > 0; })[0]; }
    else {
      var u = Math.random() * s3;
      pick = u < p[0] ? opp[0] : u < p[0] + p[1] ? opp[1] : opp[2];
    }
    assign[c] = pick; cap[pick]--;
  });
  return assign;
}

var accU = 0, cntU = 0, accB = 0, cntB = 0, positions = 0;
for (var gi = 0; gi < NGAME; gi++) {
  var g = new C.Game({ seed: SEED0 + gi, targetScore: 1000 });
  var st = { passLow: {}, wishNo: {}, playSum: [0, 0, 0, 0], playCnt: [0, 0, 0, 0] };
  var lastSingle = null, passRun = 0, guard = 0;
  while (!g.gameOver && g.phase !== 'roundEnd' && ++guard < 700) {
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    if (g.phase === 'play' && g.turnSeat === s && Math.random() < RATE) {
      positions++;
      var v = s, opp = [0, 1, 2, 3].filter(function (t) { return t !== v; });
      var truth = {};
      opp.forEach(function (os) { g.hands[os].forEach(function (c) { truth[c] = os; }); });
      for (var rep = 0; rep < REP; rep++) {
        // ① 균일
        globalThis.__TICHU_RNG = Math.random;
        var d = B.determinize(g, v);
        opp.forEach(function (os) {
          d.hands[os].forEach(function (c) { cntU++; if (truth[c] === os) accU++; });
        });
        // ② 사후분포
        var asg = beliefDeterminize(g, v, st);
        Object.keys(asg).forEach(function (c) { cntB++; if (truth[c] === asg[c]) accB++; });
      }
    }
    var a = B.botDecide(g, s, 'normal');
    if (!a || !g.apply(a).ok) break;
    var la = g.lastAction;
    if (a.type === 'pass_turn') {
      if (lastSingle && lastSingle.r >= 2 && lastSingle.r <= 14) {
        if (st.passLow[s] == null || lastSingle.r < st.passLow[s]) st.passLow[s] = lastSingle.r;
      }
      if (++passRun >= 3) { lastSingle = null; passRun = 0; }
    } else if (a.type === 'play_cards' && la) {
      passRun = 0;
      if (la.combo) {
        lastSingle = la.combo.type === 'single' ? { r: la.combo.rank } : null;
        (a.cards || []).forEach(function (id) { if (!C.isSpecial(id)) { st.playSum[s] += C.rankOf(id); st.playCnt[s]++; } });
      } else lastSingle = null;
    }
    if (g.wish && la && la.combo && g.trick && g.trick.length === 1) (st.wishNo[s] = st.wishNo[s] || {})[g.wish] = 1;
    if (g.phase === 'roundEnd' && !g.gameOver) {
      g.apply({ type: 'next_round' });
      st = { passLow: {}, wishNo: {}, playSum: [0, 0, 0, 0], playCnt: [0, 0, 0, 0] };
      lastSingle = null; passRun = 0;
    }
  }
}
function effPin(a) { return (a - 1 / 3) / (2 / 3); }
var aU = accU / cntU, aB = accB / cntB;
console.log('국면 %d · 결정화 %d회씩', positions, REP);
console.log('균일 결정화     정확도 %s%%  실효PIN %s', (100 * aU).toFixed(2), effPin(aU).toFixed(3));
console.log('사후분포 결정화 정확도 %s%%  실효PIN %s', (100 * aB).toFixed(2), effPin(aB).toFixed(3));
console.log('개선: %s%%p (실효PIN %s)', (100 * (aB - aU)).toFixed(2), (effPin(aB) - effPin(aU)).toFixed(3));
console.log('\n판정: ' + (effPin(aB) >= 0.2 ? '실효 0.2 이상 — 본격 투자 가치 있음'
  : effPin(aB) - effPin(aU) > 0.03 ? '개선은 실재하나 0.2 미달 — 큰 모델/특징 추가 검토'
  : '학습 신호 미약 — 이 특징으로는 닫힘'));
