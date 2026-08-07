/*
 * 티츄 AI 봇 — 휴리스틱 기반, 결정론적(같은 상태 → 같은 수)
 * 서버(빈자리 채움)와 클라이언트(혼자 연습) 공용 (UMD)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tichu-core.js'));
  else root.TichuBots = factory(root.TichuCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
'use strict';

/* CRN(공통난수): 측정 하네스가 globalThis.__TICHU_RNG에 시드된 난수원을 꽂으면
 * 결정화·플레이 확률 전부가 그걸 쓴다 — A/B 두 팔이 같은 세계 흐름을 공유해
 * 짝지음 분산이 줄고, 같은 설정 재실행이 비트 단위로 재현된다.
 * 미설정 시 Math.random 그대로 = 프로덕션 무영향. */
function RND() {
  return (typeof globalThis !== 'undefined' && globalThis.__TICHU_RNG)
    ? globalThis.__TICHU_RNG() : Math.random();
}

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
function botExchange(game, seat, opts) {
  var hand = sortHand(game.hands[seat]); // 오름차순
  // 반시계 진행: 좌석+1 = 내 오른쪽(다음 차례), 좌석+3 = 내 왼쪽. 둘 다 상대라 급여 규칙은 동일.
  var right = (seat + 1) % 4, left = (seat + 3) % 4, partner = partnerOf(seat);
  var give = {}, used = {};
  // 상대 둘: 마작(선 강제 떠넘기기)·개 우선, 그다음 최저 일반 카드
  //
  // keepSpecials(2단 후보): 마작·개를 넘기지 않는다. "떠넘긴다"고 봤지만 실은 선물이었다 —
  // 개는 리드를 파트너에게 넘기는 카드라 상대에게 주면 그쪽이 자기 파트너에게 쓴다.
  // 마작도 리드와 소원을 함께 준다. 실측(짝지은 200딜, 신경망 그리디): 마작만 안 넘겨도
  // +14.75점/라운드, 둘 다 안 넘기면 +26.30점/라운드. normal 풀게임 승률 61.4%±1.1.
  var opp = [];
  if (!(opts && opts.keepSpecials)) {
    if (hand.indexOf('MJ') >= 0) opp.push('MJ');
    if (hand.indexOf('DG') >= 0) opp.push('DG');
  }
  /* 보존 교환(3단 후보) — 폭탄 잠재가 있는 카드는 나누지 않는다(사용자 피드백: 사람들의 실전 규칙).
   * keepTriples: 같은 랭크 3장+ 보존 — 한 장만 들어와도 4장 폭탄. (현행은 2222 완성 폭탄도 나눴다)
   * keepStraightFlush: 같은 무늬가 5랭크 창 안에 4장+ 몰리면 보존 — 완성 스티플(5장+)과
   *   한 칸 빈 4장 모두 해당. 봉황은 폭탄에 못 끼므로 순수 같은 무늬만 본다.
   * 보호 대상을 빼고도 줄 카드가 모자라면 그냥 최저부터(폴백). */
  var protectedGive = {};
  if (opts && (opts.keepTriples || opts.keepStraightFlush)) {
    if (opts.keepTriples) {
      var rankCnt = {};
      for (var rc = 0; rc < hand.length; rc++) {
        if (!isSpecial(hand[rc])) rankCnt[rankOf(hand[rc])] = (rankCnt[rankOf(hand[rc])] || 0) + 1;
      }
      for (var rp = 0; rp < hand.length; rp++) {
        if (!isSpecial(hand[rp]) && rankCnt[rankOf(hand[rp])] >= 3) protectedGive[hand[rp]] = 1;
      }
    }
    if (opts.keepStraightFlush) {
      var bySuit = {};
      for (var sf = 0; sf < hand.length; sf++) {
        if (isSpecial(hand[sf])) continue;
        var su = hand[sf][0];
        (bySuit[su] = bySuit[su] || []).push(hand[sf]);
      }
      Object.keys(bySuit).forEach(function (su2) {
        var cards = bySuit[su2];
        for (var w = 2; w <= 10; w++) {                  // 창 [w, w+4]
          var inWin = cards.filter(function (id) { var r = rankOf(id); return r >= w && r <= w + 4; });
          if (inWin.length >= 4) inWin.forEach(function (id) { protectedGive[id] = 1; });
        }
      });
    }
    for (var i0 = 0; i0 < hand.length && opp.length < 2; i0++) {
      if (!isSpecial(hand[i0]) && opp.indexOf(hand[i0]) < 0 && !protectedGive[hand[i0]]) opp.push(hand[i0]);
    }
  }
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
// game을 주면(3단 재료, 사용자 피드백) 카운팅 소원: 이미 다 나온 랭크는 부르지 않는다.
// 소원은 "그 랭크를 낼 수 있으면 반드시 내야 한다"로 상대 손을 묶는 도구인데,
// 소진된 랭크를 부르면 아무도 안 묶인다(실제로 A 소진 후 A를 부르는 헛소원 관측).
// game 없이 부르면 기존 동작 그대로(1·2단 동결).
function botWish(handAfterPlay, game) {
  var have = {};
  handAfterPlay.forEach(function (id) { if (!isSpecial(id)) have[rankOf(id)] = true; });
  var seen = null;
  if (game && game.tricksWon) {
    seen = {};
    var addSeen = function (id) { if (!isSpecial(id)) seen[rankOf(id)] = (seen[rankOf(id)] || 0) + 1; };
    handAfterPlay.forEach(addSeen);                      // 내 손(소원 시점 잔여)도 본 카드
    (game.trickPile || []).forEach(addSeen);             // 현재 트릭
    for (var s = 0; s < 4; s++) (game.tricksWon[s] || []).forEach(addSeen);   // 딴 더미들
  }
  for (var r = 14; r >= 2; r--) {
    if (have[r]) continue;
    if (seen && (seen[r] || 0) >= 4) continue;           // 소진된 랭크 — 헛소원
    return r;
  }
  // 전부 소진·보유면 카운팅 무시하고 기존 규칙(소원 안 걸기는 −6.85 실측 손해)
  for (var r2 = 14; r2 >= 2; r2--) if (!have[r2]) return r2;
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
/* botPlay의 임의 상수 — 한 번도 스윕된 적이 없다. 롤아웃 정책의 품질이 곧 평가기 품질이고
 * 평가기가 병목임이 실측됐으므로(같은 40세계에서 롤아웃 정책만 바꿔도 최선수가 62% 갈림),
 * 이 상수들이 5단의 후보다. globalThis.__TICHU_PP로만 바뀐다 = 배포 기본값 불변. */
function PP(k, d) {
  var o = (typeof globalThis !== 'undefined') && globalThis.__TICHU_PP;
  return (o && o[k] != null) ? o[k] : d;
}

/* 봇은 리롤하지 않는다 — 측정 결과 EV가 음수다.
 * 2,500딜 짝지음(같은 시드로 리롤 유/무 비교, 페널티 −30 반영, 8장 세기 구간별):
 *   세기 −1 +0.9 / 0 −0.6 / 1 −23.9 / 3 −29.7 / 5 −36.9 / 7 −59.1 / 10 −95.1
 * 최악 구간에서 겨우 본전이고 나머지는 전부 손해다. 라운드 점수의 표준편차(±138)가
 * 손패 세기 차이를 압도해서, 30점을 확정으로 내고 새 패를 받는 도박이 값을 못 한다.
 * → 리롤은 전략 수단이 아니라 사람의 체감(연속 불운) 해소용 장치다. */
function botWantsReroll() { return false; }

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
    if (cur.rank >= PP('yieldRank', 10) || isBomb(cur.type)) return null; // 파트너가 세게 이기는 중 — 양보
  }
  var nonBomb = moves.filter(function (m) { return !isBomb(m.combo.type); });
  var trickPts = sumPoints(game.trickPile);
  if (nonBomb.length) {
    var pick = cheapest(nonBomb, true, protect);
    // 푼돈 트릭에 비싼 카드 아끼기
    if (pick.combo.rank >= PP('saveRank', 14) && trickPts < PP('savePts', 5) &&
        n > PP('saveHand', 7) && !partnerWinning) return null;
    return pick;
  }
  // 폭탄만 가능할 때: 점수가 크거나, 상대 티츄 저지, 또는 막판이면 사용
  var w = game.lastPlayerSeat;
  var enemyTichu = w >= 0 && teamOf(w) !== teamOf(seat) && game.tichu[w] > 0;
  if (trickPts >= PP('bombPts', 13) || enemyTichu || n <= PP('bombHand', 6)) return cheapest(moves, false, protect);
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
    return pool[Math.floor(RND() * pool.length)];
  }
  if (RND() < 0.3) return null; // 이길 수 있어도 종종 패스
  var nonBomb = sorted.filter(function (m) { return !isBomb(m.combo.type); });
  var pool2 = (nonBomb.length ? nonBomb : sorted).slice(0, 3);
  return pool2[Math.floor(RND() * pool2.length)];
}

// ---------- 탐색(몬테카를로) — 고수/악마 난이도 ----------
function cloneGame(game) { return game.clone ? game.clone() : C.Game.fromJSON(game.toJSON()); }
// 미관측 카드를 상대 손패 수에 맞춰 무작위 재분배(결정화)
// 확정 정보 활용: 내가 교환으로 건넨 카드는 (아직 안 나왔다면) 받은 사람 손에 반드시 있음
// constraints(선택): { maxPassSingle: {seat: rank} } — 그 좌석은 rank 초과 싱글이 없을 확률 높음(상대 패 읽기).
// 낮은 패스(≤8)만 신뢰(측정: 전략적 보유 6.5%)해 소프트 교정. 하드 아님 — 위반을 확률적으로만 스왑.
function determinize(game, seat, constraints) {
  var g = cloneGame(game);
  var others = [], pool = [];
  var pinned = {};
  // 부분 clairvoyance 진단(전역 가드, 프로덕션 무영향): 상대 카드를 확률 pinFrac로 진짜 위치에 고정.
  // pinFrac=0=균일 결정화, 1=완전정보. "belief가 얼마나 정확해야 도움되나"를 잰다.
  var pinFrac = (typeof globalThis !== 'undefined' && globalThis.__TICHU_PIN) || 0;
  for (var s = 0; s < 4; s++) if (s !== seat) {
    others.push(s);
    var hnd = g.hands[s];
    for (var hi = 0; hi < hnd.length; hi++) {
      if (pinFrac && RND() < pinFrac) (pinned[s] = pinned[s] || []).push(hnd[hi]);
      else pool.push(hnd[hi]);
    }
  }
  var gave = game.exchangeGive && game.exchangeGive[seat];
  if (gave) {
    for (var q in gave) {
      var to = +q, card = gave[q];
      if (to === seat) continue;
      var pi = pool.indexOf(card);
      if (pi >= 0) { pool.splice(pi, 1); (pinned[to] = pinned[to] || []).push(card); }
    }
  }
  for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(RND() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  var k = 0;
  for (var o = 0; o < others.length; o++) {
    var os = others[o], pin = pinned[os] || [];
    var cnt = g.hands[os].length - pin.length;
    g.hands[os] = pin.concat(pool.slice(k, k + cnt)); k += cnt;
  }
  // ③ 상대 패 읽기: 낮은 패스 제약 위반을 소프트 교정 (좌석 X가 rank R에 패스 → X의 R초과 싱글을 다른 좌석과 스왑)
  var mp = constraints && constraints.maxPassSingle;
  if (mp) {
    for (var oi = 0; oi < others.length; oi++) {
      var x = others[oi], r = mp[x];
      if (r == null || r > 8) continue; // 신뢰 구간(≤8)만
      var hand = g.hands[x];
      for (var ci = 0; ci < hand.length; ci++) {
        var id = hand[ci];
        if (isSpecial(id) || rankOf(id) <= r) continue; // 위반(R초과 싱글)만
        if (RND() < 0.25) continue;             // 소프트: 25%는 전략적 보유로 남겨둠
        // 제약 없는(또는 이 카드 허용) 다른 좌석 y의 카드와 스왑
        for (var yi = 0; yi < others.length; yi++) {
          var y = others[yi]; if (y === x) continue;
          var ry = mp[y];
          if (ry != null && ry <= 8 && rankOf(id) > ry) continue; // y도 이 카드 못 받음
          var yh = g.hands[y], swapped = false;
          for (var yj = 0; yj < yh.length; yj++) {
            var yid = yh[yj];
            // y가 넘겨줄 카드는 x가 받아도 제약 안 어겨야(≤r 또는 특수 아닌 저랭크)
            if (!isSpecial(yid) && rankOf(yid) <= r) { hand[ci] = yid; yh[yj] = id; swapped = true; break; }
          }
          if (swapped) break;
        }
      }
    }
  }
  /* 선언 편향 — 티츄를 외친 좌석은 강한 패를 들었을 확률이 높다.
   * 지금 determinize는 이 신호를 통째로 버린다(교환·패스 이력은 쓰면서). 광맥 지도에서
   * 사람이 봇을 앞서는 유형이 전부 '티츄가 걸린 국면'이었고, PIN 곡선은 믿음이 정확해지면
   * 최대 +4.61까지 번다고 했다 — 선언은 훔쳐보기가 아니라 실전에서 관측 가능한 정보다.
   *
   * 방식: 선언 좌석의 약한 카드를 비선언 좌석의 강한 카드와 소프트 스왑(패스 제약 교정과 동일 패턴).
   * 카드 총량·좌석별 장수는 보존된다. 강도는 랭크(특수는 용>봉황>마작>개).
   * globalThis.__TICHU_DECLBIAS = 0(기본, 프로덕션 무영향) ~ 1(최대). */
  var declBias = (typeof globalThis !== 'undefined' && globalThis.__TICHU_DECLBIAS) || 0;
  if (declBias > 0) {
    var strengthOf = function (id) {
      if (id === 'DRG') return 17; if (id === 'PHX') return 16;
      if (id === 'MJ') return 1;  if (id === 'DG') return 0;
      return rankOf(id);
    };
    for (var di = 0; di < others.length; di++) {
      var ds = others[di];
      var lvl = game.tichu && game.tichu[ds];            // 100=스몰, 200=라지
      if (!lvl || g.finished.indexOf(ds) >= 0) continue;
      // 라지는 8장만 보고 외친 것이라 신호가 더 강하다
      var swaps = Math.round(declBias * (lvl >= 200 ? 4 : 2));
      for (var sw = 0; sw < swaps; sw++) {
        var dh = g.hands[ds];
        if (!dh.length) break;
        // 선언 좌석에서 가장 약한 카드
        var wi = 0;
        for (var a1 = 1; a1 < dh.length; a1++) if (strengthOf(dh[a1]) < strengthOf(dh[wi])) wi = a1;
        // 비선언 상대 좌석 중 무작위로 하나 골라 가장 강한 카드
        var cands = [];
        for (var oj = 0; oj < others.length; oj++) {
          var oy = others[oj];
          if (oy === ds) continue;
          if (game.tichu && game.tichu[oy]) continue;    // 다른 선언자에게서 뺏지 않는다
          if (g.hands[oy].length) cands.push(oy);
        }
        if (!cands.length) break;
        var y2 = cands[Math.floor(RND() * cands.length)];
        var yh2 = g.hands[y2], si2 = 0;
        for (var b1 = 1; b1 < yh2.length; b1++) if (strengthOf(yh2[b1]) > strengthOf(yh2[si2])) si2 = b1;
        if (strengthOf(yh2[si2]) <= strengthOf(dh[wi])) break;   // 더 강한 카드가 없으면 중단
        var tmp2 = dh[wi]; dh[wi] = yh2[si2]; yh2[si2] = tmp2;
      }
    }
  }
  return g;
}
// 비종료 상태의 대략 평가: 지금까지 딴 점수차 + 손패 적을수록(완주 임박) 가점
function positionalEval(g, myTeam) {
  var cap = [0, 0], cards = [0, 0];
  for (var s = 0; s < 4; s++) { cap[s % 2] += sumPoints(g.tricksWon[s]); cards[s % 2] += g.hands[s].length; }
  var pts = myTeam === 0 ? (cap[0] - cap[1]) : (cap[1] - cap[0]);
  var lead = myTeam === 0 ? (cards[1] - cards[0]) : (cards[0] - cards[1]);
  return pts + lead * 1.5;
}
// 라운드 종료까지 휴리스틱('보통')으로 진행 → seat팀 점수차. deadline 넘으면 위치평가로 컷.
function playout(g, myTeam, deadline) {
  var guard = 0;
  while (g.phase !== 'roundEnd' && g.phase !== 'gameEnd') {
    if (deadline && Date.now() > deadline) return positionalEval(g, myTeam); // 매 수마다 시간 컷 — 서버 블록 최소화
    var w = g.waitingOn(); if (!w.length) break;
    var a = botDecide(g, w[0], 'normal'); if (!a) break;
    if (!g.apply(a).ok) break;
    if (++guard > 2000) break;
  }
  if (!g.roundSummary) return positionalEval(g, myTeam);
  var d = g.roundSummary.deltas;
  return myTeam === 0 ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
}
// 후보 수(낼 수 + 패스)를 N회 플레이아웃해 평균 점수가 가장 좋은 수 선택. 시간예산 budgetMs.
// 순차 탈락: 초반 몇 회로 하위 후보를 걸러내고 남은 예산을 유력 후보에 집중 (같은 예산에 표본 ↑)
function searchMove(game, seat, opts) {
  var gm = genMoves(game.hands[seat], game.currentCombo, game.wish);
  var moves = gm.moves;
  if (!moves.length) return { pass: true };
  if (moves.length === 1 && !game.currentCombo) return { play: moves[0] };
  var cands = moves.map(function (m) { return { play: m }; });
  if (game.currentCombo && !gm.forced) cands.push({ pass: true }); // 따라갈 땐 패스도 후보
  var myTeam = teamOf(seat);
  var totals = cands.map(function () { return 0; }), counts = cands.map(function () { return 0; });
  var active = cands.map(function (_, i) { return i; });
  var t0 = Date.now(), deadline = t0 + opts.budgetMs; // 절대 한도 — 플레이아웃 내부에서도 체크
  function avgOf(i) { return counts[i] ? totals[i] / counts[i] : -Infinity; }
  for (var rep = 0; rep < opts.samples; rep++) {
    if (Date.now() > deadline) break;
    var det = opts.perfect ? cloneGame(game) : determinize(game, seat);
    for (var ai = 0; ai < active.length; ai++) {
      var ci = active[ai];
      var sim = cloneGame(det), act;
      if (cands[ci].pass) act = { type: 'pass_turn', seat: seat };
      else act = { type: 'play_cards', seat: seat, cards: cands[ci].play.cards };
      if (!sim.apply(act).ok) continue;
      totals[ci] += playout(sim, myTeam, deadline); counts[ci]++;
      if (Date.now() > deadline) break;
    }
    // 탈락 지점: 6·14·30회 표본 후 "선두와 명백한 격차"인 후보만 제거 — 마진을 점차 좁힘.
    // (하위 절반 일괄 탈락은 티츄 점수의 큰 분산 때문에 진짜 좋은 수를 초반 소음으로 자를 위험)
    if ((rep === 5 || rep === 13 || rep === 29) && active.length > 3) {
      var margin = rep === 5 ? 70 : rep === 13 ? 45 : 28;
      var lead = -Infinity;
      for (var li = 0; li < active.length; li++) lead = Math.max(lead, avgOf(active[li]));
      var kept = active.filter(function (i) { return avgOf(i) >= lead - margin; });
      if (kept.length >= 2) active = kept;
    }
  }
  // 최종 선택은 생존 후보 중에서 — 탈락 후보의 적은 표본 평균이 요행으로 이기는 것 방지
  var best = null, bestAvg = -Infinity;
  for (var c2 = 0; c2 < active.length; c2++) {
    var ci2 = active[c2];
    if (!counts[ci2]) continue;
    var avg2 = totals[ci2] / counts[ci2];
    if (avg2 > bestAvg) { bestAvg = avg2; best = cands[ci2]; }
  }
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
    // 고수: 시간 컷은 이벤트루프 정지 "길이"를 예산(950ms)으로 묶을 뿐, 정지 자체는 못 막는다
    //       (동기 탐색 — 실측으로 인터벌 타이머가 950ms 굶음). 트래픽이 적은 서비스라 허용,
    //       예산 950ms — 빠른 기기는 표본 많이, 느린 서버는 적게. 자동 조절.
    //       __TICHU_HARD 전역으로 표본·예산 오버라이드 가능(측정·튜닝용).
    if (level === 'devil') mv = searchMove(game, seat, { perfect: true, samples: 1, budgetMs: 400 });
    else if (level === 'hard') {
      var hc = (typeof globalThis !== 'undefined' && globalThis.__TICHU_HARD) || { samples: 240, budgetMs: 950 };
      mv = searchMove(game, seat, { perfect: false, samples: hc.samples, budgetMs: hc.budgetMs });
    }
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

/* 파트너 티츄 보호 가드(배포층) — 탐색봇(고수·1단·2단)의 선택이 파트너의 살아있는 티츄를
 * 죽이는 손비우기/1장남기기일 때, 보통봇의 안전수(protectPartner 내장)로 교체한다.
 * 왜 필요한가: 결정화가 "선언 = 강한 패" 정보를 반영하지 못해 탐색봇의 세계에서 파트너
 * 티츄는 대부분 실패한다 → "어차피 죽을 티츄, 내가 완주"가 합리가 된다(실측: 3페어에서
 * 4/4 완주). 잘못된 믿음 위의 합리라 평가 개선이 아니라 하드 가드가 답이다. */
function guardPartnerTichu(game, seat, action) {
  if (!action || action.type !== 'play_cards') return action;
  var partner = partnerOf(seat);
  if (!(game.tichu[partner] > 0) || game.firstOutSeat !== null) return action;
  var left = game.hands[seat].length - (action.cards ? action.cards.length : 0);
  if (left >= 2) return action;
  var nb = botDecide(game, seat, 'normal');   // protectPartner가 안전수/패스를 고른다
  return nb || action;
}

/* 봉황 싱글 가드(3단 재료, 사용자 피드백) — "용이 빠졌거나 용이 나와도 대응 가능해야".
 * 실측: 2단은 용 소재와 무관하게 봉황 베팅(용 미출현 6/8 vs 소진 7/8). 점수상 용↔봉황은
 * 등가 교환이라 평가가 겁을 안 내지만, 봉황의 콤보 유연성 가치는 플레이아웃이 못 쓴다.
 * 조건: 용이 소진됐거나 / 내 손에 있거나 / 폭탄 보유면 허용. 아니면 패스(리드면 최저 싱글).
 * 강제 수(소원 등)면 건드리지 않는다. 손해인지는 게이트가 판정한다. */
function guardPhoenixSingle(game, seat, action) {
  if (!action || action.type !== 'play_cards') return action;
  if (!(action.cards && action.cards.length === 1 && action.cards[0] === 'PH')) return action;
  var hand = game.hands[seat];
  if (hand.length <= 2) return action;                   // 종반 필연은 막지 않음
  if (hand.indexOf('DR') >= 0) return action;
  var seen = (game.trickPile || []).slice();
  for (var s = 0; s < 4; s++) seen = seen.concat(game.tricksWon[s] || []);
  if (seen.indexOf('DR') >= 0) return action;            // 용 소진 — 안전
  if (hasBomb(hand)) return action;                      // 용 대응 수단 보유
  var gm = genMoves(hand, game.currentCombo, game.wish);
  if (gm.forced) return action;                          // 강제 수 — 엔진 거부 방지
  if (game.currentCombo) return { type: 'pass_turn', seat: seat };
  var lows = sortHand(hand).filter(function (id) { return !isSpecial(id); });
  if (lows.length) return { type: 'play_cards', seat: seat, cards: [lows[0]] };
  return action;
}

return {
  botGrand: botGrand,
  botTichu: botTichu,
  botExchange: botExchange,
  guardPartnerTichu: guardPartnerTichu,
  guardPhoenixSingle: guardPhoenixSingle,
  botWish: botWish,
  botDragon: botDragon,
  botPlay: botPlay,
  botDecide: botDecide,
  strength: strength,
  hasBomb: hasBomb,
  determinize: determinize, // 하이브리드(신경망+탐색) 봇이 재사용 — 교환 정보 고정 포함
  cloneGame: cloneGame
};
}));
