/* 신경망 추론기 (UMD) — Node(서버·학습도구)와 브라우저(혼자 연습 초고수) 겸용.
 * train_pilot.py의 인코딩·모델과 1:1 대응 (교차검증 500/500 유지 필수).
 * Node: NET.load(jsonPath) / 공통: NET.create(weightsObj)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tichu-core.js'));
  else root.TichuNet = factory(root.TichuCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
'use strict';

var SUITS = 'SHDC';
var TYPES = ['none', 'single', 'pair', 'triple', 'fullhouse', 'straight',
  'pairseq', 'bomb4', 'bombstraight', 'dog', 'pass'];
var T_IDX = {};
TYPES.forEach(function (t, i) { T_IDX[t] = i; });
var RANK = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
var SPECIAL = { MJ: 52, DG: 53, PH: 54, DR: 55 };
var HIST_N = 12, HIST_F = 4 + TYPES.length + 2; // 17
var S_BASE = 56 * 5 + 4 + 4 + 8 + 5 + 12 + 5 + 1 + 14 + 3; // 336
var S_DIM = S_BASE + HIST_N * HIST_F; // 540
var A_DIM = 56 + TYPES.length + 8;

function cardIdx(id) {
  if (SPECIAL[id] != null) return SPECIAL[id];
  return SUITS.indexOf(id[0]) * 13 + (RANK[id.slice(1)] - 2);
}
function rel(seat, other) { return ((other - seat) % 4 + 4) % 4; }

function encState(r) {
  var v = new Float32Array(S_DIM);
  var seat = r.seat, i;
  for (i = 0; i < r.h.length; i++) v[cardIdx(r.h[i])] = 1;
  var played = {};
  for (i = 0; i < r.played.length; i++) { played[r.played[i]] = 1; v[56 + cardIdx(r.played[i])] = 1; }
  if (r.gave) {
    for (var q in r.gave) {
      var c = r.gave[q];
      if (played[c]) continue;
      v[56 * (1 + rel(seat, +q)) + cardIdx(c)] = 1;
    }
  }
  var o = 56 * 5;
  for (i = 0; i < 4; i++) v[o + rel(seat, i)] = r.cnt[i] / 14;
  o += 4;
  for (i = 0; i < r.fin.length; i++) v[o + rel(seat, r.fin[i])] = 1;
  o += 4;
  for (i = 0; i < 4; i++) {
    if (r.tichu[i] === 100) v[o + rel(seat, i)] = 1;
    if (r.tichu[i] === 200) v[o + 4 + rel(seat, i)] = 1;
  }
  o += 8;
  v[o + (r.fo != null ? rel(seat, r.fo) + 1 : 0)] = 1;
  o += 5;
  v[o + (r.cur ? T_IDX[r.cur.t] : 0)] = 1;
  if (r.cur) { v[o + 10] = Math.min(r.cur.r, 16) / 16; v[o + 11] = r.cur.l / 14; }
  o += 12;
  v[o + (r.win != null && r.win >= 0 ? rel(seat, r.win) + 1 : 0)] = 1;
  o += 5;
  v[o] = (r.tp || 0) / 100;
  o += 1;
  v[o + (r.wish ? r.wish - 1 : 0)] = 1;
  o += 14;
  var my = seat % 2 === 0 ? r.sc[0] : r.sc[1];
  var op = seat % 2 === 0 ? r.sc[1] : r.sc[0];
  var tgt = Math.max(r.tgt || 500, 1);
  v[o] = my / tgt; v[o + 1] = op / tgt; v[o + 2] = (my - op) / tgt;
  var hist = (r.hist || []).slice(-HIST_N);
  var base = S_BASE + (HIST_N - hist.length) * HIST_F;
  for (i = 0; i < hist.length; i++) {
    var hh = hist[i], p = base + i * HIST_F;
    v[p + rel(seat, hh.s)] = 1;
    v[p + 4 + T_IDX[hh.t]] = 1;
    v[p + 4 + 11] = Math.min(hh.r, 16) / 16;
    v[p + 4 + 12] = hh.l / 14;
  }
  return v;
}
function encAction(r, cand) {
  var v = new Float32Array(A_DIM);
  var n = r.h.length, i;
  if (cand.t === 'pass') { v[56 + T_IDX.pass] = 1; return v; }
  for (i = 0; i < cand.c.length; i++) v[cardIdx(cand.c[i])] = 1;
  v[56 + T_IDX[cand.t]] = 1;
  var o = 56 + TYPES.length;
  v[o] = Math.min(cand.r, 16) / 16;
  v[o + 1] = cand.l / 14;
  v[o + 2] = (n - cand.l) / 14;
  v[o + 3] = cand.l === n ? 1 : 0;
  var cs = {};
  for (i = 0; i < cand.c.length; i++) cs[cand.c[i]] = 1;
  v[o + 4] = cs.DR ? 1 : 0; v[o + 5] = cs.PH ? 1 : 0; v[o + 6] = cs.MJ ? 1 : 0; v[o + 7] = cs.DG ? 1 : 0;
  return v;
}

function b64ToF32(b64) {
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    var buf = Buffer.from(b64, 'base64');
    // Buffer는 내부 풀 공유 — byteOffset 기준으로 정확히 잘라야 함
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function linear(W, b, x, out) { // W:[out,in] row-major
  var oN = b.length, iN = x.length;
  for (var oI = 0; oI < oN; oI++) {
    var s = b[oI], row = oI * iN;
    for (var iI = 0; iI < iN; iI++) s += W[row + iI] * x[iI];
    out[oI] = s;
  }
  return out;
}
function relu(x) { for (var i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0; return x; }

// raw: export_weights.py 출력({텐서명: {shape, b64}}) 파싱본
function create(raw) {
  var W = {};
  Object.keys(raw).forEach(function (k) { W[k] = raw[k] instanceof Float32Array ? raw[k] : b64ToF32(raw[k].b64); });
  var b1 = new Float32Array(512), b2 = new Float32Array(256), ba = new Float32Array(128),
      h1 = new Float32Array(256), ho = new Float32Array(1),
      v1 = new Float32Array(64), vo = new Float32Array(1);
  function stateEmb(sv) {
    linear(W['se.0.weight'], W['se.0.bias'], sv, b1); relu(b1);
    linear(W['se.2.weight'], W['se.2.bias'], b1, b2); relu(b2);
    return b2;
  }
  function score(z, av) {
    linear(W['ae.0.weight'], W['ae.0.bias'], av, ba); relu(ba);
    var cat = new Float32Array(256 + 128);
    cat.set(z, 0); cat.set(ba, 256);
    linear(W['head.0.weight'], W['head.0.bias'], cat, h1); relu(h1);
    linear(W['head.2.weight'], W['head.2.bias'], h1, ho);
    return ho[0];
  }
  return {
    encState: encState,
    encAction: encAction,
    valueRecord: function (r) {
      var z = stateEmb(encState(r));
      linear(W['vhead.0.weight'], W['vhead.0.bias'], z, v1); relu(v1);
      linear(W['vhead.2.weight'], W['vhead.2.bias'], v1, vo);
      return vo[0];
    },
    pickRecord: function (r) {
      var z = stateEmb(encState(r)).slice(0);
      var best = 0, bv = -Infinity;
      for (var i = 0; i < r.cands.length; i++) {
        var s = score(z, encAction(r, r.cands[i]));
        if (s > bv) { bv = s; best = i; }
      }
      return best;
    },
    probsRecord: function (r) {
      var z = stateEmb(encState(r)).slice(0);
      var logits = [], mx = -Infinity, i;
      for (i = 0; i < r.cands.length; i++) {
        var s = score(z, encAction(r, r.cands[i]));
        logits.push(s); if (s > mx) mx = s;
      }
      var sum = 0, p = [];
      for (i = 0; i < logits.length; i++) { p.push(Math.exp(logits[i] - mx)); sum += p[i]; }
      for (i = 0; i < p.length; i++) p[i] /= sum;
      return p;
    },
    makeRecord: function (g, seat, cands, hist) {
      var inHand = {};
      for (var s = 0; s < 4; s++) g.hands[s].forEach(function (id) { inHand[id] = 1; });
      return {
        hist: (hist || []).slice(-HIST_N),
        seat: seat, h: g.hands[seat],
        played: C.makeDeck().filter(function (id) { return !inHand[id]; }),
        cnt: [g.hands[0].length, g.hands[1].length, g.hands[2].length, g.hands[3].length],
        fin: g.finished, fo: g.firstOutSeat, tichu: g.tichu,
        cur: g.currentCombo ? { t: g.currentCombo.type, r: g.currentCombo.rank, l: g.currentCombo.length } : null,
        win: g.lastPlayerSeat, tp: C.sumPoints(g.trickPile), wish: g.wish,
        gave: g.exchangeGive && g.exchangeGive[seat] ? g.exchangeGive[seat] : null,
        sc: g.scores, tgt: g.targetScore, cands: cands
      };
    }
  };
}

function load(jsonPath) { // Node 전용
  var fs = require('fs');
  return create(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
}

return { load: load, create: create, S_DIM: S_DIM, A_DIM: A_DIM };
}));
