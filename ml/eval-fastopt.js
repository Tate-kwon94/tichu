#!/usr/bin/env node
/* 빠른 옵션 짝지음 평가기 — 탐색이 필요 없는 결정(소원·용증정 등)을 같은 딜에서 토글해 비교한다.
 *
 * 왜 별도 도구인가: 이런 결정은 라운드당 1회 수준이라 효과가 작고, 승단전(SE 5.5%p)이나
 * 4,000딜(SE≈1.5)로는 안 보인다. 로드맵에서 "+1.14 해상불가", "판돈 자체 없음(±1.1)"으로
 * 접힌 항목들이 정확히 이 이유였다 — 닫힌 게 아니라 못 잰 것이다.
 * 같은 딜에서 후보팀만 옵션을 켜고 라운드 점수차를 짝지으면 딜 운이 상쇄된다.
 * (교환 축에서 검증된 계측기 구조 — 40만 딜에 SE 0.15)
 *
 * 중요: 후보팀(짝수 좌석)만 옵션을 켜고 상대는 항상 기본값이다.
 *
 * 사용: node ml/eval-fastopt.js <딜수> [seedBase=0] [교환=keep]
 * 환경: TICHU_OPTS=콤마목록 (base,wishCount,dragonFar)
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var NDEAL = +process.argv[2] || 2000;
var SEED0 = +process.argv[3] || 0;
var EXCH = process.argv[4] || 'keep';
var NAMES = (process.env.TICHU_OPTS || 'base,wishCount').split(',').filter(Boolean);

/* 옵션 정의 — 각각 "후보팀 좌석의 결정을 어떻게 바꾸는가" */
var OPTS = {
  base: {},
  // 카운팅 소원: 이미 4장 다 나온 랭크를 소원으로 걸지 않는다(헛소원 방지).
  // bots.js botWish는 game 인자가 있으면 카운팅한다 — 로드맵 "+1.14 해상불가" 항목.
  wishCount: { wishCount: true },
  // 용 증정을 손패 적은 상대에게(기본은 많은 쪽) — 로드맵 "판돈 자체 없음(±1.1)" 재심사
  dragonNear: { dragonNear: true }
};
NAMES.forEach(function (n) { if (!OPTS[n]) { console.error('알 수 없는 옵션: ' + n); process.exit(1); } });

function act(g, seat, opt) {
  if (g.phase === 'exchange' && !g.exchangeGive[seat]) {
    return { type: 'submit_exchange', seat: seat, give: B.botExchange(g, seat, { keepSpecials: EXCH === 'keep' }) };
  }
  var a = B.botDecide(g, seat, 'normal');
  if (!a) return null;
  // 소원: MJ를 내는 수에 붙는다. botDecide가 이미 wish를 붙였으면 카운팅판으로 교체
  if (opt.wishCount && a.type === 'play_cards' && a.cards.indexOf('MJ') >= 0) {
    var rest = g.hands[seat].filter(function (id) { return a.cards.indexOf(id) < 0; });
    var w = B.botWish(rest, g);                    // game 인자 = 카운팅 활성
    if (w) a.wish = w; else delete a.wish;
  }
  if (opt.dragonNear && a.type === 'give_dragon') {
    var p = (seat + 1) % 4, q = (seat + 3) % 4;
    a.toSeat = g.hands[p].length <= g.hands[q].length ? p : q;
  }
  return a;
}

function playRound(seed, optName) {
  var opt = OPTS[optName];
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var guard = 0;
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    var a = act(g, s, (s % 2 === 0) ? opt : OPTS.base);   // 후보팀만 옵션
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var rs = g.roundSummary, d = rs.deltas;
  var tb = 0;
  (rs.bonuses || []).forEach(function (b) { tb += (b.seat % 2 === 0 ? 1 : -1) * b.delta; });
  var ot = rs.oneTwoTeam ? (rs.oneTwoTeam === 'A' ? 200 : -200) : 0;
  return { tot: d.teamA - d.teamB, tichu: tb, oneTwo: ot, card: (d.teamA - d.teamB) - tb - ot };
}

function stat(a) {
  var n = a.length, m = a.reduce(function (x, y) { return x + y; }, 0) / n;
  var sd = Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (n - 1));
  return { m: m, se: sd / Math.sqrt(n) };
}

var acc = {}; NAMES.forEach(function (k) { acc[k] = []; });
var used = 0;
for (var i = 0; i < NDEAL; i++) {
  var seed = SEED0 + i, row = {}, ok = true;
  for (var k = 0; k < NAMES.length; k++) {
    var v = playRound(seed, NAMES[k]);             // 같은 시드 = 같은 딜 → 짝지음
    if (!v) { ok = false; break; }
    row[NAMES[k]] = v;
  }
  if (!ok) continue;
  NAMES.forEach(function (n) { acc[n].push(row[n]); });
  used++;
}

console.log('[짝지은 ' + used + '딜 · 교환=' + EXCH + ' · 후보팀만 옵션]');
var b0 = acc[NAMES[0]];
NAMES.slice(1).forEach(function (n) {
  var diff = acc[n].map(function (x, i2) { return x.tot - b0[i2].tot; });
  var nz = diff.filter(function (d) { return d !== 0; }).length;
  var ds = stat(diff);
  console.log('  ' + n.padEnd(12) + (ds.m >= 0 ? '+' : '') + ds.m.toFixed(3) + ' ± ' + ds.se.toFixed(3) +
    '  (비영딜 ' + nz + '/' + used + ')');
  console.log('XD ' + n + ' ' + ds.m.toFixed(4) + ' ' + ds.se.toFixed(4) + ' ' + used + ' ' + nz);
});
