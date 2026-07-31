#!/usr/bin/env node
/* 롤아웃 정책(보통봇) 상수 스윕 — 강함을 좌석스왑 짝지음으로 직접 잰다.
 *
 * 왜 이 축인가: 평가기가 병목임이 실측됐다(같은 40세계에서 롤아웃 정책만 바꿔도 최선수가 62% 갈림).
 * 그런데 정책망은 658배 비싸고, 선형 증류본은 보통봇보다 190점 약해 탈락했다.
 * 남은 길은 **보통봇 자체를 강하게 만드는 것**이고, botPlay의 상수 5개는 한 번도 스윕된 적이 없다.
 *
 * 사용: node ml/sweep-rollout.js [라운드=400]
 * 각 후보를 기본값과 좌석스왑 짝지음으로 비교한다(같은 딜, 좌우 교대 → 딜 운 상쇄).
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NROUND = +process.argv[2] || 400;

/* 후보: 기본값 주변으로 한 번에 하나씩만 바꾼다(교란 최소화) */
var CANDS = [
  { yieldRank: 8 }, { yieldRank: 12 },
  { saveRank: 13 }, { saveRank: 15 },
  { savePts: 0 }, { savePts: 10 },
  { saveHand: 5 }, { saveHand: 9 },
  { bombPts: 8 }, { bombPts: 18 },
  { bombHand: 4 }, { bombHand: 8 }
];

function play(seed, side, pp) {
  var g = new C.Game({ seed: seed, targetScore: 500 }), guard = 0;
  while (!g.gameOver && g.phase !== 'roundEnd' && ++guard < 800) {
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    var mine = (side === 0) ? (s % 2 === 0) : (s % 2 === 1);
    globalThis.__TICHU_PP = mine ? pp : null;      // 내 팀 좌석만 후보 상수
    var a = B.botDecide(g, s, 'normal');
    globalThis.__TICHU_PP = null;
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var d = g.roundSummary.deltas;
  return side === 0 ? d.teamA - d.teamB : d.teamB - d.teamA;
}

console.log('롤아웃 정책 상수 스윕 (좌석스왑 짝지음, 목표 ' + NROUND + '라운드/후보)');
console.log('기본값: yieldRank 10 / saveRank 14 / savePts 5 / saveHand 7 / bombPts 13 / bombHand 6\n');
var rows = [];
CANDS.forEach(function (pp) {
  var diffs = [];
  for (var seed = 20001; diffs.length < NROUND && seed < 20001 + NROUND * 3; seed++) {
    for (var side = 0; side < 2; side++) {
      var v = play(seed, side, pp);
      if (v != null) diffs.push(v);
    }
  }
  var n = diffs.length;
  var m = diffs.reduce(function (a, b) { return a + b; }, 0) / n;
  var sd = Math.sqrt(diffs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (n - 1));
  var se = sd / Math.sqrt(n);
  var k = Object.keys(pp)[0];
  rows.push({ k: k + '=' + pp[k], m: m, se: se, sig: (m - 2 * se > 0) ? '유의 양수' : (m + 2 * se < 0 ? '유의 음수' : '') });
});
rows.sort(function (a, b) { return b.m - a.m; });
rows.forEach(function (r) {
  console.log('  ' + r.k.padEnd(16) + (r.m >= 0 ? '+' : '') + r.m.toFixed(2).padStart(7) + ' ± ' + r.se.toFixed(2).padStart(5) + '  ' + r.sig);
});
