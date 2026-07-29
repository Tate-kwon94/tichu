#!/usr/bin/env node
/* AZ 자가대전 기보 — 배포 3단 구성(PUCT + 선언망 + 학습교환)이 4좌석 전부 플레이하고,
 * 각 결정의 **방문 분포**(PUCT가 실제로 낸 결론)와 라운드 결과를 함께 기록한다.
 *
 * 왜 방문 분포인가(docs/4DAN-AZ-PLAN.md §2): 지금까지 죽은 축은 전부 "배포봇 밖에서 좋아진 것을
 * 안으로 이식"이었다(raw 정책·오라클 라벨·대리 평가 최적화 — 전부 전이 소멸). AZ는 배포봇이 실제로
 * 낸 결론을 그대로 타깃으로 쓰므로 이식 단계가 없다. 개선 경로는 하나: 프라이어 캘리브레이션
 * (현재 pmax 0.726 과확신 → 시뮬 84%가 1순위 집중). 분포 타깃이 이 낭비를 풀면 같은 950ms에서
 * 유효 탐색 폭이 넓어진다. 자기증류(argmax 모방) 천장과 다른 점이 정확히 이 지점이다.
 *
 * 탐색은 shared/hybrid-bot.js decidePuct를 opts.wantStats로 그대로 호출한다 — 복제하지 않는다.
 * 생성기가 배포 탐색과 다른 코드를 돌면 AZ의 전제가 깨진다.
 *
 * 사용: node ml/gen-az.js <weights.json> <seedStart> <seedEnd> [budgetMs=950] [c=1.0] > out.jsonl 2> log
 *       예산 기본값은 **배포와 같은 950ms**다 — pi가 "배포 탐색의 결론"이어야 타깃으로서 의미가 있다.
 *       처리량을 위해 낮추면 그만큼 다른 봇의 결론을 배우는 것이니, 낮출 땐 의식적으로 낮춰라.
 * 환경: TICHU_AZ_DECL(선언망, 기본 shared/weights-declare.json)
 *       TICHU_AZ_EXW(학습교환 선형, 기본 ml/weights-exchange-linear.json)
 *       TICHU_AZ_TEMP(뿌리 탐험 온도, 기본 0 = 방문 최다 그대로. >0이면 방문^(1/T) 샘플링)
 *       TICHU_AZ_TEMP_MOVES(온도 적용 수, 기본 8 — 초반만 다양화, 종반은 최선수)
 * 출력: gen-champion과 같은 레코드 + pi(방문분포, cands와 같은 순서·길이) + sims
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
var seedEnd = +process.argv[4] || 10;
var budget = +process.argv[5] || 950;      // 배포와 동일 (rooms.js:294)
var PUCT_C = process.argv[6] != null ? +process.argv[6] : 1.0;
var REPCAP = +process.env.TICHU_REPCAP || 1e9;   // 기본 무제한 — 예산이 유일한 제약이 되게 한다
                                              // (기본 2000이면 예산을 늘려도 2,000시뮬에서 끊긴다)
var TEMP = +process.env.TICHU_AZ_TEMP || 0;
var TEMP_MOVES = process.env.TICHU_AZ_TEMP_MOVES != null ? +process.env.TICHU_AZ_TEMP_MOVES : 8;

var hy = HY.create(wPath);
var decl = DECL.load(process.env.TICHU_AZ_DECL || path.join(__dirname, '..', 'shared', 'weights-declare.json'));
var EXW = JSON.parse(fs.readFileSync(
  process.env.TICHU_AZ_EXW || path.join(__dirname, 'weights-exchange-linear.json'), 'utf8')).w;

/* 3단 배포 교환 — eval-hybrid.js learnedGive와 같은 선형 랭커 */
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

function playedCards(g) {
  var inHand = {};
  for (var s = 0; s < 4; s++) g.hands[s].forEach(function (id) { inHand[id] = 1; });
  return C.makeDeck().filter(function (id) { return !inHand[id]; });
}

/* 보관용 레코드 — 전 필드 slice. 참조로 담으면 게임 진행에 오염된다(gen-champion 관행) */
function record(g, seat, cands, pickIdx, playIdx, pi, pr, sims, hist) {
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
    pick: pickIdx,      // 최다 방문(배포와 동일한 선택) — 기존 train_pilot도 이 파일을 소비 가능
    play: playIdx,      // 실제로 둔 수(온도 샘플링 시에만 pick과 다름). off-policy 보정용
    pi: pi,             // ★ 방문 분포(합 1) — AZ 소프트 타깃
    pr: pr,             // 생성 시점 프라이어 — KL(pi‖pr)로 "탐색이 프라이어를 얼마나 고쳤나"를 사후 측정
    sims: sims          // 결정당 시뮬 수 — 굶주림 판정용(이게 없으면 데이터 품질을 사후에 못 잼)
  };
}

/* 뿌리 온도 샘플링 — 자가대전 다양성. 기록되는 pi는 온도와 무관한 원 방문분포다
 * (타깃은 탐색의 결론이어야 하고, 온도는 데이터 수집 정책일 뿐). */
function sampleByTemp(visits, temp) {
  var w = [], sum = 0, i;
  for (i = 0; i < visits.length; i++) { var v = Math.pow(Math.max(0, visits[i]), 1 / temp); w.push(v); sum += v; }
  if (!(sum > 0)) return -1;
  var r = Math.random() * sum, acc = 0;
  for (i = 0; i < w.length; i++) { acc += w[i]; if (r <= acc) return i; }
  return w.length - 1;
}

function finishAction(g, seat, cand) {
  if (cand.t === 'pass') return { type: 'pass_turn', seat: seat };
  var a = { type: 'play_cards', seat: seat, cards: cand.c };
  if (cand.c.indexOf('MJ') >= 0) {
    var wsh = B.botWish(g.hands[seat].filter(function (id) { return cand.c.indexOf(id) < 0; }), null);
    if (wsh) a.wish = wsh;
  }
  return a;
}

/* 3단 배포 결정 — eval-hybrid hyDecide의 3단 확정 구성(exchange,learnExch 프로파일)과 동일.
 * play 국면만 wantStats로 통계를 받고, 나머지는 배포와 같은 경로. */
function decide(g, seat, hist, nMove) {
  if (g.phase === 'grand' && !g.grandAnswered[seat]) {
    return { act: { type: 'call_grand', seat: seat, call: decl.grand(g.hands[seat], null) } };
  }
  if (g.phase === 'play' && g.turnSeat === seat && !g.playedFirst[seat] &&
      !g.tichu[seat] && g.finished.indexOf(seat) < 0 && decl.tichu(g.hands[seat], null)) {
    return { act: { type: 'call_tichu', seat: seat } };
  }
  if (g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    /* repCap을 반드시 넘긴다 — 기본값 2000이라 예산을 아무리 늘려도 2,000시뮬에서 끊긴다.
     * (실제로 3800ms 생성이 950ms와 똑같은 2,000시뮬로 나온 적이 있다.) */
    var st = hy.decidePuct(g, seat, hist,
      { budgetMs: budget, c: PUCT_C, repCap: REPCAP, wantStats: true });
    var K = st.cands.length;
    if (K < 2) return { act: st.action };                 // 강제수 — 학습 신호 없음
    var total = 0, i;
    for (i = 0; i < K; i++) total += st.visits[i] > 0 ? st.visits[i] : 0;
    if (!total) return { act: st.action };                // 시뮬 0회(예산 소진) — 기록하면 잡음
    var pi = [];
    for (i = 0; i < K; i++) pi.push((st.visits[i] > 0 ? st.visits[i] : 0) / total);
    // pick은 항상 최다 방문(= 배포가 실제로 두는 수). 온도 샘플링은 행동만 바꾼다 —
    // pick을 탐험 표본으로 덮으면 하드라벨 소비자(train_pilot)가 "탐색의 결론"이 아닌
    // 탐험 잡음을 정답으로 배운다. 실제로 둔 수는 별도 필드(play)로 남긴다.
    var act = st.action, played = st.pick;
    if (TEMP > 0 && nMove < TEMP_MOVES) {
      var s2 = sampleByTemp(st.visits, TEMP);
      if (s2 >= 0 && st.visits[s2] > 0) { played = s2; act = finishAction(g, seat, st.cands[s2]); }
    }
    return { act: act, cands: st.cands, pi: pi, pr: st.priors, pick: st.pick,
      play: played === st.pick ? undefined : played, sims: total };
  }
  if (g.phase === 'exchange' && !g.exchangeGive[seat]) {
    var lg = learnedGive(g, seat);
    if (lg) return { act: { type: 'submit_exchange', seat: seat, give: lg } };
    return { act: { type: 'submit_exchange', seat: seat, give: B.botExchange(g, seat, { keepSpecials: true }) } };
  }
  return { act: B.botDecide(g, seat, 'normal') };         // 소원·용 — 배포와 동일한 휴리스틱
}

/* 버퍼 방출 — 라운드 결과가 확정된 뒤에만 부른다(out이 라벨이다) */
function flush(g, buf) {
  var d = g.roundSummary.deltas, n = buf.length;
  buf.forEach(function (r) {
    r.out = (r.seat % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
    process.stdout.write(JSON.stringify(r) + '\n');
  });
  buf.length = 0;
  return n;
}

function playGame(seed) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var buf = [], hist = [], nDec = 0, guard = 0, nMove = 0, simSum = 0, simN = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') {
      nDec += flush(g, buf);
      hist = []; nMove = 0;
      g.apply({ type: 'next_round' });
      continue;
    }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var r0 = decide(g, s, hist, nMove);
    var a = r0.act;
    if (!a) throw new Error('no action seed=' + seed);
    if (r0.pi) {
      buf.push(record(g, s, r0.cands, r0.pick, r0.play, r0.pi, r0.pr, r0.sims, hist));
      simSum += r0.sims; simN++; nMove++;
    }
    var rr = g.apply(a);
    if (!rr.ok) throw new Error('rejected seed=' + seed + ' ' + a.type + ' ' + rr.error.code);
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;                              // 불사조 랭크 확정은 apply 후에만 정확
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
    if (++guard > 30000) throw new Error('guard seed=' + seed);
  }
  // 마지막 라운드 — 게임을 끝낸 라운드는 phase가 'roundEnd'가 아니라 'gameEnd'라
  // 위 루프가 flush 없이 탈출한다. 그냥 15%가 아니라 "항상 승부가 갈린 라운드"가 통째로
  // 빠지므로, 높은 점수대(선언 위험조절이 달라지는 구간)가 학습 데이터에 아예 없게 된다.
  // (기존 gen-champion.js·gen-teacher.js도 같은 구조 — 과거 자기증류 데이터의 알려진 결함)
  if (buf.length && g.roundSummary) nDec += flush(g, buf);
  return { dec: nDec, sims: simN ? Math.round(simSum / simN) : 0 };
}

var t0 = Date.now(), total = 0, games = 0, simAcc = 0;
for (var seed = seedStart; seed <= seedEnd; seed++) {
  try {
    var r = playGame(seed);
    total += r.dec; games++; simAcc += r.sims;
    console.error('seed', seed, 'dec=' + total, 'sims/dec=' + r.sims,
      'elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
  } catch (e) {
    console.error('seed', seed, 'FAIL', e.message);
  }
}
console.error('DONE games=' + games + ' decisions=' + total +
  ' avgSims=' + (games ? Math.round(simAcc / games) : 0) +
  ' elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
