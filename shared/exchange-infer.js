/* 학습 교환 추론 — 선형·MLP 공용, 서버·클라이언트 공용 (UMD).
 * create(weightsObj)로 만든다(브라우저는 fetch JSON, 서버는 require/readFile).
 * 특징·후보는 exchange-feats 단일 소스. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tichu-core.js'), require('./exchange-feats.js'));
  } else {
    root.TichuExchangeInfer = factory(root.TichuCore, root.TichuExchangeFeats);
  }
}(typeof self !== 'undefined' ? self : this, function (C, EXF) {
'use strict';
function create(w) {
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
    pick: function (hand) {
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
return { create: create };
}));
