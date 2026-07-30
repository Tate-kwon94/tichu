#!/usr/bin/env node
/* 하이브리드 봇 실전 평가 — hybrid(신경망+탐색) vs 기존 봇
 * 사용: node ml/eval-hybrid.js <weights.json> <상대: normal|hard> <seedStart> <seedEnd> [hybridMs=950] [oppHardMs=950]
 */
'use strict';
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var HY = require(path.join(__dirname, 'hybrid-bot.js'));
var EG = require(path.join(__dirname, 'endgame.js'));
var DEEP = require(path.join(__dirname, 'deep-move.js'));

var wPath = process.argv[2];
var oppLevel = process.argv[3] || 'hard';
var seedStart = +process.argv[4] || 1;
var seedEnd = +process.argv[5] || 10;
var hyMs = +process.argv[6] || 950;
var oppMs = +process.argv[7] || 950;
var mode = process.argv[8] || 'value'; // value=가치롤아웃 | plus=챔피언+ | puct=1단 | sh=Sequential Halving(2단후보)
var hyTemp = +process.argv[9] || 1;    // 본 하이브리드의 프라이어 온도
globalThis.__TICHU_HARD = { samples: 999999, budgetMs: oppMs };
globalThis.__TICHU_STAT = { sims: 0, dec: 0 };
if (process.env.TICHU_PIN) globalThis.__TICHU_PIN = +process.env.TICHU_PIN; // 부분 clairvoyance 진단

/* 굶주림 게이트 — 이 머신이 지금 플레이아웃 1회에 몇 µs를 쓰는가.
 * 유휴면 ~425µs. 다른 프로세스에 코어를 뺏기면 수 배로 뛰고, 그러면 예산 안에 탐색이
 * 거의 일어나지 않아 "개선이 없다"와 "탐색이 없었다"를 구분할 수 없게 된다.
 * 결과 줄에 같이 찍어서 나중에라도 그 판의 유효성을 판정할 수 있게 한다. */
function measurePlayoutCost() {
  var g = new C.Game({ seed: 424242, targetScore: 500 }), guard = 0;
  while (g.phase !== 'play' && ++guard < 200) {
    var w0 = g.waitingOn(); if (!w0.length) break;
    var a0 = B.botDecide(g, w0[0], 'normal'); if (!a0 || !g.apply(a0).ok) break;
  }
  // 워밍업: V8 JIT이 최적화하기 전에는 같은 코드가 10배 이상 느리다.
  // 이걸 빼먹으면 굶주림이 아니라 워밍업을 재게 된다(실제로 그런 오탐이 났었다).
  for (var wu = 0; wu < 40; wu++) {
    var ws = g.clone(), wg = 0;
    while (ws.phase !== 'roundEnd' && ws.phase !== 'gameEnd' && ++wg < 2000) {
      var ww = ws.waitingOn(); if (!ww.length) break;
      var wa = B.botDecide(ws, ww[0], 'normal'); if (!wa || !ws.apply(wa).ok) break;
    }
  }
  var t = Date.now(), n = 0;
  while (Date.now() - t < 200) {
    var sim = g.clone(), gd = 0;
    while (sim.phase !== 'roundEnd' && sim.phase !== 'gameEnd' && ++gd < 2000) {
      var w = sim.waitingOn(); if (!w.length) break;
      var a = B.botDecide(sim, w[0], 'normal'); if (!a || !sim.apply(a).ok) break;
    }
    n++;
  }
  return n ? (Date.now() - t) * 1000 / n : -1;
}
var USPP = measurePlayoutCost();

var hy = HY.create(wPath);
// 선언 신경망(있으면 하이브리드 측 그랜드/티츄 판단에 사용 — 배포 구성과 동일)
var DECL = require(path.join(__dirname, '..', 'shared', 'declare.js'));
var decl = null, declBase = null;
try {
  var dj = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'shared', 'weights-declare.json'), 'utf8'));
  // 임계값 오버라이드 — 재학습 없이 스칼라 두 개만 바꿔 스윕할 수 있다(2단 후보 측에만 적용)
  if (process.env.TICHU_TH_T || process.env.TICHU_TH_G) {
    dj.calib = dj.calib || {};
    if (process.env.TICHU_TH_T) dj.calib.tichuThreshold = +process.env.TICHU_TH_T;
    if (process.env.TICHU_TH_G) dj.calib.grandThreshold = +process.env.TICHU_TH_G;
  }
  decl = DECL.create(dj);
  if (process.env.TICHU_TH_T || process.env.TICHU_TH_G) {
    declBase = DECL.load(path.join(__dirname, '..', 'shared', 'weights-declare.json')); // 상대(고정 1단)용 원본
  }
} catch (e) {}
// 상대가 'hy:<weights>[:temp]'(챔피언+) 또는 'pu:<weights>[:c]'(PUCT)이면 봇끼리 대결(승단전)
var oppHy = null, oppHyTemp = 1, oppHyMode = 'plus', oppHyC = 1.0;
if (oppLevel.indexOf('hy:') === 0) {
  var parts = oppLevel.slice(3).split(':');
  oppHy = HY.create(parts[0]);
  if (parts[1]) oppHyTemp = +parts[1] || 1;
  oppLevel = 'hybrid';
} else if (oppLevel.indexOf('pu:') === 0) {
  var pp = oppLevel.slice(3).split(':');
  oppHy = HY.create(pp[0]); oppHyMode = 'puct';
  if (pp[1]) oppHyC = +pp[1] || 1.0;
  oppLevel = 'hybrid';
}

// 2단 후보 프로파일 — 주(main) 봇에만 켜지는 ①②③ 개선 (상대=동결 1단은 미적용).
// 사용: TICHU_CAND=declAdjust,holdValue,oppRead node eval-hybrid.js ...
var EXF = null, EXW = null, EXM2 = null;   // 학습 교환 지연 로드(선형/MLP)
/* 학습 교환 선택기 — 주봇(3단 후보)과 상대(동결 3단 기준선)가 공유한다 */
function learnedGive(g, seat) {
  if (!EXF) {
    EXF = require(path.join(__dirname, 'exchange-feats.js'));
    EXW = JSON.parse(require('fs').readFileSync(
      process.env.TICHU_EXW || path.join(__dirname, 'weights-exchange-linear.json'), 'utf8')).w;
  }
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
var CAND = (process.env.TICHU_CAND || '').split(',').filter(Boolean);
if (CAND.indexOf('wishCount') >= 0) globalThis.__TICHU_WISH_COUNT = 1; // 카운팅 소원(주봇 탐색 경로 전체)
function hasCand(f) { return CAND.indexOf(f) >= 0; }
/* 시간 배분 — TICHU_TM=1이면 후보 봇만 켠다. 은행은 라운드 경계에서 리셋한다
 * (라운드를 넘겨 이월하면 "예산 총량이 같다"는 공정성 전제가 깨진다). */
var TM_BANK = { ms: 0 };
var TM = process.env.TICHU_TM === '1'
  ? { bank: TM_BANK, checkAt: +process.env.TICHU_TM_AT || 0.35,
      stopShare: +process.env.TICHU_TM_SHARE || 0.90,
      stopMargin: +process.env.TICHU_TM_MARGIN || 0.55,
      maxExtra: process.env.TICHU_TM_EXTRA === undefined ? 1.5 : +process.env.TICHU_TM_EXTRA,
      hardCap: +process.env.TICHU_TM_CAP || 0 }
  : undefined;
/* 상대(기준선)측 프로파일 — 사다리가 올라가면 기준선도 올라간다.
 *   3단 승단전: TICHU_OPP_CAND=exchange (상대 = 동결 2단)
 * 비어 있으면 상대는 1단. */
var OPPC = (process.env.TICHU_OPP_CAND || '').split(',').filter(Boolean);
function hasOppCand(f) { return OPPC.indexOf(f) >= 0; }
// ④ 오라클 말단 평가 — TICHU_ORACLE=<oracle.json> 이 있을 때만, 그것도 주(main) 봇에만.
var ORACLE = null, ORACLE_MIX = +process.env.TICHU_ORACLE_MIX || 0;
if (process.env.TICHU_ORACLE) {
  ORACLE = require(path.join(__dirname, '..', 'shared', 'oracle-value.js')).load(process.env.TICHU_ORACLE);
}
function scoreCtx(g, seat) { return { my: g.scores[seat % 2], opp: g.scores[1 - (seat % 2)], tgt: g.targetScore }; }

function hyDecide(g, seat, hist) {
  var ctx = hasCand('declAdjust') ? scoreCtx(g, seat) : null; // ① 선언 위험조절
  if (decl && g.phase === 'grand' && !g.grandAnswered[seat]) {
    return { type: 'call_grand', seat: seat, call: decl.grand(g.hands[seat], ctx) };
  }
  // lateTichu(3단 후보, 사용자 피드백): 선언을 첫 '차례'가 아니라 첫 '플레이' 직전으로 미룬다.
  // 패스하는 차례에 선언하면 상대에게 저지 준비 시간만 공짜로 준다(선언 간접비용의 원천).
  // 반대급부: 파트너도 늦게 안다(보호·조율 지연) — 순효과는 게이트가 판정.
  if (!hasCand('lateTichu') &&
      g.phase === 'play' && g.turnSeat === seat && !g.playedFirst[seat] &&
      !g.tichu[seat] && g.finished.indexOf(seat) < 0) {
    // ⑥ 롤아웃 선언 — 켜져 있으면 선언망 임계값 대신 "먼저 나갈 확률"을 세어본다
    if (hasCand('rollTichu')) {
      var rt = hy.declareTichu(g, seat, {
        budgetMs: +process.env.TICHU_RT_MS || 200,
        th: process.env.TICHU_RT_TH != null ? +process.env.TICHU_RT_TH : 0.5,
        calA: +process.env.TICHU_RT_A || 0,
        calB: process.env.TICHU_RT_B != null ? +process.env.TICHU_RT_B : 1
      });
      if (rt.declare) return { type: 'call_tichu', seat: seat };
    } else if (decl && decl.tichu(g.hands[seat], ctx)) {
      return { type: 'call_tichu', seat: seat };
    }
  }
  if (g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    // deepThink(4단 후보): 발굴 스윕 고손실 국면(티츄 생존·초중반 리드)에서
    // PUCT 대신 후보 전수 × W세계 CRN 평가 — 결정당 ~1.5s, 전이 함정 없음
    if (hasCand('deepThink') && DEEP.triggers(g, seat)) {
      var dm = DEEP.deepMove(g, seat, { worlds: +process.env.TICHU_DEEP_W || 200 });
      if (dm) return dm;
    }
    // 종반 완전탐색 모듈(3단 후보) — 전원 손패 소량이면 결정화 K세계 정확풀이 다수결로 교체
    if (hasCand('endgame') && EG.maxHand(g) <= (+process.env.TICHU_EG_CAP || 4)) {
      var em = EG.endgameMove(g, seat, { K: +process.env.TICHU_EG_K || 12,
        nodeCap: +process.env.TICHU_EG_NODECAP || 6000 });   // 6000 = 12세계 최악 ~0.5s, 예산 내
      // 종반 솔버도 같은 결정화 맹점(선언=강패 정보 부재) — 가드를 우회하면 안 된다
      if (em && hasCand('guardTichu')) em = B.guardPartnerTichu(g, seat, em);
      if (em) return em;
    }
    // repCap: PUCT 반복 상한. 기본 2000인데 배포 예산 950ms에서 결정의 49.8%가 여기 걸려
    // 평균 452ms(전체 예산의 23.7%)를 쓰지 않고 끝난다 — 캡 도입 당시 주석의 "2000이 안 걸린다"는
    // 평균 플레이아웃 비용 기준이었고, 종반처럼 싼 국면에서는 캡이 먼저 걸린다.
    // TICHU_REPCAP로 풀어 그 낭비가 실력인지 판정한다(2026-07-28 발견).
    var opts = { budgetMs: hyMs, temp: hyTemp, c: (+process.argv[10] || 1.5),
      repCap: +process.env.TICHU_REPCAP || undefined,
      holdValue: hasCand('holdValue'), oppRead: hasCand('oppRead'),   // ②③
      oracle: ORACLE, oracleMix: ORACLE_MIX,                          // ④
      perfect: process.env.TICHU_PERFECT === '1',                    // 3단 헤드룸: 투시(완전정보)
      playout: process.env.TICHU_PLAYOUT || undefined,                // 'neural'=신경망 플레이아웃
      oppK: +process.env.TICHU_OPPK || 0,                            // 상대-연속 편향 제거(첫 K수)
      tm: TM,
      outBonus: +process.env.TICHU_OUTBONUS || 0 };   // 5단 후보: 완주 순서 가중                                                       // 시간 배분(확정 결정 조기중단 → 접전에 몰아주기)
    var act = mode === 'oracle1ply' ? hy.decideOracle1ply(g, seat, hist, opts)  // 3단 게이트: 1-ply 오라클
      : mode === 'sh' ? hy.decideSH(g, seat, hist, opts)   // ⑤ Sequential Halving 뿌리 배분
      : mode === 'puct' ? hy.decidePuct(g, seat, hist, opts)
      : mode === 'plus' ? hy.decidePlus(g, seat, hist, opts)
      : hy.decide(g, seat, hist, opts);
    // 3단 후보: 파트너 티츄 보호 가드 — 사다리(봇 파트너)에도 이득인지 측정용
    if (hasCand('guardTichu')) act = B.guardPartnerTichu(g, seat, act);
    // 3단 후보: 봉황 싱글 가드 — 용 미소진·무대응 상태의 봉황 싱글을 억제(사용자 피드백)
    if (hasCand('phxGuard')) act = B.guardPhoenixSingle(g, seat, act);
    // lateTichu: 지금 실제로 카드를 내려는 순간에만 선언 — 선언 후 같은 좌석이 다시 행동한다
    if (hasCand('lateTichu') && act && act.type === 'play_cards' &&
        !g.playedFirst[seat] && !g.tichu[seat] && decl && decl.tichu(g.hands[seat], ctx)) {
      return { type: 'call_tichu', seat: seat };
    }
    return act;
  }
  // ⑦ 교환: 마작·개를 상대에게 넘기지 않는다 (2단 후보). 상대측(고정 1단)은 기존 그대로.
  // exchTriple/exchSF(3단 후보): 랭크 3장+ / 스티플 잠재(같은 무늬 5랭크 창 4장+) 보존 — 사용자 피드백
  if (hasCand('exchange') && g.phase === 'exchange' && !g.exchangeGive[seat]) {
    // learnExch(3단): 학습 교환 — 특징×가중치 argmax (단계1 게이트 +2.18±0.75 통과)
    // learnExch = 선형(3단 동결 구성) / learnExch2 = MLP(4단 후보 — 3단엔 미적용, 사용자 지시)
    if (hasCand('learnExch2')) {
      if (!EXM2) EXM2 = require(path.join(__dirname, 'exchange-infer.js')).load(
        process.env.TICHU_EXW2 || path.join(__dirname, 'weights-exchange-mlp.json'));
      var lg2 = EXM2.give(g, seat);
      if (lg2) return { type: 'submit_exchange', seat: seat, give: lg2 };
    }
    if (hasCand('learnExch')) {
      var lg = learnedGive(g, seat);
      if (lg) return { type: 'submit_exchange', seat: seat, give: lg };
    }
    return {
      type: 'submit_exchange', seat: seat,
      give: B.botExchange(g, seat, {
        keepSpecials: true,
        keepTriples: hasCand('exchTriple'),
        keepStraightFlush: hasCand('exchSF')
      })
    };
  }
  return B.botDecide(g, seat, 'normal'); // 교환·소원·용 — 휴리스틱 유지
}
function oppHyDecide(g, seat, hist) {
  var od = declBase || decl;                      // 고정 1단은 항상 원본 임계값
  if (od && g.phase === 'grand' && !g.grandAnswered[seat]) {
    return { type: 'call_grand', seat: seat, call: od.grand(g.hands[seat]) };
  }
  if (od && g.phase === 'play' && g.turnSeat === seat && !g.playedFirst[seat] &&
      !g.tichu[seat] && g.finished.indexOf(seat) < 0 && od.tichu(g.hands[seat])) {
    return { type: 'call_tichu', seat: seat };
  }
  if (g.phase === 'play' && g.turnSeat === seat && g.finished.indexOf(seat) < 0) {
    if (oppHyMode === 'puct') return oppHy.decidePuct(g, seat, hist, { budgetMs: oppMs, c: oppHyC });
    return oppHy.decidePlus(g, seat, hist, { budgetMs: oppMs, temp: oppHyTemp });
  }
  // 상대(기준선)도 사다리가 올라가면 개선분을 갖는다.
  // 4단 승단전: TICHU_OPP_CAND=exchange,learnExch (상대 = 동결 3단 = swa 가중치 + 학습 교환)
  if (hasOppCand('exchange') && g.phase === 'exchange' && !g.exchangeGive[seat]) {
    if (hasOppCand('learnExch')) {
      var olg = learnedGive(g, seat);
      if (olg) return { type: 'submit_exchange', seat: seat, give: olg };
    }
    return { type: 'submit_exchange', seat: seat, give: B.botExchange(g, seat, { keepSpecials: true }) };
  }
  return B.botDecide(g, seat, 'normal');
}

var GPTS = 0, GROUNDS = 0;
var TSTAT = { hy: { tichu: { n: 0, ok: 0 }, grand: { n: 0, ok: 0 } },
              op: { tichu: { n: 0, ok: 0 }, grand: { n: 0, ok: 0 } } };
function playGame(seed, hyTeamA) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var hist = [], guard = 0;
  while (!g.gameOver) {
    if (g.phase === 'roundEnd') {
      // 진단: 선언한 티츄가 실제로 성공했는가 (편 별로). 임계값이 맞는지 판정하는 핵심 지표.
      for (var ts = 0; ts < 4; ts++) {
        if (g.tichu[ts] > 0) {
          var side = ((ts % 2 === 0) === hyTeamA) ? 'hy' : 'op';
          var kind = g.tichu[ts] === 200 ? 'grand' : 'tichu';
          TSTAT[side][kind].n++;
          if (g.firstOutSeat === ts) TSTAT[side][kind].ok++;
        }
      }
      var dd = g.roundSummary.deltas;
      GPTS += hyTeamA ? (dd.teamA - dd.teamB) : (dd.teamB - dd.teamA);
      GROUNDS++;
      hist = []; TM_BANK.ms = 0; g.apply({ type: 'next_round' }); continue;  // 은행은 라운드마다 리셋
    }
    var w = g.waitingOn();
    if (!w.length) break;
    var s = w[0];
    var isHy = (s % 2 === 0) === hyTeamA;
    var a = isHy ? hyDecide(g, s, hist)
      : (oppHy ? oppHyDecide(g, s, hist) : B.botDecide(g, s, oppLevel));
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
  return g.winnerTeam === (hyTeamA ? 'A' : 'B');
}

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
var CRN = process.env.TICHU_CRN === '1';   // 공통난수 — 딜·진영별 시드 고정(설정 간 비교용)
var wins = 0, games = 0, t0 = Date.now(), PAIRS = [];
for (var seed = seedStart; seed <= seedEnd; seed++) {
  var pp = [];
  [true, false].forEach(function (side) {
    if (CRN) globalThis.__TICHU_RNG = mulberry(seed * 2 + (side ? 0 : 1) + 777000000);
    try {
      games++;
      var p0 = GPTS, r0 = GROUNDS;
      if (playGame(seed, side)) wins++;
      pp.push(GROUNDS > r0 ? (GPTS - p0) / (GROUNDS - r0) : 0);
    } catch (e) {
      games--;
      console.error('seed', seed, 'FAIL', e.message);
    }
  });
  if (pp.length === 2) PAIRS.push((pp[0] + pp[1]) / 2); // 같은 딜 양측 평균 = 딜 운 상쇄
}
console.log('SIMS perDecision=' + (__TICHU_STAT.dec ? Math.round(__TICHU_STAT.sims / __TICHU_STAT.dec) : 0) +
            ' decisions=' + __TICHU_STAT.dec + ' usPerPlayout=' + Math.round(USPP) +
            (USPP > 900 ? ' [굶주림 의심 — perDecision을 함께 볼 것]' : ''));
console.log('PAIRS ' + JSON.stringify(PAIRS.map(function (x) { return +x.toFixed(2); })));
console.log('PTS rounds=' + GROUNDS + ' total=' + GPTS + ' perRound=' + (GROUNDS ? (GPTS / GROUNDS).toFixed(2) : 0));
function tsLine(side, kind) {
  var t = TSTAT[side][kind];
  return kind + ' ' + t.ok + '/' + t.n + (t.n ? ' (' + (100 * t.ok / t.n).toFixed(0) + '%)' : '');
}
console.log('TICHU hy: ' + tsLine('hy', 'tichu') + '  ' + tsLine('hy', 'grand') +
            '  |  op: ' + tsLine('op', 'tichu') + '  ' + tsLine('op', 'grand'));
console.log('PROFILE main=[' + (CAND.join(',') || '없음') + '] opp=[' + (OPPC.join(',') || '없음') + ']');
console.log('RESULT hybrid(' + hyMs + 'ms) vs ' + oppLevel + (oppLevel === 'hard' ? '(' + oppMs + 'ms)' : '') +
  ': games=' + games + ' hyWins=' + wins + ' rate=' + (100 * wins / games).toFixed(1) +
  '% elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
