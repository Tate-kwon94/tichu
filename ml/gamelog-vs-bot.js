#!/usr/bin/env node
/* 사람 vs 봇 — 기보의 사람 플레이 결정마다 배포 3단(PUCT 950ms)이라면 어떤 수를
 * 냈을지 재현하고, 갈린 결정은 홀드아웃 CRN 세계에서 EV 격차를 잰다.
 *
 * ⚠ 2026-08-08: **이 도구의 gap 수치는 순환이다 — 쓰지 마라.**
 * 봇 수는 "결정화 + 보통봇 플레이아웃"의 argmax인데 갈린 수를 같은 통계량으로 채점한다.
 * 실측: 이 도구 −13.98(25.3σ) → 순환 제거 후 −2.13(1.1σ). 착시의 원인은 이어두기 정책이었다.
 * 대체: ml/judge-independent.js (A/B/C 3조건). 유형 분류(cls)만 여기서 재사용 가능.
 *
 * 목적(4단 3차의 수확 도구): "사람이 3단보다 잘 두는 국면"의 지도.
 * gap > 0 = 사람 수가 더 좋았다 — 그 유형이 4단 재료 후보다.
 * 주의: 평가자는 보통봇 플레이아웃 프록시다. deepThink 교훈(프록시≠실물)이 있으니
 * 이 지도는 "후보 발굴"까지만 — 재료의 최종 판정은 언제나 실물 게이트.
 *
 * 사용: node ml/gamelog-vs-bot.js <gamelog.jsonl> [puctMs=950] [worlds=200]
 * 출력: stdout JSONL {agree, gap, cls, who} — mine-analyze.py 호환
 *        stderr 플레이어별 요약(플레이 일치율·교환 일치율)
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));
var INF = require(path.join(__dirname, 'exchange-infer.js'));
var GR = require(path.join(__dirname, 'gamelog-replay.js'));

var FILE = process.argv[2] || path.join(__dirname, '..', 'data', 'gamelog.jsonl');
var PUCTMS = +process.argv[3] || 950;
var W = +process.argv[4] || 200;

var hy = HY.create(path.join(__dirname, '..', 'shared', 'weights-super3.json'));
var exch = INF.load(path.join(__dirname, '..', 'shared', 'weights-exchange3.json'));

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function actKey(a) { return (!a || a.type === 'pass_turn') ? 'pass' : a.cards.slice().sort().join(','); }

/* 두 액션을 신선한 CRN 세계 W개에서 재평가 — EV(사람) − EV(봇) */
function holdoutGap(g, seat, aHuman, aBot, rngSeed) {
  var team = seat % 2, sH = 0, sB = 0, ok = 0;
  for (var w = 0; w < W; w++) {
    globalThis.__TICHU_RNG = mulberry(rngSeed + 500000 + w * 104729);
    var det = B.determinize(g, seat);
    var vv = [];
    [aHuman, aBot].forEach(function (act) {
      var sim = det.clone();
      if (!sim.apply(act).ok) { vv.push(null); return; }
      var guard = 0;
      while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd' && ++guard < 2000) {
        var ww = sim.waitingOn(); if (!ww.length) break;
        var aa = B.botDecide(sim, ww[0], 'normal'); if (!aa || !sim.apply(aa).ok) break;
      }
      if (!sim.roundSummary) { vv.push(null); return; }
      var d = sim.roundSummary.deltas;
      vv.push(team === 0 ? d.teamA - d.teamB : d.teamB - d.teamA);
    });
    if (vv[0] != null && vv[1] != null) { sH += vv[0]; sB += vv[1]; ok++; }
  }
  delete globalThis.__TICHU_RNG;
  return ok ? +((sH - sB) / ok).toFixed(2) : null;
}

function classify(g, seat, chosenKey) {
  var n = g.hands[seat].length;
  var opp1 = (seat + 1) % 4, opp2 = (seat + 3) % 4, pt = (seat + 2) % 4;
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

var recs = GR.load(FILE);
var players = {};                    // 이름 → {plays, agree, gaps[], exch, exchSame}
function P(name) { return players[name] || (players[name] = { plays: 0, agree: 0, gaps: [], exch: 0, exchSame: 0 }); }

var t0 = Date.now(), replayFail = 0, nDec = 0;
recs.forEach(function (rec, ri) {
  if (!rec.seats) return;
  var humans = {};
  rec.seats.forEach(function (p, s) { if (p && !p.b) humans[s] = p.n || ('좌석' + s); });
  if (!Object.keys(humans).length) return;
  var r = GR.replay(rec, function (g, a, i, hist) {
    var s = a.seat;
    if (!(s in humans)) return;
    var who = humans[s];
    // 교환 결정 — 3단 학습 교환과 세트 비교 (규칙층: 측정=배포 축)
    if (a.type === 'submit_exchange' && g.phase === 'exchange') {
      var bg = null;
      try { bg = exch.give(g, s) || B.botExchange(g, s, { keepSpecials: true }); } catch (e) { /* 비교 실패 무시 */ }
      if (bg && a.give) {
        var hSet = Object.keys(a.give).map(function (k) { return a.give[k]; }).sort().join(',');
        var bSet = Object.keys(bg).map(function (k) { return bg[k]; }).sort().join(',');
        var pl = P(who); pl.exch++; if (hSet === bSet) pl.exchSame++;
      }
      return;
    }
    // 플레이 결정 — 3단 PUCT 재현 후 비교
    if (g.phase !== 'play' || g.turnSeat !== s) return;
    if (!(a.type === 'play_cards' || a.type === 'pass_turn')) return;
    if (g.hands[s].length <= 1) return;
    var seedBase = ((rec.t || 0) % 1000000007) + ri * 7919 + i * 131;
    globalThis.__TICHU_RNG = mulberry(seedBase);
    var bot = hy.decidePuct(g, s, hist, { budgetMs: PUCTMS, c: 1.0 });
    delete globalThis.__TICHU_RNG;
    if (!bot) return;
    nDec++;
    var hk = actKey(a.type === 'pass_turn' ? null : a), bk = actKey(bot.type === 'pass_turn' ? null : bot);
    var agree = hk === bk;
    var gap = 0;
    if (!agree && W > 0) gap = holdoutGap(g, s, a, bot, seedBase);
    var pl = P(who); pl.plays++; if (agree) pl.agree++; else if (gap != null) pl.gaps.push(gap);
    console.log(JSON.stringify({ agree: agree ? 1 : 0, gap: gap == null ? 0 : gap, cls: classify(g, s, hk), who: who }));
  });
  if (!r.ok) { replayFail++; console.error('  기보 #' + ri + ' 재생 실패: ' + r.error); }
  if ((ri + 1) % 10 === 0) console.error('  ' + (ri + 1) + '/' + recs.length + ' 결정 ' + nDec + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
});

console.error('=== 플레이어별 요약 (기보 ' + recs.length + '개' + (replayFail ? ', 재생 실패 ' + replayFail : '') + ') ===');
Object.keys(players).forEach(function (n) {
  var p = players[n];
  var mg = p.gaps.length ? (p.gaps.reduce(function (a, b) { return a + b; }, 0) / p.gaps.length).toFixed(1) : '-';
  var pg = p.gaps.filter(function (x) { return x > 0; }).length;
  console.error(n + ': 플레이 ' + p.plays + '수 · 3단과 일치 ' + (p.plays ? Math.round(100 * p.agree / p.plays) : 0) + '%' +
    ' · 갈린 수 평균격차 ' + mg + ' (사람우세 ' + pg + '/' + p.gaps.length + ')' +
    ' · 교환 일치 ' + p.exchSame + '/' + p.exch);
});
