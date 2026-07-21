/* 하이브리드 봇 — 결정화 탐색의 플레이아웃·평가를 신경망으로 교체.
 * 구조: 후보 수 → 결정화(교환정보 고정) → 상대 응수를 신경망(그리디)으로 롤아웃
 *       → 내 다음 결정 시점에서 가치헤드 V(s) 평가 (라운드 끝이면 실제 점수차)
 * 고수950과 같은 시간예산으로 훨씬 질 높은 수읽기가 목표.
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, 'net-infer.js'));

function create(weightsPath) {
  var net = NET.load(weightsPath);

  function candsOf(g, seat) {
    var gm = C.genMoves(g.hands[seat], g.currentCombo, g.wish);
    var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
    if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
    return { cands: cands, forced: gm.forced };
  }

  function applyCand(g, seat, cand, hist) {
    var a;
    if (cand.t === 'pass') a = { type: 'pass_turn', seat: seat };
    else {
      a = { type: 'play_cards', seat: seat, cards: cand.c };
      if (cand.c.indexOf('MJ') >= 0) {
        var wsh = B.botWish(g.hands[seat].filter(function (id) { return cand.c.indexOf(id) < 0; }));
        if (wsh) a.wish = wsh;
      }
    }
    var r = g.apply(a);
    if (!r.ok) return false;
    if (a.type === 'pass_turn') hist.push({ s: seat, t: 'pass', r: 0, l: 0 });
    else {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: seat, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: seat, t: 'dog', r: 0, l: 1 });
    }
    return true;
  }

  // 롤아웃: 내(seat) 다음 결정 시점 또는 라운드 종료까지 신경망 그리디 진행 → 가치
  function rolloutValue(sim, seat, hist) {
    var myTeamEven = seat % 2 === 0;
    var steps = 0;
    for (;;) {
      if (sim.phase === 'roundEnd' || sim.phase === 'gameEnd') {
        var d = sim.roundSummary ? sim.roundSummary.deltas : { teamA: 0, teamB: 0 };
        var delta = myTeamEven ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
        return Math.max(-2.5, Math.min(2.5, delta / 200));
      }
      var w = sim.waitingOn();
      if (!w.length) return 0;
      var s2 = w[0];
      if (sim.phase === 'play' && s2 === seat) {
        var cc = candsOf(sim, seat);
        if (cc.cands.length > 1 || steps >= 40) {
          var rec = net.makeRecord(sim, seat, cc.cands, hist);
          return net.valueRecord(rec);
        }
        // 선택지 1개면 자동 진행
        if (!applyCand(sim, seat, cc.cands[0], hist)) return 0;
      } else if (sim.phase === 'play') {
        var cc2 = candsOf(sim, s2);
        var idx = cc2.cands.length === 1 ? 0 : net.pickRecord(net.makeRecord(sim, s2, cc2.cands, hist));
        if (!applyCand(sim, s2, cc2.cands[idx], hist)) return 0;
      } else {
        var a2 = B.botDecide(sim, s2, 'normal'); // 용 증정 등 비플레이 단계
        if (!a2 || !sim.apply(a2).ok) return 0;
      }
      if (++steps > 120) return 0;
    }
  }

  // 휴리스틱('보통') 플레이아웃 — 라운드 끝까지. bots.js searchMove의 평가와 동일 개념
  function heuristicPlayout(sim, seat, deadline) {
    var myTeamEven = seat % 2 === 0;
    var guard = 0;
    while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd') {
      if (deadline && Date.now() > deadline) { // 시간 컷: 따낸 점수차 + 손패 우위 근사
        var cap = [0, 0], cards = [0, 0];
        for (var s2 = 0; s2 < 4; s2++) { cap[s2 % 2] += C.sumPoints(sim.tricksWon[s2]); cards[s2 % 2] += sim.hands[s2].length; }
        var pts = myTeamEven ? cap[0] - cap[1] : cap[1] - cap[0];
        var lead = myTeamEven ? cards[1] - cards[0] : cards[0] - cards[1];
        return pts + lead * 1.5;
      }
      var w = sim.waitingOn(); if (!w.length) break;
      var a = B.botDecide(sim, w[0], 'normal'); if (!a) break;
      if (!sim.apply(a).ok) break;
      if (++guard > 2000) break;
    }
    if (!sim.roundSummary) return 0;
    var d = sim.roundSummary.deltas;
    return myTeamEven ? d.teamA - d.teamB : d.teamB - d.teamA;
  }

  return {
    // 챔피언+ 모드: 고수950과 같은 휴리스틱 플레이아웃 평가에 신경망 프라이어·가지치기만 추가
    decidePlus: function (game, seat, hist, opts) {
      var budget = (opts && opts.budgetMs) || 950;
      var lambda = (opts && opts.lambda != null) ? opts.lambda : 20; // 원점수 단위
      var keepP = (opts && opts.keepP != null) ? opts.keepP : 0.03; // maxπ 대비 유지 비율
      var cc = candsOf(game, seat);
      var cands = cc.cands;
      if (!cands.length) return { type: 'pass_turn', seat: seat };
      var pickIdx = 0;
      if (cands.length > 1) {
        var probs = net.probsRecord(net.makeRecord(game, seat, cands, hist));
        var mx = Math.max.apply(null, probs);
        var active = [];
        for (var i0 = 0; i0 < cands.length; i0++) if (probs[i0] >= mx * keepP) active.push(i0);
        if (active.length < 2) active = probs.map(function (_, i) { return i; }); // 과도 가지치기 방지
        var totals = {}, counts = {};
        active.forEach(function (i) { totals[i] = 0; counts[i] = 0; });
        var deadline = Date.now() + budget;
        for (var rep = 0; rep < 400 && Date.now() < deadline; rep++) {
          var det = B.determinize(game, seat);
          for (var ai = 0; ai < active.length; ai++) {
            var ci = active[ai];
            if (Date.now() >= deadline && rep > 0) break;
            var sim = det.clone ? det.clone() : B.cloneGame(det);
            var h2 = hist.slice();
            if (!applyCand(sim, seat, cands[ci], h2)) continue;
            totals[ci] += heuristicPlayout(sim, seat, deadline);
            counts[ci]++;
          }
        }
        var bv = -Infinity;
        for (var a2 = 0; a2 < active.length; a2++) {
          var c3 = active[a2];
          if (!counts[c3]) continue;
          var sc = totals[c3] / counts[c3] + lambda * Math.log(Math.max(probs[c3], 1e-6));
          if (sc > bv) { bv = sc; pickIdx = c3; }
        }
      }
      var pick2 = cands[pickIdx];
      if (pick2.t === 'pass') return { type: 'pass_turn', seat: seat };
      var a3 = { type: 'play_cards', seat: seat, cards: pick2.c };
      if (pick2.c.indexOf('MJ') >= 0) {
        var wsh2 = B.botWish(game.hands[seat].filter(function (id) { return pick2.c.indexOf(id) < 0; }));
        if (wsh2) a3.wish = wsh2;
      }
      return a3;
    },

    // 플레이 결정 (선언·교환 등은 호출측이 휴리스틱 사용)
    decide: function (game, seat, hist, opts) {
      var budget = (opts && opts.budgetMs) || 950;
      var maxReps = (opts && opts.samples) || 200;
      var cc = candsOf(game, seat);
      var cands = cc.cands;
      if (!cands.length) return { type: 'pass_turn', seat: seat };
      var lambda = (opts && opts.lambda != null) ? opts.lambda : 0.2;
      var pickIdx = 0;
      if (cands.length > 1) {
        // 정책 프라이어 — 모방 정책이 아는 "카드 아끼기" 등 장기 감각의 앵커
        var probs = net.probsRecord(net.makeRecord(game, seat, cands, hist));
        var totals = cands.map(function () { return 0; });
        var counts = cands.map(function () { return 0; });
        var deadline = Date.now() + budget;
        for (var rep = 0; rep < maxReps && Date.now() < deadline; rep++) {
          var det = B.determinize(game, seat);
          for (var ci = 0; ci < cands.length; ci++) {
            if (Date.now() >= deadline && rep > 0) break;
            var sim = det.clone ? det.clone() : B.cloneGame(det);
            var h2 = hist.slice();
            if (!applyCand(sim, seat, cands[ci], h2)) continue;
            totals[ci] += rolloutValue(sim, seat, h2);
            counts[ci]++;
          }
        }
        // 점수 = 롤아웃 가치 평균 + λ·logπ (알파고식 가치+정책 결합)
        var bv = -Infinity;
        for (var c2 = 0; c2 < cands.length; c2++) {
          var sc = lambda * Math.log(Math.max(probs[c2], 1e-6));
          if (counts[c2]) sc += totals[c2] / counts[c2];
          else sc -= 1; // 평가 못 한 후보는 감점
          if (sc > bv) { bv = sc; pickIdx = c2; }
        }
      }
      var pick = cands[pickIdx];
      if (pick.t === 'pass') return { type: 'pass_turn', seat: seat };
      var a = { type: 'play_cards', seat: seat, cards: pick.c };
      if (pick.c.indexOf('MJ') >= 0) {
        var wsh = B.botWish(game.hands[seat].filter(function (id) { return pick.c.indexOf(id) < 0; }));
        if (wsh) a.wish = wsh;
      }
      return a;
    }
  };
}

module.exports = { create: create };
