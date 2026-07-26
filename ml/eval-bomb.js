#!/usr/bin/env node
/* 차례 밖 폭탄의 판돈 측정 — 봇은 지금 이 행동을 한 번도 하지 않는다.
 *
 * 발견: 400라운드에 차례 밖 폭탄 기회가 986회 있는데 봇은 0회 던진다.
 * waitingOn()이 차례 좌석만 반환해서 봇은 "폭탄 던질래?"라는 질문 자체를 받지 않는다.
 * 사람은 이 행동을 한다(클라 「폭탄 끼어들기 가능!」, 서버도 폭탄은 버전 게이트 통과).
 *
 * 2단을 만든 교환 개선과 같은 모양(탐색 밖 + 봇이 안 하던 결정)이라 유망하지만,
 * 먼저 판돈을 잰다. 같은 딜을 짝지어 후보팀(좌석 0·2)에만 규칙을 주고 점수차를 본다.
 *
 * 사용: node ml/eval-bomb.js <딜수> [seedBase] [전략,전략,...]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var NDEAL = +process.argv[2] || 3000;
var SEED0 = +process.argv[3] || 0;

function bombMoves(g, s) {
  if (!g.currentCombo) return [];
  var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
  return gm.moves.filter(function (m) { return C.isBomb(m.combo.type); });
}

/* 전략: (game, seat) → 던질 폭탄 카드 배열 또는 null.
 * 전부 "상대가 이기고 있을 때만" 판단한다(파트너 트릭을 뺏으면 손해). */
var STRATS = {
  never: function () { return null; },                       // 현행

  // 판돈이 큰 트릭만 (푼돈에 폭탄 쓰면 손해 — wasteCost와 같은 원리)
  pts15: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;          // 파트너 트릭은 안 뺏음
    return C.sumPoints(g.trickPile) >= 15 ? mv[0].cards : null;
  },
  pts25: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    return C.sumPoints(g.trickPile) >= 25 ? mv[0].cards : null;
  },

  // 티츄 저지 — 선언한 상대가 이 트릭을 먹고 완주하려는 순간
  stopTichu: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    if (g.tichu[lead] > 0 && g.finished.indexOf(lead) < 0 && g.hands[lead].length <= 3) return mv[0].cards;
    return null;
  },

  // 완주 저지 — 상대가 이 트릭을 이기면 곧 나갈 상황
  stopOut: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    return g.hands[lead].length <= 2 ? mv[0].cards : null;
  },

  // 상한 측정: 상대가 이기고 있으면 무조건(점수 무관) — 가장 공격적
  always: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    return mv[0].cards;
  },
  pts5: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    return C.sumPoints(g.trickPile) >= 5 ? mv[0].cards : null;
  },
  pts10: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    return C.sumPoints(g.trickPile) >= 10 ? mv[0].cards : null;
  },
  // 사용자 전술(2026-07-26 인터뷰): 티츄 선언자가 '고급 카드'(용·봉황 포함, 또는 A 이상)를
  // 냈을 때 폭탄으로 선을 탈취 — 점수가 아니라 완주 빌드업을 끊는 것.
  userTichu: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    if (!(g.tichu[lead] > 0 && g.finished.indexOf(lead) < 0)) return null;   // 선언자만
    var cc = g.currentCombo; if (!cc) return null;
    var hi = cc.cards && cc.cards.some(function (id) { return id === 'DR' || id === 'PH'; });
    if (!hi && cc.rank >= 13) hi = true;                                     // K 이상도 고급으로
    return hi ? mv[0].cards : null;
  },
  // 위 + 선언자 아니어도 상대가 용/봉황으로 선을 굳히려 할 때
  userWide: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    var cc = g.currentCombo; if (!cc || !cc.cards) return null;
    var prem = cc.cards.some(function (id) { return id === 'DR' || id === 'PH'; });
    var declared = g.tichu[lead] > 0 && g.finished.indexOf(lead) < 0;
    if (declared && (prem || cc.rank >= 13)) return mv[0].cards;
    if (prem && g.hands[lead].length <= 6) return mv[0].cards;               // 비선언이라도 종반 용/봉황
    return null;
  },
  // 합본: 티츄 저지 + 완주 저지 + 큰 트릭
  combo: function (g, s) {
    var mv = bombMoves(g, s); if (!mv.length) return null;
    var lead = g.lastPlayerSeat;
    if (lead < 0 || lead % 2 === s % 2) return null;
    var pts = C.sumPoints(g.trickPile);
    var tichuThreat = g.tichu[lead] > 0 && g.finished.indexOf(lead) < 0 && g.hands[lead].length <= 4;
    var outThreat = g.hands[lead].length <= 2;
    return (pts >= 20 || tichuThreat || outThreat) ? mv[0].cards : null;
  }
};
var NAMES = process.argv[4] ? process.argv[4].split(',') : ['never', 'pts15', 'pts25', 'stopTichu', 'stopOut', 'combo'];

/* 한 라운드. 후보팀(짝수 좌석)만 strat, 상대는 never. 양팀 2단 교환. */
function playRound(seed, stratName) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var guard = 0, fired = 0;
  var strat = STRATS[stratName];
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;

    // 차례 밖 폭탄 기회 검사 — 후보팀 좌석만
    if (g.phase === 'play' && g.currentCombo) {
      for (var s = 0; s < 4; s++) {
        if (s % 2 !== 0) continue;                            // 후보팀만
        if (s === g.turnSeat || g.finished.indexOf(s) >= 0) continue;
        var cards = strat(g, s);
        if (cards) {
          var r = g.apply({ type: 'play_cards', seat: s, cards: cards });
          if (r.ok) { fired++; break; }                       // 성공하면 상태가 바뀌었으니 루프 재시작
        }
      }
    }
    if (g.phase === 'roundEnd') break;

    var w = g.waitingOn(); if (!w.length) break;
    var s2 = w[0], a;
    if (g.phase === 'exchange' && !g.exchangeGive[s2]) {
      a = { type: 'submit_exchange', seat: s2, give: B.botExchange(g, s2, { keepSpecials: true }) };
    } else {
      a = B.botDecide(g, s2, 'normal');
    }
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var d = g.roundSummary.deltas;
  return { pts: d.teamA - d.teamB, fired: fired };
}

var acc = {}; NAMES.forEach(function (n) { acc[n] = []; });
var fires = {}; NAMES.forEach(function (n) { fires[n] = 0; });
var t0 = Date.now(), used = 0;
for (var i = 0; i < NDEAL; i++) {
  var row = {}, ok = true;
  for (var k = 0; k < NAMES.length; k++) {
    var v = playRound(SEED0 + i, NAMES[k]);
    if (!v) { ok = false; break; }
    row[NAMES[k]] = v;
  }
  if (!ok) continue;
  NAMES.forEach(function (n) { acc[n].push(row[n].pts); fires[n] += row[n].fired; });
  used++;
  if (used % 500 === 0) console.log('  ' + used + '/' + NDEAL + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}

function stat(a) {
  var n = a.length, m = a.reduce(function (x, y) { return x + y; }, 0) / n;
  var sd = Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (n - 1));
  return { m: m, se: sd / Math.sqrt(n) };
}
console.log('\n[짝지은 ' + used + '딜 · 후보팀만 차례 밖 폭탄]');
console.log('  전략        vs 현행(점/라운드)     라운드당 발동');
var base = acc[NAMES[0]];
NAMES.forEach(function (n) {
  var diff = acc[n].map(function (x, i2) { return x - base[i2]; });
  var ds = stat(diff);
  console.log('  ' + n.padEnd(11) + (ds.m >= 0 ? '+' : '') + ds.m.toFixed(2).padStart(7) + ' ± ' + ds.se.toFixed(2) +
              '        ' + (fires[n] / used).toFixed(2) +
              '   (' + ((ds.m * 0.72 >= 0 ? '+' : '') + (ds.m * 0.72).toFixed(1)) + '%p)');
});
