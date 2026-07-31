#!/usr/bin/env node
/* AZ 기보에서 (경량 특징, 정책망 선택) 쌍을 뽑는다 — 경량 정책 증류 학습용.
 * 라벨은 정책망의 argmax(=pick). 특징은 shared/fast-policy.js 단일 소스.
 * 사용: node ml/fastpol-feats.js <in.jsonl...> > feats.jsonl */
'use strict';
var path = require('path'), fs = require('fs');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var FP = require(path.join(__dirname, '..', 'shared', 'fast-policy.js'));
var GR = require(path.join(__dirname, 'gamelog-replay.js'));

/* AZ 레코드는 게임 상태를 통째로 담지 않는다(h, played, cnt 등 요약뿐).
 * 특징이 필요로 하는 필드만 최소 Game 유사 객체로 복원한다. */
function mkState(r) {
  var hands = [[], [], [], []];
  hands[r.seat] = r.h.slice();
  for (var s = 0; s < 4; s++) if (s !== r.seat) hands[s] = new Array(r.cnt[s]).fill('S2');
  return {
    hands: hands, currentCombo: r.cur || null, trickPile: r.tp || [],
    lastPlayerSeat: (r.win != null ? r.win : -1), tichu: r.tichu || [0, 0, 0, 0],
    firstOutSeat: (r.fo != null ? r.fo : null), wish: r.wish || null,
    finished: r.fin || []
  };
}
var out = [], nf = FP.NF, buf = new Float64Array(nf);
process.argv.slice(2).forEach(function (f) {
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).forEach(function (l) {
    var r; try { r = JSON.parse(l); } catch (e) { return; }
    if (!r.cands || r.cands.length < 2 || r.pick == null || !r.h) return;
    var g = mkState(r), X = [];
    for (var k = 0; k < r.cands.length; k++) { FP.feat(g, r.seat, r.cands[k], buf, 0); X.push(Array.prototype.slice.call(buf)); }
    out.push(JSON.stringify({ X: X, k: r.pick, n: r.cands.length }));
  });
});
process.stdout.write(out.join('\n') + '\n');
console.error('추출 ' + out.length + '건 (특징 ' + nf + '개)');
