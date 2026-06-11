#!/usr/bin/env node
/* 의존성 0 테스트 러너: node test/run-tests.js [라운드수] */
'use strict';
var fixtures = require('./fixtures.js');
var sim = require('./sim.js');

var N = parseInt(process.argv[2] || '1000', 10);

try {
  var fx = fixtures.runFixtures();
  console.log('1) 픽스처 ' + fx + '건 통과');

  var serSteps = sim.testSerialization(12345);
  console.log('2) 직렬화 왕복 일치 (' + serSteps + '스텝)');

  var t0 = Date.now();
  var st = sim.runRounds(N, 777);
  var ms = Date.now() - t0;
  console.log('3) 봇 자가대전 ' + st.rounds + '라운드 통과 — ' + st.games + '게임, ' +
              st.steps + '액션, 수 생성 검사 ' + st.sampled + '회, ' + ms + 'ms');
  console.log('   원투 ' + st.oneTwos + '회 | 티츄/그랜드 선언 ' + st.tichuCalls +
              '회 (그랜드 ' + st.grandCalls + ', 성공 ' + st.tichuMade + ')');
  console.log('ALL TESTS PASSED');
} catch (e) {
  console.error('테스트 실패: ' + e.message);
  console.error(e.stack);
  process.exit(1);
}
