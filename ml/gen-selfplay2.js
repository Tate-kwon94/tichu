#!/usr/bin/env node
/* RL 자가대전 생성 v2 — 2단 배포 환경에 맞춘 버전.
 *
 * 기존 gen-selfplay.js의 문제: 교환·선언을 botDecide('normal')의 약한 휴리스틱으로 처리했다.
 * 그런데 배포 봇(2단)은 교환에서 마작·개를 보유(⑦)하고 선언은 신경망을 쓴다.
 * 잘못된 환경에서 학습하면 잘못된 정책이 나온다 → 환경을 배포와 일치시킨다.
 *
 * 네 좌석 전원이 현재 정책(ε+소프트맥스 샘플링)으로 카드를 놓고, 교환=keepSpecials,
 * 선언=신경망(있으면). (상황, 택한 수, 행동확률 pb, 라운드 결과)를 PPO용으로 기록.
 *
 * 오라클 상태 baseline(ov): 자가대전은 4명 패를 다 본다(god view). 결정 시점의 완전정보
 * 상태값을 기록해두면, 학습 때 어드밴티지 = 라운드결과 − ov 로 딜·파트너·상대 분산을 걷어낸다.
 * (배포 정책은 오라클을 안 씀 — 학습 때만 쓰는 크리틱. 근시안 없음: 신호는 진짜 롤아웃 결과.)
 *
 * 사용: node ml/gen-selfplay2.js <weights.json> <games> <eps> [seedBase=0] [declare.json] [oracle.json] > out.jsonl
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));

var wPath = process.argv[2];
var nGames = +process.argv[3] || 100;
var eps = +process.argv[4];
if (!(eps >= 0 && eps <= 1)) eps = 0.08;
var seedBase = +process.argv[5] || 0;
var declPath = process.argv[6];
var oraclePath = process.argv[7];

var net = NET.load(wPath);
var decl = null;
if (declPath) { try { decl = require(path.join(__dirname, '..', 'shared', 'declare.js')).load(declPath); } catch (e) {} }
var oracle = null;
if (oraclePath) { try { oracle = require(path.join(__dirname, '..', 'shared', 'oracle-value.js')).load(oraclePath); } catch (e) {} }

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
          // 오라클 상태 baseline — 결정 시점(수 두기 전)의 완전정보 상태값. 딜·파트너·상대 분산 흡수.
          if (oracle) rec0.ov = Math.max(-2, Math.min(2, oracle.value(g, s)));
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
    } else if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      a = { type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: true }) }; // ⑦ 2단 교환
    } else if (decl && g.phase === 'grand' && !g.grandAnswered[s]) {
      a = { type: 'call_grand', seat: s, call: decl.grand(g.hands[s]) };
    } else if (decl && g.phase === 'play' && g.turnSeat === s && !g.playedFirst[s] &&
               !g.tichu[s] && g.finished.indexOf(s) < 0 && decl.tichu(g.hands[s])) {
      a = { type: 'call_tichu', seat: s };
    } else {
      a = B.botDecide(g, s, 'normal'); // 소원·용은 휴리스틱
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
  if ((i + 1) % 50 === 0) console.error('games ' + (i + 1) + '/' + nGames + ' decisions=' + total + ' ' + Math.round((Date.now() - t0) / 1000) + 's');
}
console.error('DONE games=' + nGames + ' decisions=' + total);
