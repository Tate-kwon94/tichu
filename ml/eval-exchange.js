#!/usr/bin/env node
/* 교환 전략 평가기 — 여러 교환 전략을 같은 딜·같은 세계에서 짝지어 비교한다.
 *
 * 왜 별도 도구인가: 교환은 오늘 유일하게 성과가 난 결정인데(마작·개 보유만으로 승단전 57.5%),
 * 승단전 80판은 표준오차 5.5%p라 교환 전략끼리의 차이를 구분할 수 없다.
 * 여기서는 같은 딜에서 전략만 바꿔 라운드 점수차를 짝지어 재므로 딜 운이 상쇄돼
 * 같은 시간에 훨씬 좁은 오차를 얻는다. (1점/라운드 ≈ 0.72%p 승률)
 *
 * 중요: 후보팀만 전략을 바꾸고 상대팀은 항상 기존(base)이다. 양쪽 다 바꾸면 차이가 상쇄된다.
 *
 * 사용: node ml/eval-exchange.js <딜수> [seedBase=0] [policy=normal|nng]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var NDEAL = +process.argv[2] || 400;
var SEED0 = +process.argv[3] || 0;
var POLICY = process.argv[4] || 'normal';
var net = null;
if (POLICY === 'nng') {
  var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));
  net = NET.load(path.join(__dirname, 'data', 'v6-weights.json'));
}

function sp(id) { return C.isSpecial(id); }
function mkGive(seat, oppTwo, partnerOne) {
  var g = {};
  g[(seat + 1) % 4] = oppTwo[0];
  g[(seat + 3) % 4] = oppTwo[1];
  g[C.partnerOf(seat)] = partnerOne;
  return g;
}
function normalsAsc(hand, exclude) {
  var out = [];
  for (var i = 0; i < hand.length; i++)
    if (!sp(hand[i]) && (!exclude || exclude.indexOf(hand[i]) < 0)) out.push(hand[i]);
  return out;                                   // sortHand가 오름차순이므로 그대로 오름차순
}

/* 전략들. 전부 (game, seat) → give 맵.
 * base = 현행 1단(마작·개를 최우선으로 상대에게). keep = ⑦(마작·개 보유). 나머지는 keep 위에서 변형. */
var STRATS = {
  base: function (g, s) { return B.botExchange(g, s); },          // 마작·개 둘 다 상대에게 (현행 1단)
  keep: function (g, s) { return B.botExchange(g, s, { keepSpecials: true }); },  // 둘 다 보유
  // 2×2 분해 — 개는 양날이다: 보유하면 "선을 잡아야만 싱글로 낼 수 있는" 부담이지만,
  // 파트너에게 선을 넘겨 원투 완주(1·2등 보너스)를 만드는 도구이기도 하다.
  // 상대에게 주면 부담을 떠넘기는 동시에 그 도구도 넘긴다. 어느 쪽이 큰지는 재야 안다.
  keep_mj: function (g, s) {                                       // 마작만 보유, 개는 상대에게
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h);
    var opp = h.indexOf('DG') >= 0 ? ['DG', n[0]] : n.slice(0, 2);
    return mkGive(s, opp, normalsAsc(h, opp).pop());
  },
  /* 사용자 전술(2026-07-26 인터뷰): "내가 티츄 가능한 패면 좋은 것은 내가 갖고 있는다.
   * 패가 너무 안 좋으면 그냥 제일 좋은 걸 줘버린다." — 조건부 교환. 기존 12변형은 전부
   * 무조건이었고 이 조건부는 미측정. 티츄 판정은 하네스 생태계와 동일한 botTichu 휴리스틱. */
  keep_tichuCond: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), opp = n.slice(0, 2);
    var rest = normalsAsc(h, opp);
    if (B.botTichu && B.botTichu(h)) {
      // 티츄 의향 → 강카드는 내가 쥐고 파트너에겐 중간(하위 1/3 위쪽)
      var mid = rest[Math.floor(rest.length * 0.4)] || rest[0];
      return mkGive(s, opp, mid);
    }
    return mkGive(s, opp, rest[rest.length - 1]);   // 평소엔 최고 카드(현행 keep)
  },
  // 변형: 티츄 의향이면 차선(2등) — 덜 극단적
  keep_tichuCond2: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), opp = n.slice(0, 2);
    var rest = normalsAsc(h, opp);
    if (B.botTichu && B.botTichu(h) && rest.length >= 2) {
      return mkGive(s, opp, rest[rest.length - 2]);
    }
    return mkGive(s, opp, rest[rest.length - 1]);
  },
  // 파트너에게 A 대신 "짝을 못 이루는 외톨이 최고카드". A가 페어면 내 조합으로 쥐고 외톨이 K를 준다.
  keep_solo_hi: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), cnt = {};
    for (var i = 0; i < n.length; i++) { var r = C.rankOf(n[i]); cnt[r] = (cnt[r] || 0) + 1; }
    var opp = n.slice(0, 2), rest = normalsAsc(h, opp);
    var solo = rest.filter(function (id) { return cnt[C.rankOf(id)] === 1; });
    return mkGive(s, opp, solo.length ? solo[solo.length - 1] : rest[rest.length - 1]);
  },
  // 상대에게 줄 최저 2장도 페어를 안 깨게 + 파트너엔 외톨이 최고
  keep_solo_both: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), cnt = {};
    for (var i = 0; i < n.length; i++) { var r = C.rankOf(n[i]); cnt[r] = (cnt[r] || 0) + 1; }
    var soloLow = n.filter(function (id) { return cnt[C.rankOf(id)] === 1; });
    var opp = (soloLow.length >= 2 ? soloLow : n).slice(0, 2), rest = normalsAsc(h, opp);
    var soloHi = rest.filter(function (id) { return cnt[C.rankOf(id)] === 1; });
    return mkGive(s, opp, soloHi.length ? soloHi[soloHi.length - 1] : rest[rest.length - 1]);
  },
  /* 조건부: 마작은 항상 보유, 개는 마작이 있을 때만 보유.
   * 2×2 주효과 분해(4000딜): 마작 보유 +11.6 / 개 보유 −1.46 / 상호작용 +3.03.
   * 개는 "선을 잡아야만 싱글로 낼 수 있는" 부담 카드라 단독 보유는 손해지만,
   * 마작이 있으면 첫 트릭 선이 보장돼 원하는 타이밍에 쓸 수 있다. */
  keep_cond: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), hasMJ = h.indexOf('MJ') >= 0;
    var opp;
    if (hasMJ) opp = n.slice(0, 2);                                // 둘 다 보유
    else if (h.indexOf('DG') >= 0) opp = ['DG', n[0]];             // 개는 떠넘긴다
    else opp = n.slice(0, 2);
    return mkGive(s, opp, normalsAsc(h, opp).pop());
  },
  // 개를 넘길 때 파트너 아닌 상대 중 '왼쪽'(내 다음 차례)에게 — 그쪽이 선을 잡으면 파트너에게 넘어간다
  keep_cond_L: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), hasMJ = h.indexOf('MJ') >= 0;
    if (hasMJ || h.indexOf('DG') < 0) {
      var o0 = n.slice(0, 2);
      return mkGive(s, o0, normalsAsc(h, o0).pop());
    }
    var g2 = {}, opp2 = [n[0]];
    g2[(s + 1) % 4] = 'DG';                                        // 왼쪽에 개
    g2[(s + 3) % 4] = n[0];
    g2[C.partnerOf(s)] = normalsAsc(h, ['DG', n[0]]).pop();
    return g2;
  },
  keep_dg: function (g, s) {                                       // 개만 보유, 마작은 상대에게
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h);
    var opp = h.indexOf('MJ') >= 0 ? ['MJ', n[0]] : n.slice(0, 2);
    return mkGive(s, opp, normalsAsc(h, opp).pop());
  },
  // 파트너에게 최고가 아니라 2번째 높은 카드 (에이스는 내가 쥔다)
  keep_p2: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h);
    var opp = n.slice(0, 2);
    var rest = normalsAsc(h, opp);
    return mkGive(s, opp, rest.length >= 2 ? rest[rest.length - 2] : rest[rest.length - 1]);
  },
  // 상대에게 최저 2장 대신, 짝(페어)을 깨지 않는 최저 2장
  keep_nopair: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h);
    var cnt = {};
    for (var i = 0; i < n.length; i++) { var r = C.rankOf(n[i]); cnt[r] = (cnt[r] || 0) + 1; }
    var solo = n.filter(function (id) { return cnt[C.rankOf(id)] === 1; });
    var opp = (solo.length >= 2 ? solo : n).slice(0, 2);
    var rest = normalsAsc(h, opp);
    return mkGive(s, opp, rest[rest.length - 1]);
  },
  // 파트너에게 최저 카드 — "파트너를 돕는 것이 정말 값어치를 하는가"의 직접 검정
  keep_plow: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h);
    return mkGive(s, n.slice(0, 2), n[2]);
  },
  // 파트너에게 개 — 파트너가 그걸로 내게 리드를 넘긴다
  keep_dgp: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), opp = n.slice(0, 2);
    if (h.indexOf('DG') >= 0) return mkGive(s, opp, 'DG');
    return mkGive(s, opp, normalsAsc(h, opp).pop());
  },
  // 파트너에게 마작 — 파트너가 선을 잡고 소원을 건다
  keep_mjp: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), opp = n.slice(0, 2);
    if (h.indexOf('MJ') >= 0) return mkGive(s, opp, 'MJ');
    return mkGive(s, opp, normalsAsc(h, opp).pop());
  },
  // 상대에게 최저가 아니라 3·4번째 — 최저 2장은 스트레이트 재료로 내가 쥔다
  keep_mid: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h);
    var opp = n.length >= 4 ? [n[2], n[3]] : n.slice(0, 2);
    return mkGive(s, opp, normalsAsc(h, opp).pop());
  },
  // 파트너에게 용 — 가장 큰 선물이 값어치를 하는가
  keep_drp: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h), opp = n.slice(0, 2);
    if (h.indexOf('DR') >= 0) return mkGive(s, opp, 'DR');
    return mkGive(s, opp, normalsAsc(h, opp).pop());
  },
  // 파트너에게 불사조(내가 쥐던 것)를 준다 — 파트너의 완주를 돕는 쪽에 건다
  keep_ph: function (g, s) {
    var h = C.sortHand(g.hands[s]), n = normalsAsc(h);
    var opp = n.slice(0, 2);
    if (h.indexOf('PH') >= 0) return mkGive(s, opp, 'PH');
    var rest = normalsAsc(h, opp);
    return mkGive(s, opp, rest[rest.length - 1]);
  },
};
var NAMES = process.env.TICHU_STRATS ? process.env.TICHU_STRATS.split(',') : Object.keys(STRATS);

function netAction(g, seat, hist) {
  var gm = C.genMoves(g.hands[seat], g.currentCombo, g.wish);
  if (!gm.moves.length) return { type: 'pass_turn', seat: seat };
  var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
  if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
  var pick = cands[cands.length === 1 ? 0 : net.pickRecord(net.makeRecord(g, seat, cands, hist))];
  if (pick.t === 'pass') return { type: 'pass_turn', seat: seat };
  var a = { type: 'play_cards', seat: seat, cards: pick.c };
  if (pick.c.indexOf('MJ') >= 0) {
    var wsh = B.botWish(g.hands[seat].filter(function (id) { return pick.c.indexOf(id) < 0; }));
    if (wsh) a.wish = wsh;
  }
  return a;
}

/* 한 딜을 한 전략으로 라운드 끝까지. 후보팀(짝수 좌석)만 strat, 상대는 base. */
function playRound(seed, stratName) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], guard = 0;
  while (!g.gameOver && ++guard < 20000) {
    if (g.phase === 'roundEnd') break;
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    var a;
    if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      var f = (s % 2 === 0) ? STRATS[stratName] : STRATS.base;
      a = { type: 'submit_exchange', seat: s, give: f(g, s) };
    } else if (net && g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
      a = netAction(g, s, hist);
    } else {
      a = B.botDecide(g, s, 'normal');
    }
    if (!a || !g.apply(a).ok) return null;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
  }
  if (!g.roundSummary) return null;
  var rs = g.roundSummary, d = rs.deltas;
  // 이득의 출처를 가른다 — 카드 점수인가, 티츄 보너스인가, 원투 완주 보너스인가
  var tb = 0;
  (rs.bonuses || []).forEach(function (b) { tb += (b.seat % 2 === 0 ? 1 : -1) * b.delta; });
  var ot = rs.oneTwoTeam ? (rs.oneTwoTeam === 'A' ? 200 : -200) : 0;
  return { tot: d.teamA - d.teamB, tichu: tb, oneTwo: ot, card: (d.teamA - d.teamB) - tb - ot };
}

var acc = {}; NAMES.forEach(function (k) { acc[k] = []; });
var t0 = Date.now(), used = 0;
for (var i = 0; i < NDEAL; i++) {
  var seed = SEED0 + i, row = {}, ok = true;
  for (var k = 0; k < NAMES.length; k++) {
    var v = playRound(seed, NAMES[k]);          // 같은 시드 = 같은 딜 → 짝지음
    if (v == null) { ok = false; break; }
    row[NAMES[k]] = v;
  }
  if (!ok) continue;
  NAMES.forEach(function (n) { acc[n].push(row[n]); });
  used++;
  if (used % 100 === 0) console.log('  ' + used + '/' + NDEAL + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}

function stat(a) {
  var n = a.length, m = a.reduce(function (x, y) { return x + y; }, 0) / n;
  var sd = Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (n - 1));
  return { m: m, se: sd / Math.sqrt(n) };
}
console.log('\n[짝지은 ' + used + '딜 · 플레이 정책 ' + POLICY + ' · 후보팀만 전략 변경]');
console.log('  전략          점/라운드      vs base 차이       화폐환산');
var b = acc[NAMES[0]];
NAMES.forEach(function (n) {
  var s = stat(acc[n].map(function (x) { return x.tot; }));
  var diff = acc[n].map(function (x, i) { return x.tot - b[i].tot; });
  var ds = stat(diff);
  console.log('  ' + n.padEnd(12) + (s.m >= 0 ? '+' : '') + s.m.toFixed(2).padStart(7) +
              '      ' + (ds.m >= 0 ? '+' : '') + ds.m.toFixed(2) + ' ± ' + ds.se.toFixed(2) +
              '      ' + (ds.m * 0.72 >= 0 ? '+' : '') + (ds.m * 0.72).toFixed(1) + '%p');
});
console.log('\n  [이득의 출처 — base 대비 차이]');
console.log('  전략            카드점수    티츄보너스   원투보너스');
NAMES.slice(1).forEach(function (n) {
  var c = stat(acc[n].map(function (x, i) { return x.card - b[i].card; }));
  var t = stat(acc[n].map(function (x, i) { return x.tichu - b[i].tichu; }));
  var o = stat(acc[n].map(function (x, i) { return x.oneTwo - b[i].oneTwo; }));
  console.log('  ' + n.padEnd(14) + (c.m >= 0 ? '+' : '') + c.m.toFixed(2).padStart(7) +
              '     ' + (t.m >= 0 ? '+' : '') + t.m.toFixed(2).padStart(7) +
              '     ' + (o.m >= 0 ? '+' : '') + o.m.toFixed(2).padStart(7));
});
