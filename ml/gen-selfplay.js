#!/usr/bin/env node
/* RL 자가대전 생성 — 신경망(ε-greedy)끼리 두고 (상황, 택한 수, 라운드 결과)를 기록.
 * DMC(DouZero식) 학습용. 4좌석 전원 신경망, 모든 플레이 결정 기록.
 * 사용: node ml/gen-selfplay.js <weights.json> <games> <eps> [seedBase=0] > out.jsonl 2> progress.log
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, 'net-infer.js'));

var wPath = process.argv[2];
var nGames = +process.argv[3] || 100;
var eps = +process.argv[4];
if (!(eps >= 0 && eps <= 1)) eps = 0.08;
var seedBase = +process.argv[5] || 0;

var net = NET.load(wPath);

function playGame(seed) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], buf = [], nDec = 0, guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') {
      var d = g.roundSummary.deltas;
      for (var bi = 0; bi < buf.length; bi++) {
        var r0 = buf[bi];
        r0.out = (r0.seat % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
        process.stdout.write(JSON.stringify(r0) + '\n');
      }
      nDec += buf.length; buf = []; hist = [];
      g.apply({ type: 'next_round' });
      continue;
    }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var a = null;
    if (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
      var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
      if (!gm.moves.length) a = { type: 'pass_turn', seat: s };
      else {
        var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
        if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
        var idx, pb = 1;
        if (cands.length === 1) idx = 0;
        else {
          // 정책 소프트맥스에서 샘플링(자연 탐험) + ε 바닥 혼합 — PPO용 행동확률(pb) 기록
          var rec0 = net.makeRecord(g, s, cands, hist);
          var probs = net.probsRecord(rec0);
          var K = probs.length, u = Math.random(), acc = 0;
          if (Math.random() < eps) idx = Math.floor(Math.random() * K);
          else {
            idx = K - 1;
            for (var pi = 0; pi < K; pi++) { acc += probs[pi]; if (u < acc) { idx = pi; break; } }
          }
          pb = (1 - eps) * probs[idx] + eps / K;
          rec0.pick = idx;
          rec0.pb = pb;
          buf.push(rec0);
        }
        var pick = cands[idx];
        if (pick.t === 'pass') a = { type: 'pass_turn', seat: s };
        else {
          a = { type: 'play_cards', seat: s, cards: pick.c };
          if (pick.c.indexOf('MJ') >= 0) {
            var wsh = B.botWish(g.hands[s].filter(function (id) { return pick.c.indexOf(id) < 0; }));
            if (wsh) a.wish = wsh;
          }
        }
      }
    } else {
      a = B.botDecide(g, s, 'normal'); // 선언·교환·소원·용 — 휴리스틱 고정(v1 RL 범위 밖)
    }
    if (!a) throw new Error('no action');
    var r = g.apply(a);
    if (!r.ok) throw new Error('rejected ' + a.type + ' ' + r.error.code);
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
    if (++guard > 30000) throw new Error('guard');
  }
  return nDec;
}

var t0 = Date.now(), total = 0;
for (var i = 0; i < nGames; i++) {
  try {
    total += playGame(seedBase + i);
  } catch (e) {
    console.error('game', i, 'FAIL', e.message);
  }
  if ((i + 1) % 50 === 0) console.error('games ' + (i + 1) + '/' + nGames + ' decisions=' + total + ' elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
}
console.error('DONE games=' + nGames + ' decisions=' + total);
