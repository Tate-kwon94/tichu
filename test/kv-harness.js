#!/usr/bin/env node
/* e2e-kv.js가 fork하는 하네스 — stats 모듈을 실제 서버와 같은 수명주기로 태운다.
 * (require → 하이드레이션 → 기록 → flush → 종료)
 * 인자: record | read | racy */
'use strict';
var mode = process.argv[2] || 'record';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  if (mode === 'racy') {
    // 하이드레이션이 끝나기 전(가짜 KV가 1.2초 지연)에 기록을 밀어 넣는다
    var ST = require('../server/stats.js');
    ST.recordGame(['권', null, null, null], 'A', [null, 'super2', 'super2', 'super2']);
    await sleep(3600);                       // 하이드레이션 완료 + 재생 대기
    var d = ST.detail('권');
    console.log('RACY games=' + (d && d.games));
    await ST.flush();
    return;
  }

  if (mode === 'overlap') {
    // 게임1 기록 → 디바운스 저장이 PUT 진행 중일 때 게임2 기록 → 즉시 종료 플러시
    var SO = require('../server/stats.js');
    await sleep(1800);
    SO.recordGame(['권', null, null, null], 'A', [null, 'super2', 'super2', 'super2']);
    await sleep(5600);                       // 디바운스 5초 → PUT 시작(3초 지연 중)
    SO.recordGame(['권', null, null, null], 'A', [null, 'super2', 'super2', 'super2']);
    await SO.flush();
    console.log('OVERLAP-FLUSHED');
    return;
  }

  var ST = require('../server/stats.js');
  await sleep(1800);                         // 하이드레이션 대기(404 재시도 800ms 포함)

  if (mode === 'proto') {
    // 프로토타입 오염 확인 — 평범한 객체가 오염 키를 물려받았는지
    var probe = {};
    console.log(probe.g === undefined && ({}).w === undefined ? 'PROTO-CLEAN' : 'PROTO-DIRTY');
    return;
  }

  if (mode === 'read') {
    var det = ST.detail('권');
    console.log('READ games=' + (det && det.games) + ' elo=' + (det && det.elo));
    return;
  }

  var st = ST.status();
  console.log('PERSIST mode=' + st.mode + ' probe=' + st.probe + ' restored=' + st.restored);
  ST.recordGame(['권', null, null, null], 'A', [null, 'super2', 'super2', 'super2']);
  console.log('RECORDED');
  await ST.flush();
}

main().then(function () { process.exit(0); }, function (e) { console.error(e); process.exit(1); });
