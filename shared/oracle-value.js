/* 오라클 가치망 — "완전정보 국면 → 그 라운드의 최종 점수차" 회귀.
 *
 * 왜 오라클(4명 패 전부)이 반칙이 아닌가:
 *   PUCT는 매 시뮬마다 B.determinize()로 상대 패를 무작위 배분한 "가상 세계"를 만든다.
 *   그 세계 안에서는 4명 패가 모두 확정이고, 지금은 그 세계를 '보통봇 플레이아웃'으로 평가한다.
 *   즉 완전정보 평가는 이미 하고 있다 — 다만 느리고(629µs) 표본 1개라 분산이 크고,
 *   "남은 라운드를 전원 보통봇이 둔다"는 편향까지 있다.
 *   가치망은 같은 입력(그 세계의 완전정보)에 대해 기댓값을 한 번에 준다.
 *   여러 세계에 대해 평균 내는 구조는 그대로이므로 봇이 아는 정보는 늘지 않는다.
 *
 * 인코더는 이 파일이 유일한 소스다. 학습(파이썬)은 여기서 뽑은 바이너리만 읽으므로
 * JS/파이썬 인코더가 어긋나는 사고가 구조적으로 불가능하다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tichu-core.js'));
  else root.TichuOracle = factory(root.TichuCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
'use strict';

var SUITS = 'SHDC';
var TYPES = ['none', 'single', 'pair', 'triple', 'fullhouse', 'straight',
             'pairseq', 'bomb4', 'bombstraight', 'dog', 'pass'];
var T_IDX = {};
TYPES.forEach(function (t, i) { T_IDX[t] = i; });
var RANKN = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
              '10': 10, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
var SPECIAL = { MJ: 52, DG: 53, PH: 54, DR: 55 };

function cardIdx(id) {
  if (SPECIAL[id] != null) return SPECIAL[id];
  return SUITS.indexOf(id.charAt(0)) * 13 + (RANKN[id.slice(1)] - 2);
}
function rel(seat, other) { return ((other - seat) % 4 + 4) % 4; } // 0=나 1=오른쪽 2=파트너 3=왼쪽

// ── 특징 배치 ────────────────────────────────────────────────
var O_HAND = 0,    // 4×56 — 상대위치 p의 손패 (완전정보의 핵심)
    O_CNT  = 224,  // 4  — 손패 장수/14
    O_FIN  = 228,  // 4  — 완주 여부
    O_TSM  = 232,  // 4  — 스몰 티츄 선언
    O_TGR  = 236,  // 4  — 라지 티츄 선언
    O_FO   = 240,  // 5  — 최초 완주자(없음 + 상대위치4)
    O_CUR  = 245,  // 11 — 현재 콤보 타입
    O_CURR = 256,  // 1  — 현재 콤보 랭크
    O_CURL = 257,  // 1  — 현재 콤보 장수
    O_WIN  = 258,  // 5  — 현재 트릭 선두(없음 + 상대위치4)
    O_TURN = 263,  // 4  — 차례
    O_TP   = 267,  // 1  — 트릭더미 점수
    O_CAP  = 268,  // 2  — 팀별 확보 점수(우리/상대)
    O_WISH = 270,  // 14 — 소원(없음 + 2..14)
    O_SC   = 284,  // 3  — 게임 점수 우리/상대/차이 (목표 대비)
    O_PH   = 287,  // 3  — 국면(play/dragon/기타)
    S_ORC  = 290;

function newBuf() {
  return { idx: new Int32Array(128), val: new Float32Array(128), n: 0 };
}

/* 활성 특징만 (index, value)로 담는다.
 * 희소로 담아야 추론 1층을 활성 특징 수(≈40)만큼만 돌 수 있다 — 290 전체를 도는 것보다 훨씬 빠르다.
 * 학습용 조밀 벡터도 이 목록에서 만들므로 두 경로가 어긋날 수 없다. */
function encActive(g, seat, buf) {
  var idx = buf.idx, val = buf.val, n = 0, s, p, i;
  function put(k, v) { idx[n] = k; val[n] = v; n++; }

  for (s = 0; s < 4; s++) {
    p = rel(seat, s);
    var h = g.hands[s];
    for (i = 0; i < h.length; i++) put(O_HAND + p * 56 + cardIdx(h[i]), 1);
    if (h.length) put(O_CNT + p, h.length / 14);
    if (g.finished.indexOf(s) >= 0) put(O_FIN + p, 1);
    if (g.tichu[s] === 100) put(O_TSM + p, 1);
    else if (g.tichu[s] === 200) put(O_TGR + p, 1);
  }
  put(O_FO + (g.firstOutSeat != null && g.firstOutSeat >= 0 ? rel(seat, g.firstOutSeat) + 1 : 0), 1);

  var cur = g.currentCombo;
  put(O_CUR + (cur ? T_IDX[cur.type] : 0), 1);
  if (cur) {
    put(O_CURR, Math.min(cur.rank, 16) / 16);
    put(O_CURL, cur.length / 14);
  }
  put(O_WIN + (g.lastPlayerSeat != null && g.lastPlayerSeat >= 0 ? rel(seat, g.lastPlayerSeat) + 1 : 0), 1);
  if (g.turnSeat != null && g.turnSeat >= 0) put(O_TURN + rel(seat, g.turnSeat), 1);

  var tp = C.sumPoints(g.trickPile);
  if (tp) put(O_TP, tp / 100);
  var cap = [0, 0];
  for (s = 0; s < 4; s++) cap[s % 2] += C.sumPoints(g.tricksWon[s]);
  var me = seat % 2;
  if (cap[me]) put(O_CAP, cap[me] / 100);
  if (cap[1 - me]) put(O_CAP + 1, cap[1 - me] / 100);

  put(O_WISH + (g.wish ? g.wish - 1 : 0), 1);

  var tgt = Math.max(g.targetScore || 500, 1);
  var my = g.scores[me], op = g.scores[1 - me];
  if (my) put(O_SC, my / tgt);
  if (op) put(O_SC + 1, op / tgt);
  if (my !== op) put(O_SC + 2, (my - op) / tgt);

  put(O_PH + (g.phase === 'play' ? 0 : g.phase === 'dragon' ? 1 : 2), 1);

  buf.n = n;
  return n;
}

// 학습 데이터 내보내기용 조밀 벡터 (희소 목록에서 그대로 전개)
function encDense(g, seat, out, buf) {
  var n = encActive(g, seat, buf);
  out.fill(0);
  for (var k = 0; k < n; k++) out[buf.idx[k]] += buf.val[k];
  return out;
}

function b64ToF32(b64) {
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    var b = Buffer.from(b64, 'base64');
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  var bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function create(raw) {
  var W = {};
  Object.keys(raw).forEach(function (k) { W[k] = raw[k] instanceof Float32Array ? raw[k] : b64ToF32(raw[k].b64); });
  var b0 = W['o.0.bias'], b2 = W['o.2.bias'], b4 = W['o.4.bias'];
  var H1 = b0.length, H2 = b2.length;

  // 1층 가중치를 [입력, 은닉]으로 전치 — 활성 특징 하나당 은닉 벡터가 연속 메모리에 놓여 캐시 효율↑
  var w0 = W['o.0.weight'], w0t = new Float32Array(S_ORC * H1), oi, ii;
  for (oi = 0; oi < H1; oi++) {
    var row = oi * S_ORC;
    for (ii = 0; ii < S_ORC; ii++) w0t[ii * H1 + oi] = w0[row + ii];
  }
  var w2 = W['o.2.weight'], w4 = W['o.4.weight'];
  var h1 = new Float32Array(H1), h2 = new Float32Array(H2), buf = newBuf();

  function forward(idx, val, n) {
    var k, i, o;
    h1.set(b0);
    for (k = 0; k < n; k++) {
      var base = idx[k] * H1, v = val[k];
      if (v === 1) { for (o = 0; o < H1; o++) h1[o] += w0t[base + o]; }
      else { for (o = 0; o < H1; o++) h1[o] += w0t[base + o] * v; }
    }
    for (o = 0; o < H1; o++) if (h1[o] < 0) h1[o] = 0;
    for (o = 0; o < H2; o++) {
      var s = b2[o], r = o * H1;
      for (i = 0; i < H1; i++) s += w2[r + i] * h1[i];
      h2[o] = s > 0 ? s : 0;
    }
    var out = b4[0];
    for (i = 0; i < H2; i++) out += w4[i] * h2[i];
    return out;
  }

  function value(g, seat) {
    var n = encActive(g, seat, buf);
    return forward(buf.idx, buf.val, n);
  }

  // 조밀 벡터 입력 — 파이썬 학습본과 JS 추론본이 같은 값을 내는지 대조검증용
  var dIdx = new Int32Array(S_ORC), dVal = new Float32Array(S_ORC);
  function valueDense(vec) {
    var n = 0;
    for (var i = 0; i < S_ORC; i++) if (vec[i] !== 0) { dIdx[n] = i; dVal[n] = vec[i]; n++; }
    return forward(dIdx, dVal, n);
  }

  return { value: value, valueDense: valueDense, H1: H1, H2: H2 };
}

function load(jsonPath) { // Node 전용
  return create(JSON.parse(require('fs').readFileSync(jsonPath, 'utf8')));
}

return { load: load, create: create, encActive: encActive, encDense: encDense,
         newBuf: newBuf, S_ORC: S_ORC };
}));
