/*
 * 티츄(Tichu) 규칙 엔진 — 순수 로직, 의존성 0
 * 서버(Node require)와 브라우저(script 태그) 공용 (UMD)
 *
 * 카드 ID: "S2"~"SA","H2"~"HA","D2"~"DA","C2"~"CA" (랭크 문자: 2-9,T,J,Q,K,A)
 *          + 특수 "MJ"(마작/1), "DG"(개), "PH"(불사조), "DR"(용)
 * 좌석: 0~3, 팀 A = 0+2, 팀 B = 1+3, 차례는 0→1→2→3 순환
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TichuCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ---------- 카드 ----------
var SUITS = ['S', 'H', 'D', 'C'];
var SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
var RANK_CHARS = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
var CHAR_RANKS = {};
Object.keys(RANK_CHARS).forEach(function (r) { CHAR_RANKS[RANK_CHARS[r]] = +r; });
var SPECIALS = ['MJ', 'DG', 'PH', 'DR'];

function makeDeck() {
  var d = [];
  SUITS.forEach(function (s) { for (var r = 2; r <= 14; r++) d.push(s + RANK_CHARS[r]); });
  return d.concat(SPECIALS);
}
function isSpecial(id) { return id === 'MJ' || id === 'DG' || id === 'PH' || id === 'DR'; }
function rankOf(id) {
  if (id === 'MJ') return 1;
  if (id === 'DR') return 15;
  if (id === 'PH' || id === 'DG') return 0;
  return CHAR_RANKS[id[1]];
}
function suitOf(id) { return isSpecial(id) ? null : id[0]; }
function pointsOf(id) {
  if (id === 'DR') return 25;
  if (id === 'PH') return -25;
  var r = rankOf(id);
  return r === 5 ? 5 : (r === 10 || r === 13) ? 10 : 0;
}
function sumPoints(ids) { var t = 0; for (var i = 0; i < ids.length; i++) t += pointsOf(ids[i]); return t; }
function sortKey(id) {
  if (id === 'DG') return -1;
  if (id === 'MJ') return 1;
  if (id === 'PH') return 14.5;
  if (id === 'DR') return 15;
  return rankOf(id) + 'SHDC'.indexOf(id[0]) * 0.01;
}
function sortHand(ids) { return ids.slice().sort(function (a, b) { return sortKey(a) - sortKey(b); }); }
function rankLabel(r) {
  if (r === 1) return '1';
  if (r <= 10) return String(r);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '용' }[r] || String(r);
}
function cardName(id) {
  if (id === 'MJ') return '마작(1)';
  if (id === 'DG') return '개';
  if (id === 'PH') return '불사조';
  if (id === 'DR') return '용';
  return SUIT_SYMBOL[id[0]] + rankLabel(rankOf(id));
}

// ---------- 시드 RNG (직렬화 가능) ----------
function makeRng(seed) {
  return {
    s: seed >>> 0,
    next: function () {
      // >>>0 로 항상 부호 없는 32비트 유지 (직렬화 표현 일관성)
      this.s = (this.s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  };
}
function shuffled(arr, rng) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rng.next() * (i + 1));
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ---------- 조합 판정 ----------
// cs: [{rank, suit}] — 불사조 제외(대체 랭크로 치환된 상태), 마작은 rank 1 / suit null
function identifyNormal(cs) {
  var n = cs.length;
  var rs = cs.map(function (c) { return c.rank; }).sort(function (a, b) { return a - b; });
  var cnt = {};
  rs.forEach(function (r) { cnt[r] = (cnt[r] || 0) + 1; });
  var uniq = Object.keys(cnt).map(Number).sort(function (a, b) { return a - b; });

  if (n === 1) return { type: 'single', rank: rs[0], length: 1 };
  if (n === 2) return (rs[0] === rs[1] && rs[0] >= 2) ? { type: 'pair', rank: rs[0], length: 2 } : null;
  if (n === 3) return (rs[0] === rs[2] && rs[0] >= 2) ? { type: 'triple', rank: rs[0], length: 3 } : null;
  if (n === 4 && uniq.length === 1) return { type: 'bomb4', rank: rs[0], length: 4 };
  if (n === 5 && uniq.length === 2) {
    var c0 = cnt[uniq[0]], c1 = cnt[uniq[1]];
    if ((c0 === 2 && c1 === 3) || (c0 === 3 && c1 === 2)) {
      if (uniq[0] < 2) return null;
      return { type: 'fullhouse', rank: c0 === 3 ? uniq[0] : uniq[1], length: 5 };
    }
  }
  if (n >= 5 && uniq.length === n && uniq[n - 1] - uniq[0] === n - 1) {
    var flush = cs.every(function (c) { return c.suit && c.suit === cs[0].suit; });
    return { type: flush ? 'bombstraight' : 'straight', rank: uniq[n - 1], length: n };
  }
  if (n >= 4 && n % 2 === 0 && uniq.length === n / 2 && uniq[0] >= 2 &&
      uniq[uniq.length - 1] - uniq[0] === n / 2 - 1 &&
      uniq.every(function (r) { return cnt[r] === 2; })) {
    return { type: 'pairseq', rank: uniq[uniq.length - 1], length: n };
  }
  return null;
}

// ids 배열 → 조합 {type, rank, length} | null
// 불사조 단독은 rank:'PH' 센티널 (낼 때 현재 조합 기준으로 수치 확정)
function identify(ids) {
  var n = ids.length;
  if (!n) return null;
  if (ids.indexOf('DG') >= 0) return n === 1 ? { type: 'dog', rank: 0, length: 1 } : null;
  if (ids.indexOf('DR') >= 0) return n === 1 ? { type: 'single', rank: 15, length: 1 } : null;
  var hasPH = ids.indexOf('PH') >= 0;
  var rest = ids.filter(function (id) { return id !== 'PH'; })
                .map(function (id) { return { rank: rankOf(id), suit: suitOf(id) }; });
  if (n === 1 && hasPH) return { type: 'single', rank: 'PH', length: 1 };
  if (!hasPH) return identifyNormal(rest);
  // 불사조 와일드: 2~A 각 랭크로 치환해 최고 해석 채택 (폭탄은 만들 수 없음)
  var best = null;
  for (var r = 2; r <= 14; r++) {
    var c = identifyNormal(rest.concat([{ rank: r, suit: null }]));
    if (c && c.type !== 'bomb4' && c.type !== 'bombstraight' && (!best || c.rank > best.rank)) best = c;
  }
  return best;
}

function isBomb(t) { return t === 'bomb4' || t === 'bombstraight'; }

// c가 cur를 이기는가 (둘 다 rank 숫자 확정 상태)
function beats(c, cur) {
  if (!cur) return true;
  if (isBomb(c.type)) {
    if (!isBomb(cur.type)) return true;
    if (c.type !== cur.type) return c.type === 'bombstraight';
    if (c.type === 'bombstraight' && c.length !== cur.length) return c.length > cur.length;
    return c.rank > cur.rank;
  }
  if (isBomb(cur.type)) return false;
  return c.type === cur.type && c.length === cur.length && c.rank > cur.rank;
}

// ---------- 합법 수 생성 ----------
// 반환: {forced, moves:[{cards, combo}]} — forced=true면 소원 이행 의무(해당 수만 허용)
function genMoves(hand, cur, wish) {
  var moves = [];
  var norm = hand.filter(function (id) { return !isSpecial(id); });
  var hasPH = hand.indexOf('PH') >= 0, hasMJ = hand.indexOf('MJ') >= 0;
  var hasDG = hand.indexOf('DG') >= 0, hasDR = hand.indexOf('DR') >= 0;
  var by = {};
  norm.forEach(function (id) { var r = rankOf(id); (by[r] = by[r] || []).push(id); });
  var ranks = Object.keys(by).map(Number).sort(function (a, b) { return a - b; });
  function add(cards, combo) { moves.push({ cards: cards, combo: combo }); }

  // 싱글
  ranks.forEach(function (r) { add([by[r][0]], { type: 'single', rank: r, length: 1 }); });
  if (hasMJ) add(['MJ'], { type: 'single', rank: 1, length: 1 });
  if (hasDR) add(['DR'], { type: 'single', rank: 15, length: 1 });
  if (hasPH) {
    if (!cur) add(['PH'], { type: 'single', rank: 1.5, length: 1 });
    else if (cur.type === 'single' && !isBomb(cur.type) && cur.rank < 15)
      add(['PH'], { type: 'single', rank: cur.rank + 0.5, length: 1 });
  }
  if (hasDG && !cur) add(['DG'], { type: 'dog', rank: 0, length: 1 });

  // 페어 / 트리플 / 포카드 폭탄
  ranks.forEach(function (r) {
    var g = by[r];
    if (g.length >= 2) add(g.slice(0, 2), { type: 'pair', rank: r, length: 2 });
    else if (hasPH) add([g[0], 'PH'], { type: 'pair', rank: r, length: 2 });
    if (g.length >= 3) add(g.slice(0, 3), { type: 'triple', rank: r, length: 3 });
    else if (g.length === 2 && hasPH) add([g[0], g[1], 'PH'], { type: 'triple', rank: r, length: 3 });
    if (g.length === 4) add(g.slice(), { type: 'bomb4', rank: r, length: 4 });
  });

  // 풀하우스 (불사조는 한 곳에만)
  var trip = [], pr = [];
  ranks.forEach(function (r) {
    var g = by[r];
    if (g.length >= 3) trip.push({ r: r, cards: g.slice(0, 3), ph: false });
    else if (g.length === 2 && hasPH) trip.push({ r: r, cards: g.slice(0, 2), ph: true });
    if (g.length >= 2) pr.push({ r: r, cards: g.slice(0, 2), ph: false });
    else if (hasPH) pr.push({ r: r, cards: [g[0]], ph: true });
  });
  trip.forEach(function (t) {
    pr.forEach(function (p) {
      if (t.r === p.r || (t.ph && p.ph)) return;
      var cards = t.cards.concat(p.cards);
      if (t.ph || p.ph) cards = cards.concat(['PH']);
      if (cards.length === 5) add(cards, { type: 'fullhouse', rank: t.r, length: 5 });
    });
  });

  // 스트레이트 (마작=1 포함, 불사조는 빈칸 1개 대체 — 1 자리는 불가)
  function has(r) { return (r === 1 && hasMJ) || (by[r] && by[r].length > 0); }
  // 일반 스트레이트가 우연히 전부 같은 무늬면(=스트플 폭탄으로 판정됨) 다른 무늬로 교체.
  // 교체 불가면 null — 그 카드들은 폭탄 루프에서 bombstraight로 따로 생성된다.
  function unflush(cards) {
    var suit0 = null;
    for (var i = 0; i < cards.length; i++) {
      if (isSpecial(cards[i])) return cards; // MJ/PH 포함 → 플러시 불가
      if (suit0 === null) suit0 = cards[i][0];
      else if (cards[i][0] !== suit0) return cards;
    }
    for (var j = 0; j < cards.length; j++) {
      var alts = by[rankOf(cards[j])];
      for (var k = 0; k < alts.length; k++) {
        if (alts[k][0] !== suit0) {
          var c2 = cards.slice();
          c2[j] = alts[k];
          return c2;
        }
      }
    }
    return null;
  }
  for (var a = 1; a <= 10; a++) {
    for (var b = a + 4; b <= 14; b++) {
      var miss = [];
      for (var r1 = a; r1 <= b; r1++) if (!has(r1)) miss.push(r1);
      if (miss.length === 0) {
        var cs1 = [];
        for (var r2 = a; r2 <= b; r2++) cs1.push(r2 === 1 ? 'MJ' : by[r2][0]);
        cs1 = unflush(cs1);
        if (cs1) add(cs1, { type: 'straight', rank: b, length: b - a + 1 });
      } else if (miss.length === 1 && hasPH && miss[0] >= 2) {
        var cs2 = [];
        for (var r3 = a; r3 <= b; r3++) cs2.push(r3 === miss[0] ? 'PH' : (r3 === 1 ? 'MJ' : by[r3][0]));
        add(cs2, { type: 'straight', rank: b, length: b - a + 1 });
      }
    }
  }

  // 연속 페어 (불사조는 한 자리만 보충)
  for (var pa = 2; pa <= 13; pa++) {
    for (var pb = pa + 1; pb <= 14; pb++) {
      var usedPH = false, okSeq = true, csp = [];
      for (var pr1 = pa; pr1 <= pb; pr1++) {
        var g2 = by[pr1] || [];
        if (g2.length >= 2) { csp.push(g2[0], g2[1]); }
        else if (g2.length === 1 && hasPH && !usedPH) { csp.push(g2[0], 'PH'); usedPH = true; }
        else { okSeq = false; break; }
      }
      if (okSeq) add(csp, { type: 'pairseq', rank: pb, length: (pb - pa + 1) * 2 });
    }
  }

  // 스트레이트 플러시 폭탄 (불사조/마작 불가)
  SUITS.forEach(function (su) {
    var set = {};
    norm.forEach(function (id) { if (id[0] === su) set[rankOf(id)] = id; });
    for (var fa = 2; fa <= 10; fa++) {
      for (var fb = fa + 4; fb <= 14; fb++) {
        var okF = true;
        for (var fr = fa; fr <= fb; fr++) if (!set[fr]) { okF = false; break; }
        if (okF) {
          var csf = [];
          for (var fr2 = fa; fr2 <= fb; fr2++) csf.push(set[fr2]);
          add(csf, { type: 'bombstraight', rank: fb, length: fb - fa + 1 });
        }
      }
    }
  });

  var legal = cur ? moves.filter(function (m) { return beats(m.combo, cur); }) : moves;
  if (wish) {
    var f = legal.filter(function (m) {
      return m.cards.some(function (id) { return !isSpecial(id) && rankOf(id) === wish; });
    });
    if (f.length) return { forced: true, moves: f };
  }
  return { forced: false, moves: legal };
}

// ---------- 팀/좌석 ----------
function teamOf(s) { return s % 2; } // 0: 팀A(0,2), 1: 팀B(1,3)
function partnerOf(s) { return (s + 2) % 4; }

// ---------- 게임 상태머신 ----------
function err(code, message) { return { ok: false, error: { code: code, message: message } }; }
function okRes() { return { ok: true }; }

var FIELDS = ['targetScore', 'scores', 'round', 'phase', 'hands', '_restDeck', 'tricksWon',
  'trick', 'trickPile', 'currentCombo', 'lastPlayerSeat', 'turnSeat', 'leaderSeat', 'wish',
  'tichu', 'grandAnswered', 'playedFirst', 'exchangeGive', 'exchangeReceived', 'finished',
  'firstOutSeat', 'dragonChooser', '_pendingRoundEnd', 'roundSummary', 'gameOver',
  'winnerTeam', 'lastAction', 'history'];

function Game(opts) {
  opts = opts || {};
  this.targetScore = opts.targetScore || 1000;
  var seed = opts.seed != null ? opts.seed : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  this.rng = makeRng(seed);
  // 점수 이어하기: opts.scores로 시작 점수 주입 가능
  this.scores = (opts.scores && opts.scores.length === 2) ? [opts.scores[0] | 0, opts.scores[1] | 0] : [0, 0];
  this.round = 0;
  this.gameOver = false;
  this.winnerTeam = null;
  this.lastAction = null;
  this.history = []; // 라운드별 점수 변동 누적
  this._startRound();
}

Game.prototype._startRound = function () {
  this.round++;
  var deck = shuffled(makeDeck(), this.rng);
  this.hands = [0, 1, 2, 3].map(function (s) { return sortHand(deck.slice(s * 8, s * 8 + 8)); });
  this._restDeck = deck.slice(32);
  this.tricksWon = [[], [], [], []];
  this.trick = [];
  this.trickPile = [];
  this.currentCombo = null;
  this.lastPlayerSeat = -1;
  this.turnSeat = -1;
  this.leaderSeat = -1;
  this.wish = null;
  this.tichu = [0, 0, 0, 0];
  this.grandAnswered = [false, false, false, false];
  this.playedFirst = [false, false, false, false];
  this.exchangeGive = [null, null, null, null];
  this.exchangeReceived = [null, null, null, null];
  this.finished = [];
  this.firstOutSeat = null;
  this.dragonChooser = null;
  this._pendingRoundEnd = false;
  this.roundSummary = null;
  this.phase = 'grand';
};

Game.prototype.apply = function (a) {
  if (!a || typeof a.type !== 'string') return err('BAD_REQUEST', '잘못된 액션');
  switch (a.type) {
    case 'call_grand': return this._callGrand(a.seat, !!a.call);
    case 'call_tichu': return this._callTichu(a.seat);
    case 'submit_exchange': return this._submitExchange(a.seat, a.give);
    case 'play_cards': return this._playCards(a.seat, a.cards, a.wish);
    case 'pass_turn': return this._pass(a.seat);
    case 'give_dragon': return this._giveDragon(a.seat, a.toSeat);
    case 'next_round': return this._nextRound();
    case 'restart': return this._restart();
    default: return err('BAD_REQUEST', '알 수 없는 액션: ' + a.type);
  }
};

Game.prototype._badSeat = function (s) { return !(s === 0 || s === 1 || s === 2 || s === 3); };

Game.prototype._callGrand = function (s, call) {
  if (this._badSeat(s)) return err('BAD_REQUEST', '좌석 오류');
  if (this.phase !== 'grand') return err('BAD_PHASE', '그랜드 티츄 단계가 아닙니다');
  if (this.grandAnswered[s]) return err('BAD_PHASE', '이미 응답했습니다');
  this.grandAnswered[s] = true;
  if (call) this.tichu[s] = 200;
  this.lastAction = { seat: s, kind: call ? 'grand' : 'grand_pass' };
  if (this.grandAnswered.every(Boolean)) {
    for (var p = 0; p < 4; p++) this.hands[p] = sortHand(this.hands[p].concat(this._restDeck.slice(p * 6, p * 6 + 6)));
    this._restDeck = [];
    this.phase = 'exchange';
  }
  return okRes();
};

Game.prototype._canTichu = function (s) {
  if (this._badSeat(s)) return false;
  if (this.tichu[s] || this.playedFirst[s] || this.finished.indexOf(s) >= 0) return false;
  if (this.phase === 'exchange' || this.phase === 'play') return true;
  if (this.phase === 'grand') return this.grandAnswered[s];
  return false;
};

Game.prototype._callTichu = function (s) {
  if (!this._canTichu(s)) return err('BAD_PHASE', '지금은 티츄를 선언할 수 없습니다');
  this.tichu[s] = 100;
  this.lastAction = { seat: s, kind: 'tichu' };
  return okRes();
};

Game.prototype._submitExchange = function (s, give) {
  if (this._badSeat(s)) return err('BAD_REQUEST', '좌석 오류');
  if (this.phase !== 'exchange') return err('BAD_PHASE', '교환 단계가 아닙니다');
  if (!give || typeof give !== 'object') return err('BAD_REQUEST', '교환 카드를 지정하세요');
  var targets = [0, 1, 2, 3].filter(function (x) { return x !== s; });
  var norm = {}, used = {};
  for (var i = 0; i < targets.length; i++) {
    var q = targets[i];
    var id = give[q] != null ? give[q] : give[String(q)];
    if (typeof id !== 'string' || this.hands[s].indexOf(id) < 0) return err('CARDS_NOT_IN_HAND', '손에 없는 카드입니다');
    if (used[id]) return err('BAD_REQUEST', '같은 카드를 두 번 줄 수 없습니다');
    used[id] = true;
    norm[q] = id;
  }
  this.exchangeGive[s] = norm; // 전원 제출 전 재제출 허용(덮어쓰기)
  this.lastAction = { seat: s, kind: 'exchange_submit' };
  if (this.exchangeGive.every(Boolean)) {
    var p, q2;
    for (p = 0; p < 4; p++) {
      var giving = this.exchangeGive[p];
      var ids = Object.keys(giving).map(function (k) { return giving[k]; });
      this.hands[p] = this.hands[p].filter(function (id2) { return ids.indexOf(id2) < 0; });
      this.exchangeReceived[p] = [];
    }
    for (p = 0; p < 4; p++) {
      for (q2 in this.exchangeGive[p]) {
        var to = +q2, card = this.exchangeGive[p][q2];
        this.hands[to].push(card);
        this.exchangeReceived[to].push({ fromSeat: p, card: card });
      }
    }
    for (p = 0; p < 4; p++) this.hands[p] = sortHand(this.hands[p]);
    var holder = 0;
    for (p = 0; p < 4; p++) if (this.hands[p].indexOf('MJ') >= 0) holder = p;
    this.leaderSeat = this.turnSeat = holder;
    this.phase = 'play';
    this.lastAction = { kind: 'exchange_done', leader: holder };
  }
  return okRes();
};

Game.prototype._playCards = function (s, ids, wishChoice) {
  if (this._badSeat(s)) return err('BAD_REQUEST', '좌석 오류');
  if (this.phase !== 'play') return err('BAD_PHASE', '지금은 카드를 낼 수 없습니다');
  if (this.finished.indexOf(s) >= 0) return err('BAD_PHASE', '이미 완주했습니다');
  if (!Array.isArray(ids) || ids.length === 0) return err('BAD_REQUEST', '카드를 선택하세요');
  var seen = {}, i;
  for (i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== 'string' || seen[ids[i]]) return err('BAD_REQUEST', '카드 지정 오류');
    seen[ids[i]] = true;
    if (this.hands[s].indexOf(ids[i]) < 0) return err('CARDS_NOT_IN_HAND', '손에 없는 카드입니다');
  }
  var combo = identify(ids);
  if (!combo) return err('INVALID_COMBO', '유효한 조합이 아닙니다');

  if (combo.type === 'dog') {
    if (s !== this.turnSeat) return err('NOT_YOUR_TURN', '차례가 아닙니다');
    if (this.currentCombo) return err('INVALID_COMBO', '개는 선일 때만 낼 수 있습니다');
  }
  // 불사조 단독 해석 확정
  if (combo.type === 'single' && combo.rank === 'PH') {
    if (this.currentCombo) {
      if (isBomb(this.currentCombo.type)) return err('COMBO_TOO_LOW', '폭탄은 불사조로 이길 수 없습니다');
      if (this.currentCombo.type !== 'single') return err('INVALID_COMBO', '불사조 단독은 싱글에만 낼 수 있습니다');
      if (this.currentCombo.rank >= 15) return err('COMBO_TOO_LOW', '용은 불사조로 이길 수 없습니다');
      combo = { type: 'single', rank: this.currentCombo.rank + 0.5, length: 1 };
    } else {
      combo = { type: 'single', rank: 1.5, length: 1 };
    }
  }
  // 차례 검사 (차례 밖은 폭탄 끼어들기만)
  if (s !== this.turnSeat) {
    if (!isBomb(combo.type)) return err('NOT_YOUR_TURN', '차례가 아닙니다 (폭탄만 끼어들 수 있습니다)');
    if (!this.currentCombo) return err('NOT_YOUR_TURN', '빈 트릭에는 끼어들 수 없습니다');
    if (!beats(combo, this.currentCombo)) return err('COMBO_TOO_LOW', '현재 조합을 이길 수 없습니다');
  } else if (this.currentCombo && combo.type !== 'dog') {
    if (!beats(combo, this.currentCombo)) return err('COMBO_TOO_LOW', '현재 조합을 이길 수 없습니다');
  }
  // 소원 강제 (자기 차례에만 적용)
  if (s === this.turnSeat && this.wish) {
    var g = genMoves(this.hands[s], this.currentCombo, this.wish);
    var fulfills = false;
    for (i = 0; i < ids.length; i++) if (!isSpecial(ids[i]) && rankOf(ids[i]) === this.wish) fulfills = true;
    if (g.forced && !fulfills) return err('WISH_REQUIRED', '소원(' + rankLabel(this.wish) + ')을 이행할 수 있어 해당 숫자를 포함해야 합니다');
  }

  // ---- 적용 ----
  this.hands[s] = this.hands[s].filter(function (id) { return !seen[id]; });
  this.playedFirst[s] = true;
  this.trick.push({ seat: s, cards: ids.slice() });
  this.trickPile = this.trickPile.concat(ids);
  var hadWish = this.wish;
  if (hadWish) {
    for (i = 0; i < ids.length; i++) if (!isSpecial(ids[i]) && rankOf(ids[i]) === hadWish) { this.wish = null; break; }
  }

  if (combo.type === 'dog') {
    this.lastAction = { seat: s, kind: 'dog' };
    var pile = this.trickPile;
    this.trickPile = []; this.trick = []; this.currentCombo = null; this.lastPlayerSeat = -1;
    this.tricksWon[partnerOf(s)] = this.tricksWon[partnerOf(s)].concat(pile);
    var end1 = this._checkFinish(s);
    if (end1) return end1;
    var t1;
    if (this.finished.indexOf(s) < 0 && 4 - this.finished.length <= 2) {
      t1 = s; // 1:1 상황: 개를 내면 선이 자기에게 돌아옴 (개로 완주한 경우는 제외)
    } else {
      t1 = partnerOf(s);
      while (this.finished.indexOf(t1) >= 0) t1 = (t1 + 1) % 4;
    }
    this.lastAction.toSeat = t1;
    this.leaderSeat = this.turnSeat = t1;
    return okRes();
  }

  this.currentCombo = combo;
  this.lastPlayerSeat = s;
  this.lastAction = { seat: s, kind: isBomb(combo.type) ? 'bomb' : 'play', cards: ids.slice(), combo: combo };
  if (ids.indexOf('MJ') >= 0 && wishChoice != null) {
    var w = Math.floor(Number(wishChoice));
    if (w >= 2 && w <= 14) { this.wish = w; this.lastAction.wish = w; }
  }
  var end2 = this._checkFinish(s);
  if (end2) return end2;
  this._advanceTurn(s);
  return okRes();
};

// 완주 처리: 라운드가 끝나면 결과(ok)를 반환, 아니면 null
Game.prototype._checkFinish = function (s) {
  if (this.hands[s].length > 0) return null;
  this.finished.push(s);
  if (this.firstOutSeat === null) this.firstOutSeat = s;
  if (this.finished.length === 2 && teamOf(this.finished[0]) === teamOf(this.finished[1])) {
    return this._endRound({ oneTwo: true }); // 원투 피니시 — 즉시 종료
  }
  if (this.finished.length === 3) {
    // 진행 중 트릭은 현재 승자(방금 낸 사람)에게 — 단 용 싱글이면 상대에게 증정 후 종료.
    // 이 시점엔 활동 중인 상대가 최대 1명이라 선택의 여지가 없음 → 자동 증정.
    if (this.currentCombo && this.currentCombo.type === 'single' && this.currentCombo.rank === 15) {
      var dOpps = [(s + 1) % 4, (s + 3) % 4];
      var dSelf = this;
      var dAct = dOpps.filter(function (o) { return dSelf.finished.indexOf(o) < 0; });
      var dTo = dAct.length === 1 ? dAct[0] : dOpps[0]; // 둘 다 완주면 같은 팀이라 어느 쪽이든 동일
      this.tricksWon[dTo] = this.tricksWon[dTo].concat(this.trickPile);
      this.lastAction = { seat: s, kind: 'dragon_give', toSeat: dTo, auto: true };
      this.trickPile = []; this.trick = []; this.currentCombo = null;
      return this._endRound({});
    }
    if (this.lastPlayerSeat >= 0) {
      this.tricksWon[this.lastPlayerSeat] = this.tricksWon[this.lastPlayerSeat].concat(this.trickPile);
    }
    this.trickPile = []; this.trick = []; this.currentCombo = null;
    return this._endRound({});
  }
  return null;
};

Game.prototype._pass = function (s) {
  if (this._badSeat(s)) return err('BAD_REQUEST', '좌석 오류');
  if (this.phase !== 'play') return err('BAD_PHASE', '지금은 패스할 수 없습니다');
  if (s !== this.turnSeat) return err('NOT_YOUR_TURN', '차례가 아닙니다');
  if (!this.currentCombo) return err('CANNOT_PASS_LEAD', '선두는 패스할 수 없습니다');
  if (this.wish) {
    var g = genMoves(this.hands[s], this.currentCombo, this.wish);
    if (g.forced) return err('WISH_REQUIRED', '소원(' + rankLabel(this.wish) + ')을 이행할 수 있어 패스할 수 없습니다');
  }
  this.lastAction = { seat: s, kind: 'pass' };
  this._advanceTurn(s);
  return okRes();
};

Game.prototype._advanceTurn = function (from) {
  var t = from;
  for (var i = 0; i < 4; i++) {
    t = (t + 1) % 4;
    if (t === this.lastPlayerSeat) { this._winTrick(); return; }
    if (this.finished.indexOf(t) < 0) { this.turnSeat = t; return; }
  }
};

Game.prototype._winTrick = function () {
  var w = this.lastPlayerSeat;
  if (this.currentCombo && this.currentCombo.type === 'single' && this.currentCombo.rank === 15) {
    // 용 트릭: 상대 두 명이 다 살아있을 때만 선택. 한 명이 완주했으면 남은 상대에게 자동 증정.
    var opps = [(w + 1) % 4, (w + 3) % 4];
    var self = this;
    var act = opps.filter(function (o) { return self.finished.indexOf(o) < 0; });
    if (act.length >= 2) {
      this.phase = 'dragon';
      this.dragonChooser = w;
      this.lastAction = { seat: w, kind: 'trick_won', dragon: true };
      return;
    }
    var to = act.length === 1 ? act[0] : opps[0]; // 둘 다 완주면 어느 쪽이든 같은 팀
    this.tricksWon[to] = this.tricksWon[to].concat(this.trickPile);
    this.lastAction = { seat: w, kind: 'dragon_give', toSeat: to, auto: true };
    this._afterTrick(w);
    return;
  }
  this.tricksWon[w] = this.tricksWon[w].concat(this.trickPile);
  this.lastAction = { seat: w, kind: 'trick_won' };
  this._afterTrick(w);
};

Game.prototype._afterTrick = function (w) {
  this.trickPile = []; this.trick = []; this.currentCombo = null; this.lastPlayerSeat = -1;
  var t = w;
  while (this.finished.indexOf(t) >= 0) t = (t + 1) % 4;
  this.leaderSeat = this.turnSeat = t;
};

Game.prototype._giveDragon = function (s, toSeat) {
  if (this.phase !== 'dragon') return err('BAD_PHASE', '용 증정 단계가 아닙니다');
  if (s !== this.dragonChooser) return err('NOT_YOUR_TURN', '용 증정은 트릭 승자가 합니다');
  var opps = [(s + 1) % 4, (s + 3) % 4];
  if (opps.indexOf(toSeat) < 0) return err('BAD_REQUEST', '상대팀에게만 줄 수 있습니다');
  this.tricksWon[toSeat] = this.tricksWon[toSeat].concat(this.trickPile);
  this.lastAction = { seat: s, kind: 'dragon_give', toSeat: toSeat };
  this.dragonChooser = null;
  if (this._pendingRoundEnd) {
    this.trickPile = []; this.trick = []; this.currentCombo = null; this.lastPlayerSeat = -1;
    return this._endRound({});
  }
  this.phase = 'play';
  this._afterTrick(s);
  return okRes();
};

Game.prototype._endRound = function (o) {
  o = o || {};
  var first = this.firstOutSeat;
  var bonuses = [];
  var dA = 0, dB = 0, s2;
  for (s2 = 0; s2 < 4; s2++) {
    if (this.tichu[s2]) {
      var made = first === s2;
      var delta = made ? this.tichu[s2] : -this.tichu[s2];
      bonuses.push({ seat: s2, call: this.tichu[s2] === 200 ? 'grand' : 'tichu', made: made, delta: delta });
      if (teamOf(s2) === 0) dA += delta; else dB += delta;
    }
  }
  var cardPoints = null, oneTwoTeam = null;
  if (o.oneTwo) {
    oneTwoTeam = teamOf(first) === 0 ? 'A' : 'B';
    if (teamOf(first) === 0) dA += 200; else dB += 200;
  } else {
    var last = -1;
    for (s2 = 0; s2 < 4; s2++) if (this.finished.indexOf(s2) < 0) last = s2;
    // 막내의 트릭 → 1등에게, 막내의 손패 → 상대팀 점수로
    this.tricksWon[first] = this.tricksWon[first].concat(this.tricksWon[last]);
    this.tricksWon[last] = [];
    var cp = [0, 0];
    for (s2 = 0; s2 < 4; s2++) cp[teamOf(s2)] += sumPoints(this.tricksWon[s2]);
    cp[1 - teamOf(last)] += sumPoints(this.hands[last]);
    cardPoints = { teamA: cp[0], teamB: cp[1] };
    dA += cp[0]; dB += cp[1];
  }
  this.scores[0] += dA;
  this.scores[1] += dB;
  var gameOver = false, winnerTeam = null;
  if ((this.scores[0] >= this.targetScore || this.scores[1] >= this.targetScore) && this.scores[0] !== this.scores[1]) {
    gameOver = true;
    winnerTeam = this.scores[0] > this.scores[1] ? 'A' : 'B';
  }
  this.roundSummary = {
    round: this.round,
    oneTwoTeam: oneTwoTeam,
    cardPoints: cardPoints,
    bonuses: bonuses,
    deltas: { teamA: dA, teamB: dB },
    totals: { teamA: this.scores[0], teamB: this.scores[1] },
    finishOrder: this.finished.slice(),
    gameOver: gameOver,
    winnerTeam: winnerTeam
  };
  this.history.push({
    round: this.round,
    deltas: { teamA: dA, teamB: dB },
    totals: { teamA: this.scores[0], teamB: this.scores[1] },
    oneTwoTeam: oneTwoTeam
  });
  this.gameOver = gameOver;
  this.winnerTeam = winnerTeam;
  this.phase = gameOver ? 'gameEnd' : 'roundEnd';
  this.lastAction = { kind: 'round_end' };
  return okRes();
};

Game.prototype._nextRound = function () {
  if (this.phase !== 'roundEnd') return err('BAD_PHASE', '라운드 종료 상태가 아닙니다');
  this._startRound();
  return okRes();
};

Game.prototype._restart = function () {
  this.scores = [0, 0];
  this.gameOver = false;
  this.winnerTeam = null;
  this.round = 0;
  this.history = [];
  this._startRound();
  return okRes();
};

// 지금 행동해야 하는 좌석들
Game.prototype.waitingOn = function () {
  var out = [], s;
  switch (this.phase) {
    case 'grand':
      for (s = 0; s < 4; s++) if (!this.grandAnswered[s]) out.push(s);
      return out;
    case 'exchange':
      for (s = 0; s < 4; s++) if (!this.exchangeGive[s]) out.push(s);
      return out;
    case 'play':
      return this.turnSeat >= 0 ? [this.turnSeat] : [];
    case 'dragon':
      return this.dragonChooser != null ? [this.dragonChooser] : [];
    default:
      return [];
  }
};

// seat 관점의 가려진(redacted) 게임 뷰 — 다른 사람 손패는 절대 포함하지 않음
Game.prototype.viewFor = function (seat) {
  var self = this;
  var you = null;
  if (seat === 0 || seat === 1 || seat === 2 || seat === 3) {
    var mustWish = false;
    if (this.phase === 'play' && this.turnSeat === seat && this.wish) {
      mustWish = genMoves(this.hands[seat], this.currentCombo, this.wish).forced;
    }
    you = {
      seat: seat,
      hand: this.hands[seat].slice(),
      canCallGrand: this.phase === 'grand' && !this.grandAnswered[seat],
      canCallTichu: this._canTichu(seat),
      exchangeSubmitted: !!this.exchangeGive[seat],
      received: this.exchangeReceived[seat],
      mustFulfillWish: mustWish
    };
  }
  return {
    round: this.round,
    phase: this.phase,
    turnSeat: this.turnSeat,
    leaderSeat: this.leaderSeat,
    you: you,
    seats: [0, 1, 2, 3].map(function (s) {
      return {
        seat: s,
        handCount: self.hands[s].length,
        tichu: self.tichu[s] === 200 ? 'grand' : self.tichu[s] === 100 ? 'tichu' : 'none',
        out: self.finished.indexOf(s) >= 0,
        outRank: self.finished.indexOf(s) >= 0 ? self.finished.indexOf(s) + 1 : null,
        trickPoints: sumPoints(self.tricksWon[s])
      };
    }),
    scores: { teamA: this.scores[0], teamB: this.scores[1] },
    targetScore: this.targetScore,
    trick: this.trick.map(function (p) { return { seat: p.seat, cards: p.cards.slice() }; }),
    currentCombo: this.currentCombo,
    trickPilePoints: sumPoints(this.trickPile),
    wish: this.wish,
    dragonChooser: this.dragonChooser,
    firstOutSeat: this.firstOutSeat,
    waitingOn: this.waitingOn(),
    lastAction: this.lastAction,
    roundSummary: this.roundSummary,
    gameOver: this.gameOver,
    winnerTeam: this.winnerTeam,
    history: this.history
  };
};

Game.prototype.toJSON = function () {
  var j = { v: 1, rngS: this.rng.s };
  for (var i = 0; i < FIELDS.length; i++) j[FIELDS[i]] = this[FIELDS[i]];
  return JSON.parse(JSON.stringify(j));
};

Game.fromJSON = function (j) {
  var c = JSON.parse(JSON.stringify(j));
  var g = Object.create(Game.prototype);
  g.rng = makeRng(0);
  g.rng.s = c.rngS >>> 0;
  for (var i = 0; i < FIELDS.length; i++) g[FIELDS[i]] = c[FIELDS[i]];
  if (!g.history) g.history = []; // 구버전 저장본 호환
  return g;
};

return {
  SUITS: SUITS,
  SUIT_SYMBOL: SUIT_SYMBOL,
  RANK_CHARS: RANK_CHARS,
  SPECIALS: SPECIALS,
  makeDeck: makeDeck,
  isSpecial: isSpecial,
  rankOf: rankOf,
  suitOf: suitOf,
  pointsOf: pointsOf,
  sumPoints: sumPoints,
  sortHand: sortHand,
  rankLabel: rankLabel,
  cardName: cardName,
  makeRng: makeRng,
  shuffled: shuffled,
  identify: identify,
  isBomb: isBomb,
  beats: beats,
  genMoves: genMoves,
  teamOf: teamOf,
  partnerOf: partnerOf,
  Game: Game
};
}));
