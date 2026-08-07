#!/usr/bin/env node
/* 사람 수 vs 봇 수를 **선택에 쓰이지 않은 심판**으로 다시 채점한다.
 *
 * 왜 다시 재는가 — gamelog-vs-bot.js의 채점이 순환이었다.
 * 봇의 수는 "결정화 세계 + 보통봇 플레이아웃"의 argmax로 뽑힌다. 그런데 그 도구는
 * 갈린 수를 **똑같은 통계량**으로 채점한다. 그러면 봇이 이기는 게 정의상 보장된다.
 * (프로젝트 방법론 §5 "순환논증 금지"의 정확한 사례.)
 *
 * 순환은 두 겹이다:
 *   ① determinize(g, seat) — 봇의 믿음분포에서 상대 패를 다시 뽑는다. 봇은 그 분포 위에서 최적화했다.
 *   ② 이어두기가 전 좌석 보통봇 — **사람 자신의 이후 수까지** 봇으로 둔다.
 *      사람이 여러 트릭에 걸쳐 세운 계획은 다음 수부터 폐기되므로 계획적인 수일수록 낮게 찍힌다.
 *
 * 이 도구가 깨는 방법:
 *   ① 기보에는 진짜 손패가 있다 → 결정화 없이 **진짜 세계**에서 잰다. 봇이 최적화한 분포가 아니다.
 *   ② 이어두기를 **신경망 그리디**로 바꾼다 — 선택(PUCT의 리프=보통봇 플레이아웃)에 쓰이지 않은 정책.
 *
 * 세 가지를 나란히 내놓아 어느 겹이 결과를 만들었는지 분해한다:
 *   A) det+bot   = 종전 방식(순환) — 재현 대조군
 *   B) true+bot  = ①만 제거
 *   C) true+net  = ①② 모두 제거  ← 주 판정
 *
 * 진짜 세계는 하나뿐이라 분산을 줄일 표본이 없다. 대신 이어두기의 무작위성(RNG)만
 * CRN으로 여러 번 굴려 평균낸다 — 양 분기에 같은 시드를 써 짝지음을 유지한다.
 *
 * 사용: node ml/judge-independent.js <gamelog.jsonl> [puctMs=950] [reps=24] [최대결정=800] [seed=7]
 * 출력: stderr 요약, stdout JSONL {who, gapA, gapB, gapC}
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));
var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));
var GR = require(path.join(__dirname, 'gamelog-replay.js'));

var FILE = process.argv[2] || path.join(__dirname, '..', 'data', 'gamelog.jsonl');
var PUCTMS = +process.argv[3] || 950;
var REPS = +process.argv[4] || 24;
var MAXDEC = +process.argv[5] || 800;
var SEED = +process.argv[6] || 7;
/* 샤딩 — CI 20러너 분산용. 라운드를 러너별로 나눈다(라운드 단위라 결정이 쪼개지지 않는다). */
var SHARD = +process.env.SHARD || 0;
var TOTAL_SHARDS = +process.env.TOTAL_SHARDS || 1;
var RATE = process.env.RATE ? +process.env.RATE : 0.16;   // 표본율 (1이면 전수)

var WPATH = path.join(__dirname, '..', 'shared', 'weights-super3.json');
var hy = HY.create(WPATH);
var net = NET.load(WPATH);

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* 신경망 그리디 — measure-gap.js와 같은 구현(선례 재사용) */
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

/* 한 분기를 끝까지 굴려 팀 점수차를 낸다. useNet=true면 전 좌석 신경망 그리디 */
function rollTo(sim, team, hist0, useNet) {
  var guard = 0, hist = hist0.slice();
  while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd' && ++guard < 2000) {
    var w = sim.waitingOn(); if (!w.length) break;
    var s = w[0];
    var isPlay = (sim.phase === 'play' && sim.turnSeat === s && sim.finished.indexOf(s) < 0);
    var a = (isPlay && useNet) ? netAction(sim, s, hist) : B.botDecide(sim, s, 'normal');
    if (!a || !sim.apply(a).ok) return null;
  }
  if (!sim.roundSummary) return null;
  var d = sim.roundSummary.deltas;
  return team === 0 ? d.teamA - d.teamB : d.teamB - d.teamA;
}

/* 두 수를 같은 조건에서 REPS회 굴려 EV(사람) − EV(봇).
 * mode: 'detBot' | 'trueBot' | 'trueNet' */
function gap(g, seat, aH, aB, hist, mode, rngSeed) {
  var team = seat % 2, sH = 0, sB = 0, ok = 0;
  var useNet = (mode === 'trueNet');
  var useDet = (mode === 'detBot');
  for (var w = 0; w < REPS; w++) {
    var base;
    globalThis.__TICHU_RNG = mulberry(rngSeed + w * 104729);
    base = useDet ? B.determinize(g, seat) : g;
    var vv = [];
    [aH, aB].forEach(function (act) {
      // 짝지음: 두 분기에 같은 RNG 시드 — 이어두기 무작위성이 차이를 만들지 않게
      globalThis.__TICHU_RNG = mulberry(rngSeed + w * 104729 + 13);
      var sim = base.clone ? base.clone() : B.cloneGame(base);
      if (!sim.apply(act).ok) { vv.push(null); return; }
      vv.push(rollTo(sim, team, hist, useNet));
    });
    if (vv[0] != null && vv[1] != null) { sH += vv[0]; sB += vv[1]; ok++; }
  }
  delete globalThis.__TICHU_RNG;
  return ok ? (sH - sB) / ok : null;
}

function actKey(a) { return (!a || a.type === 'pass_turn') ? 'pass' : a.cards.slice().sort().join(','); }

/* 결정 유형 — gamelog-vs-bot.js와 같은 스키마(mine-analyze.py 호환).
 * 티츄 맥락(tMe/tPt/tOp)이 들어 있어 "선언이 걸린 국면"을 따로 뽑을 수 있다. */
function classify(g, seat, chosenKey) {
  var n = g.hands[seat].length;
  var pt = (seat + 2) % 4, opp1 = (seat + 1) % 4, opp2 = (seat + 3) % 4;
  return {
    lead: !g.currentCombo ? 1 : 0,
    hand: n <= 4 ? 'end' : n <= 9 ? 'mid' : 'early',
    req: g.currentCombo ? g.currentCombo.type : '-',
    pick: chosenKey === 'pass' ? 'pass' : 'play',
    tMe: (g.tichu[seat] > 0 && g.finished.indexOf(seat) < 0) ? 1 : 0,
    tPt: (g.tichu[pt] > 0 && g.firstOutSeat === null) ? 1 : 0,
    tOp: ((g.tichu[opp1] > 0 && g.finished.indexOf(opp1) < 0) || (g.tichu[opp2] > 0 && g.finished.indexOf(opp2) < 0)) ? 1 : 0,
    wish: g.wish ? 1 : 0,
    bomb: B.hasBomb(g.hands[seat]) ? 1 : 0
  };
}

// ---------- 본체 ----------
var recs = GR.load(FILE);
var rnd = mulberry(SEED);
var rows = [], seen = 0, div = 0, t0 = Date.now();

for (var ri = 0; ri < recs.length && rows.length < MAXDEC; ri++) {
  if (TOTAL_SHARDS > 1 && (ri % TOTAL_SHARDS) !== SHARD) continue;
  GR.replay(recs[ri], function (g, act, i, hist) {
    if (rows.length >= MAXDEC) return;
    if (g.phase !== 'play') return;
    if (act.type !== 'play_cards' && act.type !== 'pass_turn') return;
    var s = act.seat;
    if (g.turnSeat !== s) return;
    seen++;
    // 표본 축소 — 결정마다 PUCT 950ms + 롤아웃이라 전수는 불가
    if (RATE < 1 && rnd() > RATE) return;

    var bot = hy.decidePuct(g.clone(), s, hist, { budgetMs: PUCTMS, c: 1.5 });
    if (actKey(bot) === actKey(act)) return;   // 일치는 격차 0
    div++;
    var sd = 900000 + rows.length * 7919;
    var row = {
      who: (recs[ri].seats[s] || {}).n || ('seat' + s),
      cls: classify(g, s, actKey(act)),
      gapA: gap(g, s, act, bot, hist, 'detBot', sd),
      gapB: gap(g, s, act, bot, hist, 'trueBot', sd),
      gapC: gap(g, s, act, bot, hist, 'trueNet', sd)
    };
    rows.push(row);
    process.stdout.write(JSON.stringify(row) + '\n');
    if (rows.length % 25 === 0) {
      process.stderr.write('  ' + rows.length + '/' + MAXDEC + ' (' + Math.round((Date.now() - t0) / 1000) + 's)\n');
    }
  });
}

function stat(key) {
  var v = rows.map(function (r) { return r[key]; }).filter(function (x) { return x != null; });
  if (!v.length) return null;
  var m = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
  var sd = Math.sqrt(v.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / Math.max(1, v.length - 1));
  var se = sd / Math.sqrt(v.length);
  var pos = v.filter(function (x) { return x > 0; }).length;
  return { n: v.length, m: m, se: se, pos: 100 * pos / v.length };
}

process.stderr.write('\n=== 독립 심판 (갈린 수 ' + rows.length + '건 / 훑은 결정 ' + seen + ') ===\n');
[['A) det+bot  (종전=순환)', 'gapA'],
 ['B) true+bot (①제거)', 'gapB'],
 ['C) true+net (①②제거) ★', 'gapC']].forEach(function (p) {
  var st = stat(p[1]);
  if (!st) { process.stderr.write(p[0] + ': 데이터 없음\n'); return; }
  process.stderr.write(p[0] + ': 평균 ' + (st.m >= 0 ? '+' : '') + st.m.toFixed(2) +
    ' ± ' + st.se.toFixed(2) + '  · 사람우세 ' + st.pos.toFixed(0) + '%  (n=' + st.n + ')\n');
});
process.stderr.write('\n해석: 사람우세가 50%에 가까우면 "봇과 다를 뿐 우열 없음",\n' +
  '      50%보다 크게 낮으면 사람이 실제로 약하다는 뜻이다.\n' +
  '      A와 C의 차이가 곧 순환이 만들어낸 착시의 크기다.\n');
