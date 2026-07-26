#!/usr/bin/env node
/* 종반 완전탐색 모듈의 끝단 게이트 — 짝지은 딜에서 후보팀에만 모듈을 심는다.
 *
 * 모듈(배포와 동일한 형태): 내 차례 & 모든 손패 ≤ HANDCAP 이면,
 *   내 시점 결정화 세계 K개를 각각 알파베타로 정확히 풀고 → 최선수 다수결.
 * 상대 패는 모른다(결정화) — 배포 가능한 규칙 계층이며, 교환(⑦)과 같은 전이 특성.
 *
 * 근거: 종반 정확해와 보통봇 수가 20~40% 불일치(실측), 분산의 64%가 원투(종반 결정),
 *       손패≤4 풀이 중앙 2ms — 12세계 다수결이 결정당 ~24ms로 예산 내.
 *
 * 사용: node ml/eval-endgame.js <딜수> [seedBase] [HANDCAP=4] [K=12]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var EG = require(path.join(__dirname, 'endgame.js'));

var NDEAL = +process.argv[2] || 6000;
var SEED0 = +process.argv[3] || 0;
var HANDCAP = +process.argv[4] || 4;
var K = +process.argv[5] || 12;
var NODECAP = +process.argv[6] || 6000;                       // 꼬리 통제 — 캡 도달 세계는 휴리스틱 잎으로 반환

function actKey(a) {
  return !a ? 'x' : (a.type === 'pass_turn' ? 'pass' : a.cards.slice().sort().join(','));
}

function maxHand(g) {
  return Math.max(g.hands[0].length, g.hands[1].length, g.hands[2].length, g.hands[3].length);
}

/* 종반 모듈: 결정화 K세계 완전풀이 다수결. 실패/무후보면 null(휴리스틱 폴백). */
function endgameMove(g, s) {
  var votes = Object.create(null), acts = Object.create(null);
  for (var w = 0; w < K; w++) {
    var det = B.determinize(g, s);
    var r = EG.solve(det, NODECAP);
    if (!r.best) continue;
    var k = actKey(r.best);
    votes[k] = (votes[k] || 0) + 1;
    acts[k] = r.best;
  }
  var bestK = null, bestN = 0;
  for (var k2 in votes) if (votes[k2] > bestN) { bestN = votes[k2]; bestK = k2; }
  return bestK ? acts[bestK] : null;
}

var moduleUses = 0, moduleDiff = 0;        // 모듈 발동 횟수 · 보통봇과 다른 수를 고른 횟수

function playRound(seed, useModule) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var guard = 0;
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0], a = null;
    if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      a = { type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: true }) };
    } else if (useModule && s % 2 === 0 && g.phase === 'play' && g.turnSeat === s &&
               g.finished.indexOf(s) < 0 && maxHand(g) <= HANDCAP) {
      a = endgameMove(g, s);
      if (a) {
        moduleUses++;
        var nb = B.botDecide(g, s, 'normal');
        if (actKey(a) !== actKey(nb)) moduleDiff++;
      }
      if (!a) a = B.botDecide(g, s, 'normal');
    } else {
      a = B.botDecide(g, s, 'normal');
    }
    if (!a || !g.apply(a).ok) return null;
  }
  if (!g.roundSummary) return null;
  var rs = g.roundSummary;
  var ot = rs.oneTwoTeam ? (rs.oneTwoTeam === 'A' ? 200 : -200) : 0;
  return { tot: rs.deltas.teamA - rs.deltas.teamB, oneTwo: ot };
}

var offA = [], onA = [], t0 = Date.now(), used = 0;
for (var i = 0; i < NDEAL; i++) {
  var seed = SEED0 + i;
  var off = playRound(seed, false);
  var on = playRound(seed, true);
  if (!off || !on) continue;
  offA.push(off); onA.push(on); used++;
  if (used % 500 === 0) console.log('  ' + used + '/' + NDEAL + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}

function stat(a) {
  var n = a.length, m = a.reduce(function (x, y) { return x + y; }, 0) / n;
  var sd = Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (n - 1));
  return { m: m, se: sd / Math.sqrt(n) };
}
var dTot = onA.map(function (x, i2) { return x.tot - offA[i2].tot; });
var dOT = onA.map(function (x, i2) { return x.oneTwo - offA[i2].oneTwo; });
var s1 = stat(dTot), s2 = stat(dOT);
console.log('\n[짝지은 ' + used + '딜 · 손패≤' + HANDCAP + ' · ' + K + '세계 다수결 · 후보팀만]');
console.log('  종반모듈 효과: ' + (s1.m >= 0 ? '+' : '') + s1.m.toFixed(2) + ' ± ' + s1.se.toFixed(2) +
            ' 점/라운드  (' + (s1.m * 0.72 >= 0 ? '+' : '') + (s1.m * 0.72).toFixed(1) + '%p)');
console.log('  그중 원투 기여: ' + (s2.m >= 0 ? '+' : '') + s2.m.toFixed(2));
console.log('  모듈 발동 ' + (moduleUses / used).toFixed(2) + '회/라운드 · 보통봇과 다른 수 ' +
            (moduleUses ? (100 * moduleDiff / moduleUses).toFixed(0) : 0) + '%');
console.log('EG ' + s1.m.toFixed(4) + ' ' + s1.se.toFixed(4) + ' ' + used + ' ' + s2.m.toFixed(3) + ' ' + moduleUses + ' ' + moduleDiff);
