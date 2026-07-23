#!/usr/bin/env node
/* 선언(라지/스몰 티츄) 지능화용 라운드 데이터 — 신경망 그리디 자가대전(고속).
 * 라운드마다 4좌석 각각: {h8: 그랜드 시점 8장, h14: 교환 후 14장, grand, tichu, first, delta}
 * 선언·교환은 현행 휴리스틱(실전 분포 반영), 플레이는 신경망 그리디(~1ms/수).
 * 사용: node ml/gen-rounds.js <weights.json> <games> [seedBase] > rounds.jsonl 2> progress.log
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));

var net = NET.load(process.argv[2]);
var nGames = +process.argv[3] || 100;
var seedBase = +process.argv[4] || 0;

function playGame(seed) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], rows = 0, guard = 0;
  var h8 = null, h14 = null, grandCall = null;
  function snapRoundStart() {
    h8 = g.hands.map(function (h) { return h.slice(); });   // 그랜드 단계 = 8장
    h14 = null; grandCall = [0, 0, 0, 0];
  }
  snapRoundStart();
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') {
      var d = g.roundSummary.deltas;
      for (var s2 = 0; s2 < 4; s2++) {
        if (!h8 || !h14) break;
        process.stdout.write(JSON.stringify({
          h8: h8[s2], h14: h14[s2],
          grand: grandCall[s2],
          tichu: g.tichu[s2],
          first: g.roundSummary.finishOrder[0] === s2 ? 1 : 0,
          delta: (s2 % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA)
        }) + '\n');
        rows++;
      }
      g.apply({ type: 'next_round' });
      hist = [];
      if (!g.gameOver) snapRoundStart();
      continue;
    }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var a;
    if (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
      if (h14 === null) h14 = g.hands.map(function (h) { return h.slice(); }); // 교환 직후 스냅
      var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
      var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
      if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
      var idx = cands.length === 1 ? 0 : net.pickRecord(net.makeRecord(g, s, cands, hist));
      var pick = cands[idx];
      if (pick.t === 'pass') a = { type: 'pass_turn', seat: s };
      else {
        a = { type: 'play_cards', seat: s, cards: pick.c };
        if (pick.c.indexOf('MJ') >= 0) {
          var wsh = B.botWish(g.hands[s].filter(function (id) { return pick.c.indexOf(id) < 0; }));
          if (wsh) a.wish = wsh;
        }
      }
    } else {
      a = B.botDecide(g, s, 'normal');
      if (a && a.type === 'call_grand' && a.call) grandCall[s] = 1;
    }
    if (!a) break;
    var r = g.apply(a);
    if (!r.ok) break;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
    if (++guard > 30000) break;
  }
  return rows;
}

var t0 = Date.now(), total = 0;
for (var i = 0; i < nGames; i++) {
  try { total += playGame(seedBase + i); } catch (e) { console.error('game', i, 'FAIL', e.message); }
  if ((i + 1) % 200 === 0) console.error('games ' + (i + 1) + '/' + nGames + ' rows=' + total + ' elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
}
console.error('DONE games=' + nGames + ' rows=' + total);
