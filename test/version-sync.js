#!/usr/bin/env node
/* 에셋 버전 표기 3곳 일치 검사.
 *
 * 왜: 배포 때 올려야 하는 표기가 세 곳이다 — client/*.html의 ?v=, index.html의
 * window.__ASSET_V, client/sw.js의 VERSION/V. 사람 절차로는 __ASSET_V가 v34에서
 * 6번의 배포(v35~v40) 동안 방치됐고, 그 결과 4단 교환 가중치를 ?v=34로 요청해
 * 오프라인 첫 실행에서 조용히 3단 교환기로 강등됐다(2026-08-27 발견).
 * 하나라도 어긋나면 배포 전에 여기서 죽는다.
 *
 * 실행: node test/version-sync.js  (npm test의 첫 단계)
 */
'use strict';
var fs = require('fs');
var path = require('path');
var C = path.join(__dirname, '..', 'client');

function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
var fail = [];
var html = fs.readdirSync(C).filter(function (f) { return /\.html$/.test(f); });
var vs = [];
html.forEach(function (f) {
  var src = fs.readFileSync(path.join(C, f), 'utf8');
  var m = uniq(src.match(/\?v=(\d+)/g) || []);
  if (m.length !== 1) fail.push(f + ': ?v= 표기가 ' + (m.length ? '섞임 ' + m.join(',') : '없음'));
  else vs.push(m[0].slice(3));
});
var index = fs.readFileSync(path.join(C, 'index.html'), 'utf8');
var av = (index.match(/__ASSET_V = "(\d+)"/) || [])[1];
if (!av) fail.push('index.html: __ASSET_V 없음');
var sw = fs.readFileSync(path.join(C, 'sw.js'), 'utf8');
var swV = (sw.match(/var VERSION = 'tichu-v(\d+)'/) || [])[1];
var swQ = (sw.match(/var V = 'v=(\d+)'/) || [])[1];
if (!swV || !swQ) fail.push('sw.js: VERSION/V 표기 없음');
var all = uniq(vs.concat([av, swV, swQ]).filter(Boolean));
if (all.length > 1) fail.push('불일치: html ?v=' + uniq(vs).join('/') + ' · __ASSET_V=' + av + ' · sw VERSION=' + swV + ' · sw V=' + swQ);
if (fail.length) {
  console.error('★ 에셋 버전 표기 불일치:\n  ' + fail.join('\n  '));
  process.exit(1);
}
console.log('버전 표기 3곳 일치: v' + all[0] + ' (' + html.join(', ') + ', __ASSET_V, sw.js)');
