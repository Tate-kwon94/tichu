#!/usr/bin/env node
/* 플레이아웃 편향의 크기를 잰다 — 보정망을 만들 가치가 있는지 먼저 판정.
 *
 * 같은 세계 w에 대해
 *   a = 보통봇 플레이아웃            (지금 1단이 말단 평가로 쓰는 값 — 결정론적)
 *   b = 네 자리 전부 신경망 그리디    (내 미래 플레이도 강하다고 가정한 값)
 *   c = 우리 팀만 신경망, 상대는 보통 (신경망이 정말 보통보다 센지 확인)
 * 을 구해서
 *   sd(b−a)  보정의 크기. 세계 간 신호 sd 대비 작으면 보정해봐야 순위가 안 바뀐다.
 *   mean(c−a) 신경망 그리디의 실제 우위(점수). 0 근처면 라벨을 강하게 만든 의미가 없다.
 *
 * 사용: node ml/measure-gap.js <weights.json> [세계수=200]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));

var net = NET.load(process.argv[2]);
var NW = +process.argv[3] || 200;

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

// who(seat) → true면 신경망 그리디, false면 보통봇
function rollout(sim, seat, hist0, who) {
  var myEven = seat % 2 === 0, guard = 0, hist = hist0.slice();
  while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd') {
    var w = sim.waitingOn(); if (!w.length) break;
    var s = w[0];
    var isPlay = (sim.phase === 'play' && sim.turnSeat === s && sim.finished.indexOf(s) < 0);
    var a = (isPlay && who(s)) ? netAction(sim, s, hist) : B.botDecide(sim, s, 'normal');
    if (!a || !sim.apply(a).ok) break;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = sim.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
    if (++guard > 2000) break;
  }
  if (!sim.roundSummary) return 0;
  var d = sim.roundSummary.deltas;
  return Math.max(-2, Math.min(2, (myEven ? d.teamA - d.teamB : d.teamB - d.teamA) / 100));
}

// 실제 대국에서 중간 국면을 모으고, 각 국면마다 결정화 세계를 하나 만든다(= 탐색 말단과 같은 분포)
var worlds = [];
for (var seed = 500000; worlds.length < NW && seed < 540000; seed++) {
  var g = new C.Game({ seed: seed, targetScore: 500 }), hist = [], guard = 0;
  while (!g.gameOver && ++guard < 3000 && worlds.length < NW) {
    if (g.phase === 'roundEnd') { hist = []; g.apply({ type: 'next_round' }); continue; }
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    var isPlay = (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0);
    if (isPlay && g.hands[s].length >= 4 && Math.random() < 0.05) {
      worlds.push({ w: B.determinize(g, s), seat: s, hist: hist.slice() });
    }
    var a = B.botDecide(g, s, 'normal'); if (!a || !g.apply(a).ok) break;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la2 = g.lastAction;
      if (la2 && la2.combo) hist.push({ s: s, t: la2.combo.type, r: la2.combo.rank, l: la2.combo.length });
      else if (la2 && la2.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
  }
}
console.log('결정화 세계 ' + worlds.length + '개');

var A = [], Bv = [], Cv = [], t0 = Date.now();
for (var i = 0; i < worlds.length; i++) {
  var o = worlds[i], me = o.seat % 2;
  A.push(rollout(o.w.clone(), o.seat, o.hist, function () { return false; }));
  Bv.push(rollout(o.w.clone(), o.seat, o.hist, function () { return true; }));
  Cv.push(rollout(o.w.clone(), o.seat, o.hist, function (s) { return s % 2 === me; }));
  if ((i + 1) % 50 === 0) console.log('  ' + (i + 1) + '/' + worlds.length + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
}

function stat(v) {
  var n = v.length, m = v.reduce(function (a, b) { return a + b; }, 0) / n;
  var s = Math.sqrt(v.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / n);
  return { m: m, sd: s };
}
var dBA = A.map(function (a, i) { return Bv[i] - a; });
var dCA = A.map(function (a, i) { return Cv[i] - a; });
var sA = stat(A), sBA = stat(dBA), sCA = stat(dCA);

console.log('\n[세계 간 신호]');
console.log('  보통 플레이아웃 a: 평균 ' + sA.m.toFixed(3) + '  sd ' + sA.sd.toFixed(3) + '  ← 탐색이 구분하는 신호의 크기');
console.log('\n[편향의 크기]');
console.log('  b−a (네 자리 전부 신경망): 평균 ' + sBA.m.toFixed(3) + '  sd ' + sBA.sd.toFixed(3) +
            '   신호 대비 ' + (100 * sBA.sd / sA.sd).toFixed(0) + '%');
console.log('  c−a (우리 팀만 신경망):    평균 ' + sCA.m.toFixed(3) + '  sd ' + sCA.sd.toFixed(3) +
            '   ← 평균이 +면 신경망이 보통보다 강함');
var agree = 0;
for (var j = 0; j < A.length; j++) if ((A[j] > 0) === (Bv[j] > 0)) agree++;
console.log('\n  부호 일치율 a vs b: ' + (100 * agree / A.length).toFixed(0) + '%  (낮을수록 편향이 판단을 뒤집는다는 뜻)');
