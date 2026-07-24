#!/usr/bin/env node
/* 배포본(oracle-value.js) 예측을 학습본 덤프와 대조.
 * 사용: node ml/check-oracle.js <oracle.json> <data.bin> <py-pred.json>
 */
'use strict';
var fs = require('fs'), path = require('path');
var OR = require(path.join(__dirname, '..', 'shared', 'oracle-value.js'));

var oracle = OR.load(process.argv[2]);
var buf = fs.readFileSync(process.argv[3]);
var f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
var REC = OR.S_ORC + 1;
var py = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));

var maxDiff = 0, worst = -1, row = new Float32Array(OR.S_ORC);
for (var i = 0; i < py.n; i++) {
  for (var j = 0; j < OR.S_ORC; j++) row[j] = f[i * REC + j];
  var d = Math.abs(oracle.valueDense(row) - py.pred[i]);
  if (d > maxDiff) { maxDiff = d; worst = i; }
}
console.log('대조 ' + py.n + '건 · 최대 절대오차 ' + maxDiff.toExponential(2) + ' (행 ' + worst + ')');
if (maxDiff > 1e-3) { console.log('❌ 불일치 — 전치/인덱싱 확인 필요'); process.exit(1); }
console.log('✅ 학습본과 배포본 일치 (float32 오차 범위)');
