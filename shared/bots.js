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
    teamOf = C.teamOf, sortHand = C.sortHand, makeDeck = C.makeDeck;

// ---------- 카드 카운팅 (확정승 판정) ----------
// 미관측 집합: 전체 덱 − 내 손 − 이미 나온 카드 = 상대 3명 손에 남은 카드
function outstanding(game, seat) {
  var seen = {};
  game.hands[seat].forEach(function (id) { seen[id] = 1; });
  for (var s = 0; s < 4; s++) for (var i = 0; i < game.tricksWon[s].length; i++) seen[game.tricksWon[s][i]] = 1;
  for (var j = 0; j < game.trickPile.length; j++) seen[game.trickPile[j]] = 1;
  return makeDeck().filter(function (id) { return !seen[id]; });
}
// 싱글로 냈을 때 더 이상 아무도 못 이기는가(확정승)
function bossSingleRank(rank, out) {
  if (rank >= 15) return true;              // 용
  if (out.indexOf('DR') >= 0) return false; // 상대에 용
  if (out.indexOf('PH') >= 0) return false; // 불사조가 비-용 싱글을 모두 이김
  var mx = 0;
  for (var i = 0; i < out.length; i++) if (!isSpecial(out[i])) { var r = rankOf(out[i]); if (r > mx) mx = r; }
  return rank > mx;
}
function isBossCard(id, out) {
  if (id === 'DR') return true;
  if (isSpecial(id)) return false; // 마작·개·불사조는 단독 확정승 아님
  return bossSingleRank(rankOf(id), out);
}
// 확정승 싱글 보유 수(= 내가 통제 가능한 트릭 수 근사)
function controlCount(hand, out) {
  var c = 0;
  for (var i = 0; i < hand.length; i++) if (isBossCard(hand[i], out)) c++;
  return c;
}

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
// 티츄 가치 점수 — 1등 완주 가능성과 상관되게 측정 기반으로 가중
function tichuScore(hand) {
  var s = 0, aces = 0;
  if (hasBomb(hand)) s += 4;
  for (var i = 0; i < hand.length; i++) {
    var id = hand[i];
    if (id === 'DR') s += 1.6;
    else if (id === 'PH') s += 1.2;
    else if (!isSpecial(id)) {
      var r = rankOf(id);
      if (r === 14) { s += 2; aces++; }
      else if (r === 13) s += 1;
      else if (r === 12) s += 0.4;
      else if (r <= 6) s -= 0.25; // 저카드 부채
    }
  }
  if (aces >= 2) s += 1;
  return s;
}
function thresh(name, def) {
  try {
    var t = (typeof globalThis !== 'undefined') && globalThis.__TICHU_TH;
    return (t && t[name] != null) ? t[name] : def;
  } catch (e) { return def; }
}
// 라지(±200): 8장만 보고 매우 강할 때만. 스몰(±100): 적극적으로(성공률 ~61% 지점).
function botGrand(hand8) { return tichuScore(hand8) >= thresh('grand', 9.5); }
function botTichu(hand14) { return tichuScore(hand14) >= thresh('tichu', 8); }

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
function leadValue(m, protect, ctx) {
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
function lowestLead(moves, protect, ctx) {
  var best = null, bv = Infinity;
  for (var i = 0; i < moves.length; i++) {
    var v = leadValue(moves[i], protect, ctx);
    if (v < bv) { bv = v; best = moves[i]; }
  }
  return best;
}
function botPlay(game, seat) {
  var hand = game.hands[seat];
  var n = hand.length;
  var cur = game.currentCombo;
  var g = genMoves(hand, cur, game.wish);
  var moves = g.moves;
  if (!moves.length) return null;
  var protect = bombCards(hand); // 폭탄 구성 카드 — 함부로 분해하지 않음
  var partner = partnerOf(seat);
  // 파트너가 티츄를 불렀고 아직 아무도 완주 안 함 → 절대 1등으로 나가면 안 됨(파트너 티츄 보호)
  var protectPartner = game.tichu[partner] > 0 && game.firstOutSeat === null;
  var partnerOutFirst = game.firstOutSeat === partner;
  var iTichu = game.tichu[seat] > 0 && game.finished.indexOf(seat) < 0;

  // ---- 파트너 티츄 보호: 손을 비우거나 1장만 남기는 수만 금지(정상 플레이는 유지) ----
  if (protectPartner) {
    var safe = moves.filter(function (m) { return (n - m.cards.length) >= 2; });
    if (!cur) {
      var leadPool = safe.length ? safe : moves.filter(function (m) { return m.cards.length < n; });
      return lowestLead(leadPool.length ? leadPool : moves, protect);
    }
    if (!safe.length) return g.forced ? cheapest(moves, false, protect) : null;
    // 카드가 적으면(≤4) 트릭을 따지 않고 패스 — 선이 되어 1장으로 강제 완주되는 덫을 피함
    if (n <= 4) return g.forced ? cheapest(safe, false, protect) : null;
    moves = safe; // 그 외엔 정상 따라가기를 "안전한 수"에서만 수행 (싼 트릭은 능동적으로 따냄)
  }

  var finishers = moves.filter(function (m) { return m.cards.length === n; });
  // ---- 내가 티츄를 불렀으면 1등 완주를 최우선 ----
  if (iTichu && finishers.length && game.firstOutSeat === null) return finishers[0];
  // ---- 파트너가 1등 완주 → 즉시 2등 완주로 원투(+200) 추구 ----
  if (partnerOutFirst && finishers.length) return finishers[0];

  if (!cur) { // 리드
    if (finishers.length) return finishers[0];
    return lowestLead(moves, protect);
  }
  if (g.forced) return cheapest(moves, false, protect); // 소원 의무는 최저로 이행

  var partnerWinning = game.lastPlayerSeat === partner;
  if (finishers.length && !partnerWinning) return finishers[0];
  if (partnerWinning) {
    if (finishers.length && n <= 4) return finishers[0];
    if (cur.rank >= 10 || isBomb(cur.type)) return null; // 파트너가 세게 이기는 중 — 양보
  }
  var nonBomb = moves.filter(function (m) { return !isBomb(m.combo.type); });
  var trickPts = sumPoints(game.trickPile);
  if (nonBomb.length) {
    var pick = cheapest(nonBomb, true, protect);
    // 푼돈 트릭에 비싼 카드 아끼기
    if (pick.combo.rank >= 14 && trickPts < 5 && n > 7 && !partnerWinning) return null;
    return pick;
  }
  // 폭탄만 가능할 때: 점수가 크거나, 상대 티츄 저지, 또는 막판이면 사용
  var w = game.lastPlayerSeat;
  var enemyTichu = w >= 0 && teamOf(w) !== teamOf(seat) && game.tichu[w] > 0;
  if (trickPts >= 13 || enemyTichu || n <= 6) return cheapest(moves, false, protect);
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

// ---------- 탐색(몬테카를로) — 고수/악마 난이도 ----------
function cloneGame(game) { return C.Game.fromJSON(game.toJSON()); }
// 미관측 카드를 상대 손패 수에 맞춰 무작위 재분배(결정화)
function determinize(game, seat) {
  var g = cloneGame(game);
  var others = [], pool = [];
  for (var s = 0; s < 4; s++) if (s !== seat) { others.push(s); pool = pool.concat(g.hands[s]); }
  for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  var k = 0;
  for (var o = 0; o < others.length; o++) { var cnt = g.hands[others[o]].length; g.hands[others[o]] = pool.slice(k, k + cnt); k += cnt; }
  return g;
}
// 현재 상태에서 라운드 종료까지 휴리스틱('보통')으로 진행 → seat팀 점수차
function playout(g, myTeam) {
  var guard = 0;
  while (g.phase !== 'roundEnd' && g.phase !== 'gameEnd') {
    var w = g.waitingOn(); if (!w.length) break;
    var a = botDecide(g, w[0], 'normal'); if (!a) break;
    if (!g.apply(a).ok) break;
    if (++guard > 2000) break;
  }
  if (!g.roundSummary) return 0;
  var d = g.roundSummary.deltas;
  return myTeam === 0 ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
}
// 후보 수(낼 수 + 패스)를 N회 플레이아웃해 평균 점수가 가장 좋은 수 선택. 시간예산 budgetMs.
function searchMove(game, seat, opts) {
  var gm = genMoves(game.hands[seat], game.currentCombo, game.wish);
  var moves = gm.moves;
  if (!moves.length) return { pass: true };
  if (moves.length === 1 && !game.currentCombo) return { play: moves[0] };
  var cands = moves.map(function (m) { return { play: m }; });
  if (game.currentCombo && !gm.forced) cands.push({ pass: true }); // 따라갈 땐 패스도 후보
  var myTeam = teamOf(seat);
  var totals = cands.map(function () { return 0; }), counts = cands.map(function () { return 0; });
  var t0 = Date.now(), reps = 0;
  for (var rep = 0; rep < opts.samples; rep++) {
    if (Date.now() - t0 > opts.budgetMs) break;
    var det = opts.perfect ? cloneGame(game) : determinize(game, seat);
    reps++;
    for (var ci = 0; ci < cands.length; ci++) {
      var sim = cloneGame(det), act;
      if (cands[ci].pass) act = { type: 'pass_turn', seat: seat };
      else act = { type: 'play_cards', seat: seat, cards: cands[ci].play.cards };
      if (!sim.apply(act).ok) continue;
      totals[ci] += playout(sim, myTeam); counts[ci]++;
      if (Date.now() - t0 > opts.budgetMs * 1.5) break;
    }
  }
  var best = null, bestAvg = -Infinity;
  for (var c = 0; c < cands.length; c++) { if (!counts[c]) continue; var avg = totals[c] / counts[c]; if (avg > bestAvg) { bestAvg = avg; best = cands[c]; } }
  return best || { play: botPlay(game, seat) || moves[0] };
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
    var mv;
    if (level === 'devil') mv = searchMove(game, seat, { perfect: true, samples: 1, budgetMs: 400 });
    else if (level === 'hard') mv = searchMove(game, seat, { perfect: false, samples: 14, budgetMs: 220 });
    else if (easy) { var e = botPlayEasy(game, seat); mv = e ? { play: e } : { pass: true }; }
    else { var p = botPlay(game, seat); mv = p ? { play: p } : { pass: true }; }
    if (mv.pass || !mv.play) return { type: 'pass_turn', seat: seat };
    var cards = mv.play.cards;
    var a = { type: 'play_cards', seat: seat, cards: cards };
    if (cards.indexOf('MJ') >= 0) {
      var wsh = botWish(game.hands[seat].filter(function (id) { return cards.indexOf(id) < 0; }));
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
