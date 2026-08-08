#!/usr/bin/env node
/* 처치 발현 게이트 — 대조군이 있는 유일한 방법.
 *
 * 왜 필요한가: PUCT는 매 시뮬마다 새 세계를 뽑아 확률적이다. 같은 설정을 두 번 돌려도
 * 수가 ~31% 바뀐다. 그런데 이 프로젝트는 "처치로 수가 N% 바뀌었다"를 발현 증거로 써 왔고,
 * 2026-07-30에 그 때문에 winCtx가 "맥락별로 작동한다"고 오판할 뻔했다(실제로는 미발현).
 *
 * 하는 일: 같은 국면에서
 *   대조군 = 기준 설정 두 번 (A1 vs A2)  → 잡음 바닥
 *   처치군 = 기준 vs 처치     (A1 vs B)  → 잡음 + 처치
 * 순효과 = 처치군 변경률 − 대조군 변경률. 이게 유의하지 않으면 처치가 발현되지 않은 것이다.
 *
 * 사용: node ml/gate-treatment.js '<처치 opts JSON>' [국면수=40] [예산ms=350] [시드=3001]
 *   예: node ml/gate-treatment.js '{"outBonus":8}' 40 350
 *       node ml/gate-treatment.js '{"winCtx":1}' 40 350
 * 환경: TICHU_SCORES="460,100" 로 게임 점수 맥락 지정(winCtx류 검사용)
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));

var TREAT = JSON.parse(process.argv[2] || '{}');
if (process.env.TICHU_FASTPOL) {                        // 경량 롤아웃 정책도 처치로 취급
  var FPM = require(path.join(__dirname, '..', 'shared', 'fast-policy.js'));
  TREAT.fastPol = FPM.create(JSON.parse(require('fs').readFileSync(process.env.TICHU_FASTPOL, 'utf8')));
}
var NPOS = +process.argv[3] || 40;
var BUD = +process.argv[4] || 350;
var SEED0 = +process.argv[5] || 3001;
var SCORES = (process.env.TICHU_SCORES || '').split(',').filter(Boolean).map(Number);

var hy = HY.create(path.join(__dirname, '..', 'shared', 'weights-super3.json'));
function key(a) { return JSON.stringify((a && a.cards) || 'pass'); }

var ctrl = 0, treat = 0, n = 0, qShift = 0;
for (var seed = SEED0; n < NPOS && seed < SEED0 + NPOS * 200; seed++) {
  var opt = { seed: seed, targetScore: 500 };
  if (SCORES.length === 2) opt.scores = SCORES;
  var g = new C.Game(opt);
  /* TICHU_DECL="1,3" 이면 그 좌석들이 라지 티츄를 선언한 국면을 만든다.
   * 선언 조건부 처치(declBias 등)는 선언이 없는 국면에선 정의상 무효라, 무작위 국면으로 재면
   * 희석돼 '발현 안 됨'으로 보인다 — 처치가 적용되는 부분모집단에서 재야 한다. */
  var DECL = (process.env.TICHU_DECL || '').split(',').filter(Boolean).map(Number);
  for (var i = 0; i < 4; i++) g.apply({ type: 'call_grand', seat: i, call: DECL.indexOf(i) >= 0 });
  for (var s = 0; s < 4; s++) g.apply({ type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: true }) });
  var gd = 0, step = (seed % 7) + 3;
  while (g.phase === 'play' && gd < step) {
    var w = g.waitingOn(); if (!w.length) break;
    var a0 = B.botDecide(g, w[0], 'normal'); if (!a0 || !g.apply(a0).ok) break;
    gd++;
  }
  if (g.phase !== 'play') continue;
  // TICHU_NEEDWISH=1 이면 소원이 살아 있는 국면만 — 조건부 처치는 조건이 성립해야 발현한다
  if (process.env.TICHU_NEEDWISH === '1' && !g.wish) continue;
  var base = { budgetMs: BUD, c: 1.0, repCap: 1e9, wantStats: true };
  var A1 = hy.decidePuct(g, g.turnSeat, [], base);
  if (A1.cands.length < 2) continue;
  var A2 = hy.decidePuct(g, g.turnSeat, [], base);                       // 대조군
  var Bt = hy.decidePuct(g, g.turnSeat, [], Object.assign({}, base, TREAT)); // 처치군
  n++;
  if (key(A1.action) !== key(A2.action)) ctrl++;
  if (key(A1.action) !== key(Bt.action)) treat++;
  qShift += Math.abs(Bt.q[Bt.pick] - A1.q[A1.pick]);
}

function se(p, m) { return Math.sqrt(p * (1 - p) / m); }
var pc = ctrl / n, pt = treat / n;
var d = pt - pc, ds = Math.sqrt(se(pc, n) * se(pc, n) + se(pt, n) * se(pt, n));
console.log('처치: ' + JSON.stringify(TREAT) + (SCORES.length ? '  점수맥락 ' + SCORES.join(':') : ''));
console.log('  국면 ' + n + ' · 예산 ' + BUD + 'ms');
console.log('  대조군(같은 설정 2회) 변경률 ' + (100 * pc).toFixed(1) + '%   ← 잡음 바닥');
console.log('  처치군 변경률           ' + (100 * pt).toFixed(1) + '%');
console.log('  순효과 ' + (100 * d).toFixed(1) + '%p ± ' + (100 * ds).toFixed(1) + '  (' + (ds ? (d / ds).toFixed(1) : '0') + 'σ)');
console.log('  평균 |Q 변화| ' + (qShift / n).toFixed(4));
console.log('  판정: ' + (d / ds >= 2 ? '발현 확인' : (d / ds >= 1 ? '약한 발현 — 표본 늘려 재확인' : '발현 안 됨 — 실물 측정 무의미')));
