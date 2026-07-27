#!/usr/bin/env node
/* 발굴 스윕 — 3단 자가대전에서 "배포봇(PUCT 950ms)의 수"와 "심층 오라클의 수"가
 * 갈리는 결정을 유형별로 채굴한다. 목적: 교환처럼 규칙층으로 캘 수 있는
 * 미발굴 손실 주머니의 지도(빈도 × EV 격차).
 *
 * 오라클 = 후보 전수 × W세계 CRN 플레이아웃 평균 (시간예산 없는 평가 —
 * 950ms가 못 사는 표본을 산다. 참고: 과거 "4배 예산" 실험은 repCap 버그로
 * 실제 1.6배였음 — 진짜 대량평가 vs 배포예산 비교는 이번이 처음이다).
 *
 * 사용: node ml/mine-decisions.js <games> <seedBase> [puctMs=950] [worlds=250]
 * 출력: 결정당 JSONL {agree, gap, cls:{lead,hand,combo,tichu,wish,bomb}}
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));
var INF = require(path.join(__dirname, 'exchange-infer.js'));

var NGAMES = +process.argv[2] || 20;
var SEED0 = +process.argv[3] || 0;
var PUCTMS = +process.argv[4] || 950;
var W = +process.argv[5] || 250;

var hy = HY.create(path.join(__dirname, '..', 'shared', 'weights-super3.json'));
var exch = INF.load(path.join(__dirname, '..', 'shared', 'weights-exchange3.json'));
var DECL = require(path.join(__dirname, '..', 'shared', 'declare.js'));
var decl = DECL.load(path.join(__dirname, '..', 'shared', 'weights-declare.json'));

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function actKey(a) {
  if (!a || a.type === 'pass_turn') return 'pass';
  return a.cards.slice().sort().join(',');
}

/* 심층 오라클: 후보 전수 × W세계(CRN — 모든 후보가 같은 세계에서 평가) */
function oracleEval(g, seat, rngSeed) {
  var gm = C.genMoves(g.hands[seat], g.currentCombo, g.wish);
  var acts = gm.moves.map(function (m) {
    var a = { type: 'play_cards', seat: seat, cards: m.cards };
    if (m.cards.indexOf('MJ') >= 0) { var wsh = B.botWish(g.hands[seat].filter(function (id) { return m.cards.indexOf(id) < 0; })); if (wsh) a.wish = wsh; }
    return a;
  });
  if (g.currentCombo && !gm.forced) acts.push({ type: 'pass_turn', seat: seat });
  if (acts.length < 2) return null;
  var team = seat % 2;
  var sums = acts.map(function () { return 0; }), oks = acts.map(function () { return 0; });
  for (var w = 0; w < W; w++) {
    globalThis.__TICHU_RNG = mulberry(rngSeed + w * 7919);
    var det = B.determinize(g, seat);                 // 후보 간 같은 세계(같은 시드)
    for (var ci = 0; ci < acts.length; ci++) {
      var sim = det.clone();
      if (!sim.apply(acts[ci]).ok) continue;
      var guard = 0;
      while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd' && ++guard < 2000) {
        var ww = sim.waitingOn(); if (!ww.length) break;
        var aa = B.botDecide(sim, ww[0], 'normal'); if (!aa || !sim.apply(aa).ok) break;
      }
      if (sim.roundSummary) {
        var d = sim.roundSummary.deltas;
        sums[ci] += (team === 0 ? d.teamA - d.teamB : d.teamB - d.teamA);
        oks[ci]++;
      }
    }
  }
  delete globalThis.__TICHU_RNG;
  var best = -1, bestV = -Infinity, evs = [];
  for (var i = 0; i < acts.length; i++) {
    var v = oks[i] ? sums[i] / oks[i] : -Infinity;
    evs.push(v);
    if (v > bestV) { bestV = v; best = i; }
  }
  return { acts: acts, evs: evs, best: best };
}

/* 홀드아웃 격차: 특정 두 액션(오라클 선택 vs PUCT 선택)을 신선한 B세계에서 재평가.
 * 선택에 쓴 세계로 격차를 재면 승자의 저주(+~5점)가 섞인다 — B세계 격차가 무편향. */
function holdoutGap(g, seat, aOracle, aPuct, rngSeed) {
  var team = seat % 2, sO = 0, sP = 0, ok = 0;
  for (var w = 0; w < W; w++) {
    globalThis.__TICHU_RNG = mulberry(rngSeed + 500000 + w * 104729);
    var det = B.determinize(g, seat);
    var vv = [];
    [aOracle, aPuct].forEach(function (act) {
      var sim = det.clone();
      if (!sim.apply(act).ok) { vv.push(null); return; }
      var guard = 0;
      while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd' && ++guard < 2000) {
        var ww = sim.waitingOn(); if (!ww.length) break;
        var aa = B.botDecide(sim, ww[0], 'normal'); if (!aa || !sim.apply(aa).ok) break;
      }
      if (!sim.roundSummary) { vv.push(null); return; }
      var d = sim.roundSummary.deltas;
      vv.push(team === 0 ? d.teamA - d.teamB : d.teamB - d.teamA);
    });
    if (vv[0] != null && vv[1] != null) { sO += vv[0]; sP += vv[1]; ok++; }
  }
  delete globalThis.__TICHU_RNG;
  return ok ? +((sO - sP) / ok).toFixed(2) : null;
}

function classify(g, seat, chosen) {
  var n = g.hands[seat].length;
  var opp1 = (seat + 1) % 4, opp2 = (seat + 3) % 4, pt = (seat + 2) % 4;
  return {
    lead: !g.currentCombo ? 1 : 0,
    hand: n <= 4 ? 'end' : n <= 9 ? 'mid' : 'early',
    req: g.currentCombo ? g.currentCombo.type : '-',
    pick: chosen === 'pass' ? 'pass' : 'play',
    tMe: (g.tichu[seat] > 0 && g.finished.indexOf(seat) < 0) ? 1 : 0,
    tPt: (g.tichu[pt] > 0 && g.firstOutSeat === null) ? 1 : 0,
    tOp: ((g.tichu[opp1] > 0 && g.finished.indexOf(opp1) < 0) || (g.tichu[opp2] > 0 && g.finished.indexOf(opp2) < 0)) ? 1 : 0,
    wish: g.wish ? 1 : 0,
    bomb: B.hasBomb(g.hands[seat]) ? 1 : 0
  };
}

var t0 = Date.now(), nDec = 0, nDis = 0;
for (var gi = 0; gi < NGAMES; gi++) {
  var seed = SEED0 + gi;
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], guard = 0;
  while (++guard < 20000) {
    if (g.phase === 'roundEnd' || g.phase === 'gameEnd') break;
    var w0 = g.waitingOn(); if (!w0.length) break;
    var s = w0[0], a = null;
    if (decl && g.phase === 'grand' && !g.grandAnswered[s]) {
      a = { type: 'call_grand', seat: s, call: decl.grand(g.hands[s]) };
    } else if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      a = { type: 'submit_exchange', seat: s, give: exch.give(g, s) || B.botExchange(g, s, { keepSpecials: true }) };
    } else if (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
      if (decl && !g.playedFirst[s] && !g.tichu[s] && decl.tichu(g.hands[s])) {
        a = { type: 'call_tichu', seat: s };
      } else {
        globalThis.__TICHU_RNG = mulberry(seed * 1000 + g.hands[s].length * 7 + s);
        a = hy.decidePuct(g, s, hist, { budgetMs: PUCTMS, c: 1.0 });
        delete globalThis.__TICHU_RNG;
        // 좌석 0의 결정만 채굴 (비용 통제)
        if (s === 0 && a && g.hands[0].length > 1) {
          var oc = oracleEval(g, 0, seed * 100000 + nDec * 131);
          if (oc) {
            nDec++;
            var pk = actKey(a);
            var ok2 = actKey(oc.acts[oc.best]);
            var pIdx = -1;
            for (var ai = 0; ai < oc.acts.length; ai++) if (actKey(oc.acts[ai]) === pk) { pIdx = ai; break; }
            var agree = pk === ok2;
            if (!agree) nDis++;
            // 격차는 홀드아웃(신선 B세계)으로 — 선택 잡음 제거된 무편향 추정
            var gap = 0;
            if (!agree && pIdx >= 0) gap = holdoutGap(g, 0, oc.acts[oc.best], oc.acts[pIdx], seed * 100000 + nDec * 131);
            console.log(JSON.stringify({ agree: agree ? 1 : 0, gap: gap, cls: classify(g, 0, pk) }));
          }
        }
      }
    } else {
      a = B.botDecide(g, s, 'normal');
    }
    if (!a || !g.apply(a).ok) break;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
  }
  if ((gi + 1) % 5 === 0) console.error('  ' + (gi + 1) + '/' + NGAMES + ' 결정 ' + nDec + ' 불일치 ' + nDis + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}
console.error('완료: 결정 ' + nDec + ' · 불일치 ' + nDis + ' (' + (nDec ? Math.round(100 * nDis / nDec) : 0) + '%)');
