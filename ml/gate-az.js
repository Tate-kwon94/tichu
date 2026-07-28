#!/usr/bin/env node
/* AZ 사전등록 게이트 — "배포 탐색이 자기 프라이어를 실제로 고치고 있는가"를 학습 0으로 잰다.
 *
 * 왜 이 게이트가 먼저인가: AZ의 유일한 개선 경로는 프라이어 재캘리브레이션이다(§2).
 * 탐색의 방문분포가 프라이어와 사실상 같으면 배울 게 없고(신호 0), 탐색이 프라이어의 1순위를
 * 뒤집는 일이 드물면 배워도 배포 행동이 안 바뀐다. 둘 다 학습 없이 잴 수 있다 —
 * 하룻밤 생성·학습을 태우기 전에 몇 분으로 접을 수 있는 지점이다.
 * (전례: 3단 gate-headroom.js가 같은 방식으로 RL 착수를 정당화했다.)
 *
 * 사전등록 기준 (데이터 보기 전 고정):
 *   A. 신호량   mean KL(π_visits ‖ π_prior) ≥ 0.05 nats        — 미만이면 배울 게 없음 → 접기
 *   B. 개선률   P(argmax π_visits ≠ argmax π_prior) ≥ 5%       — 미만이면 배워도 행동 불변 → 접기
 *   C. 무의미   pmax(visits) 와 pmax(prior)가 둘 다 >0.95면 국면이 자명(둘 다 만족해도 가치 낮음)
 * A·B 둘 다 통과해야 GO. 하나라도 미달이면 접고 3안(사람 기보)으로 전환.
 *
 * 사용: node ml/gate-az.js <weights.json> <seedStart> <seedEnd> [budgetMs=950] [c=1.0]
 * 출력: GATE ... (파싱 가능 한 줄) + 진단 분해
 */
'use strict';
var path = require('path');
var fs = require('fs');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));
var DECL = require(path.join(__dirname, '..', 'shared', 'declare.js'));
var EXF = require(path.join(__dirname, 'exchange-feats.js'));

var wPath = process.argv[2] || path.join(__dirname, '..', 'shared', 'weights-super3.json');
var seedStart = +process.argv[3] || 1;
var seedEnd = +process.argv[4] || 4;
var budget = +process.argv[5] || 950;
var PUCT_C = process.argv[6] != null ? +process.argv[6] : 1.0;

var hy = HY.create(wPath);
var decl = DECL.load(path.join(__dirname, '..', 'shared', 'weights-declare.json'));
var EXW = JSON.parse(fs.readFileSync(path.join(__dirname, 'weights-exchange-linear.json'), 'utf8')).w;

function learnedGive(g, seat) {
  var cands = EXF.candidates(g.hands[seat]);
  if (cands.length < 2) return null;
  var best = 0, bestV = -1e9;
  for (var i = 0; i < cands.length; i++) {
    var x = EXF.features(g.hands[seat], cands[i]), v = 0;
    for (var j = 0; j < x.length; j++) v += x[j] * EXW[j];
    if (v > bestV) { bestV = v; best = i; }
  }
  var give = {};
  give[(seat + 1) % 4] = cands[best].o[0];
  give[(seat + 3) % 4] = cands[best].o[1];
  give[C.partnerOf(seat)] = cands[best].p;
  return give;
}
function argmax(a) { var b = 0; for (var i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; }

var acc = { n: 0, kl: 0, klSq: 0, flip: 0, pmaxV: 0, pmaxP: 0, sims: 0, k: 0,
  byK: {}, flipTop2: 0, trivial: 0, klByBucket: {} };

function tally(pi, pr, sims) {
  var kl = 0;
  for (var i = 0; i < pi.length; i++) {
    if (pi[i] > 0) kl += pi[i] * Math.log(pi[i] / Math.max(pr[i], 1e-12));
  }
  var av = argmax(pi), ap = argmax(pr);
  var pmv = pi[av], pmp = pr[ap];
  acc.n++; acc.kl += kl; acc.klSq += kl * kl;
  if (av !== ap) acc.flip++;
  acc.pmaxV += pmv; acc.pmaxP += pmp; acc.sims += sims; acc.k += pi.length;
  if (pmv > 0.95 && pmp > 0.95) acc.trivial++;
  var kb = pi.length <= 3 ? '2-3' : pi.length <= 8 ? '4-8' : pi.length <= 20 ? '9-20' : '21+';
  if (!acc.byK[kb]) acc.byK[kb] = { n: 0, kl: 0, flip: 0 };
  acc.byK[kb].n++; acc.byK[kb].kl += kl; if (av !== ap) acc.byK[kb].flip++;
  // 프라이어 확신도별 분해 — 과확신 구간에서 탐색이 더 많이 뒤집는지
  var pb = pmp < 0.5 ? '<.5' : pmp < 0.7 ? '.5-.7' : pmp < 0.9 ? '.7-.9' : '.9+';
  if (!acc.klByBucket[pb]) acc.klByBucket[pb] = { n: 0, kl: 0, flip: 0 };
  acc.klByBucket[pb].n++; acc.klByBucket[pb].kl += kl; if (av !== ap) acc.klByBucket[pb].flip++;
}

function playGame(seed) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') { hist = []; g.apply({ type: 'next_round' }); continue; }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0], a;
    if (g.phase === 'grand' && !g.grandAnswered[s]) {
      a = { type: 'call_grand', seat: s, call: decl.grand(g.hands[s], null) };
    } else if (g.phase === 'play' && g.turnSeat === s && !g.playedFirst[s] && !g.tichu[s] &&
               g.finished.indexOf(s) < 0 && decl.tichu(g.hands[s], null)) {
      a = { type: 'call_tichu', seat: s };
    } else if (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0) {
      var st = hy.decidePuct(g, s, hist, { budgetMs: budget, c: PUCT_C, wantStats: true });
      a = st.action;
      if (st.cands.length >= 2 && st.totalN > 0) {
        var tot = 0, i;
        for (i = 0; i < st.visits.length; i++) tot += st.visits[i] > 0 ? st.visits[i] : 0;
        if (tot > 0) {
          var pi = [];
          for (i = 0; i < st.visits.length; i++) pi.push((st.visits[i] > 0 ? st.visits[i] : 0) / tot);
          tally(pi, st.priors, tot);
        }
      }
    } else if (g.phase === 'exchange' && !g.exchangeGive[s]) {
      var lg = learnedGive(g, s);
      a = { type: 'submit_exchange', seat: s, give: lg || B.botExchange(g, s, { keepSpecials: true }) };
    } else {
      a = B.botDecide(g, s, 'normal');
    }
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
}

var t0 = Date.now();
for (var seed = seedStart; seed <= seedEnd; seed++) {
  try { playGame(seed); console.error('seed', seed, 'n=' + acc.n, Math.round((Date.now() - t0) / 1000) + 's'); }
  catch (e) { console.error('seed', seed, 'FAIL', e.message); }
}
var n = acc.n || 1;
var meanKL = acc.kl / n;
var seKL = Math.sqrt(Math.max(0, acc.klSq / n - meanKL * meanKL) / n);
var flip = acc.flip / n;
console.log('GATE n=' + acc.n + ' meanKL=' + meanKL.toFixed(4) + ' seKL=' + seKL.toFixed(4) +
  ' flip=' + (flip * 100).toFixed(1) + '% pmaxVisit=' + (acc.pmaxV / n).toFixed(3) +
  ' pmaxPrior=' + (acc.pmaxP / n).toFixed(3) + ' simsPerDec=' + Math.round(acc.sims / n) +
  ' avgK=' + (acc.k / n).toFixed(1) + ' trivial=' + (acc.trivial / n * 100).toFixed(1) + '%');
console.log('VERDICT A(KL>=0.05)=' + (meanKL >= 0.05 ? 'PASS' : 'FAIL') +
  ' B(flip>=5%)=' + (flip >= 0.05 ? 'PASS' : 'FAIL') +
  ' => ' + (meanKL >= 0.05 && flip >= 0.05 ? 'GO' : 'KILL'));
Object.keys(acc.byK).sort().forEach(function (k) {
  var b = acc.byK[k];
  console.log('  후보수 ' + k + ': n=' + b.n + ' KL=' + (b.kl / b.n).toFixed(4) + ' flip=' + (b.flip / b.n * 100).toFixed(1) + '%');
});
Object.keys(acc.klByBucket).sort().forEach(function (k) {
  var b = acc.klByBucket[k];
  console.log('  프라이어확신 ' + k + ': n=' + b.n + ' KL=' + (b.kl / b.n).toFixed(4) + ' flip=' + (b.flip / b.n * 100).toFixed(1) + '%');
});
