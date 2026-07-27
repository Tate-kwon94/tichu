/* 학습 교환 추론 — 선형·MLP 공용 (특징은 exchange-feats.js 단일 소스).
 * 가중치 JSON의 arch 필드로 분기: 없으면 선형(w), 'mlp1'이면 w2·relu(W1x+b1)+b2. */
'use strict';
var path = require('path');
var fs = require('fs');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var EXF = require(path.join(__dirname, 'exchange-feats.js'));

function load(wPath) {
  var w = JSON.parse(fs.readFileSync(wPath, 'utf8'));
  function score(x) {
    if (w.arch === 'mlp1') {
      var s = w.b2;
      for (var h = 0; h < w.W1.length; h++) {
        var a = w.b1[h];
        for (var j = 0; j < x.length; j++) a += w.W1[h][j] * x[j];
        if (a > 0) s += w.w2[h] * a;
      }
      return s;
    }
    var v = 0;
    for (var j2 = 0; j2 < x.length; j2++) v += x[j2] * w.w[j2];
    return v;
  }
  return {
    score: score,
    /* 손패에서 최선 교환 give 맵. 후보 부족 시 null(호출측 폴백). */
    give: function (g, seat) {
      var cands = EXF.candidates(g.hands[seat]);
      if (cands.length < 2) return null;
      var best = 0, bestV = -Infinity;
      for (var i = 0; i < cands.length; i++) {
        var v = score(EXF.features(g.hands[seat], cands[i]));
        if (v > bestV) { bestV = v; best = i; }
      }
      var give = {};
      give[(seat + 1) % 4] = cands[best].o[0];
      give[(seat + 3) % 4] = cands[best].o[1];
      give[C.partnerOf(seat)] = cands[best].p;
      return give;
    },
    pick: function (hand) {                    // 패리티 검증용 — 후보 인덱스만
      var cands = EXF.candidates(hand);
      var best = 0, bestV = -Infinity;
      for (var i = 0; i < cands.length; i++) {
        var v = score(EXF.features(hand, cands[i]));
        if (v > bestV) { bestV = v; best = i; }
      }
      return best;
    }
  };
}

module.exports = { load: load };
