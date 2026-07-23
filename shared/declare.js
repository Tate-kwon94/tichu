/* 선언 신경망 (UMD) — 손패 → 1등 완주 확률. 스몰(14장)·라지(8장) 티츄 판단.
 * 데이터 기반: 66만 라운드에서 학습, EV 최적 임계로 보정 (train_declare.py)
 * Node: DECL.load(jsonPath) / 공통: DECL.create(weightsObj)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TichuDeclare = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var SUITS = 'SHDC';
var RANK = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
var SPECIAL = { MJ: 52, DG: 53, PH: 54, DR: 55 };

function cardIdx(id) {
  if (SPECIAL[id] != null) return SPECIAL[id];
  return SUITS.indexOf(id[0]) * 13 + (RANK[id.slice(1)] - 2);
}
function b64ToF32(b64) {
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    var buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function linear(W, b, x, out) {
  var oN = b.length, iN = x.length;
  for (var oI = 0; oI < oN; oI++) {
    var s = b[oI], row = oI * iN;
    for (var iI = 0; iI < iN; iI++) s += W[row + iI] * x[iI];
    out[oI] = s;
  }
  return out;
}
function relu(x) { for (var i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0; return x; }

function buildMlp(T) { // f.0/f.2/f.4 3층 MLP → 시그모이드 확률
  var h1 = new Float32Array(T['f.0.bias'].length);
  var h2 = new Float32Array(T['f.2.bias'].length);
  var o = new Float32Array(1);
  return function (hand) {
    var v = new Float32Array(56);
    for (var i = 0; i < hand.length; i++) v[cardIdx(hand[i])] = 1;
    linear(T['f.0.weight'], T['f.0.bias'], v, h1); relu(h1);
    linear(T['f.2.weight'], T['f.2.bias'], h1, h2); relu(h2);
    linear(T['f.4.weight'], T['f.4.bias'], h2, o);
    return 1 / (1 + Math.exp(-o[0]));
  };
}

// raw: { t: {텐서}, g: {텐서}, calib: {tichuThreshold, grandThreshold} }
function create(raw) {
  function tensors(group) {
    var T = {};
    Object.keys(group).forEach(function (k) { T[k] = group[k] instanceof Float32Array ? group[k] : b64ToF32(group[k].b64); });
    return T;
  }
  var pT = buildMlp(tensors(raw.t));
  var pG = buildMlp(tensors(raw.g));
  var cal = raw.calib || {};
  var thT = cal.tichuThreshold != null ? cal.tichuThreshold : 0.5;
  var thG = cal.grandThreshold != null ? cal.grandThreshold : 0.52;
  return {
    pFirst14: pT,
    pFirst8: pG,
    tichu: function (hand14) { return pT(hand14) >= thT; },   // 스몰 티츄 선언 판단
    grand: function (hand8) { return pG(hand8) >= thG; }      // 라지 티츄 선언 판단
  };
}

function load(jsonPath) { // Node 전용
  var fs = require('fs');
  return create(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
}

return { load: load, create: create };
}));
