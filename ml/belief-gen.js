#!/usr/bin/env node
/* 믿음망 훈련 데이터 생성 — "미관측 카드가 세 상대 중 누구 손에 있나".
 *
 * 왜: PIN 곡선이 확정한 헤드룸(+5.6, 정확도 50% 지점)에 닿으려면 결정화 정확도를
 * 30%p 올려야 하는데, 개별 규칙 신호는 1%p도 못 움직였다(§1-8 ⑧). 남은 길은 학습.
 * 본 투자 전 선행 검증: 작은 학습 모델이 정확도를 실제로 얼마나 올리는지 잰다 —
 * PIN 곡선이 정확도→점수 환산표이므로 정확도만 재면 투자 가치가 판정된다.
 *
 * 라벨은 공짜다: 자가대전에서는 진짜 손패를 안다.
 * 특징은 관점 좌석이 실제로 관측 가능한 것만 쓴다(실전 투입 가능해야 하므로):
 * 손패 크기·교환으로 준 카드·선언×랭크·낮은싱글 패스 이력·소원 연역·플레이 평균 랭크.
 *
 * 모델: 조건부 로짓 — 카드마다 세 상대 좌석의 특징 φ(s,c)에 공유 가중치 w를 곱해
 * softmax. 출력 JSONL: {f:[[..],[..],[..]], y:0|1|2}
 *
 * 사용: node ml/belief-gen.js <시드시작> <게임수> <표본율> > out.jsonl
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var SEED0 = +process.argv[2] || 50000;
var NGAME = +process.argv[3] || 200;
var RATE = +process.argv[4] || 0.06;

function rankOfSafe(id) { return C.isSpecial(id) ? (id === 'DR' ? 15 : id === 'PH' ? 14.5 : id === 'MJ' ? 1 : 0) : C.rankOf(id); }

/* φ(s,c): 관점 v가 관측 가능한, 좌석 s가 카드 c를 들고 있을 신호들 */
function feat(g, v, s, c, st) {
  var r = rankOfSafe(c);
  var hi = r >= 11 ? 1 : 0, lo = (r > 0 && r <= 7) ? 1 : 0;
  var decl = (g.tichu[s] > 0 && g.finished.indexOf(s) < 0) ? 1 : 0;
  var gave = (g.exchangeGive[v] && g.exchangeGive[v][s] === c) ? 1 : 0;
  var passedBelow = (st.passLow[s] != null && !C.isSpecial(c) && r > st.passLow[s]) ? 1 : 0;
  var wishNo = (st.wishNo[s] && !C.isSpecial(c) && st.wishNo[s][r]) ? 1 : 0;
  var mean = st.playSum[s] ? st.playSum[s] / st.playCnt[s] / 14 : 0.5;
  return [
    g.hands[s].length / 14,        // 0 용량
    gave,                          // 1 교환 확정 정보
    decl * hi,                     // 2 선언 좌석 × 고랭크
    decl * lo,                     // 3 선언 좌석 × 저랭크
    decl * (c === 'DR' ? 1 : 0),   // 4 선언 × 용
    decl * (c === 'PH' ? 1 : 0),   // 5 선언 × 봉황
    passedBelow,                   // 6 낮은 싱글 패스 → 그보다 높은 싱글 없음(소프트)
    wishNo,                        // 7 소원 연역(하드에 가까움)
    mean * hi,                     // 8 지금까지 높은 카드를 내온 좌석 × 고랭크
    mean * lo,                     // 9              × 저랭크
    (g.playedFirst[s] ? 0 : 1) * hi// 10 아직 한 수도 안 낸 좌석 × 고랭크(정보 없음 표지)
  ];
}

var out = 0;
for (var gi = 0; gi < NGAME; gi++) {
  var g = new C.Game({ seed: SEED0 + gi, targetScore: 1000 });
  var st = { passLow: {}, wishNo: {}, playSum: [0,0,0,0], playCnt: [0,0,0,0] };
  var lastSingle = null, passRun = 0, wishLead = null;
  var guard = 0;
  while (!g.gameOver && g.phase !== 'roundEnd' && ++guard < 700) {
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    // 표본 추출: play 단계 결정 시점
    if (g.phase === 'play' && g.turnSeat === s && Math.random() < RATE) {
      var v = s;
      var opp = [0,1,2,3].filter(function (t) { return t !== v; });
      opp.forEach(function () {});
      // 미관측 카드 = 세 상대의 손패
      for (var oi = 0; oi < opp.length; oi++) {
        var os = opp[oi];
        for (var ci = 0; ci < g.hands[os].length; ci++) {
          var c = g.hands[os][ci];
          var rows = opp.map(function (t) { return feat(g, v, t, c, st); });
          var y = oi;
          console.log(JSON.stringify({ f: rows, y: y }));
          out++;
        }
      }
    }
    var a = B.botDecide(g, s, 'normal');
    if (!a || !g.apply(a).ok) break;
    // 관측 이력 갱신 (모든 좌석이 공유 관측)
    var la = g.lastAction;
    if (a.type === 'pass_turn') {
      if (lastSingle && lastSingle.r >= 2 && lastSingle.r <= 14) {
        if (st.passLow[s] == null || lastSingle.r < st.passLow[s]) st.passLow[s] = lastSingle.r;
      }
      if (++passRun >= 3) { lastSingle = null; passRun = 0; }
    } else if (a.type === 'play_cards' && la) {
      passRun = 0;
      if (la.combo) {
        if (la.combo.type === 'single') lastSingle = { r: la.combo.rank }; else lastSingle = null;
        (a.cards || []).forEach(function (id) {
          if (!C.isSpecial(id)) { st.playSum[s] += C.rankOf(id); st.playCnt[s]++; }
        });
        // 소원 연역: 소원이 걸린 채 리드(=직전이 트릭 시작) — 근사: 소원 활성 중 리드한 좌석
        if (g.wish && !g.currentCombo) { /* 트릭 종료 직후 */ }
      } else lastSingle = null;
      if (g.wish && la.combo && !C.isSpecial((a.cards||[])[0]||'')) {
        // 리드 여부는 currentCombo 직전 상태로 판정해야 하나 근사 생략 — wishNo는 별도 계산
      }
    }
    // 소원 연역(정확판): 소원이 살아 있고 방금 s가 리드했다면 s는 그 랭크가 없다
    if (g.wish && la && la.combo && g.trick && g.trick.length === 1) {
      (st.wishNo[s] = st.wishNo[s] || {})[g.wish] = 1;
    }
    if (g.phase === 'roundEnd' && !g.gameOver) {
      g.apply({ type: 'next_round' });
      st = { passLow: {}, wishNo: {}, playSum: [0,0,0,0], playCnt: [0,0,0,0] };
      lastSingle = null; passRun = 0;
    }
  }
}
console.error('생성 완료: ' + out + '건 (게임 ' + NGAME + ')');
