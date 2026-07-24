#!/usr/bin/env node
/* 오라클 가치망 학습 데이터 생성 — (완전정보 국면, 그 라운드의 최종 점수차).
 *
 * 기록 시점을 "어떤 좌석이 방금 수를 둔 직후, 그 좌석 관점"으로 맞춘 이유:
 *   PUCT 말단이 정확히 그 국면이다(applyCand로 내 수를 둔 직후 → 평가). 학습 분포를 사용 분포에 맞춘다.
 *
 * 출력은 JSON이 아니라 float32 바이너리다: [S_ORC 특징][라벨] × N.
 * 인코딩은 shared/oracle-value.js 한 곳에서만 하므로 JS/파이썬 인코더가 어긋날 수 없고,
 * 파싱 비용도 0이다.
 *
 * 표본 추출률(keep)이 중요하다: 한 라운드의 모든 국면은 라벨이 단 하나(그 라운드 결과)라
 * 서로 강하게 상관돼 있다. 정보량은 "국면 수"가 아니라 "라운드 수"로 정해진다.
 * 그래서 라운드마다 몇 국면만 뽑고 라운드를 많이 도는 편이 같은 디스크로 훨씬 많이 배운다.
 *
 * 사용: node ml/gen-oracle.js <games> <seedBase> <out.bin> [level=normal] [keep=0.1]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));
var OR = require(path.join(__dirname, '..', 'shared', 'oracle-value.js'));

var nGames = +process.argv[2] || 100;
var seedBase = +process.argv[3] || 0;
var outPath = process.argv[4];
var level = process.argv[5] || 'normal';
var keep = process.argv[6] != null ? +process.argv[6] : 0.1;
if (!outPath) { console.error('사용: node ml/gen-oracle.js <games> <seedBase> <out.bin> [level] [keep]'); process.exit(1); }

/* 라벨을 만드는 정책이 곧 "무엇의 가치를 배우는가"를 정한다.
 *   normal                       — 보통봇. 값싸다. 1단이 지금 쓰는 플레이아웃과 같은 양(= 새 편향 없음).
 *   net:<w.json>                 — 신경망 그리디. 중간 강도, 게임당 약 0.5초.
 *   puct:<w.json>:<ms>[:<o.json>] — 진짜 1단급. 오라클을 주면 그것 자체가 8배 빨라진다(정책반복 2회차용).
 * 선언·교환·소원·용은 어느 모드든 휴리스틱 고정(v1 범위 밖). */
var playPolicy = null;
if (level.indexOf('net:') === 0 || level.indexOf('puct:') === 0) {
  var isPuct = level.indexOf('puct:') === 0;
  var pa = level.slice(isPuct ? 5 : 4).split(':');
  var NET = require(path.join(__dirname, '..', 'shared', 'net-infer.js'));
  var netP = NET.load(pa[0]);
  if (isPuct) {
    var HY = require(path.join(__dirname, '..', 'shared', 'hybrid-bot.js'));
    var hyP = HY.create(pa[0]);
    var msP = +pa[1] || 30;
    var orP = pa[2] ? OR.load(pa[2]) : null;
    playPolicy = function (g, seat, hist) {
      return hyP.decidePuct(g, seat, hist, { budgetMs: msP, c: 1.0, oracle: orP });
    };
  } else {
    playPolicy = function (g, seat, hist) {
      var gm = C.genMoves(g.hands[seat], g.currentCombo, g.wish);
      if (!gm.moves.length) return { type: 'pass_turn', seat: seat };
      var cands = gm.moves.map(function (m) { return { c: m.cards, t: m.combo.type, r: m.combo.rank, l: m.combo.length }; });
      if (g.currentCombo && !gm.forced) cands.push({ t: 'pass' });
      var pick = cands[cands.length === 1 ? 0 : netP.pickRecord(netP.makeRecord(g, seat, cands, hist))];
      if (pick.t === 'pass') return { type: 'pass_turn', seat: seat };
      var a = { type: 'play_cards', seat: seat, cards: pick.c };
      if (pick.c.indexOf('MJ') >= 0) {
        var wsh = B.botWish(g.hands[seat].filter(function (id) { return pick.c.indexOf(id) < 0; }));
        if (wsh) a.wish = wsh;
      }
      return a;
    };
  }
}

var S = OR.S_ORC, REC = S + 1;
var CHUNK = 4096;                                  // 레코드 단위 버퍼
var chunk = new Float32Array(CHUNK * REC), chunkN = 0;
// createWriteStream은 파일을 비동기로 연다 — 본체가 동기 루프라 이벤트 루프가 안 돌면
// 파일이 열리지도 않고 write()가 전부 램에 쌓인다. 동기 fd로 쓴다.
var fd = fs.openSync(outPath, 'w');
var chunkBuf = Buffer.from(chunk.buffer);
var written = 0;

function flush() {
  if (!chunkN) return;
  fs.writeSync(fd, chunkBuf, 0, chunkN * REC * 4);
  written += chunkN; chunkN = 0;
}
function emit(vec, label) {
  chunk.set(vec, chunkN * REC);
  chunk[chunkN * REC + S] = label;
  if (++chunkN === CHUNK) flush();
}

var buf = OR.newBuf();
var scratch = new Float32Array(S);

function playGame(seed) {
  var g = new C.Game({ seed: seed, targetScore: 500 });
  var pend = [], hist = [], guard = 0;
  while (!g.gameOver && ++guard < 30000) {
    if (g.phase === 'roundEnd') {
      hist = [];
      var d = g.roundSummary.deltas;
      for (var i = 0; i < pend.length; i++) {
        var raw = (pend[i].seat % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
        // 플레이아웃이 하던 것과 같은 양을 예측하도록 동일하게 자름(hybrid-bot: clamp(v/100, ±2))
        emit(pend[i].vec, Math.max(-2, Math.min(2, raw / 100)));
      }
      pend = [];
      g.apply({ type: 'next_round' });
      continue;
    }
    var w = g.waitingOn(); if (!w.length) break;
    var s = w[0];
    var isPlay = (g.phase === 'play' && g.turnSeat === s && g.finished.indexOf(s) < 0);
    var a = (isPlay && playPolicy) ? playPolicy(g, s, hist) : B.botDecide(g, s, playPolicy ? 'normal' : level);
    if (!a || !g.apply(a).ok) break;
    if (a.type === 'pass_turn') hist.push({ s: s, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: s, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: s, t: 'dog', r: 0, l: 1 });
    }
    if (isPlay && g.phase === 'play' && Math.random() < keep) {
      var vec = new Float32Array(S);
      OR.encDense(g, s, vec, buf);
      pend.push({ vec: vec, seat: s });
    }
  }
  return pend.length === 0;
}

var t0 = Date.now();
for (var gi = 0; gi < nGames; gi++) {
  try { playGame(seedBase + gi); } catch (e) { console.error('game', gi, 'FAIL', e.message); }
  if ((gi + 1) % 200 === 0) {
    console.error('games ' + (gi + 1) + '/' + nGames + ' samples=' + (written + chunkN) +
                  ' ' + Math.round((Date.now() - t0) / 1000) + 's');
  }
}
flush();
fs.closeSync(fd);
console.error('DONE games=' + nGames + ' keep=' + keep + ' samples=' + written + ' dim=' + S +
              ' ' + Math.round((Date.now() - t0) / 1000) + 's -> ' + outPath);
