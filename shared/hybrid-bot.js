/* 하이브리드 봇 (UMD) — 결정화 탐색 + 신경망 프라이어·가지치기. 서버·브라우저 겸용.
 * 챔피언+ 모드(decidePlus)가 공식 초고수: 고수와 같은 휴리스틱 플레이아웃 평가에
 * 신경망이 후보 가지치기(keepP)와 정책 가산점(λ·logπ)을 얹는다.
 * Node: create('<weights.json 경로>') / 브라우저: create(TichuNet.create(파싱된 가중치))
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tichu-core.js'), require('./bots.js'), require('./net-infer.js'));
  } else {
    root.TichuHybrid = factory(root.TichuCore, root.TichuBots, root.TichuNet);
  }
}(typeof self !== 'undefined' ? self : this, function (C, B, NET) {
'use strict';

function create(netOrPath) {
  var net = (typeof netOrPath === 'string') ? NET.load(netOrPath)
    : (netOrPath && netOrPath.pickRecord) ? netOrPath
    : NET.create(netOrPath);

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

  // 신경망 그리디 롤아웃 → 내 다음 결정 시점의 가치헤드 평가 (가치모드용)
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
          return net.valueRecord(net.makeRecord(sim, seat, cc.cands, hist));
        }
        if (!applyCand(sim, seat, cc.cands[0], hist)) return 0;
      } else if (sim.phase === 'play') {
        var cc2 = candsOf(sim, s2);
        var idx = cc2.cands.length === 1 ? 0 : net.pickRecord(net.makeRecord(sim, s2, cc2.cands, hist));
        if (!applyCand(sim, s2, cc2.cands[idx], hist)) return 0;
      } else {
        var a2 = B.botDecide(sim, s2, 'normal');
        if (!a2 || !sim.apply(a2).ok) return 0;
      }
      if (++steps > 120) return 0;
    }
  }

  // 휴리스틱('보통') 플레이아웃 — 라운드 끝까지 (챔피언+ 평가)
  function heuristicPlayout(sim, seat, deadline) {
    var myTeamEven = seat % 2 === 0;
    var guard = 0;
    while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd') {
      if (deadline && Date.now() > deadline) {
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

  // 고급 자원 낭비 페널티(원점수 단위) — 푼돈 트릭에 폭탄·용·A를 쓰는 수 억제.
  // 시뮬레이션 평균이 희석하는 "아껴야 하는 이유"를 명시 비용으로 보정 (사람 체감 개선)
  function wasteCost(g, seat, cand, handN) {
    if (cand.t === 'pass' || cand.l === handN || handN <= 6) return 0; // 완주 수·종반 면제
    var opp1 = (seat + 1) % 4, opp2 = (seat + 3) % 4;
    var enemyTichu = (g.tichu[opp1] > 0 && g.finished.indexOf(opp1) < 0) ||
                     (g.tichu[opp2] > 0 && g.finished.indexOf(opp2) < 0);
    if (enemyTichu) return 0; // 상대 티츄 저지 국면 면제
    var pts = C.sumPoints(g.trickPile);
    var cost = 0;
    if (cand.t === 'bomb4' || cand.t === 'bombstraight') {
      if (pts < 15) cost += 30; // 푼돈에 폭탄
    } else {
      for (var i = 0; i < cand.c.length; i++) {
        var id = cand.c[i];
        if (id === 'DR') { if (pts < 10) cost += 25; }
        else if (id !== 'PH' && id !== 'MJ' && id !== 'DG' && C.rankOf(id) >= 14 &&
                 cand.t === 'single' && pts < 5) cost += 12; // 푼돈에 A 싱글
      }
    }
    return cost;
  }

  function finishAction(g, seat, pick) {
    if (pick.t === 'pass') return { type: 'pass_turn', seat: seat };
    var a = { type: 'play_cards', seat: seat, cards: pick.c };
    if (pick.c.indexOf('MJ') >= 0) {
      var wsh = B.botWish(g.hands[seat].filter(function (id) { return pick.c.indexOf(id) < 0; }));
      if (wsh) a.wish = wsh;
    }
    return a;
  }

  return {
    // 챔피언+ 모드 (공식 초고수)
    decidePlus: function (game, seat, hist, opts) {
      var budget = (opts && opts.budgetMs) || 950;
      var lambda = (opts && opts.lambda != null) ? opts.lambda : 20; // 원점수 단위
      var keepP = (opts && opts.keepP != null) ? opts.keepP : 0.03;
      var temp = (opts && opts.temp) ? opts.temp : 1; // >1 = 프라이어 완화(자기증류 과확신 보정)
      var cc = candsOf(game, seat);
      var cands = cc.cands;
      if (!cands.length) return { type: 'pass_turn', seat: seat };
      var pickIdx = 0;
      if (cands.length > 1) {
        var probs = net.probsRecord(net.makeRecord(game, seat, cands, hist));
        if (temp !== 1) {
          var tSum = 0, ti;
          for (ti = 0; ti < probs.length; ti++) { probs[ti] = Math.pow(probs[ti], 1 / temp); tSum += probs[ti]; }
          for (ti = 0; ti < probs.length; ti++) probs[ti] /= tSum;
        }
        var mx = Math.max.apply(null, probs);
        var active = [];
        for (var i0 = 0; i0 < cands.length; i0++) if (probs[i0] >= mx * keepP) active.push(i0);
        if (active.length < 2) active = probs.map(function (_, i) { return i; });
        var totals = {}, counts = {};
        active.forEach(function (i) { totals[i] = 0; counts[i] = 0; });
        function avgOf(i) { return counts[i] ? totals[i] / counts[i] : -Infinity; }
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
          // 마진 탈락(고수 탐색과 동일 기법): 선두와 명백한 격차인 후보 제거 → 남은 예산 집중
          if ((rep === 5 || rep === 13 || rep === 29) && active.length > 3) {
            var margin = rep === 5 ? 70 : rep === 13 ? 45 : 28;
            var lead = -Infinity;
            for (var li = 0; li < active.length; li++) lead = Math.max(lead, avgOf(active[li]));
            var kept = active.filter(function (i) { return avgOf(i) >= lead - margin; });
            if (kept.length >= 2) active = kept;
          }
        }
        var bv = -Infinity;
        var handN = game.hands[seat].length;
        for (var a2 = 0; a2 < active.length; a2++) {
          var c3 = active[a2];
          if (!counts[c3]) continue;
          var sc = totals[c3] / counts[c3] + lambda * Math.log(Math.max(probs[c3], 1e-6))
            - wasteCost(game, seat, cands[c3], handN);
          if (sc > bv) { bv = sc; pickIdx = c3; }
        }
      }
      return finishAction(game, seat, cands[pickIdx]);
    },

    // 가치모드 (연구용 보존)
    decide: function (game, seat, hist, opts) {
      var budget = (opts && opts.budgetMs) || 950;
      var maxReps = (opts && opts.samples) || 200;
      var lambda = (opts && opts.lambda != null) ? opts.lambda : 0.2;
      var cc = candsOf(game, seat);
      var cands = cc.cands;
      if (!cands.length) return { type: 'pass_turn', seat: seat };
      var pickIdx = 0;
      if (cands.length > 1) {
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
        var bv = -Infinity;
        for (var c2 = 0; c2 < cands.length; c2++) {
          var sc = lambda * Math.log(Math.max(probs[c2], 1e-6));
          if (counts[c2]) sc += totals[c2] / counts[c2];
          else sc -= 1;
          if (sc > bv) { bv = sc; pickIdx = c2; }
        }
      }
      return finishAction(game, seat, cands[pickIdx]);
    }
  };
}

return { create: create };
}));
