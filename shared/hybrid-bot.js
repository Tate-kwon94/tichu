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
function RND() {
  return (typeof globalThis !== 'undefined' && globalThis.__TICHU_RNG)
    ? globalThis.__TICHU_RNG() : Math.random();
}

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
        var wsh = B.botWish(g.hands[seat].filter(function (id) { return cand.c.indexOf(id) < 0; }), (typeof globalThis !== 'undefined' && globalThis.__TICHU_WISH_COUNT) ? g : null); // 카운팅 소원(3단 재료, 잠김)
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

  // ④ 오라클 말단 평가 — 결정화된 세계(4명 패 확정)를 가치망 1회로 평가.
  // 플레이아웃이 그 세계를 "한 번 둬본 표본 1개"로 재는 것을, 기댓값 한 방으로 대체한다.
  // 봇이 아는 정보는 늘지 않는다: 그 완전정보는 결정화가 방금 지어낸 가상 세계의 것이고,
  // 여러 세계에 평균 내는 구조는 그대로다(= 지금 플레이아웃이 하는 일과 동일).
  function oracleEval(sim, seat, oracle) {
    var guard = 0;
    // 용 증정 등 중간 국면은 학습 분포 밖 — 한두 수 진행시켜 play 국면으로 되돌린다
    while (sim.phase !== 'play' && sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd' && ++guard < 8) {
      var w = sim.waitingOn(); if (!w.length) break;
      var a = B.botDecide(sim, w[0], 'normal'); if (!a || !sim.apply(a).ok) break;
    }
    if (sim.phase === 'roundEnd' || sim.phase === 'gameEnd') {  // 이미 끝났으면 실제 결과가 정답
      var d = sim.roundSummary ? sim.roundSummary.deltas : { teamA: 0, teamB: 0 };
      var delta = (seat % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
      return Math.max(-2, Math.min(2, delta / 100));
    }
    return Math.max(-2, Math.min(2, oracle.value(sim, seat)));
  }

  // 신경망 그리디 플레이아웃 — 라운드 끝까지 모두 정책망으로 둔다(보통봇보다 강한 평가).
  // 3단 헤드룸 측정용: 평가(롤아웃 정책)를 강하게 하면 탐색이 더 정확해지는가.
  // 비쌈(net 호출 ~1500µs/수)이라 실전용 아님 — 상한 확인 후 값이 있으면 가치망으로 근사.
  function neuralPlayout(sim, seat, hist, deadline) {
    var myTeamEven = seat % 2 === 0, guard = 0, h = hist.slice();
    while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd') {
      if (deadline && Date.now() > deadline) {
        var cap = [0, 0], cards = [0, 0];
        for (var s3 = 0; s3 < 4; s3++) { cap[s3 % 2] += C.sumPoints(sim.tricksWon[s3]); cards[s3 % 2] += sim.hands[s3].length; }
        return (myTeamEven ? cap[0] - cap[1] : cap[1] - cap[0]) + (myTeamEven ? cards[1] - cards[0] : cards[0] - cards[1]) * 1.5;
      }
      var w = sim.waitingOn(); if (!w.length) break;
      var s2 = w[0], a;
      if (sim.phase === 'play' && sim.turnSeat === s2 && sim.finished.indexOf(s2) < 0) {
        var cc = candsOf(sim, s2);
        if (cc.cands.length === 1) { if (!applyCand(sim, s2, cc.cands[0], h)) break; continue; }
        var idx = net.pickRecord(net.makeRecord(sim, s2, cc.cands, h));
        if (!applyCand(sim, s2, cc.cands[idx], h)) break;
      } else {
        a = B.botDecide(sim, s2, 'normal'); if (!a || !sim.apply(a).ok) break;  // 선언·교환·소원·용은 휴리스틱
      }
      if (++guard > 2000) break;
    }
    if (!sim.roundSummary) return 0;
    var d = sim.roundSummary.deltas;
    return myTeamEven ? d.teamA - d.teamB : d.teamB - d.teamA;
  }

  // 휴리스틱('보통') 플레이아웃 — 라운드 끝까지 (챔피언+ 평가)
  //
  // oppK > 0 이면 "상대-연속 편향 제거": 상대 좌석의 첫 oppK 수만 신경망 그리디로 둔다.
  // 왜: 리프가 "상대가 보통봇처럼 약하게 응수한다"고 가정하는데 실전 상대는 탐색봇이다.
  // clairvoyance는 "내 은닉정보" 축을 닫았지만 "상대 정책 강도" 축은 직교라 미폐쇄였다.
  // 전체를 신경망으로 두면 201배 느리므로, 반격이 결정되는 초반 몇 수만 정확히 둔다.
  /* outBonus(5단 후보): 평가 목표에 "먼저 나가기" 가중을 더한다.
   * 왜: 로드맵은 평가기를 통째로 교체하거나(가치망, 실패) 플레이아웃 정책을 강화하는 것만(−0.02)
   * 시도했고, **평가 목표 자체를 재설계**한 적이 없다. holdValue(카드 아끼기)가 같은 종류의
   * 의도적 편향이었고 체감을 올린 전례가 있다.
   * 라운드 점수차는 완주 순서를 원투(+200)로만 본다 — 원투가 아니어도 먼저 나가는 것은
   * 상대에게 잔여 카드를 넘기지 않는다는 가치가 있는데 그 부분이 평가에 약하게 들어간다.
   * out[s] = 완주 등수(0=1등), 미완주는 4로 본다. 내 팀 등수합이 작을수록 가산. */
  /* winCtx(5단 후보): 목적함수를 "라운드 점수 최대화"에서 "게임 승리"로 바꾼다.
   * 발견: 평가기가 game score를 전혀 보지 않는다 — 480:100이든 0:0이든 똑같이 둔다.
   * 그런데 게임의 목적은 목표점수(500/1000)에 먼저 닿는 것이다. 라운드 점수는 대리 지표일 뿐이고,
   * 그 대리성이 깨지는 구간이 실재한다:
   *   - 우리가 목표에 근접 → 적게 이겨도 게임이 끝난다(추가 점수는 가치 0)
   *   - 상대가 목표에 근접 → 우리 점수보다 상대 저지가 우선(막지 못하면 게임이 끝난다)
   * w=1이면 라운드 종료 후 실제로 게임이 끝나는지를 보고 승/패에 ±BIG을 준다. */
  /* winCtx(5단 후보 v3): 점수 맥락에 따라 **내 득점과 상대 실점의 가중을 비대칭으로** 만든다.
   *
   * v1(이진: 이 라운드로 게임이 끝나는가)과 v2(연속 남은거리)는 발현이 0이었다.
   * 원인이 명확했다 — 둘 다 라운드 점수차의 **단조 변환**이라 모든 후보를 같이 밀어올리고
   * 순위를 못 바꾼다(게이트 0.3σ, Q는 0.40씩 움직이는데 수는 안 바뀜).
   * 순위를 바꾸려면 라운드 점수차의 함수가 아니어야 한다 → 팀별 델타를 분리해 다르게 가중한다.
   *
   * 왜 비대칭이 옳은가: 상대가 목표에 근접했으면 상대의 10점이 우리 10점보다 위험하다
   * (그 10점이 게임을 끝낼 수 있다). 반대도 성립한다. 현행 평가는 둘을 같은 무게로 본다.
   * 목표까지 남은 라운드 수 r = (목표−현재)/50 로 급함을 재고, 급할수록 가중을 올린다.
   *
   * ★ 결론(2026-07-30): **닫힘.** v1(이진)·v2(연속 남은거리)·v3(비대칭 가중) 셋 다 발현 0
   * (게이트 −0.9~+0.9σ, 점수맥락 0:0 / 400:250 / 250:400 / 440:440 전부).
   * 기전: 한 라운드의 카드 점수는 100점 제로섬이라 myD + opD ≈ 상수다. 그래서 팀 델타를
   * 어떻게 선형 재가중해도 결과는 myD의 스케일링 + 거의 상수 = **단조 변환**이고,
   * 단조 변환은 후보 순위를 바꾸지 못한다(Q는 0.10~0.40 움직이는데 수는 안 바뀜).
   * 비단조가 되는 곳은 목표 초과 시 포화뿐이고, 그건 후보들이 목표 통과 여부에서
   * 갈릴 때만 생겨 매우 드물다. → 점수 맥락 축은 라운드 평가 수준에서 여지가 거의 없다. */
  function winTerm(sim, seat, w) {
    if (!w || !sim.roundSummary) return 0;
    var t = sim.targetScore;
    if (!t || t > 100000) return 0;                   // 상한 없는 측정용 게임은 제외
    var even = (seat % 2 === 0);
    var d = sim.roundSummary.deltas;
    var myD = even ? d.teamA : d.teamB;
    var opD = even ? d.teamB : d.teamA;
    // 라운드 시작 시점 점수 = 종료 점수 − 이 라운드 델타
    var myBefore = (even ? sim.scores[0] : sim.scores[1]) - myD;
    var opBefore = (even ? sim.scores[1] : sim.scores[0]) - opD;
    var rMy = Math.max(0.5, (t - myBefore) / 50);      // 남은 라운드 수(하한 0.5)
    var rOp = Math.max(0.5, (t - opBefore) / 50);
    var wMy = 1 + w / rMy;                            // 우리가 급하면 내 득점 가중↑
    var wOp = 1 + w / rOp;                            // 상대가 급하면 상대 실점 가중↑
    return (wMy * myD - wOp * opD) - (myD - opD);      // 기준(대칭)과의 차이만 더한다
  }

  function outTerm(sim, seat, w) {
    if (!w) return 0;
    var fin = sim.finished || [], mine = 0, opp = 0;
    for (var s = 0; s < 4; s++) {
      var idx = fin.indexOf(s);
      var rank = idx >= 0 ? idx : 4;                 // 미완주는 최하위 취급
      if ((s % 2) === (seat % 2)) mine += rank; else opp += rank;
    }
    return (opp - mine) * w;                          // 우리 팀이 먼저 나갔을수록 +
  }

  /* 롤아웃 정책 주입(5단 후보). fastPol이 있으면 카드 결정만 그것으로 두고 나머지는 휴리스틱.
   * 근거: 평가기가 병목임이 실측됐다(같은 40세계에서 보통봇 vs 정책망이 62% 다른 수를 고름).
   * 정책망은 658배 비싸 못 쓰지만, 선형 증류본은 롤아웃 비용이 오히려 9% 낮으면서(228 vs 251µs)
   * 효과의 대부분을 재현한다(불일치 50% vs 정책망 62%). */
  function heuristicPlayout(sim, seat, deadline, oppK, hist, outW, winW, fastPol) {
    var myTeamEven = seat % 2 === 0;
    var guard = 0, nOpp = 0, h = (oppK && hist) ? hist.slice() : null;
    while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd') {
      if (deadline && Date.now() > deadline) {
        var cap = [0, 0], cards = [0, 0];
        for (var s2 = 0; s2 < 4; s2++) { cap[s2 % 2] += C.sumPoints(sim.tricksWon[s2]); cards[s2 % 2] += sim.hands[s2].length; }
        var pts = myTeamEven ? cap[0] - cap[1] : cap[1] - cap[0];
        var lead = myTeamEven ? cards[1] - cards[0] : cards[0] - cards[1];
        return pts + lead * 1.5;
      }
      var w = sim.waitingOn(); if (!w.length) break;
      var s3 = w[0];
      // 상대 좌석(내 팀 아님)의 카드 결정이고 아직 예산(oppK) 남았으면 신경망 그리디
      if (oppK && nOpp < oppK && (s3 % 2) !== (seat % 2) &&
          sim.phase === 'play' && sim.turnSeat === s3 && sim.finished.indexOf(s3) < 0) {
        var cc = candsOf(sim, s3);
        if (cc.cands.length > 1) {
          var idx = net.pickRecord(net.makeRecord(sim, s3, cc.cands, h || []));
          if (!applyCand(sim, s3, cc.cands[idx], h || [])) break;
          nOpp++;
          if (++guard > 2000) break;
          continue;
        }
      }
      var a = null;
      if (fastPol && sim.phase === 'play' && sim.turnSeat === s3 && sim.finished.indexOf(s3) < 0) {
        var gmf = C.genMoves(sim.hands[s3], sim.currentCombo, sim.wish);
        var cdf = gmf.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
        if (sim.currentCombo && !gmf.forced) cdf.push({ t: 'pass' });
        if (cdf.length) {
          var cf = cdf[fastPol.pick(sim, s3, cdf)];
          a = cf.t === 'pass' ? { type: 'pass_turn', seat: s3 } : { type: 'play_cards', seat: s3, cards: cf.c };
          if (cf.c && cf.c.indexOf('MJ') >= 0) {
            var wif = B.botWish(sim.hands[s3].filter(function (x) { return cf.c.indexOf(x) < 0; }), null);
            if (wif) a.wish = wif;
          }
        }
      }
      if (!a) a = B.botDecide(sim, s3, 'normal');
      if (!a) break;
      if (!sim.apply(a).ok) break;
      if (h) {
        if (a.type === 'pass_turn') h.push({ s: s3, t: 'pass', r: 0, l: 0 });
        else if (a.type === 'play_cards') {
          var la2 = sim.lastAction;
          if (la2 && la2.combo) h.push({ s: s3, t: la2.combo.type, r: la2.combo.rank, l: la2.combo.length });
        }
      }
      if (++guard > 2000) break;
    }
    if (!sim.roundSummary) return 0;
    var d = sim.roundSummary.deltas;
    var base = myTeamEven ? d.teamA - d.teamB : d.teamB - d.teamA;
    return base + outTerm(sim, seat, outW) + winTerm(sim, seat, winW);
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

  // Phase 3: 이력에서 "각 좌석이 싱글에 패스한 최대 랭크" 추출. 그 좌석은 해당 랭크 초과 싱글이 없을 확률↑.
  // cur(따라가는 콤보)를 재구성 — 새 플레이는 cur 갱신, 개는 리셋, 패스는 cur 유지(그때 못 이긴 것).
  function passConstraints(hist) {
    var cur = null, mp = {};
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      if (h.t === 'pass') {
        if (cur && cur.t === 'single' && cur.r >= 2 && cur.r <= 14) {
          if (mp[h.s] == null || cur.r < mp[h.s]) mp[h.s] = cur.r; // 가장 낮은 패스 랭크(가장 강한 제약)
        }
      } else if (h.t === 'dog') {
        cur = null;
      } else {
        cur = { t: h.t, r: h.r };
      }
    }
    return mp;
  }

  // Phase 2: 보유 가치(아끼기) — 강카드를 이번 수로 소비하는 기회비용을 평가에 반영(v-space 음수).
  // 시뮬 평균이 희석하는 "아꼈다 결정적일 때 쓴다"의 가치를 명시화. 3가지로 감쇠(지금 쓸 값어치·위협·종반).
  function holdBonus(g, seat, cand) {
    var n = g.hands[seat].length;
    if (cand.t === 'pass' || cand.l === n) return 0; // 패스·완주는 소비/기회비용 아님
    var spend = 0;
    if (cand.t === 'bomb4' || cand.t === 'bombstraight') spend += 25; // 폭탄 가장 아깝
    for (var i = 0; i < (cand.c || []).length; i++) {
      var id = cand.c[i];
      if (id === 'DR') spend += 20;                               // 용
      else if (id === 'PH') spend += 12;                          // 불사조
      else if (id !== 'MJ' && id !== 'DG' && C.rankOf(id) === 14) spend += 10; // A
      else if (id !== 'MJ' && id !== 'DG' && C.rankOf(id) === 13) spend += 4;  // K
    }
    if (!spend) return 0;
    var pot = C.sumPoints(g.trickPile);
    var potF = Math.max(0, 1 - pot / 20);                         // 트릭 점수 크면 지금 써도 됨
    var opp1 = (seat + 1) % 4, opp2 = (seat + 3) % 4;
    var threat = ((g.tichu[opp1] > 0 && g.finished.indexOf(opp1) < 0) ||
                  (g.tichu[opp2] > 0 && g.finished.indexOf(opp2) < 0) ||
                  g.hands[opp1].length <= 3 || g.hands[opp2].length <= 3) ? 0.3 : 1.0; // 상대 위협 시 지금 써야
    var decay = Math.max(0, (n - 5) / 9);                         // 종반(손패 적음)엔 아낄 이유 없음
    return -(spend / 50) * potF * threat * decay;                // 소비 억제 = 아끼기 (v-space 나눔=강도)
  }

  function finishAction(g, seat, pick) {
    if (pick.t === 'pass') return { type: 'pass_turn', seat: seat };
    var a = { type: 'play_cards', seat: seat, cards: pick.c };
    if (pick.c.indexOf('MJ') >= 0) {
      var wsh = B.botWish(g.hands[seat].filter(function (id) { return pick.c.indexOf(id) < 0; }), (typeof globalThis !== 'undefined' && globalThis.__TICHU_WISH_COUNT) ? g : null);
      if (wsh) a.wish = wsh;
    }
    return a;
  }

  return {
    // PUCT 모드 (알파고 방식) — 신경망 정책을 "가지치기 힌트"가 아니라 "탐험 배분"으로 사용.
    // 매 시뮬 후보 선택: Q + c·P·√(ΣN)/(1+N). 유망 후보는 깊이 파되 정책확률만큼 탐험도 보장
    // → 강한 신경망일수록 배분이 정확해져 강함이 실력으로 전환(챔피언+의 과확신 함정 회피).
    // 평가는 검증된 휴리스틱 플레이아웃, 최종 선택은 최다 방문(robust).
    // opts.wantStats: 액션 대신 {action, cands, visits, q, priors, ...}를 반환한다(AZ 자가대전 기록용).
    // 탐색 코드는 한 줄도 갈라지지 않는다 — 반환문만 다르다. 생성기가 배포 탐색과 다른 코드를 돌면
    // "배포 시스템 자체를 훈련한다"는 AZ의 전제가 깨지고 전이 문제가 되살아난다(로드맵 §0-보론4).
    decidePuct: function (game, seat, hist, opts) {
      var budget = (opts && opts.budgetMs) || 950;
      var c = (opts && opts.c != null) ? opts.c : 1.5;
      var temp = (opts && opts.temp) ? opts.temp : 1;
      var stats = !!(opts && opts.wantStats);
      var cc = candsOf(game, seat);
      var cands = cc.cands;
      function ret(action, cs, vis, qq, pr, tn, rp, pk) {
        return stats ? { action: action, cands: cs, visits: vis, q: qq, priors: pr,
          totalN: tn, rep: rp, pick: pk, forced: cc.forced } : action;
      }
      if (!cands.length) return ret({ type: 'pass_turn', seat: seat }, [], [], [], [], 0, 0, -1);
      if (cands.length === 1) return ret(finishAction(game, seat, cands[0]), cands, [1], [0], [1], 1, 0, 0);
      var probs = net.probsRecord(net.makeRecord(game, seat, cands, hist));
      if (temp !== 1) {
        var tS = 0, ti;
        for (ti = 0; ti < probs.length; ti++) { probs[ti] = Math.pow(probs[ti], 1 / temp); tS += probs[ti]; }
        for (ti = 0; ti < probs.length; ti++) probs[ti] /= tS;
      }
      var K = cands.length;
      // ② 보유 가치: 후보별 기회비용을 미리 계산(결정론적, 상수 오프셋)
      var holdV = null;
      if (opts && opts.holdValue) {
        holdV = new Float64Array(K);
        for (var hi = 0; hi < K; hi++) holdV[hi] = holdBonus(game, seat, cands[hi]);
      }
      // ③ 상대 패 읽기: 이력에서 "각 좌석이 싱글에 패스한 최대 랭크" 추출 → 결정화 제약
      var constraints = (opts && opts.oppRead) ? { maxPassSingle: passConstraints(hist) } : null;
      // ④ 오라클 말단 평가(있으면 플레이아웃 대신). oracleMix는 안전판 — 그 비율만큼은 여전히
      //    실제 플레이아웃으로 재서, 가치망이 통째로 틀린 영역을 탐색이 물고 늘어지는 사고를 막는다.
      var oracle = (opts && opts.oracle) || null;
      var oracleMix = (opts && opts.oracleMix) || 0;
      var oppK = (opts && opts.oppK) || 0;   // 상대-연속 편향 제거: 상대 첫 K수만 신경망
      var outW = (opts && opts.outBonus) || 0;  // 5단 후보: 완주 순서 가중(평가 목표 재설계)
      var winW = (opts && opts.winCtx) || 0;
      var fastPol = (opts && opts.fastPol) || null;  // 5단 후보: 롤아웃 정책 증류본    // 5단 후보: 게임 승리 목적함수(점수 맥락 반영)
      var Q = new Float64Array(K), N = new Int32Array(K), totalN = 0;
      var deadline = Date.now() + budget, rep = 0;
      // 반복 상한: 플레이아웃(≈650µs)은 950ms에 1,500회라 2000이 안 걸리지만,
      // 오라클(≈100µs)은 2000에서 예산 대부분을 남기고 멈춘다. 오라클일 때만 상한을 푼다(1단 경로 불변).
      var repCap = (opts && opts.repCap) || (oracle ? 40000 : 2000);
      /* 시간 배분(opts.tm) — 결정의 57%가 사실상 확정인데(방문 pmax≥0.95) 균등하게 예산을 다 쓴다.
       * 확정된 결정은 일찍 끊고, 아낀 시간을 접전 결정(pmax<0.8, 전체의 19%)에 몰아준다.
       * 엔진 최적화와 달리 이건 단별로 켜고 끌 수 있어 상대 재료가 된다.
       * tm = { bank: {ms:0}, checkAt: 0.35, stopShare: 0.90, stopMargin: 0.55, maxExtra: 1.5 }
       *   checkAt   예산의 이 비율 시점에 조기중단 판정
       *   stopShare 선두 후보 방문 점유가 이 값 이상이면 확정으로 보고 중단
       *   stopMargin 선두-2위 점유 차가 이 값 이상이어야 중단(둘 다 만족해야)
       *   maxExtra  접전이면 은행에서 예산의 이 배수까지 추가로 꺼내 쓴다 */
      var tm = (opts && opts.tm) || null;
      var tmCheck = tm ? Date.now() + budget * (tm.checkAt || 0.35) : 0;
      var tmDone = false, tmStart = Date.now();
      while (Date.now() < deadline && rep < repCap) {
        if (tm && !tmDone && Date.now() >= tmCheck) {
          tmDone = true;
          var s1 = -1, s2 = -1;                       // 1·2위 방문수
          for (var ti = 0; ti < K; ti++) { var nv = N[ti]; if (nv > s1) { s2 = s1; s1 = nv; } else if (nv > s2) s2 = nv; }
          var share = totalN > 0 ? s1 / totalN : 0;
          var marg = totalN > 0 ? (s1 - Math.max(0, s2)) / totalN : 0;
          if (share >= (tm.stopShare || 0.90) && marg >= (tm.stopMargin || 0.55)) {
            if (tm.bank) tm.bank.ms += (deadline - Date.now());   // 남은 예산을 은행에
            break;                                                 // 확정 — 여기서 끊는다
          }
          /* 접전이면 은행에서 꺼내 예산을 늘린다. maxExtra=0이면 상한 없음 —
           * 어려운 한 수에 은행 전액을 쏟는다(사람이 결정적 국면에서 장고하는 것과 같다).
           * 총량은 은행이 스스로 제한한다(아낀 만큼만 쓴다) — 라운드 총 시간은 균등 배분 이하.
           * hardCap은 UX·서버 보호용 절대 벽(한 수가 몇 초씩 걸리면 게임이 멈춘 것처럼 보인다). */
          if (tm.bank && tm.bank.ms > 0) {
            var lim = tm.maxExtra ? budget * tm.maxExtra : tm.bank.ms;
            var extra = Math.min(tm.bank.ms, lim);
            if (tm.hardCap) extra = Math.min(extra, Math.max(0, tm.hardCap - budget));
            tm.bank.ms -= extra;
            deadline += extra;
          }
        }
        // PUCT 선택
        var best = -1, bv = -Infinity, sqrtT = Math.sqrt(totalN + 1);
        for (var i = 0; i < K; i++) {
          var u = c * probs[i] * sqrtT / (1 + N[i]);
          var q = N[i] ? Q[i] : 0; // 미방문은 Q=0(중립) — 탐험항이 첫 방문 유도
          if (q + u > bv) { bv = q + u; best = i; }
        }
        // 완전정보(투시) 모드 — 결정화 대신 실제 게임을 복제. 상대 패를 다 안다.
        // 3단 헤드룸 측정용: 투시 봇 vs 결정화 봇의 격차 = 불완전정보 처리의 상한.
        var det = (opts && opts.perfect) ? game.clone()
          : B.determinize(game, seat, constraints); // ③ 제약 반영 결정화
        var sim = det.clone ? det.clone() : B.cloneGame(det);
        var h2 = hist.slice();
        if (applyCand(sim, seat, cands[best], h2)) {
          var v = (oracle && (!oracleMix || RND() >= oracleMix))
            ? oracleEval(sim, seat, oracle)
            : (opts && opts.playout === 'neural')
              ? Math.max(-2, Math.min(2, neuralPlayout(sim, seat, h2, deadline) / 100))
              : Math.max(-2, Math.min(2, heuristicPlayout(sim, seat, deadline, oppK, h2, outW, winW, fastPol) / 100));
          if (holdV) v += holdV[best]; // 강카드 소비 억제 = 아끼기
          Q[best] += (v - Q[best]) / (N[best] + 1); // 러닝 평균
          N[best]++; totalN++;
        } else {
          Q[best] = -1e9; N[best]++; // 불법 수 배제
        }
        rep++;
      }
      // 계측: 결정당 시뮬 수. 이게 없으면 승단전 결과에서 "효과가 없다"와
      // "CPU가 굶어서 탐색이 아예 일어나지 않았다"를 구분할 수 없다.
      if (globalThis.__TICHU_STAT) { globalThis.__TICHU_STAT.sims += rep; globalThis.__TICHU_STAT.dec++; }
      // 최종: 최다 방문 (동률이면 Q 높은 쪽)
      /* 최종 선택 규칙(5단 후보). 현행은 최다 방문(robust) — AlphaZero 관행이다.
       * 미시도 대안: 충분히 방문된 후보 중 Q 최대. 방문수는 "탐험이 여기를 많이 봤다"는
       * 뜻이고 Q는 "실제로 좋았다"는 뜻인데, 둘이 갈릴 때 현행은 전자를 택한다.
       * 단조 변환이 아니라 선택 규칙 자체를 바꾸므로 발현이 보장된다(winCtx 교훈).
       * pickRule='maxq': N ≥ minFrac × maxN 인 후보 중 Q 최대. 방문 적은 요행을 배제. */
      var pick = 0, bn = -1;
      for (var j = 0; j < K; j++) {
        if (N[j] > bn || (N[j] === bn && Q[j] > Q[pick])) { bn = N[j]; pick = j; }
      }
      if (opts && opts.pickRule === 'maxq' && bn > 0) {
        var minN = bn * (opts.minFrac || 0.25), bq = -Infinity, pq = pick;
        for (var j2 = 0; j2 < K; j2++) {
          if (N[j2] >= minN && Q[j2] > bq) { bq = Q[j2]; pq = j2; }
        }
        pick = pq;
      }
      return ret(finishAction(game, seat, cands[pick]), cands,
        stats ? Array.prototype.slice.call(N) : null, stats ? Array.prototype.slice.call(Q) : null,
        stats ? Array.prototype.slice.call(probs) : null, totalN, rep, pick);
    },

    // 1-ply 오라클 그리디 (3단 게이트) — 탐색 없이 argmax_a V_oracle(s⊕a).
    // 후보-baseline 어드밴티지의 고정점. 이게 2단을 이기면 그걸 정책에 증류하면 3단.
    decideOracle1ply: function (game, seat, hist, opts) {
      var oracle = opts && opts.oracle;
      var cc = candsOf(game, seat);
      var cands = cc.cands;
      if (!cands.length) return { type: 'pass_turn', seat: seat };
      if (cands.length === 1) return finishAction(game, seat, cands[0]);
      var best = 0, bv = -Infinity;
      for (var i = 0; i < cands.length; i++) {
        var sim = game.clone(), h2 = hist.slice();
        if (!applyCand(sim, seat, cands[i], h2)) continue;
        // 내 수 직후 국면을 오라클로 평가(내 좌석 관점). 중간 국면은 oracleEval이 play로 되돌림.
        var v = oracleEval(sim, seat, oracle);
        if (v > bv) { bv = v; best = i; }
      }
      return finishAction(game, seat, cands[best]);
    },

    // ⑥ 롤아웃 티츄 선언 (2단 후보) — 손패 점수 임계값 대신 "먼저 나갈 확률"을 실제로 세어본다.
    //
    // 티츄는 맞으면 +100, 틀리면 −100이라 판돈이 카드 한 장 고르기(측정 5점)의 40배다.
    // 그런데 1단은 선언망의 손패 점수 하나로 결정하고, 그 추정은 롤아웃 참값과 상관 0.657에
    // 분포가 절반으로 눌려 있다(sd 0.133 vs 0.263) → 손패의 3%에서만 선언한다.
    // 실제로 먼저 나가는 손패는 23%다. 사실상 "티츄를 안 하는 봇"이다.
    //
    // 주의: 롤아웃 정책이 보통봇이라 p에 체계적 편향이 있다(내가 실제보다 약하게 두고,
    // 상대는 내 티츄를 저지하지 않는다). 카드 놓기와 달리 여기서는 p>임계 하나로 결정이 갈려
    // 편향이 평균으로 지워지지 않는다. 그래서 calA/calB로 선형 보정하고 임계값을 따로 둔다.
    declareTichu: function (game, seat, opts) {
      var budget = (opts && opts.budgetMs) || 200;
      var th = (opts && opts.th != null) ? opts.th : 0.5;
      var maxN = (opts && opts.maxN) || 600;
      var calA = (opts && opts.calA != null) ? opts.calA : 0;   // p_보정 = calA + calB·p_롤아웃
      var calB = (opts && opts.calB != null) ? opts.calB : 1;
      var deadline = Date.now() + budget, hit = 0, n = 0;
      while (Date.now() < deadline && n < maxN) {
        var det = B.determinize(game, seat);
        var sim = det.clone ? det.clone() : B.cloneGame(det);
        if (!sim.apply({ type: 'call_tichu', seat: seat }).ok) sim.tichu[seat] = 100;
        var guard = 0;
        // 누가 먼저 나갔는지만 알면 되므로 firstOutSeat가 정해지는 즉시 중단 — 롤아웃 비용 절반
        while (sim.firstOutSeat == null && sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd' && ++guard < 2000) {
          var w = sim.waitingOn(); if (!w.length) break;
          var a = B.botDecide(sim, w[0], 'normal');
          if (!a || !sim.apply(a).ok) break;
        }
        if (sim.firstOutSeat === seat) hit++;
        n++;
      }
      var p = n ? hit / n : 0;
      var pc = Math.max(0, Math.min(1, calA + calB * p));
      return { p: p, pCal: pc, n: n, declare: pc >= th };
    },

    // ⑤ Sequential Halving 뿌리 배분 (2단 후보) — PUCT와 같은 부품, 예산 배분만 다르다.
    //
    // 왜 바꾸는가: 뿌리에서 우리가 원하는 건 "탐색이 끝났을 때 최선을 고르는 것"(단순 후회)이지
    // "탐색 도중 나쁜 수를 적게 두는 것"(누적 후회)이 아니다. 도중에 뭘 시뮬하든 대가가 없다.
    // PUCT는 후자에 맞춰져 있어, 프라이어가 확신하면(측정 pmax 0.726) 예산의 84%를 1위에 쏟고
    // 2위는 2.7%만 받는다 → 2위의 Q가 부정확해 "정말 1위가 맞나"를 판정하지 못한다.
    // (측정: 1위-2위 격차의 z 중앙값 1.73, 국면의 30%가 z<1 = 사실상 동전던지기)
    //
    // SH는 라운드마다 하위 절반을 탈락시키고 남은 후보에 예산을 몰아준다.
    // K=7이면 3라운드, 최종 상위 2후보가 각각 ~620시뮬 → 격차 표준오차 0.107→0.045.
    decideSH: function (game, seat, hist, opts) {
      var budget = (opts && opts.budgetMs) || 950;
      var cc = candsOf(game, seat);
      var cands = cc.cands;
      if (!cands.length) return { type: 'pass_turn', seat: seat };
      if (cands.length === 1) return finishAction(game, seat, cands[0]);
      var K = cands.length, i;
      var probs = net.probsRecord(net.makeRecord(game, seat, cands, hist));
      var temp = (opts && opts.temp) ? opts.temp : 1;
      if (temp !== 1) {
        var tS = 0;
        for (i = 0; i < K; i++) { probs[i] = Math.pow(probs[i], 1 / temp); tS += probs[i]; }
        for (i = 0; i < K; i++) probs[i] /= tS;
      }
      // 프라이어 사전 가지치기(선택) — SH는 프라이어를 안 쓰므로, 정말 가망 없는 후보만 미리 뺀다
      var keepP = (opts && opts.keepP != null) ? opts.keepP : 0;
      var mx = 0;
      for (i = 0; i < K; i++) if (probs[i] > mx) mx = probs[i];
      var alive = [];
      for (i = 0; i < K; i++) if (!keepP || probs[i] >= mx * keepP) alive.push(i);
      if (alive.length < 2) { alive = []; for (i = 0; i < K; i++) alive.push(i); }

      var lambda = (opts && opts.lambda != null) ? opts.lambda : 0; // 순위에 프라이어를 섞는 정도
      var holdV = null;
      if (opts && opts.holdValue) {
        holdV = new Float64Array(K);
        for (i = 0; i < K; i++) holdV[i] = holdBonus(game, seat, cands[i]);
      }
      var oracle = (opts && opts.oracle) || null;
      var Q = new Float64Array(K), N = new Int32Array(K), dead = {};

      function evalIn(det, ci, deadline) {
        var sim = det.clone ? det.clone() : B.cloneGame(det);
        var h2 = hist.slice();
        if (!applyCand(sim, seat, cands[ci], h2)) { dead[ci] = 1; return; }
        var v = oracle ? oracleEval(sim, seat, oracle)
                       : Math.max(-2, Math.min(2, heuristicPlayout(sim, seat, deadline) / 100));
        if (holdV) v += holdV[ci];
        Q[ci] += (v - Q[ci]) / (N[ci] + 1);
        N[ci]++;
      }
      // 공통난수(CRN): 세계를 하나 뽑아 살아있는 후보 전부를 그 안에서 평가한다.
      // 후보마다 다른 세계를 뽑으면 "후보 차이"에 "세계 차이"가 섞인다. 같은 세계를 공유하면
      // 그 부분이 상쇄된다 — 실측 세계 내 상관 0.612, 비교 분산 2.67배 감소, 비용은 오히려 감소
      // (결정화 K회 → 1회). 챔피언+(decidePlus)는 원래 이 성질을 갖고 있었고 PUCT가 잃었다.
      function simWorld(deadline) {
        var det = B.determinize(game, seat);
        for (var ai = 0; ai < alive.length; ai++) evalIn(det, alive[ai], deadline);
      }
      function rank(a, b) {                       // 큰 쪽이 앞
        var sa = (N[a] ? Q[a] : -1e9) + lambda * Math.log(Math.max(probs[a], 1e-6));
        var sb = (N[b] ? Q[b] : -1e9) + lambda * Math.log(Math.max(probs[b], 1e-6));
        if (dead[a]) sa = -1e18;
        if (dead[b]) sb = -1e18;
        return sb - sa;
      }

      var crn = !(opts && opts.crn === false);
      var t0 = Date.now();
      var R = Math.max(1, Math.ceil(Math.log(alive.length) / Math.LN2));
      var perSim = 0.7;                            // 시뮬 1회 예상 ms — 실측으로 갱신
      for (var r = 0; r < R && alive.length > 1; r++) {
        var roundEnd = t0 + budget * (r + 1) / R;
        if (crn) {
          // 끝까지 못 돌 세계는 아예 시작하지 않는다 — 후보별 N이 어긋나면 짝지음이 깨져 이득이 사라진다
          while (Date.now() + alive.length * perSim < roundEnd) {
            var tw = Date.now();
            simWorld(roundEnd);
            perSim = perSim * 0.7 + ((Date.now() - tw) / alive.length) * 0.3;
          }
        } else {
          var turn = 0;
          while (Date.now() < roundEnd) { evalIn(B.determinize(game, seat), alive[turn % alive.length], roundEnd); turn++; }
        }
        alive.sort(rank);
        alive = alive.slice(0, Math.max(1, Math.ceil(alive.length / 2)));
      }
      if (globalThis.__TICHU_STAT) {
        var tot = 0; for (var qi = 0; qi < K; qi++) tot += N[qi];
        globalThis.__TICHU_STAT.sims += tot; globalThis.__TICHU_STAT.dec++;
      }
      var order = alive.slice().sort(rank);
      return finishAction(game, seat, cands[order[0]]);
    },

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
