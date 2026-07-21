/* 규칙 엔진 엣지 케이스 픽스처 — node test/run-tests.js 로 실행 */
'use strict';
var C = require('../shared/tichu-core.js');
var B = require('../shared/bots.js');

var count = 0;
function eq(actual, expected, msg) {
  count++;
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error('FAIL [' + msg + '] got ' + a + ' want ' + e);
}
function truthy(v, msg) { count++; if (!v) throw new Error('FAIL [' + msg + '] falsy'); }
function applyOk(g, a, msg) {
  var r = g.apply(a);
  if (!r.ok) throw new Error('FAIL [' + msg + '] 거부됨: ' + r.error.code + ' ' + r.error.message);
  return r;
}
function applyErr(g, a, code, msg) {
  var r = g.apply(a);
  count++;
  if (r.ok) throw new Error('FAIL [' + msg + '] 거부돼야 하는데 통과');
  if (r.error.code !== code) throw new Error('FAIL [' + msg + '] 에러코드 ' + r.error.code + ' (기대: ' + code + ')');
}

// play 단계 시나리오 빌더 — 필요한 필드만 덮어쓰기
function scenario(over) {
  var g = new C.Game({ seed: 42 });
  g.phase = 'play';
  g.grandAnswered = [true, true, true, true];
  g.exchangeGive = [{}, {}, {}, {}];
  g.exchangeReceived = [[], [], [], []];
  g._restDeck = [];
  g.hands = [[], [], [], []];
  g.tricksWon = [[], [], [], []];
  g.trick = [];
  g.trickPile = [];
  g.currentCombo = null;
  g.lastPlayerSeat = -1;
  g.turnSeat = 0;
  g.leaderSeat = 0;
  g.wish = null;
  g.tichu = [0, 0, 0, 0];
  g.playedFirst = [false, false, false, false];
  g.finished = [];
  g.firstOutSeat = null;
  g.dragonChooser = null;
  g._pendingRoundEnd = false;
  g.roundSummary = null;
  for (var k in over) g[k] = over[k];
  return g;
}

function drive(g, maxSteps) {
  var steps = 0;
  while (g.phase !== 'roundEnd' && g.phase !== 'gameEnd') {
    var w = g.waitingOn();
    if (!w.length) throw new Error('대기 좌석 없음 phase=' + g.phase);
    var a = B.botDecide(g, w[0]);
    if (!a) throw new Error('봇 액션 없음 phase=' + g.phase + ' seat=' + w[0]);
    applyOk(g, a, 'drive:' + a.type);
    if (++steps > maxSteps) throw new Error('스텝 초과');
  }
}

function runFixtures() {
  count = 0;
  var id = C.identify;

  // ---- 조합 판정 ----
  eq(id(['S5', 'H5']), { type: 'pair', rank: 5, length: 2 }, '페어');
  eq(id(['S9', 'H9', 'D9']), { type: 'triple', rank: 9, length: 3 }, '트리플');
  eq(id(['S9', 'H9', 'D9', 'C9']), { type: 'bomb4', rank: 9, length: 4 }, '포카드 폭탄');
  eq(id(['S9', 'H9', 'D9', 'S4', 'H4']), { type: 'fullhouse', rank: 9, length: 5 }, '풀하우스');
  eq(id(['MJ', 'S2', 'H3', 'D4', 'C5']), { type: 'straight', rank: 5, length: 5 }, '마작 스트레이트');
  eq(id(['H3', 'H4', 'H5', 'H6', 'H7']), { type: 'bombstraight', rank: 7, length: 5 }, '스트플 폭탄');
  eq(id(['H3', 'S4', 'H5', 'H6', 'H7']), { type: 'straight', rank: 7, length: 5 }, '혼합 스트레이트');
  eq(id(['S7', 'H7', 'S8', 'H8']), { type: 'pairseq', rank: 8, length: 4 }, '연속 페어');
  eq(id(['S7', 'H7', 'S9', 'H9']), null, '비연속 페어쌍 무효');
  eq(id(['S2', 'H3']), null, '잡카드 무효');
  eq(id(['DG']), { type: 'dog', rank: 0, length: 1 }, '개 단독');
  eq(id(['DG', 'S2']), null, '개+카드 무효');
  eq(id(['DR']), { type: 'single', rank: 15, length: 1 }, '용 단독');
  eq(id(['DR', 'S2']), null, '용+카드 무효');

  // ---- 불사조 ----
  eq(id(['SA', 'PH']), { type: 'pair', rank: 14, length: 2 }, '불사조 페어 A');
  eq(id(['SK', 'HK', 'PH']), { type: 'triple', rank: 13, length: 3 }, '불사조 트리플 K');
  eq(id(['S9', 'H9', 'PH', 'S4', 'H4']), { type: 'fullhouse', rank: 9, length: 5 }, '불사조 풀하우스 최대해석');
  eq(id(['S9', 'H9', 'D9', 'PH']), null, '불사조 폭탄 불가');
  eq(id(['S3', 'H4', 'D5', 'C6', 'PH']), { type: 'straight', rank: 7, length: 5 }, '불사조 스트레이트 상단연장');
  eq(id(['MJ', 'S2', 'H3', 'D4', 'PH']), { type: 'straight', rank: 5, length: 5 }, '마작+불사조 스트레이트');
  eq(id(['H3', 'H4', 'H5', 'H6', 'PH']).type, 'straight', '불사조 포함 시 스트플 아님');
  eq(id(['PH']), { type: 'single', rank: 'PH', length: 1 }, '불사조 단독 센티널');
  eq(id(['S7', 'H7', 'S8', 'PH']), { type: 'pairseq', rank: 8, length: 4 }, '불사조 연속페어');

  // ---- beats ----
  truthy(C.beats({ type: 'bomb4', rank: 5, length: 4 }, { type: 'single', rank: 14, length: 1 }), '폭탄>일반');
  truthy(C.beats({ type: 'bombstraight', rank: 7, length: 5 }, { type: 'bomb4', rank: 14, length: 4 }), '스트플>포카드');
  truthy(!C.beats({ type: 'bomb4', rank: 14, length: 4 }, { type: 'bombstraight', rank: 7, length: 5 }), '포카드<스트플');
  truthy(C.beats({ type: 'bombstraight', rank: 8, length: 6 }, { type: 'bombstraight', rank: 14, length: 5 }), '긴 스트플 승');
  truthy(!C.beats({ type: 'straight', rank: 9, length: 6 }, { type: 'straight', rank: 8, length: 5 }), '길이 다른 스트레이트 불가');
  truthy(!C.beats({ type: 'pair', rank: 9, length: 2 }, { type: 'single', rank: 2, length: 1 }), '타입 불일치 불가');

  // ---- genMoves 소원 강제 ----
  var gm = C.genMoves(['S3', 'S7', 'H7', 'D7', 'C7'], { type: 'single', rank: 10, length: 1 }, 7);
  truthy(gm.forced, '소원 강제 플래그');
  truthy(gm.moves.length >= 1 && gm.moves.every(function (m) {
    return m.cards.some(function (c) { return !C.isSpecial(c) && C.rankOf(c) === 7; });
  }), '강제 수는 전부 소원 숫자 포함');
  truthy(gm.moves.some(function (m) { return m.combo.type === 'bomb4'; }), '소원이 폭탄을 강제');

  // ---- 개: 파트너 완주 시 다음 사람에게 선 ----
  var g1 = scenario({
    hands: [['DG', 'S2'], ['H3', 'H4'], [], ['C5', 'C6']],
    finished: [2], firstOutSeat: 2, turnSeat: 0, leaderSeat: 0
  });
  applyOk(g1, { type: 'play_cards', seat: 0, cards: ['DG'] }, '개 플레이');
  eq(g1.turnSeat, 3, '개: 파트너(완주) 건너뛰고 3번에게 선');
  truthy(g1.tricksWon[2].indexOf('DG') >= 0, '개 카드는 파트너 더미로');

  // ---- 용 트릭 증정 ----
  var g2 = scenario({
    hands: [['DR', 'S2'], ['H3', 'H4'], ['C5', 'C6'], ['D8', 'D9']],
    turnSeat: 0, leaderSeat: 0
  });
  applyOk(g2, { type: 'play_cards', seat: 0, cards: ['DR'] }, '용 플레이');
  applyOk(g2, { type: 'pass_turn', seat: 1 }, '패스1');
  applyOk(g2, { type: 'pass_turn', seat: 2 }, '패스2');
  applyOk(g2, { type: 'pass_turn', seat: 3 }, '패스3');
  eq(g2.phase, 'dragon', '용 트릭 → 증정 단계');
  eq(g2.dragonChooser, 0, '증정자는 승자');
  applyErr(g2, { type: 'give_dragon', seat: 0, toSeat: 2 }, 'BAD_REQUEST', '파트너에게 증정 불가');
  applyOk(g2, { type: 'give_dragon', seat: 0, toSeat: 1 }, '상대에게 증정');
  truthy(g2.tricksWon[1].indexOf('DR') >= 0, '용 카드가 상대 더미로');
  eq(g2.phase, 'play', '증정 후 플레이 재개');
  eq(g2.turnSeat, 0, '선은 승자 유지');

  // ---- 불사조 싱글: K는 이기고 용은 못 이김 ----
  var g3 = scenario({
    hands: [['SK', 'S2'], ['PH', 'H4'], ['DR', 'C6'], ['D8', 'D9']],
    turnSeat: 0, leaderSeat: 0
  });
  applyOk(g3, { type: 'play_cards', seat: 0, cards: ['SK'] }, 'K 싱글');
  applyOk(g3, { type: 'play_cards', seat: 1, cards: ['PH'] }, '불사조가 K를 이김');
  eq(g3.currentCombo.rank, 13.5, '불사조 랭크 = 13.5');
  applyOk(g3, { type: 'play_cards', seat: 2, cards: ['DR'] }, '용이 불사조를 이김');
  applyErr(g3, { type: 'play_cards', seat: 3, cards: ['D8'] }, 'COMBO_TOO_LOW', '용 위에 일반 싱글 불가');
  var g3b = scenario({
    hands: [['S2', 'S3'], ['PH', 'H4'], ['C5', 'C6'], ['D8', 'D9']],
    currentCombo: { type: 'single', rank: 15, length: 1 },
    lastPlayerSeat: 0, trick: [{ seat: 0, cards: ['DR'] }], trickPile: ['DR'],
    hands_0_override: null, turnSeat: 1
  });
  applyErr(g3b, { type: 'play_cards', seat: 1, cards: ['PH'] }, 'COMBO_TOO_LOW', '불사조로 용 못 이김');

  // ---- 원투 피니시 ----
  var g4 = scenario({
    hands: [[], ['H3', 'H4'], ['S2'], ['C5', 'C6']],
    finished: [0], firstOutSeat: 0, turnSeat: 2, leaderSeat: 2
  });
  applyOk(g4, { type: 'play_cards', seat: 2, cards: ['S2'] }, '원투 마무리');
  eq(g4.phase, 'roundEnd', '원투 즉시 라운드 종료');
  eq(g4.roundSummary.oneTwoTeam, 'A', '원투 팀 A');
  eq(g4.roundSummary.deltas.teamA, 200, '원투 +200');
  eq(g4.roundSummary.cardPoints, null, '원투는 카드점수 없음');

  // ---- 소원 강제: 패스 불가, 폭탄으로 이행 ----
  var g5 = scenario({
    hands: [['SA'], ['S3', 'S7', 'H7', 'D7', 'C7'], ['HA'], ['DA']],
    currentCombo: { type: 'single', rank: 10, length: 1 },
    lastPlayerSeat: 0, trick: [{ seat: 0, cards: ['ST'] }], trickPile: ['ST'],
    wish: 7, turnSeat: 1
  });
  applyErr(g5, { type: 'pass_turn', seat: 1 }, 'WISH_REQUIRED', '소원 이행 가능 시 패스 불가');
  applyOk(g5, { type: 'play_cards', seat: 1, cards: ['S7', 'H7', 'D7', 'C7'] }, '폭탄으로 소원 이행');
  eq(g5.wish, null, '소원 해소');

  // ---- 막내 트릭/손패 처리 ----
  var g6 = scenario({
    hands: [[], [], ['S5'], ['H3', 'H4']],
    finished: [0, 1], firstOutSeat: 0,
    currentCombo: { type: 'single', rank: 2, length: 1 },
    lastPlayerSeat: 3, trick: [{ seat: 3, cards: ['D2'] }], trickPile: ['D2'],
    turnSeat: 2
  });
  applyOk(g6, { type: 'play_cards', seat: 2, cards: ['S5'] }, '3번째 완주');
  eq(g6.phase, 'roundEnd', '3명 완주 → 라운드 종료');
  eq(g6.roundSummary.cardPoints.teamA, 5, '진행 트릭은 현재 승자에게 (5점)');
  eq(g6.roundSummary.cardPoints.teamB, 0, '막내 손패(점수 0)는 상대팀에');
  eq(g6.roundSummary.cardPoints.teamA + g6.roundSummary.cardPoints.teamB, 5, '카드점수 합(부분 덱)');

  // ---- 티츄 보너스 ----
  var g7 = scenario({
    hands: [['S2'], ['H3', 'H9'], ['C4', 'C7'], ['D6', 'D9']],
    tichu: [100, 0, 0, 0], turnSeat: 0, leaderSeat: 0
  });
  applyOk(g7, { type: 'play_cards', seat: 0, cards: ['S2'] }, '티츄 선언자 1등');
  drive(g7, 100);
  truthy(g7.roundSummary, '라운드 종료');
  eq(g7.roundSummary.bonuses.length, 1, '보너스 1건');
  eq(g7.roundSummary.bonuses[0].seat, 0, '보너스 좌석');
  eq(g7.roundSummary.bonuses[0].made, true, '티츄 성공');
  eq(g7.roundSummary.bonuses[0].delta, 100, '+100');

  // ---- 티츄 실패 ----
  var g8 = scenario({
    hands: [['S2', 'S3'], ['H3'], ['C4', 'C7'], ['D6', 'D9']],
    tichu: [100, 0, 0, 0], turnSeat: 1, leaderSeat: 1
  });
  applyOk(g8, { type: 'play_cards', seat: 1, cards: ['H3'] }, '상대가 먼저 완주');
  drive(g8, 100);
  eq(g8.roundSummary.bonuses[0].made, false, '티츄 실패');
  eq(g8.roundSummary.bonuses[0].delta, -100, '-100');

  // ---- 폭탄 끼어들기 (차례 밖) ----
  var g9 = scenario({
    hands: [['SA', 'S2'], ['H3', 'H4'], ['S7', 'H7', 'D7', 'C7'], ['D8', 'D9']],
    turnSeat: 0, leaderSeat: 0
  });
  applyOk(g9, { type: 'play_cards', seat: 0, cards: ['SA'] }, 'A 싱글');
  // 차례는 1이지만 2가 폭탄 끼어들기
  applyOk(g9, { type: 'play_cards', seat: 2, cards: ['S7', 'H7', 'D7', 'C7'] }, '차례 밖 폭탄');
  eq(g9.turnSeat, 3, '폭탄 후 차례는 폭탄자 다음');
  eq(g9.lastPlayerSeat, 2, '폭탄자가 현재 승자');
  applyErr(g9, { type: 'play_cards', seat: 0, cards: ['S2'] }, 'NOT_YOUR_TURN', '차례 밖 일반 카드 불가');

  // ---- 개 1:1: 어느 구성이든 자기 턴으로 복귀 ----
  var g12 = scenario({
    hands: [['DG', 'S2'], ['H3', 'H4'], [], []],
    finished: [3, 2], firstOutSeat: 3, turnSeat: 0, leaderSeat: 0
  });
  applyOk(g12, { type: 'play_cards', seat: 0, cards: ['DG'] }, '개 1:1 플레이');
  eq(g12.turnSeat, 0, '개 1:1(남은 상대=1번): 내 턴으로 복귀');

  var g13 = scenario({
    hands: [['DG', 'S2'], [], [], ['D8', 'D9']],
    finished: [1, 2], firstOutSeat: 1, turnSeat: 0, leaderSeat: 0
  });
  applyOk(g13, { type: 'play_cards', seat: 0, cards: ['DG'] }, '개 1:1 플레이(구성B)');
  eq(g13.turnSeat, 0, '개 1:1(남은 상대=3번): 내 턴으로 복귀');

  // ---- 개 3인 활동(1:2): 파트너 완주 시 다음 활동자에게 (기존 규칙 유지) ----
  var g13b = scenario({
    hands: [['DG', 'S2'], ['H3', 'H4'], [], ['D8', 'D9']],
    finished: [2], firstOutSeat: 2, turnSeat: 0, leaderSeat: 0
  });
  applyOk(g13b, { type: 'play_cards', seat: 0, cards: ['DG'] }, '개 플레이(3인 활동)');
  eq(g13b.turnSeat, 3, '개 1:2(파트너만 완주): 파트너 다음 순번에게');

  // ---- 개를 마지막 카드로 내고 완주: 1:1 규칙 미적용, 파트너에게 선 (턴 멈춤 방지) ----
  var g13c = scenario({
    hands: [['DG'], [], ['C5', 'C6'], ['D8', 'D9']],
    finished: [1], firstOutSeat: 1, turnSeat: 0, leaderSeat: 0
  });
  applyOk(g13c, { type: 'play_cards', seat: 0, cards: ['DG'] }, '개로 완주');
  eq(g13c.finished.indexOf(0) >= 0, true, '개로 완주 처리');
  eq(g13c.turnSeat, 2, '개 완주: 활동 중인 파트너에게 선');

  // ---- 용 트릭 자동 증정: 상대 1명 완주 시 남은 상대에게(선택창 없음) ----
  var g14 = scenario({
    hands: [['DR', 'S2'], [], ['C5', 'C6'], ['D8', 'D9']],
    finished: [1], firstOutSeat: 1, turnSeat: 0, leaderSeat: 0
  });
  applyOk(g14, { type: 'play_cards', seat: 0, cards: ['DR'] }, '용 플레이(상대 1명 완주)');
  applyOk(g14, { type: 'pass_turn', seat: 2 }, '패스');
  applyOk(g14, { type: 'pass_turn', seat: 3 }, '패스');
  eq(g14.phase, 'play', '용 자동 증정: 증정 단계 건너뜀');
  truthy(g14.tricksWon[3].indexOf('DR') >= 0, '용 트릭이 남은 상대에게 자동으로');
  eq(g14.lastAction.kind, 'dragon_give', '자동 증정 기록');
  truthy(g14.lastAction.auto, '자동 증정 플래그');
  eq(g14.turnSeat, 0, '선은 승자 유지');

  // ---- 용으로 3번째 완주(라운드 종료): 증정 단계 없이 자동 증정 후 종료 ----
  var g15 = scenario({
    hands: [['DR'], [], [], ['D8', 'D9']],
    finished: [1, 2], firstOutSeat: 1, turnSeat: 0, leaderSeat: 0
  });
  applyOk(g15, { type: 'play_cards', seat: 0, cards: ['DR'] }, '용으로 완주');
  eq(g15.phase, 'roundEnd', '용 완주: 증정 대기 없이 라운드 종료');
  eq(g15.dragonChooser, null, '증정자 없음(자동)');
  truthy(g15.roundSummary, '라운드 결과 생성');

  // ---- 소원 지속: 아무도 이행 못 하고 트릭이 끝나도 소원 유지 ----
  var g16 = scenario({
    hands: [['MJ', 'S2', 'H3', 'D4', 'C5', 'S9'], ['H6', 'H7'], ['C6', 'C7'], ['D6', 'D7']],
    turnSeat: 0, leaderSeat: 0
  });
  applyOk(g16, { type: 'play_cards', seat: 0, cards: ['MJ', 'S2', 'H3', 'D4', 'C5'], wish: 13 }, '1 스트레이트+소원 K');
  eq(g16.wish, 13, '소원 등록');
  applyOk(g16, { type: 'pass_turn', seat: 1 }, '이행 불가 → 패스 허용');
  applyOk(g16, { type: 'pass_turn', seat: 2 }, '패스');
  applyOk(g16, { type: 'pass_turn', seat: 3 }, '패스');
  eq(g16.turnSeat, 0, '트릭 승자 재리드');
  eq(g16.wish, 13, '트릭이 끝나도 소원 유지');

  // ---- 직렬화 왕복 ----
  var g10 = new C.Game({ seed: 7 });
  var j = g10.toJSON();
  var g10b = C.Game.fromJSON(j);
  eq(JSON.stringify(g10b.toJSON()), JSON.stringify(j), '직렬화 왕복 동일');
  applyOk(g10b, { type: 'call_grand', seat: 0, call: false }, '복원본 동작');

  // ---- viewFor 정보 은닉 ----
  var g11 = new C.Game({ seed: 9 });
  var v = g11.viewFor(0);
  eq(v.you.hand.length, 8, '그랜드 단계 8장');
  truthy(!JSON.stringify(v.seats).match(/"hand"/), '다른 좌석 손패 미포함');
  eq(v.seats[1].handCount, 8, '장수만 공개');

  return count;
}

module.exports = { runFixtures: runFixtures };
