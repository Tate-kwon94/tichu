/* 심층사고 모듈 (4단 후보) — 발굴 스윕이 찾은 고손실 국면에서 PUCT 대신
 * "후보 전수 × W세계 CRN 플레이아웃 평균"으로 수를 고른다.
 *
 * 근거(홀드아웃 무편향): 티츄 선언이 걸린 리드 18~24점, 티츄 싱글 따라가기 9~15점 —
 * 배포 예산(950ms)의 표본 부족이 만드는 실측 손실. 탐색을 우회하는 직접 평가라
 * 전이 함정이 없다(교환·종반 모듈과 같은 배포 구조).
 * 주의: 과거 "예산4배 무익" 결론은 repCap 버그(실제 1.6배)로 무효 — 이 축은 미측정이었다.
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* 발동 조건 — 스윕 상위 유형: 티츄(내·파·상대) 살아있는 모든 플레이 결정 + 초중반 리드 */
function triggers(g, seat) {
  if (g.hands[seat].length <= 1) return false;
  var opp1 = (seat + 1) % 4, opp2 = (seat + 3) % 4, pt = (seat + 2) % 4;
  var tichuLive = (g.tichu[seat] > 0 && g.finished.indexOf(seat) < 0) ||
                  (g.tichu[pt] > 0 && g.firstOutSeat === null) ||
                  (g.tichu[opp1] > 0 && g.finished.indexOf(opp1) < 0) ||
                  (g.tichu[opp2] > 0 && g.finished.indexOf(opp2) < 0);
  if (tichuLive) return true;
  return !g.currentCombo && g.hands[seat].length >= 5;   // 초중반 리드
}

/* 심층 평가 수 선택. rngSeed 미지정 시 비시드(배포). */
function deepMove(g, seat, opts) {
  opts = opts || {};
  var W = opts.worlds || 200;
  var gm = C.genMoves(g.hands[seat], g.currentCombo, g.wish);
  var acts = gm.moves.map(function (m) {
    var a = { type: 'play_cards', seat: seat, cards: m.cards };
    if (m.cards.indexOf('MJ') >= 0) {
      var wsh = B.botWish(g.hands[seat].filter(function (id) { return m.cards.indexOf(id) < 0; }));
      if (wsh) a.wish = wsh;
    }
    return a;
  });
  if (g.currentCombo && !gm.forced) acts.push({ type: 'pass_turn', seat: seat });
  if (acts.length < 2) return null;                      // 강제/단일 수 — 모듈 불필요
  var team = seat % 2;
  var sums = acts.map(function () { return 0; }), oks = acts.map(function () { return 0; });
  var rng = opts.rngSeed != null ? mulberry(opts.rngSeed) : null;
  var prev = (typeof globalThis !== 'undefined') ? globalThis.__TICHU_RNG : undefined;
  for (var w = 0; w < W; w++) {
    if (rng) globalThis.__TICHU_RNG = mulberry((opts.rngSeed + w * 7919) | 0);
    var det = B.determinize(g, seat);                    // CRN: 모든 후보가 같은 세계에서 평가
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
  if (typeof globalThis !== 'undefined') {
    if (prev === undefined) delete globalThis.__TICHU_RNG; else globalThis.__TICHU_RNG = prev;
  }
  var best = -1, bestV = -Infinity;
  for (var i = 0; i < acts.length; i++) {
    if (!oks[i]) continue;
    var v = sums[i] / oks[i];
    if (v > bestV) { bestV = v; best = i; }
  }
  return best >= 0 ? acts[best] : null;
}

module.exports = { triggers: triggers, deepMove: deepMove };
