#!/usr/bin/env node
/* 롤아웃 정책 자격 게이트 — **강함을 먼저 잰다.**
 *
 * 왜: 2026-07-31에 경량 증류 정책을 "재현율 59%"와 "보통봇과 50% 불일치"만 보고
 * 롤아웃에 넣었다가 실물 −73.74(승률 11%)로 붕괴했다. 진단해 보니 그 정책은
 * 플레이어로서 보통봇보다 라운드당 192점 약했다.
 *   - 재현율은 강함이 아니다(41%를 틀리며 플레이가 무너질 수 있다)
 *   - 기준선과 다르다는 건 목표와 같다는 뜻이 아니다(무작위도 50% 불일치한다)
 * 롤아웃 정책의 자격 조건은 하나뿐이다: **보통봇보다 강하고 비용이 비슷할 것.**
 *
 * 이 게이트를 통과하기 전에는 어떤 정책도 롤아웃에 넣지 않는다.
 *
 * 사용: node ml/gate-rollout.js <정책모듈경로> <가중치경로> [라운드=600]
 *   정책모듈은 create(weights) → { pick(game, seat, cands) } 를 내보내야 한다.
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var MOD = process.argv[2];
var WPATH = process.argv[3];
var NROUND = +process.argv[4] || 600;
if (!MOD || !WPATH) { console.error('사용: node ml/gate-rollout.js <모듈> <가중치> [라운드]'); process.exit(2); }

var M = require(path.resolve(MOD));
var pol = M.create(JSON.parse(require('fs').readFileSync(WPATH, 'utf8')));

function act(g, s, useNew) {
  if (useNew && g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
    var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
    var cds = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
    if (g.currentCombo && !gm.forced) cds.push({ t: 'pass' });
    if (cds.length) {
      var cd = cds[pol.pick(g, s, cds)];
      var a = cd.t === 'pass' ? { type: 'pass_turn', seat: s } : { type: 'play_cards', seat: s, cards: cd.c };
      if (cd.c && cd.c.indexOf('MJ') >= 0) {
        var wi = B.botWish(g.hands[s].filter(function (x) { return cd.c.indexOf(x) < 0; }), null);
        if (wi) a.wish = wi;
      }
      return a;
    }
  }
  return B.botDecide(g, s, 'normal');
}

/* 좌석 스왑 짝지음 — 같은 딜을 두 번(신정책이 팀A / 팀B) 돌려 딜 운을 상쇄한다 */
var diffs = [];
for (var seed = 9001; diffs.length < NROUND && seed < 9001 + NROUND * 3; seed++) {
  for (var side = 0; side < 2; side++) {
    var g = new C.Game({ seed: seed, targetScore: 500 }), guard = 0;
    while (!g.gameOver && g.phase !== 'roundEnd' && ++guard < 800) {
      var w = g.waitingOn(); if (!w.length) break;
      var s = w[0];
      var mine = (side === 0) ? (s % 2 === 0) : (s % 2 === 1);
      var a = act(g, s, mine);
      if (!a || !g.apply(a).ok) break;
    }
    if (!g.roundSummary) continue;
    var d = g.roundSummary.deltas;
    diffs.push(side === 0 ? d.teamA - d.teamB : d.teamB - d.teamA);
  }
}
var n = diffs.length;
var m = diffs.reduce(function (a, b) { return a + b; }, 0) / n;
var sd = Math.sqrt(diffs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (n - 1));
var se = sd / Math.sqrt(n);

/* 비용도 함께 — 강해도 느리면 시뮬이 줄어 순손실이다 */
var g0 = new C.Game({ seed: 12345, targetScore: 500 });
for (var i = 0; i < 4; i++) g0.apply({ type: 'call_grand', seat: i, call: false });
for (var s0 = 0; s0 < 4; s0++) g0.apply({ type: 'submit_exchange', seat: s0, give: B.botExchange(g0, s0, { keepSpecials: true }) });
var gd = 0;
while (g0.phase === 'play' && gd < 4) { var w0 = g0.waitingOn(); if (!w0.length) break; var a0 = B.botDecide(g0, w0[0], 'normal'); if (!a0 || !g0.apply(a0).ok) break; gd++; }
function bench(useNew) {
  for (var k = 0; k < 2000; k++) act(g0, g0.turnSeat, useNew);
  var t = Date.now(), N = 30000;
  for (var k2 = 0; k2 < N; k2++) act(g0, g0.turnSeat, useNew);
  return (Date.now() - t) * 1000 / N;
}
var tb = bench(false), tn = bench(true);

console.log('롤아웃 정책 자격 게이트: ' + MOD);
console.log('  강함 (좌석스왑 짝지음 ' + n + '라운드): ' + (m >= 0 ? '+' : '') + m.toFixed(1) + ' ± ' + se.toFixed(1) + ' 점/라운드');
console.log('  비용: 보통봇 ' + tb.toFixed(2) + 'µs → 신정책 ' + tn.toFixed(2) + 'µs (' + (tn / tb).toFixed(2) + '배)');
var strong = m - 2 * se > 0;
console.log('  판정: ' + (strong ? '통과 — 보통봇보다 유의하게 강함' : (m + 2 * se < 0 ? '탈락 — 유의하게 약함' : '판정 불가 — 0과 구분 안 됨')));
process.exit(strong ? 0 : 1);
