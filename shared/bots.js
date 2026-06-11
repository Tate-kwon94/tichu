/*
 * 티츄 AI 봇 — 휴리스틱 기반, 결정론적(같은 상태 → 같은 수)
 * 서버(빈자리 채움)와 클라이언트(혼자 연습) 공용 (UMD)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tichu-core.js'));
  else root.TichuBots = factory(root.TichuCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
'use strict';

var genMoves = C.genMoves, isSpecial = C.isSpecial, isBomb = C.isBomb,
    rankOf = C.rankOf, sumPoints = C.sumPoints, partnerOf = C.partnerOf,
    teamOf = C.teamOf, sortHand = C.sortHand;

// ---------- 선언 판단 ----------
function strength(hand) {
  var s = 0;
  for (var i = 0; i < hand.length; i++) {
    var id = hand[i];
    if (id === 'DR') s += 3;
    else if (id === 'PH') s += 2.5;
    else {
      var r = rankOf(id);
      if (r === 14) s += 2;
      else if (r === 13) s += 0.7;
    }
  }
  return s;
}
function countRank(hand, r) {
  var c = 0;
  for (var i = 0; i < hand.length; i++) if (!isSpecial(hand[i]) && rankOf(hand[i]) === r) c++;
  return c;
}
// 손에서 폭탄(포카드/스트레이트플러시)을 이루는 카드 ID 집합 — 분해 방지용
function bombCards(hand) {
  var set = {}, by = {};
  hand.forEach(function (id) { if (!isSpecial(id)) { var r = rankOf(id); (by[r] = by[r] || []).push(id); } });
  Object.keys(by).forEach(function (r) { if (by[r].length === 4) by[r].forEach(function (id) { set[id] = true; }); });
  genMoves(hand, null, null).moves.forEach(function (m) {
    if (m.combo.type === 'bombstraight') m.cards.forEach(function (id) { set[id] = true; });
  });
  return set;
}
function hasBomb(hand) {
  var by = {};
  hand.forEach(function (id) { if (!isSpecial(id)) { var r = rankOf(id); by[r] = (by[r] || 0) + 1; } });
  for (var r in by) if (by[r] === 4) return true;
  var ms = genMoves(hand, null, null).moves;
  for (var i = 0; i < ms.length; i++) if (ms[i].combo.type === 'bombstraight') return true;
  return false;
}
// 그랜드는 8장만 보고 ±200 — 매우 강한 손에만 (과다 선언이 성공률을 떨어뜨림)
function botGrand(hand8) {
  var s = strength(hand8), aces = countRank(hand8, 14), dragon = hand8.indexOf('DR') >= 0;
  return s >= 8 || (dragon && aces >= 2) || (s >= 7 && hasBomb(hand8));
}
function botTichu(hand14) { return strength(hand14) + (hasBomb(hand14) ? 4 : 0) >= 10; }

// ---------- 교환 ----------
// 상대(좌/우)에게 최저 카드 + 마작/개 떠넘기기, 파트너에게 가장 강한 카드(용/불사조는 보유)
function botExchange(game, seat) {
  var hand = sortHand(game.hands[seat]); // 오름차순
  var left = (seat + 1) % 4, right = (seat + 3) % 4, partner = partnerOf(seat);
  var give = {}, used = {};
  // 상대 둘: 마작(선 강제 떠넘기기)·개 우선, 그다음 최저 일반 카드
  var opp = [];
  if (hand.indexOf('MJ') >= 0) opp.push('MJ');
  if (hand.indexOf('DG') >= 0) opp.push('DG');
  for (var i = 0; i < hand.length && opp.length < 2; i++) {
    if (!isSpecial(hand[i]) && opp.indexOf(hand[i]) < 0) opp.push(hand[i]);
  }
  give[left] = opp[0]; used[opp[0]] = 1;
  give[right] = opp[1]; used[opp[1]] = 1;
  // 파트너: 가장 높은 일반 카드 (용·불사조는 내가 쥔다)
  var pc = null;
  for (var j = hand.length - 1; j >= 0; j--) {
    if (!used[hand[j]] && !isSpecial(hand[j])) { pc = hand[j]; break; }
  }
  if (!pc) { for (var k = 0; k < hand.length; k++) if (!used[hand[k]]) { pc = hand[k]; break; } } // 폴백
  give[partner] = pc;
  return give;
}

// ---------- 소원 선택: 내게 없는 높은 숫자 ----------
function botWish(handAfterPlay) {
  var have = {};
  handAfterPlay.forEach(function (id) { if (!isSpecial(id)) have[rankOf(id)] = true; });
  for (var r = 14; r >= 2; r--) if (!have[r]) return r;
  return null;
}

// ---------- 용 증정: 손패 많은 상대에게 ----------
function botDragon(game, seat) {
  var a = (seat + 1) % 4, b = (seat + 3) % 4;
  return game.hands[a].length >= game.hands[b].length ? a : b;
}

// ---------- 플레이 ----------
// move가 보호 대상(폭탄 구성) 카드를 비폭탄 수로 분해하면 true
function breaksBomb(m, protect) {
  if (!protect || isBomb(m.combo.type)) return false;
  for (var i = 0; i < m.cards.length; i++) if (protect[m.cards[i]]) return true;
  return false;
}
function leadValue(m, protect) {
  if (m.combo.type === 'dog') return -100; // 개는 일찍 처분
  var v = m.combo.rank * 2 - m.cards.length * 3;
  if (m.cards.indexOf('PH') >= 0) v += 12;
  if (m.cards.indexOf('DR') >= 0) v += 8;
  if (isBomb(m.combo.type)) v += 40; // 폭탄은 아껴두기
  if (breaksBomb(m, protect)) v += 25; // 폭탄 구성 카드 분해 회피
  return v;
}
function cheapest(moves, penalizeSpecials, protect) {
  var best = null, bv = Infinity;
  for (var i = 0; i < moves.length; i++) {
    var m = moves[i];
    var v = m.combo.rank;
    if (penalizeSpecials) {
      if (m.cards.indexOf('PH') >= 0) v += 6;
      if (m.cards.indexOf('DR') >= 0) v += 4;
    }
    if (isBomb(m.combo.type)) v += 20;
    if (breaksBomb(m, protect)) v += 30; // 폭탄을 푼돈 수로 찢지 않기
    if (v < bv) { bv = v; best = m; }
  }
  return best;
}
// 반환: {cards} (낼 수) | null (패스)
function botPlay(game, seat) {
  var hand = game.hands[seat];
  var cur = game.currentCombo;
  var g = genMoves(hand, cur, game.wish);
  var moves = g.moves;
  if (!moves.length) return null;
  var protect = bombCards(hand); // 폭탄 구성 카드 — 함부로 분해하지 않음
  var finishers = moves.filter(function (m) { return m.cards.length === hand.length; });

  if (!cur) { // 리드
    if (finishers.length) return finishers[0];
    var best = null, bv = Infinity;
    for (var i = 0; i < moves.length; i++) {
      var v = leadValue(moves[i], protect);
      if (v < bv) { bv = v; best = moves[i]; }
    }
    return best;
  }
  if (g.forced) return cheapest(moves, false, protect); // 소원 의무는 최저로 이행

  var partnerWinning = game.lastPlayerSeat === partnerOf(seat);
  if (finishers.length && !partnerWinning) return finishers[0];
  if (partnerWinning) {
    if (finishers.length && hand.length <= 4) return finishers[0];
    if (cur.rank >= 10 || isBomb(cur.type)) return null; // 파트너가 세게 이기는 중 — 양보
  }
  var nonBomb = moves.filter(function (m) { return !isBomb(m.combo.type); });
  var trickPts = sumPoints(game.trickPile);
  if (nonBomb.length) {
    var pick = cheapest(nonBomb, true, protect);
    // 푼돈 트릭에 비싼 카드 아끼기
    if (pick.combo.rank >= 14 && trickPts < 5 && hand.length > 7 && !partnerWinning) return null;
    return pick;
  }
  // 폭탄만 가능할 때: 점수가 크거나, 상대 티츄 저지, 또는 막판이면 사용
  var w = game.lastPlayerSeat;
  var enemyTichu = w >= 0 && teamOf(w) !== teamOf(seat) && game.tichu[w] > 0;
  if (trickPts >= 13 || enemyTichu || hand.length <= 6) return cheapest(moves, false);
  return null;
}

// ---------- 쉬움 난이도: 선언 안 함, 자주 패스, 무작위성 ----------
function botPlayEasy(game, seat) {
  var hand = game.hands[seat];
  var cur = game.currentCombo;
  var g = genMoves(hand, cur, game.wish);
  var moves = g.moves;
  if (!moves.length) return null;
  if (g.forced) return cheapest(moves, false); // 소원 의무는 지킴
  var sorted = moves.slice().sort(function (x, y) { return x.combo.rank - y.combo.rank; });
  if (!cur) {
    // 리드: 낮은 절반 중 무작위 (방향성 없는 플레이)
    var pool = sorted.filter(function (m) { return !isBomb(m.combo.type); });
    if (!pool.length) pool = sorted;
    pool = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)));
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (Math.random() < 0.3) return null; // 이길 수 있어도 종종 패스
  var nonBomb = sorted.filter(function (m) { return !isBomb(m.combo.type); });
  var pool2 = (nonBomb.length ? nonBomb : sorted).slice(0, 3);
  return pool2[Math.floor(Math.random() * pool2.length)];
}

// ---------- 통합 의사결정: 현재 상태에서 seat가 할 액션 ----------
function botDecide(game, seat, level) {
  var easy = level === 'easy';
  var phase = game.phase;
  if (phase === 'grand' && !game.grandAnswered[seat]) {
    return { type: 'call_grand', seat: seat, call: easy ? false : botGrand(game.hands[seat]) };
  }
  if (phase === 'exchange' && !game.exchangeGive[seat]) {
    if (!easy && !game.tichu[seat] && botTichu(game.hands[seat])) return { type: 'call_tichu', seat: seat };
    return { type: 'submit_exchange', seat: seat, give: botExchange(game, seat) };
  }
  if (phase === 'dragon' && game.dragonChooser === seat) {
    return { type: 'give_dragon', seat: seat, toSeat: botDragon(game, seat) };
  }
  if (phase === 'play' && game.turnSeat === seat && game.finished.indexOf(seat) < 0) {
    var mv = easy ? botPlayEasy(game, seat) : botPlay(game, seat);
    if (!mv) return { type: 'pass_turn', seat: seat };
    var a = { type: 'play_cards', seat: seat, cards: mv.cards };
    if (mv.cards.indexOf('MJ') >= 0) {
      var after = game.hands[seat].filter(function (id) { return mv.cards.indexOf(id) < 0; });
      var wsh = botWish(after);
      if (wsh) a.wish = wsh;
    }
    return a;
  }
  return null;
}

return {
  botGrand: botGrand,
  botTichu: botTichu,
  botExchange: botExchange,
  botWish: botWish,
  botDragon: botDragon,
  botPlay: botPlay,
  botDecide: botDecide,
  strength: strength,
  hasBomb: hasBomb
};
}));
