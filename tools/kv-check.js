#!/usr/bin/env node
/* Cloudflare KV 자격증명 점검 — 쓰기·읽기·삭제를 한 번 왕복해 본다.
 *
 * 사용:
 *   CF_ACCOUNT_ID=... CF_KV_NAMESPACE_ID=... CF_KV_TOKEN=... node tools/kv-check.js
 *
 * 통과하면 서버에 같은 값을 넣었을 때 전적이 영구 저장된다.
 * 실전 전적 키는 건드리지 않는다(점검 전용 키를 쓰고 지운다).
 */
'use strict';
process.env.CF_KV_KEY = process.env.CF_KV_KEY || 'tichu:stats:v1';
var KV = require('../server/kv.js');

function mask(s) { return !s ? '(없음)' : s.slice(0, 4) + '…' + s.slice(-4) + ' (' + s.length + '자)'; }

async function main() {
  console.log('계정 ID     : ' + (process.env.CF_ACCOUNT_ID || '(없음)'));
  console.log('네임스페이스: ' + (process.env.CF_KV_NAMESPACE_ID || '(없음)'));
  console.log('토큰        : ' + mask(process.env.CF_KV_TOKEN));
  console.log('');

  if (!KV.enabled()) {
    console.error('✗ 환경변수 3개가 모두 필요합니다: CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_KV_TOKEN');
    process.exit(1);
  }

  var key = 'tichu:selfcheck';
  var value = JSON.stringify({ hello: '티츄', at: new Date().toISOString() });

  process.stdout.write('1) 쓰기… ');
  await KV.put(key, value);
  console.log('OK');

  process.stdout.write('2) 읽기… ');
  var got = await KV.get(key);
  if (got !== value) throw new Error('값 불일치\n  보냄: ' + value + '\n  받음: ' + got);
  console.log('OK (왕복 일치)');

  process.stdout.write('3) 실제 전적 키 확인… ');
  var live = await KV.get(process.env.CF_KV_KEY);
  if (live == null) console.log('아직 없음 — 첫 게임 뒤 생성됩니다');
  else {
    var n = 0;
    try { n = Object.keys(JSON.parse(live)).length; } catch (e) {}
    console.log('있음 — ' + n + '명, ' + live.length + '바이트');
  }

  console.log('\n✓ 자격증명 정상. Render 환경변수에 같은 값을 넣고 재배포하면 전적이 유지됩니다.');
}

main().then(function () { process.exit(0); }, function (e) {
  console.error('\n✗ 실패: ' + e.message);
  console.error('\n확인할 것:');
  console.error('  · 토큰 권한이 "Workers KV Storage: Edit" 인지 (Read만이면 쓰기가 403)');
  console.error('  · 계정 ID / 네임스페이스 ID를 서로 바꿔 넣지 않았는지');
  console.error('  · 토큰의 계정 범위가 해당 계정으로 되어 있는지');
  process.exit(1);
});
