#!/usr/bin/env node
/* 자기증류 기보 생성 — 챔피언+(신경망 프라이어·가지치기 + 탐색)가 4좌석 전부 플레이.
 * 순환: 현행 최강 봇의 기보 → 다음 신경망(v4, v5…) 학습 → 더 강한 챔피언+.
 * 사용: node ml/gen-champion.js <weights.json> <seedStart> <seedEnd> [budgetMs=600] > out.jsonl 2> progress.log
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, 'hybrid-bot.js'));

var wPath = process.argv[2];
var seedStart = +process.argv[3] || 1;
var seedEnd = +process.argv[4] || 10;
var budget = +process.argv[5] || 600;

var hy = HY.create(wPath);

function keyOf(cards) { return cards ? cards.slice().sort().join(',') : 'PASS'; }

function playedCards(g) {
  var inHand = {};
  for (var s = 0; s < 4; s++) g.hands[s].forEach(function (id) { inHand[id] = 1; });
  return C.makeDeck().filter(function (id) { return !inHand[id]; });
}

function record(g, seat, cands, pickIdx, hist) {
  return {
    hist: hist.slice(-12),
    seat: seat,
    h: g.hands[seat].slice(),
    played: playedCards(g),
    cnt: [g.hands[0].length, g.hands[1].length, g.hands[2].length, g.hands[3].length],
    fin: g.finished.slice(),
    fo: g.firstOutSeat,
    tichu: g.tichu.slice(),
    cur: g.currentCombo ? { t: g.currentCombo.type, r: g.currentCombo.rank, l: g.currentCombo.length } : null,
    win: g.lastPlayerSeat,
    tp: C.sumPoints(g.trickPile),
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
  var buf = [], hist = [], nDec = 0, guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') {
      var d = g.roundSummary.deltas;
      buf.forEach(function (r) {
        r.out = (r.seat % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
        process.stdout.write(JSON.stringify(r) + '\n');
      });
      nDec += buf.length; buf = []; hist = [];
      g.apply({ type: 'next_round' });
      continue;
    }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var isPlay = g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0;
    var cands = null, a;
    if (isPlay) {
      var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
      cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
      if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
      a = hy.decidePlus(g, s, hist, { budgetMs: budget });
    } else {
      a = B.botDecide(g, s, 'normal');
    }
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
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
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
console.error('DONE decisions=' + total);
