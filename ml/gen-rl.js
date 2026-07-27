#!/usr/bin/env node
/* 3단 RL 자가대전 생성 — 학습팀(0,2) vs 동결 2단(1,3).
 *
 * 왜 대칭 자가대전이 아니라 "학습 vs 동결"인가:
 *   전원 현재정책이면 리워드가 자기 기준이라 "다 같이 패스"가 안정 균형(과거 붕괴 구조원인).
 *   동결 2단을 상대로 두면 과다패스가 즉시 상대적 손해 → 붕괴 흡인자 소멸.
 *   그리고 "2단을 이긴다"를 직접 최적화(best-response). 동결 상대라 순환 없음.
 *
 * 양 팀 모두 2단 환경: 교환=keepSpecials, 선언=신경망. 학습팀만 카드 결정을 ε+softmax로 샘플·기록.
 * 오라클 상태 baseline(ov): god view로 결정 시점 완전정보 상태값 기록 → 학습 때 분산 제거.
 *
 * 사용: node ml/gen-rl.js <learn.json> <frozen.json> <games> <eps> <seedBase> <declare.json> [oracle.json]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));
// 4단 환경: 양팀 교환을 학습(선형)으로 (동결 3단 생태계). 미설정 시 2단 환경 그대로.
var RLEXM = process.env.TICHU_RL_EXW
  ? require(path.join(__dirname, 'exchange-infer.js')).load(process.env.TICHU_RL_EXW)
  : null;

var learnNet = NET.load(process.argv[2]);
var frozenNet = NET.load(process.argv[3]);
var nGames = +process.argv[4] || 100;
var eps = +process.argv[5]; if (!(eps >= 0 && eps <= 1)) eps = 0.05;
var seedBase = +process.argv[6] || 0;
var declPath = process.argv[7];
var oraclePath = process.argv[8];

var decl = null;
if (declPath) { try { decl = require(path.join(__dirname, '..', 'shared', 'declare.js')).load(declPath); } catch (e) {} }
var oracle = null;
if (oraclePath) { try { oracle = require(path.join(__dirname, '..', 'shared', 'oracle-value.js')).load(oraclePath); } catch (e) {} }

function frozenPlay(g, s, hist) {                             // 동결 2단 카드 결정(그리디)
  var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
  if (!gm.moves.length) return { type: 'pass_turn', seat: s };
  var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
  if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
  var pick = cands[cands.length === 1 ? 0 : frozenNet.pickRecord(frozenNet.makeRecord(g, s, cands, hist))];
  if (pick.t === 'pass') return { type: 'pass_turn', seat: s };
  var a = { type: 'play_cards', seat: s, cards: pick.c };
  if (pick.c.indexOf('MJ') >= 0) { var w = B.botWish(g.hands[s].filter(function (id) { return pick.c.indexOf(id) < 0; })); if (w) a.wish = w; }
  return a;
}

function playGame(seed) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], buf = [], nDec = 0, guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') {
      var d = g.roundSummary.deltas;
      for (var bi = 0; bi < buf.length; bi++) {
        buf[bi].out = d.teamA - d.teamB;                     // 학습팀 = A(짝수좌석)
        process.stdout.write(JSON.stringify(buf[bi]) + '\n');
      }
      nDec += buf.length; buf = []; hist = [];
      g.apply({ type: 'next_round' });
      continue;
    }
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    var learn = (s % 2 === 0);
    var a = null;
    if (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
      if (!learn) { a = frozenPlay(g, s, hist); }
      else {
        var gm = C.genMoves(g.hands[s], g.currentCombo, g.wish);
        if (!gm.moves.length) a = { type: 'pass_turn', seat: s };
        else {
          var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
          if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
          var idx, pb = 1;
          if (cands.length === 1) idx = 0;
          else {
            var rec0 = learnNet.makeRecord(g, s, cands, hist);
            var probs = learnNet.probsRecord(rec0);
            var K = probs.length, u = Math.random(), acc = 0;
            if (Math.random() < eps) idx = Math.floor(Math.random() * K);
            else { idx = K - 1; for (var pi = 0; pi < K; pi++) { acc += probs[pi]; if (u < acc) { idx = pi; break; } } }
            pb = (1 - eps) * probs[idx] + eps / K;
            rec0.pick = idx; rec0.pb = pb;
            if (oracle) rec0.ov = Math.max(-2, Math.min(2, oracle.value(g, s)));
            buf.push(rec0);
          }
          var pick = cands[idx];
          if (pick.t === 'pass') a = { type: 'pass_turn', seat: s };
          else {
            a = { type: 'play_cards', seat: s, cards: pick.c };
            if (pick.c.indexOf('MJ') >= 0) { var wsh = B.botWish(g.hands[s].filter(function (id) { return pick.c.indexOf(id) < 0; })); if (wsh) a.wish = wsh; }
          }
        }
      }
    } else if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      a = { type: 'submit_exchange', seat: s,
            give: (RLEXM && RLEXM.give(g, s)) || B.botExchange(g, s, { keepSpecials: true }) }; // ⑦ 양팀 2단
    } else if (decl && g.phase === 'grand' && !g.grandAnswered[s]) {
      a = { type: 'call_grand', seat: s, call: decl.grand(g.hands[s]) };
    } else if (decl && g.phase === 'play' && g.turnSeat === s && !g.playedFirst[s] &&
               !g.tichu[s] && g.finished.indexOf(s) < 0 && decl.tichu(g.hands[s])) {
      a = { type: 'call_tichu', seat: s };
    } else {
      a = B.botDecide(g, s, 'normal');
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
  try { total += playGame(seedBase + i); }
  catch (e) { console.error('game', i, 'FAIL', e.message); }
  if ((i + 1) % 50 === 0) console.error('games ' + (i + 1) + '/' + nGames + ' dec=' + total + ' ' + Math.round((Date.now() - t0) / 1000) + 's');
}
console.error('DONE games=' + nGames + ' decisions=' + total);
