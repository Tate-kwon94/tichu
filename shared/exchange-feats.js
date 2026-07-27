/* 학습 교환 — 후보별 특징 추출 (JS 단일 소스).
 *
 * 파이썬은 이 파일이 뽑은 숫자만 학습한다(선형대수 전용). 추론도 이 파일을 그대로 쓰므로
 * 언어 간 전치·불일치 버그가 구조적으로 불가능하다(오라클 인코더 때의 교훈).
 *
 * CLI: node ml/exchange-feats.js <labels.jsonl >features.jsonl
 *      각 줄 {X:[[후보별 특징]], k:최선후보, ev:[...], n:후보수}
 */
// 서버·클라이언트 공용 (UMD) — ml/exchange-feats.js는 CLI 겸 심
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tichu-core.js'));
  } else {
    root.TichuExchangeFeats = factory(root.TichuCore);
  }
}(typeof self !== 'undefined' ? self : this, function (C) {
'use strict';


function sp(id) { return C.isSpecial(id); }

/* gen-exchange-labels.js와 동일한 후보 열거 — 학습·추론·라벨이 같은 후보 공간을 봐야 한다 */
function candidates(hand) {
  var h = C.sortHand(hand), n = normalsAsc(h), out = [], seen = {};
  var cnt = {};
  n.forEach(function (id) { cnt[C.rankOf(id)] = (cnt[C.rankOf(id)] || 0) + 1; });
  var sfProt = sfProtected(n);
  var nonTriple = n.filter(function (id) { return cnt[C.rankOf(id)] < 3 && !sfProt[id]; });
  var pOpts = [n[n.length - 1], n[n.length - 2], n[n.length - 3]].filter(Boolean);
  function push(p, o) {
    if (!p || !o[0] || !o[1] || o[0] === o[1] || o[0] === p || o[1] === p) return;
    var key = p + '|' + o[0] + '|' + o[1];
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ p: p, o: o });
  }
  for (var pi = 0; pi < pOpts.length; pi++) {
    var rest = normalsAsc(h, [pOpts[pi]]);
    var oOpts = [[rest[0], rest[1]], [rest[0], rest[2]], [rest[1], rest[2]]];
    for (var oi = 0; oi < oOpts.length; oi++) push(pOpts[pi], oOpts[oi]);
    var restNT = nonTriple.filter(function (id) { return id !== pOpts[pi]; });
    push(pOpts[pi], [restNT[0], restNT[1]]);
  }
  return out;
}
function normalsAsc(h, ex) {
  var o = [];
  for (var i = 0; i < h.length; i++) if (!sp(h[i]) && (!ex || ex.indexOf(h[i]) < 0)) o.push(h[i]);
  return o;
}
function sfProtected(normals) {
  var out = {}, bySuit = {};
  normals.forEach(function (id) { (bySuit[id[0]] = bySuit[id[0]] || []).push(id); });
  Object.keys(bySuit).forEach(function (su) {
    for (var w = 2; w <= 10; w++) {
      var inWin = bySuit[su].filter(function (id) { var r = C.rankOf(id); return r >= w && r <= w + 4; });
      if (inWin.length >= 4) inWin.forEach(function (id) { out[id] = 1; });
    }
  });
  return out;
}

/* 후보 특징 벡터 — 선형 랭커가 소화할 수 있게 명시적 상호작용 포함 */
function features(hand, cand) {
  var h = C.sortHand(hand), n = normalsAsc(h);
  var cnt = {};
  n.forEach(function (id) { cnt[C.rankOf(id)] = (cnt[C.rankOf(id)] || 0) + 1; });
  var sfProt = sfProtected(n);
  var rp = C.rankOf(cand.p), r1 = C.rankOf(cand.o[0]), r2 = C.rankOf(cand.o[1]);
  var pairsBroken = (cnt[r1] === 2 ? 1 : 0) + (cnt[r2] === 2 && r1 !== r2 ? 1 : 0) + (r1 === r2 && cnt[r1] === 2 ? 1 : 0);
  var tripleBroken = (cnt[r1] >= 3 ? 1 : 0) + (cnt[r2] >= 3 && r2 !== r1 ? 1 : 0);
  var sfBroken = (sfProt[cand.o[0]] ? 1 : 0) + (sfProt[cand.o[1]] ? 1 : 0);
  var pPairBroken = cnt[rp] === 2 ? 1 : 0;
  var pTripleBroken = cnt[rp] >= 3 ? 1 : 0;
  // 손 문맥
  var hasPH = h.indexOf('PH') >= 0 ? 1 : 0, hasDR = h.indexOf('DR') >= 0 ? 1 : 0;
  var hasMJ = h.indexOf('MJ') >= 0 ? 1 : 0, hasDG = h.indexOf('DG') >= 0 ? 1 : 0;
  var top = n.length ? C.rankOf(n[n.length - 1]) : 0;
  var strength = (hasPH + hasDR) * 2 + n.filter(function (id) { return C.rankOf(id) >= 13; }).length;
  return [
    1,                                   // bias
    rp / 14,                             // 파트너 급여 랭크
    (top - rp) / 14,                     // 최고 대비 얼마나 아꼈나
    r1 / 14, r2 / 14,                    // 상대 급여 랭크
    pairsBroken, tripleBroken, sfBroken, // 상대 급여가 깨는 구조
    pPairBroken, pTripleBroken,          // 파트너 급여가 깨는 구조
    hasPH, hasDR, hasMJ, hasDG,
    strength / 8,
    (rp / 14) * (strength / 8),          // 강한 손 × 좋은 카드 급여 상호작용
    (r1 + r2) / 28 * (strength / 8)
  ];
}

return { candidates: candidates, features: features, DIM: 17 };
}));
