/* 종반 완전탐색 — 결정화된 세계(완전정보)를 알파베타로 정확히 푼다.
 *
 * 왜 종반인가: 분산의 64%가 원투 완주에서 나오고 그건 종반에 갈린다. 그런데 종반이야말로
 * 휴리스틱 플레이아웃이 가장 부정확한 구간(카드 한 장 순서가 승패를 가름)이다.
 * 손패가 작으면(≤4~6장) 트리가 계산 가능한 크기가 된다.
 *
 * 사용자 인터뷰의 전술(카운팅 활용·템포 통제·완주 순서 설계)이 완전정보 트리에선 공짜로 나온다.
 *
 * v1: 엔진 clone/apply 그대로 사용(정확성 우선, 속도는 게이트 통과 후 최적화).
 *     용 증정·소원 등 비플레이 결정은 휴리스틱 위임(트리는 플레이/패스만 분기).
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var NODE_CAP = 300000;

/* 반환: { value, best, nodes, capped }
 * value = teamA − teamB (라운드 델타, 좌석 0·2 관점), best = 뿌리 최선 액션 */
function solve(game, nodeCap) {
  var cap = nodeCap || NODE_CAP;
  var stats = { nodes: 0, capped: false };

  function rec(g, alpha, beta) {
    if (g.phase === 'roundEnd' || g.phase === 'gameEnd') {
      var d = g.roundSummary ? g.roundSummary.deltas : { teamA: 0, teamB: 0 };
      return d.teamA - d.teamB;
    }
    if (++stats.nodes > cap) { stats.capped = true; return heuristicValue(g); }

    var w = g.waitingOn();
    if (!w.length) return heuristicValue(g);
    var s = w[0];

    // 비플레이 국면(용 증정 등)은 휴리스틱 위임 후 계속
    if (!(g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0)) {
      var ha = B.botDecide(g, s, 'normal');
      if (!ha) return heuristicValue(g);
      var g2 = g.clone();
      if (!g2.apply(ha).ok) return heuristicValue(g);
      return rec(g2, alpha, beta);
    }

    var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
    var acts = [];
    // 이동 순서: 긴 조합·완주 수 먼저(가지치기 효율) — 종반 직관: 털 수 있으면 털어본다
    var moves = gm.moves.slice().sort(function (a, b) { return b.cards.length - a.cards.length; });
    for (var i = 0; i < moves.length; i++) {
      var a = { type: 'play_cards', seat: s, cards: moves[i].cards };
      if (moves[i].cards.indexOf('MJ') >= 0) {
        var wsh = B.botWish(g.hands[s].filter(function (id) { return moves[i].cards.indexOf(id) < 0; }), (typeof globalThis !== 'undefined' && globalThis.__TICHU_WISH_COUNT) ? g : null);
        if (wsh) a.wish = wsh;
      }
      acts.push(a);
    }
    if (g.currentCombo && !gm.forced) acts.push({ type: 'pass_turn', seat: s });
    if (!acts.length) acts.push({ type: 'pass_turn', seat: s });

    var maximizing = (s % 2 === 0);
    var bestV = maximizing ? -Infinity : Infinity;
    for (var k = 0; k < acts.length; k++) {
      var gc = g.clone();
      if (!gc.apply(acts[k]).ok) continue;
      var v = rec(gc, alpha, beta);
      if (maximizing) { if (v > bestV) bestV = v; if (bestV > alpha) alpha = bestV; }
      else { if (v < bestV) bestV = v; if (bestV < beta) beta = bestV; }
      if (beta <= alpha) break;                              // 가지치기
    }
    return bestV === -Infinity || bestV === Infinity ? heuristicValue(g) : bestV;
  }

  // 캡 도달 시 잎 근사: 확보 점수 + 손패 우위(플레이아웃의 컷오프 근사와 동일 철학)
  function heuristicValue(g) {
    var cap2 = [0, 0], cards = [0, 0];
    for (var s2 = 0; s2 < 4; s2++) { cap2[s2 % 2] += C.sumPoints(g.tricksWon[s2]); cards[s2 % 2] += g.hands[s2].length; }
    return (cap2[0] - cap2[1]) + (cards[1] - cards[0]) * 1.5;
  }

  // 뿌리: 각 후보를 직접 전개해 최선 액션 반환
  var w0 = game.waitingOn();
  var s0 = w0[0];
  var gm0 = C.genMoves(game.hands[s0], game.currentCombo, game.wish);
  var rootActs = [];
  gm0.moves.forEach(function (m) {
    var a = { type: 'play_cards', seat: s0, cards: m.cards };
    if (m.cards.indexOf('MJ') >= 0) {
      var wsh = B.botWish(game.hands[s0].filter(function (id) { return m.cards.indexOf(id) < 0; }), (typeof globalThis !== 'undefined' && globalThis.__TICHU_WISH_COUNT) ? game : null);
      if (wsh) a.wish = wsh;
    }
    rootActs.push(a);
  });
  if (game.currentCombo && !gm0.forced) rootActs.push({ type: 'pass_turn', seat: s0 });

  var maximizing0 = (s0 % 2 === 0);
  var best = null, bestV = maximizing0 ? -Infinity : Infinity;
  var alpha = -Infinity, beta = Infinity;
  for (var i = 0; i < rootActs.length; i++) {
    var gc = game.clone();
    if (!gc.apply(rootActs[i]).ok) continue;
    var v = rec(gc, alpha, beta);
    if (maximizing0 ? v > bestV : v < bestV) { bestV = v; best = rootActs[i]; }
    if (maximizing0) { if (bestV > alpha) alpha = bestV; }
    else { if (bestV < beta) beta = bestV; }
  }
  return { value: bestV, best: best, nodes: stats.nodes, capped: stats.capped };
}

/* 배포용 모듈: 내 시점 결정화 K세계를 정확히 풀어 최선수 다수결.
 * null 반환 시 호출측이 기존 경로(PUCT/휴리스틱)로 폴백한다. */
function endgameMove(g, seat, opts) {
  opts = opts || {};
  var K = opts.K || 12, nodeCap = opts.nodeCap || 30000;
  var votes = Object.create(null), acts = Object.create(null);
  for (var w = 0; w < K; w++) {
    var det = B.determinize(g, seat);
    var r = solve(det, nodeCap);
    if (!r.best) continue;
    var k = !r.best.cards ? 'pass' : r.best.cards.slice().sort().join(',');
    votes[k] = (votes[k] || 0) + 1;
    acts[k] = r.best;
  }
  var bestK = null, bestN = 0;
  for (var k2 in votes) if (votes[k2] > bestN) { bestN = votes[k2]; bestK = k2; }
  return bestK ? acts[bestK] : null;
}

function maxHand(g) {
  return Math.max(g.hands[0].length, g.hands[1].length, g.hands[2].length, g.hands[3].length);
}

module.exports = { solve: solve, endgameMove: endgameMove, maxHand: maxHand };
