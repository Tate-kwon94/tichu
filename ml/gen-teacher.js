#!/usr/bin/env node
/* 교사 기보 생성 — v15 고수(탐색봇) 자가대전에서 플레이 결정을 JSONL로 기록.
 * 신경망 부트스트랩(모방학습)용. 선언·교환·소원·용은 v1 범위 밖(휴리스틱 유지).
 * 사용: node ml/gen-teacher.js <seedStart> <seedEnd> [budgetMs=100] > 출력.jsonl 2> 진행.log
 * (기보는 stdout, 진행 로그는 stderr — 샌드박스 환경에서도 셸 리다이렉트는 항상 동작)
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

var seedStart = +process.argv[2] || 1;
var seedEnd = +process.argv[3] || 10;
var budget = +process.argv[4] || 100;
globalThis.__TICHU_HARD = { samples: 999999, budgetMs: budget };

var out = { write: function (s) { process.stdout.write(s); }, end: function (cb) { if (cb) cb(); } };

function keyOf(cards) { return cards ? cards.slice().sort().join(',') : 'PASS'; }

// 공개적으로 이미 나온 카드 = 전체 덱 − 네 손 전부 (트릭 더미 포함해 손 밖이면 공개된 것)
function playedCards(g) {
  var inHand = {};
  for (var s = 0; s < 4; s++) g.hands[s].forEach(function (id) { inHand[id] = 1; });
  return C.makeDeck().filter(function (id) { return !inHand[id]; });
}

function record(g, seat, cands, pickIdx, hist) {
  return {
    hist: hist.slice(-12), // 최근 12수: {s:좌석, t:타입, r:랭크, l:장수} (패스는 t:'pass')
    seat: seat,
    h: g.hands[seat].slice(),
    played: playedCards(g),
    cnt: [g.hands[0].length, g.hands[1].length, g.hands[2].length, g.hands[3].length],
    fin: g.finished.slice(),
    fo: g.firstOutSeat,
    tichu: g.tichu.slice(),
    cur: g.currentCombo ? { t: g.currentCombo.type, r: g.currentCombo.rank, l: g.currentCombo.length } : null,
    win: g.lastPlayerSeat,
    tp: C.sumPoints ? C.sumPoints(g.trickPile) : 0,
    wish: g.wish,
    gave: g.exchangeGive && g.exchangeGive[seat] ? g.exchangeGive[seat] : null,
    sc: g.scores.slice(),
    tgt: g.targetScore,
    cands: cands,
    pick: pickIdx
  };
}

function playGame(seed) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var buf = []; // 라운드 종료 시 결과를 채워 출력
  var hist = []; // 이번 라운드의 플레이 이력 (플레이·패스)
  var nDec = 0, guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') {
      var d = g.roundSummary.deltas;
      buf.forEach(function (r) {
        r.out = (r.seat % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
        out.write(JSON.stringify(r) + '\n');
      });
      nDec += buf.length; buf = []; hist = [];
      g.apply({ type: 'next_round' });
      continue;
    }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var isPlay = g.phase === 'play' && g.turnSeat === s;
    var cands = null;
    if (isPlay) {
      var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
      cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
      if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
    }
    var a = B.botDecide(g, s, 'hard');
    if (!a) throw new Error('no action seed=' + seed);
    if (isPlay && cands && cands.length > 1) {
      var key = a.type === 'pass_turn' ? 'PASS' : keyOf(a.cards);
      var idx = -1;
      for (var i = 0; i < cands.length; i++) {
        var k2 = cands[i].t === 'pass' ? 'PASS' : keyOf(cands[i].c);
        if (k2 === key) { idx = i; break; }
      }
      if (idx >= 0) buf.push(record(g, s, cands, idx, hist));
    }
    var r = g.apply(a);
    if (!r.ok) throw new Error('rejected seed=' + seed + ' ' + a.type + ' ' + r.error.code);
    // 플레이 이력 축적 (라운드 내) — 학습 특징용
    if (g.phase === 'play' || a.type === 'play_cards' || a.type === 'pass_turn') {
      if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
      else if (a.type === 'play_cards' && r.ok) {
        var la = g.lastAction;
        if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
        else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
      }
    }
    if (++guard > 30000) throw new Error('guard seed=' + seed);
  }
  return nDec;
}

var t0 = Date.now(), total = 0;
for (var seed = seedStart; seed <= seedEnd; seed++) {
  try {
    total += playGame(seed);
    console.error('seed', seed, 'done, decisions=', total, 'elapsed=', Math.round((Date.now() - t0) / 1000) + 's');
  } catch (e) {
    console.error('seed', seed, 'FAIL', e.message);
  }
}
out.end(function () { console.error('TOTAL decisions=' + total); });
