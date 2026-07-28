#!/usr/bin/env node
/* 선언 임계값 스윕 — weights-declare.json의 스칼라 두 개(tichuThreshold, grandThreshold).
 *
 * 이 두 값은 한 번도 스윕된 적이 없다(①declAdjust는 점수맥락에 따른 '이동'이었지 기준값이 아님).
 * 실측 근거: 라지 티츄 성공률이 양측 합계 46.7%로 손익분기 50%를 밑돈다 = ±200 내기에서 순손실.
 * 예측기 AUC가 0.623(거의 동전)인데 임계값이 0.52로 공격적이다 — 약한 예측기일수록 보수적이어야 한다.
 *
 * 승단전은 80판에 15분·SE 5.5%p라 2차원 스윕이 불가능하므로, 같은 딜을 짝지어 라운드 점수차를 잰다.
 * 주의: 플레이는 보통봇이라 실제 1단보다 완주 능력이 낮다 → 임계값의 절대 최적점은 다를 수 있다.
 *       방향과 순위를 보고, 최종 확정은 승단전으로 한다.
 *
 * 사용: node ml/eval-declare.js <딜수> [seedBase] [교환=keep|base]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var DECL = require(path.join(__dirname, '..', 'shared', 'declare.js'));

var NDEAL = +process.argv[2] || 4000;
var SEED0 = +process.argv[3] || 970000;
var EXCH = process.argv[4] || 'keep';                 // ⑦ 위에서 재는 것이 맞다(2단 기준선)

var raw = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'shared', 'weights-declare.json'), 'utf8'));
function declWith(t, g) {
  var j = JSON.parse(JSON.stringify(raw));
  j.calib = j.calib || {};
  j.calib.tichuThreshold = t; j.calib.grandThreshold = g;
  return DECL.create(j);
}
var BASE_T = (raw.calib && raw.calib.tichuThreshold != null) ? raw.calib.tichuThreshold : 0.5;
var BASE_G = (raw.calib && raw.calib.grandThreshold != null) ? raw.calib.grandThreshold : 0.52;
var declBase = declWith(BASE_T, BASE_G);

/* 격자는 현행을 가운데 두고 양쪽으로. 처음엔 올리는 쪽만 훑었는데, 실전 로그에서
 * 우리 팀 선언 성공률이 스몰 63.6%·라지 60.9%로 손익분기 50%를 크게 웃도는 것이 확인됐다
 * → 오히려 더 공격적으로 가야 한다. 격자의 끝이 현행이면 방향을 못 찾는다. */
/* 격자는 TICHU_DECL_T/TICHU_DECL_G(콤마 목록)로 지정 가능 — CI 대량 스윕용.
 * 과거 스윕은 4,000딜(SE≈1.5)이라 ±3점 효과가 안 보였다. "현행이 최적"은 그 정밀도의 결론이다. */
var GRID = [];
var TS = (process.env.TICHU_DECL_T || '').split(',').filter(Boolean).map(Number);
var GS = (process.env.TICHU_DECL_G || '').split(',').filter(Boolean).map(Number);
if (!TS.length) TS = [0.34, 0.40, 0.46, BASE_T];
if (!GS.length) GS = [0.34, 0.40, 0.46, BASE_G];
TS.forEach(function (t) {
  GS.forEach(function (g) {
    GRID.push({ t: +t.toFixed(3), g: +g.toFixed(3), k: 't' + t.toFixed(2) + '/g' + g.toFixed(2) });
  });
});
if (!GRID.some(function (x) { return Math.abs(x.t - BASE_T) < 1e-9 && Math.abs(x.g - BASE_G) < 1e-9; })) {
  GRID.push({ t: BASE_T, g: BASE_G, k: 't' + BASE_T.toFixed(2) + '/g' + BASE_G.toFixed(2) });  // 기준선 필수
}
// 중복 제거
var seen = {}; GRID = GRID.filter(function (x) { if (seen[x.k]) return false; seen[x.k] = 1; return true; });
GRID.forEach(function (x) { x.d = declWith(x.t, x.g); });

function playRound(seed, cand) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var guard = 0;
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0], mine = (s % 2 === 0), d = mine ? cand.d : declBase, a = null;
    if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      a = { type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: EXCH === 'keep' }) };
    } else if (g.phase === 'grand' && !g.grandAnswered[s]) {
      a = { type: 'call_grand', seat: s, call: d.grand(g.hands[s]) };
    } else if (g.phase === 'play' && g.turnSeat === s && !g.playedFirst[s] && !g.tichu[s] &&
               g.finished.indexOf(s) < 0 && d.tichu(g.hands[s])) {
      a = { type: 'call_tichu', seat: s };
    } else {
      a = B.botDecide(g, s, 'normal');
    }
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var rs = g.roundSummary, tb = 0, tn = 0, tok = 0, gn = 0, gok = 0;
  (rs.bonuses || []).forEach(function (b) {
    if (b.seat % 2 !== 0) return;                      // 우리 팀 선언만 집계
    tb += b.delta;
    if (b.call === 'grand') { gn++; if (b.made) gok++; } else { tn++; if (b.made) tok++; }
  });
  return { tot: rs.deltas.teamA - rs.deltas.teamB, tb: tb, tn: tn, tok: tok, gn: gn, gok: gok };
}

var acc = GRID.map(function () { return []; });
var t0 = Date.now(), used = 0;
for (var i = 0; i < NDEAL; i++) {
  var row = [], ok = true;
  for (var k = 0; k < GRID.length; k++) {
    var v = playRound(SEED0 + i, GRID[k]);
    if (!v) { ok = false; break; }
    row.push(v);
  }
  if (!ok) continue;
  for (var k2 = 0; k2 < GRID.length; k2++) acc[k2].push(row[k2]);
  used++;
  if (used % 500 === 0) console.log('  ' + used + '/' + NDEAL + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}

function stat(a) {
  var n = a.length, m = a.reduce(function (x, y) { return x + y; }, 0) / n;
  var sd = Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (n - 1));
  return { m: m, se: sd / Math.sqrt(n) };
}
var bi0 = 0;
GRID.forEach(function (x, i) { if (Math.abs(x.t - BASE_T) < 1e-9 && Math.abs(x.g - BASE_G) < 1e-9) bi0 = i; });
var b0 = acc[bi0];
console.log('\n[짝지은 ' + used + '딜 · 교환=' + EXCH + ' · 우리 팀만 임계값 변경]');
console.log('  티츄/라지 임계   vs 현행(점/라운드)     스몰 성공     라지 성공');
var rows = [];
GRID.forEach(function (x, i) {
  var diff = acc[i].map(function (v, j) { return v.tot - b0[j].tot; });
  var ds = stat(diff);
  var tn = 0, tok = 0, gn = 0, gok = 0;
  acc[i].forEach(function (v) { tn += v.tn; tok += v.tok; gn += v.gn; gok += v.gok; });
  rows.push({ k: x.k, m: ds.m, se: ds.se, tn: tn, tok: tok, gn: gn, gok: gok });
});
rows.sort(function (a, b) { return b.m - a.m; });
rows.forEach(function (r) {
  console.log('  ' + r.k.padEnd(16) + (r.m >= 0 ? '+' : '') + r.m.toFixed(2).padStart(7) + ' ± ' + r.se.toFixed(2) +
              '     ' + (r.tn ? (100 * r.tok / r.tn).toFixed(0) + '% (' + r.tn + ')' : '-').padStart(11) +
              '   ' + (r.gn ? (100 * r.gok / r.gn).toFixed(0) + '% (' + r.gn + ')' : '-').padStart(11));
});
console.log('\n  현행 = t' + BASE_T.toFixed(2) + '/g' + BASE_G.toFixed(2) + ' (기준선, 차이 0)');
console.log('  주의: 최댓값 선택은 승자의 저주 — 상위 후보는 반드시 다른 시드로 재확인할 것.');
// 기계 판독 줄 (ml/merge-xd.py 풀링용) — XD <키> <평균차> <SE> <딜수> <비영딜수>
rows.forEach(function (r) {
  if (Math.abs(r.m) < 1e-12 && Math.abs(r.se) < 1e-12) return;   // 기준선 자기 자신
  console.log('XD ' + r.k + ' ' + r.m.toFixed(4) + ' ' + r.se.toFixed(4) + ' ' + used + ' ' + used);
});
