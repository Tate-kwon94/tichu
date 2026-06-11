/* 시드 봇 자가대전 시뮬레이션 — invariant 검사 */
'use strict';
var C = require('../shared/tichu-core.js');
var B = require('../shared/bots.js');

// 56장 보존 + 중복 없음 (라운드 진행 중 모든 구역 합산)
function checkConservation(g, ctx) {
  var all = [];
  for (var s = 0; s < 4; s++) {
    all = all.concat(g.hands[s], g.tricksWon[s]);
  }
  all = all.concat(g.trickPile, g._restDeck || []);
  if (all.length !== 56) throw new Error('카드 수 ' + all.length + ' (' + ctx + ')');
  var set = {};
  for (var i = 0; i < all.length; i++) {
    if (set[all[i]]) throw new Error('카드 중복 ' + all[i] + ' (' + ctx + ')');
    set[all[i]] = true;
  }
}

// 생성된 합법 수가 전부 판정기를 통과하는지 (샘플 검사)
function checkMoves(g, ctx) {
  if (g.phase !== 'play' || g.turnSeat < 0) return;
  var s = g.turnSeat;
  var ms = C.genMoves(g.hands[s], g.currentCombo, g.wish).moves;
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    if (m.combo.type === 'dog') continue;
    if (m.cards.length === 1 && m.cards[0] === 'PH') continue; // 센티널은 엔진에서 확정
    var idc = C.identify(m.cards);
    if (!idc) throw new Error('생성 수 무효 ' + m.cards.join(',') + ' (' + ctx + ')');
    if (idc.type !== m.combo.type || idc.length !== m.combo.length)
      throw new Error('생성 수 해석 불일치 ' + m.cards.join(',') + ' (' + ctx + ')');
    if (idc.rank < m.combo.rank) throw new Error('해석 랭크 역전 ' + m.cards.join(',') + ' (' + ctx + ')');
    if (g.currentCombo && !C.beats(m.combo, g.currentCombo))
      throw new Error('beats 불일치 ' + m.cards.join(',') + ' (' + ctx + ')');
  }
}

function botStep(g, ctx) {
  var w = g.waitingOn();
  if (!w.length) throw new Error('대기 좌석 없음 phase=' + g.phase + ' (' + ctx + ')');
  var s = w[0];
  var a = null;
  // 플레이 직전 티츄 기회
  if (g.phase === 'play' && !g.playedFirst[s] && !g.tichu[s] && g.turnSeat === s && B.botTichu(g.hands[s])) {
    a = { type: 'call_tichu', seat: s };
  } else {
    a = B.botDecide(g, s);
  }
  if (!a) throw new Error('봇 액션 없음 phase=' + g.phase + ' seat=' + s + ' (' + ctx + ')');
  var r = g.apply(a);
  if (!r.ok) throw new Error('액션 거부 ' + a.type + ' → ' + r.error.code + ' ' + r.error.message + ' (' + ctx + ')');
  return a;
}

function runRounds(N, seedBase) {
  var rounds = 0, games = 0, oneTwos = 0, tichuCalls = 0, tichuMade = 0,
      grandCalls = 0, steps = 0, sampled = 0;
  while (rounds < N) {
    var seed = (seedBase + games) | 0;
    var g = new C.Game({ seed: seed });
    games++;
    var guard = 0;
    for (;;) {
      var ctx = 'seed=' + seed + ' round=' + g.round;
      if (g.phase === 'roundEnd' || g.phase === 'gameEnd') {
        var sum = g.roundSummary;
        if (!sum) throw new Error('roundSummary 없음 (' + ctx + ')');
        if (sum.oneTwoTeam) {
          oneTwos++;
        } else {
          var tot = sum.cardPoints.teamA + sum.cardPoints.teamB;
          if (tot !== 100) throw new Error('카드점수 합 ' + tot + ' (' + ctx + ')');
        }
        sum.bonuses.forEach(function (b) {
          tichuCalls++;
          if (b.call === 'grand') grandCalls++;
          if (b.made) tichuMade++;
        });
        rounds++;
        guard = 0;
        if (g.phase === 'gameEnd' || rounds >= N) break;
        var rr = g.apply({ type: 'next_round' });
        if (!rr.ok) throw new Error('next_round 실패 (' + ctx + ')');
        continue;
      }
      botStep(g, ctx);
      steps++;
      checkConservation(g, ctx);
      if (steps % 37 === 0) { checkMoves(g, ctx); sampled++; }
      if (++guard > 3000) throw new Error('라운드 미종료 — 무한루프 의심 (' + ctx + ')');
    }
  }
  return { rounds: rounds, games: games, oneTwos: oneTwos, tichuCalls: tichuCalls,
           tichuMade: tichuMade, grandCalls: grandCalls, steps: steps, sampled: sampled };
}

// 직렬화 왕복: 같은 액션을 원본/복원본에 적용하며 매 스텝 상태 일치 확인
function testSerialization(seed) {
  var g = new C.Game({ seed: seed });
  var g2 = C.Game.fromJSON(g.toJSON());
  var steps = 0;
  while (g.phase !== 'gameEnd' && steps < 5000) {
    var a;
    if (g.phase === 'roundEnd') {
      if (g.round >= 3) break; // 3라운드면 충분
      a = { type: 'next_round' };
    } else {
      var w = g.waitingOn();
      a = B.botDecide(g, w[0]);
    }
    var r1 = g.apply(a);
    var r2 = g2.apply(JSON.parse(JSON.stringify(a)));
    if (r1.ok !== r2.ok) throw new Error('직렬화: 적용 결과 불일치 step=' + steps);
    var s1 = JSON.stringify(g.toJSON()), s2 = JSON.stringify(g2.toJSON());
    if (s1 !== s2) throw new Error('직렬화: 상태 불일치 step=' + steps + ' action=' + a.type);
    if (steps % 97 === 0) g2 = C.Game.fromJSON(JSON.parse(s2)); // 중간 재복원
    steps++;
  }
  if (steps < 50) throw new Error('직렬화 테스트 스텝 부족: ' + steps);
  return steps;
}

module.exports = { runRounds: runRounds, testSerialization: testSerialization,
                   checkConservation: checkConservation };
