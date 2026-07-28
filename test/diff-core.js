#!/usr/bin/env node
/* 코어 차등 테스트 — 최적화본이 참조본과 정확히 같게 동작하는가.
 *
 * 왜 필요한가: tichu-core.js는 서버·클라이언트·모든 봇이 쓰는 규칙 엔진이라
 * 성능 최적화가 동작을 1비트라도 바꾸면 게임이 조용히 틀어진다. 특히 clone은
 * 얕은 복사가 하나만 섞여도 탐색(수천 번의 시뮬)이 실제 게임 상태를 오염시킨다.
 *
 * 사용: TICHU_REF=/경로/이전-tichu-core.js node test/diff-core.js
 *       (참조본이 없으면 git show <이전커밋>:shared/tichu-core.js > /tmp/ref.js 로 만든다)
 */
'use strict';
var path = require('path');
var REFP = process.env.TICHU_REF;
if (!REFP) {
  console.error('TICHU_REF에 참조본 경로를 지정하세요.');
  console.error('  예: git show HEAD~1:shared/tichu-core.js > /tmp/ref.js');
  console.error('      TICHU_REF=/tmp/ref.js node test/diff-core.js');
  process.exit(2);
}
var REF = require(REFP);
var NEW = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));
var B = require(path.join(__dirname, '..', 'shared', 'bots.js'));

/* ---------- 1) genMoves: 수 집합 완전 일치 ---------- */
function key(m) {
  return m.cards.slice().sort().join(',') + '|' + m.combo.type + '|' + m.combo.rank + '|' + m.combo.length;
}
function setOf(res) { return { forced: res.forced, keys: res.moves.map(key).sort() }; }

var CURS = [null,
  { type: 'single', rank: 5, length: 1 }, { type: 'single', rank: 12, length: 1 },
  { type: 'pair', rank: 7, length: 2 }, { type: 'triple', rank: 9, length: 3 },
  { type: 'straight', rank: 9, length: 5 }, { type: 'straight', rank: 11, length: 7 },
  { type: 'pairseq', rank: 8, length: 4 }, { type: 'fullhouse', rank: 10, length: 5 },
  { type: 'bomb4', rank: 6, length: 4 }, { type: 'bombstraight', rank: 9, length: 5 }];
var WISHES = [null, 2, 5, 9, 14];

function testGenMoves(n) {
  var rng = (function (s) { return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })(42);
  var deck = REF.makeDeck(), bad = 0, moves = 0;
  for (var t = 0; t < n; t++) {
    var d = deck.slice();
    for (var i = d.length - 1; i > 0; i--) { var j = (rng() * (i + 1)) | 0; var x = d[i]; d[i] = d[j]; d[j] = x; }
    var hand = REF.sortHand(d.slice(0, 1 + ((rng() * 14) | 0)));
    var cur = CURS[(rng() * CURS.length) | 0];
    var wish = WISHES[(rng() * WISHES.length) | 0];
    var a = setOf(REF.genMoves(hand, cur, wish));
    var b = setOf(NEW.genMoves(hand, cur, wish));
    moves += a.keys.length;
    if (a.forced !== b.forced || a.keys.join(';') !== b.keys.join(';')) {
      bad++;
      if (bad <= 3) {
        var sa = {}; a.keys.forEach(function (k) { sa[k] = 1; });
        var sb = {}; b.keys.forEach(function (k) { sb[k] = 1; });
        console.log('불일치: hand=' + hand.join(',') + ' cur=' + JSON.stringify(cur) + ' wish=' + wish);
        console.log('  참조에만: ' + a.keys.filter(function (k) { return !sb[k]; }).slice(0, 5).join(' / '));
        console.log('  신규에만: ' + b.keys.filter(function (k) { return !sa[k]; }).slice(0, 5).join(' / '));
      }
    }
  }
  console.log('1) genMoves 차등: ' + n + '케이스 · 총 ' + moves + '수 · 불일치 ' + bad);
  return bad;
}

/* ---------- 2) clone: 값 동일 + 참조 비공유(깊은 복사) ---------- */
function playSome(M, seed, steps) {
  var g = new M.Game({ seed: seed, targetScore: 500 });
  for (var i = 0; i < 4; i++) g.apply({ type: 'call_grand', seat: i, call: i === 1 });
  for (var s = 0; s < 4; s++) g.apply({ type: 'submit_exchange', seat: s, give: B.botExchange(g, s, { keepSpecials: true }) });
  for (var t = 0; t < steps && !g.gameOver; t++) {
    var w = g.waitingOn(); if (!w.length) break;
    var a = B.botDecide(g, w[0], 'normal'); if (!a) break;
    if (!g.apply(a).ok) break;
  }
  return g;
}
function checkDeep(orig, copy, p, out) {
  if (typeof orig === 'function') return;                 // rng.next — clone이 새로 만드는 게 정상
  if (p === 'g.rng') {                                    // rng는 makeRng로 재생성(상태 s만 이월)
    if (orig.s !== copy.s) out.diff.push('g.rng.s ' + orig.s + ' != ' + copy.s);
    return;
  }
  if (orig === null || typeof orig !== 'object') {
    if (orig !== copy) out.diff.push(p + ': ' + orig + ' != ' + copy);
    return;
  }
  if (orig === copy) { out.shared.push(p); return; }       // ★ 참조 공유 = 얕은 복사 결함
  var ka = Object.keys(orig), kb = Object.keys(copy);
  if (ka.length !== kb.length) { out.diff.push(p + ': 키 수 ' + ka.length + ' != ' + kb.length); return; }
  for (var i = 0; i < ka.length; i++) {
    if (!(ka[i] in copy)) { out.diff.push(p + '.' + ka[i] + ' 없음'); continue; }
    checkDeep(orig[ka[i]], copy[ka[i]], p + '.' + ka[i], out);
  }
}
function testClone(n) {
  var bad = 0;
  for (var seed = 1; seed <= n; seed++) {
    var steps = 3 + (seed % 40);
    var gR = playSome(REF, seed, steps), gN = playSome(NEW, seed, steps);
    var out = { diff: [], shared: [] };
    var cN = gN.clone();
    checkDeep(gN, cN, 'g', out);
    var same = JSON.stringify(gR.clone().toJSON()) === JSON.stringify(cN.toJSON());
    if (out.diff.length || out.shared.length || !same) {
      bad++;
      if (bad <= 3) {
        console.log('seed ' + seed + ':');
        if (out.shared.length) console.log('  ★참조 공유(얕은 복사): ' + out.shared.slice(0, 6).join(' | '));
        if (out.diff.length) console.log('  값 불일치: ' + out.diff.slice(0, 4).join(' | '));
        if (!same) console.log('  참조본 clone과 구조 다름');
      }
    }
  }
  console.log('2) clone 차등: ' + n + '케이스 · 문제 ' + bad);
  return bad;
}

var fail = testGenMoves(+process.env.TICHU_DIFF_N || 40000) + testClone(300);
console.log(fail ? 'DIFF FAILED' : 'DIFF PASSED');
process.exit(fail ? 1 : 0);
