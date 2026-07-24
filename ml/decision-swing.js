#!/usr/bin/env node
/* 아직 안 재본 결정들의 판돈을 잰다 — 만들기 전에 값어치부터.
 *
 * "최적은 얼마인가"는 롤아웃으로 정해야 하는데, 그러면 오늘 ⑥(티츄)에서 당한 순환논증에 빠진다.
 * 그래서 여기서는 **선택지 간 값의 폭(swing)** 만 잰다: 같은 딜에서 그 결정만 바꿔 라운드 점수차를 비교.
 *   폭이 작으면 → 아무리 잘 골라도 얻을 게 없다(측정 끝, 투자 안 함).
 *   폭이 크면   → 현행 휴리스틱이 그 폭의 어디쯤인지가 곧 헤드룸.
 * 이 논리는 정답을 몰라도 성립하므로 순환하지 않는다.
 *
 * 사용: node ml/decision-swing.js <딜수> [seedBase]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var NDEAL = +process.argv[2] || 1500;
var SEED0 = +process.argv[3] || 960000;

/* 개입: 라운드를 돌리면서 특정 결정만 지정된 방식으로 바꾼다. 대상은 팀A(짝수 좌석). */
var MODES = [
  'base',        // 전부 현행 휴리스틱 (⑦ keep 교환 적용 — 이미 확정분)
  'dragon_L',    // 용 트릭을 항상 왼쪽 상대에게
  'dragon_R',    // 항상 오른쪽 상대에게
  'wish_none',   // 마작 소원을 아예 안 건다
  'wish_low',    // 소원을 낮은 랭크로 (현행은 내게 없는 높은 랭크)
  'grand_never', // 라지 티츄 절대 안 함
  'tichu_never', // 스몰 티츄 절대 안 함
];

function playRound(seed, mode) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var guard = 0, mine = function (s) { return s % 2 === 0; };
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0], a = null;

    if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      // ⑦은 양팀 모두 적용 — 이미 확정된 개선이므로 그 위에서 다음 판돈을 잰다
      a = { type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: true }) };
    } else if (g.phase === 'dragon' && mine(s) && (mode === 'dragon_L' || mode === 'dragon_R')) {
      a = { type: 'give_dragon', seat: s, toSeat: mode === 'dragon_L' ? (s + 1) % 4 : (s + 3) % 4 };
    } else if (g.phase === 'grand' && !g.grandAnswered[s] && mine(s) && mode === 'grand_never') {
      a = { type: 'call_grand', seat: s, call: false };
    } else {
      a = B.botDecide(g, s, 'normal');
      if (a && mine(s)) {
        if (mode === 'tichu_never' && a.type === 'call_tichu') a = B.botDecide(g, s, 'easy');
        else if (a.type === 'play_cards' && a.wish) {
          if (mode === 'wish_none') delete a.wish;
          else if (mode === 'wish_low') a.wish = 2;
        }
      }
      // 소원/티츄를 막았는데 easy가 또 티츄를 부르면 방어
      if (mode === 'tichu_never' && a && a.type === 'call_tichu') a = null;
      if (!a) {                                     // 티츄 대신 그냥 플레이하도록 재요청
        var g2 = g.clone(); g2.tichu[s] = -1;       // 임시 표식 없이도 botDecide는 티츄를 다시 부를 수 있어
        a = B.botDecide(g, s, 'easy');
        if (a && a.type === 'call_tichu') return null;
      }
    }
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var d = g.roundSummary.deltas;
  return d.teamA - d.teamB;
}

var acc = {}; MODES.forEach(function (m) { acc[m] = []; });
var t0 = Date.now(), used = 0, skipped = 0;
for (var i = 0; i < NDEAL; i++) {
  var seed = SEED0 + i, row = {}, ok = true;
  for (var k = 0; k < MODES.length; k++) {
    var v = playRound(seed, MODES[k]);
    if (v == null) { ok = false; break; }
    row[MODES[k]] = v;
  }
  if (!ok) { skipped++; continue; }
  MODES.forEach(function (m) { acc[m].push(row[m]); });
  used++;
  if (used % 300 === 0) console.log('  ' + used + '/' + NDEAL + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}

function stat(a) {
  var n = a.length, m = a.reduce(function (x, y) { return x + y; }, 0) / n;
  var sd = Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (n - 1));
  return { m: m, se: sd / Math.sqrt(n) };
}
console.log('\n[짝지은 ' + used + '딜 (건너뜀 ' + skipped + ') · 팀A만 개입 · ⑦교환은 양팀 적용]');
console.log('  개입            vs 현행 차이 (점/라운드)     화폐환산');
var b = acc.base;
MODES.slice(1).forEach(function (m) {
  var diff = acc[m].map(function (x, i) { return x - b[i]; });
  var ds = stat(diff);
  console.log('  ' + m.padEnd(14) + (ds.m >= 0 ? '+' : '') + ds.m.toFixed(2).padStart(7) + ' ± ' + ds.se.toFixed(2) +
              '            ' + (ds.m * 0.72 >= 0 ? '+' : '') + (ds.m * 0.72).toFixed(1) + '%p');
});
console.log('\n  해석: 차이가 크게 음수면 현행이 그 결정을 이미 잘 하고 있다는 뜻(= 헤드룸 작음).');
console.log('        0에 가까우면 그 결정이 아예 중요하지 않거나, 현행이 무작위와 다름없다는 뜻.');
