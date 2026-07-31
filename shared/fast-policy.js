/* 롤아웃 전용 경량 정책 (UMD) — 5단 후보.
 *
 * 왜: 실측으로 **평가기가 병목**임이 확인됐다. 같은 40세계(CRN)에서 보통봇 롤아웃과
 * 정책망 롤아웃이 8국면 중 5개에서 다른 최선수를 고른다(62% 불일치).
 * 그런데 정책망은 한 수에 2,961µs로 botDecide(4.5µs)의 658배라 롤아웃에 못 쓴다
 * (앞 3수만 써도 시뮬이 8,000→225로 붕괴).
 *
 * 그래서 정책망을 **선형 모델로 증류**한다. 목표는 한 수 50µs 이하(현재의 1/60).
 * 특징은 후보별 스칼라 몇 개뿐이라 곱셈-덧셈 수백 번이면 끝난다.
 *
 * 설계 원칙(교환 랭커에서 검증된 것): 특징 추출을 이 파일 하나로 두고
 * 학습(파이썬)과 추론(JS)이 같은 코드를 쓴다 — 언어 간 불일치가 구조적으로 불가능하다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tichu-core.js'));
  } else {
    root.TichuFastPolicy = factory(root.TichuCore);
  }
}(typeof self !== 'undefined' ? self : this, function (C) {
'use strict';

var NF = 18;   // 특징 수 — 늘리면 학습·추론 양쪽이 자동으로 따라간다

/* 후보 하나의 특징. game은 결정 시점 상태, cand는 {c:[카드], t:타입, r:랭크, l:길이} 또는 {t:'pass'}.
 * 전부 O(손패) 이하로 계산된다 — 롤아웃에서 수만 번 불리므로 할당·정렬을 피한다. */
function feat(g, seat, cand, out, off) {
  var hand = g.hands[seat], n = hand.length;
  var isPass = cand.t === 'pass';
  var cl = isPass ? 0 : cand.c.length;
  var cur = g.currentCombo;
  var pts = 0, hi = 0, hasSpecial = 0, bombLen = 0;
  if (!isPass) {
    for (var i = 0; i < cand.c.length; i++) {
      var id = cand.c[i];
      pts += C.pointsOf(id);
      var r = C.rankOf(id);
      if (r > hi) hi = r;
      if (C.isSpecial(id)) hasSpecial = 1;
    }
    if (cand.t === 'bomb4' || cand.t === 'bombstraight') bombLen = cl;
  }
  // 파트너가 현재 트릭을 이기는 중인가
  var partner = (seat + 2) % 4;
  var pWin = (g.lastPlayerSeat === partner) ? 1 : 0;
  var trickPts = C.sumPoints(g.trickPile || []);
  var oppMin = Math.min(g.hands[(seat + 1) % 4].length, g.hands[(seat + 3) % 4].length);

  out[off + 0] = isPass ? 1 : 0;
  out[off + 1] = cl / 5;
  out[off + 2] = pts / 25;
  out[off + 3] = hi / 15;
  out[off + 4] = hasSpecial;
  out[off + 5] = bombLen / 5;
  out[off + 6] = (n - cl) / 14;                       // 낼 뒤 남는 장수
  out[off + 7] = (n - cl) === 0 ? 1 : 0;              // 이 수로 완주
  out[off + 8] = pWin;
  out[off + 9] = pWin && isPass ? 1 : 0;              // 파트너 이기는데 패스(양보)
  out[off + 10] = trickPts / 25;
  out[off + 11] = trickPts >= 10 && !isPass ? 1 : 0;  // 큰 트릭을 먹으러 감
  out[off + 12] = cur ? 1 : 0;                        // 따라가기 국면
  out[off + 13] = cur && !isPass ? (hi - (cur.rank || 0)) / 15 : 0;  // 얼마나 세게 눌렀나
  out[off + 14] = g.tichu[seat] > 0 ? 1 : 0;
  out[off + 15] = g.tichu[partner] > 0 && g.firstOutSeat === null ? 1 : 0;
  out[off + 16] = oppMin / 14;                        // 상대 최소 잔여
  out[off + 17] = (g.wish && !isPass) ? 1 : 0;
}

/* 후보 배열 → 각 후보의 점수. w는 길이 NF의 선형 가중치. */
function score(g, seat, cands, w, buf) {
  var K = cands.length;
  if (!buf || buf.length < NF) buf = new Float64Array(NF);
  var best = 0, bv = -Infinity;
  for (var k = 0; k < K; k++) {
    feat(g, seat, cands[k], buf, 0);
    var s = 0;
    for (var j = 0; j < NF; j++) s += w[j] * buf[j];
    if (s > bv) { bv = s; best = k; }
  }
  return best;
}

function create(weights) {
  var w = weights && weights.w ? weights.w : weights;
  if (!w || w.length !== NF) throw new Error('fast-policy: 가중치 길이가 ' + NF + '이 아님');
  var buf = new Float64Array(NF);
  return {
    NF: NF,
    pick: function (g, seat, cands) { return score(g, seat, cands, w, buf); }
  };
}

return { NF: NF, feat: feat, score: score, create: create };
}));
