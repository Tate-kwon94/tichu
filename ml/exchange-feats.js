/* 심(shim) — 실체는 shared/exchange-feats.js (서버·클라이언트 공용 UMD). CLI 겸용. */
'use strict';
var path = require('path');
var EXF = require(path.join(__dirname, '..', 'shared', 'exchange-feats.js'));
module.exports = EXF;

// CLI: 라벨 jsonl → 특징 jsonl
if (require.main === module) {
  var lines = require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean);
  lines.forEach(function (line) {
    var d = JSON.parse(line);
    var cands = EXF.candidates(d.h);
    if (cands.length !== d.ev.length) return;
    var X = cands.map(function (c) { return EXF.features(d.h, c); });
    process.stdout.write(JSON.stringify({ X: X, k: d.k, ev: d.ev }) + '\n');
  });
}
