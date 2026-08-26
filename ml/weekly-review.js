#!/usr/bin/env node
/* 주간 기보 리뷰 — 라이브 KV 기보 전체를 수집해 마크다운 요약을 낸다.
 *
 * 왜 GitHub Actions인가: 클라우드 Claude 루틴을 먼저 시도했으나 세션이 첫 턴을 시작하지
 * 못하고 멈추는 인프라 문제가 재현됐다(2026-08-26, MCP 커넥터 제거 후에도 동일).
 * 이 통계는 결정론적이라 LLM이 필요 없고, 이 프로젝트의 검증된 인프라(Actions)로 충분하다.
 *
 * 출력: stdout 마크다운 (워크플로가 $GITHUB_STEP_SUMMARY로 tee)
 * 알림: 총 라운드 ≥ 1,000이면 맨 위에 "사람 메타 재평가 시점" 배너 —
 *       사람은 봇보다 티츄 선언을 2.3배 자주 하고, 사람이 봇을 앞서는 유형은 티츄 국면뿐
 *       이라는 실측(docs/4DAN-PROTOCOL.md §1-8)에 따라 가드 채굴을 재개할 기준점.
 *
 * 사용: node ml/weekly-review.js  (네트워크 필요; Node 18+ 전역 fetch)
 */
'use strict';
var BASE = process.env.TICHU_BASE || 'https://tichu.kwon.work';
var crypto = require('crypto');

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
async function getJSON(u) { var r = await fetch(u); if (!r.ok) throw new Error(u + ' → ' + r.status); return r.json(); }
async function getText(u) { var r = await fetch(u); if (!r.ok) throw new Error(u + ' → ' + r.status); return r.text(); }

(async function () {
  var status = await getJSON(BASE + '/gamelog/status');
  var keys = (status.kv && status.kv.keys) || [];
  var seen = new Set(), recs = [], badLines = 0;
  for (var i = 0; i < keys.length; i++) {
    var txt = '';
    try { txt = await getText(BASE + '/gamelog/get?key=' + encodeURIComponent(keys[i])); }
    catch (e) { console.error('키 실패: ' + keys[i] + ' — ' + e.message); continue; }
    txt.split('\n').forEach(function (line) {
      line = line.trim(); if (!line) return;
      var r; try { r = JSON.parse(line); } catch (e) { badLines++; return; }
      var h = md5(JSON.stringify(r, Object.keys(r).sort()));
      if (seen.has(h)) return;
      seen.add(h); recs.push(r);
    });
  }
  var stats = await getJSON(BASE + '/stats');

  var now = Date.now(), week = 7 * 86400 * 1000;
  var ts = recs.map(function (r) { return r.t; }).filter(function (x) { return typeof x === 'number'; });
  var newWeek = recs.filter(function (r) { return typeof r.t === 'number' && now - r.t < week; }).length;
  function day(t) { return new Date(t).toISOString().slice(0, 10); }

  // 구성·단수
  var mix = {}, dans = {}, noReplay = 0;
  recs.forEach(function (r) {
    var seats = r.seats || [];
    var nb = seats.filter(function (x) { return x && x.b; }).length;
    var k = '사람' + (seats.length - nb) + '봇' + nb;
    mix[k] = (mix[k] || 0) + 1;
    dans[r.dan || '?'] = (dans[r.dan || '?'] || 0) + 1;
    if (!r.hands0 || !r.acts) noReplay++;
  });

  // 선언(플레이어별) + 성공률
  var decl = {};
  recs.forEach(function (r) {
    var seats = r.seats || [];
    (r.sum && r.sum.b || []).forEach(function (b) {
      var s = b.seat, nm = (seats[s] && seats[s].b) ? '(봇)' : ((seats[s] || {}).n || '?');
      var d = decl[nm] = decl[nm] || { n: 0, ok: 0 };
      d.n++; if (b.made) d.ok++;
    });
  });

  // 리롤
  var rrRounds = recs.filter(function (r) { return r.rerolls; });
  var rrTotal = rrRounds.reduce(function (a, r) { return a + r.rerolls; }, 0);

  // 봇 혼합 — 사람 우세 팀 점수차(단수별)
  var byDan = {};
  recs.forEach(function (r) {
    var seats = r.seats || [], d = r.sum && r.sum.d;
    if (!d || seats.length !== 4) return;
    var b = seats.map(function (x) { return !!(x && x.b); });
    var nb = b.filter(Boolean).length;
    if (nb === 0 || nb === 4) return;
    var hA = (!b[0] ? 1 : 0) + (!b[2] ? 1 : 0), hB = (!b[1] ? 1 : 0) + (!b[3] ? 1 : 0);
    if (hA === hB) return;
    var v = hA > hB ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
    (byDan[r.dan || '?'] = byDan[r.dan || '?'] || []).push(v);
  });

  // ---------- 출력 ----------
  var out = [];
  if (recs.length >= 1000) {
    out.push('# 🔔 사람 메타 재평가 시점 도달 (' + recs.length + '라운드)');
    out.push('기보가 충분히 쌓였다. **선언 빈도·티츄 국면 가드 채굴을 재개할 것.**');
    out.push('');
  }
  out.push('## 티츄 주간 기보 리뷰 — ' + new Date().toISOString().slice(0, 10));
  out.push('');
  out.push('| 지표 | 값 |');
  out.push('|---|---|');
  out.push('| 총 라운드 (중복 제거) | **' + recs.length + '** |');
  if (ts.length) out.push('| 기간 | ' + day(Math.min.apply(null, ts)) + ' ~ ' + day(Math.max.apply(null, ts)) + ' |');
  out.push('| 최근 7일 신규 | **' + newWeek + '** |');
  out.push('| 리롤 | ' + rrTotal + '회 / ' + rrRounds.length + '라운드 |');
  out.push('| 재생 불가 레코드 | ' + noReplay + ' · 파싱 실패 줄 ' + badLines + ' |');
  out.push('| 구성 | ' + Object.keys(mix).sort().map(function (k) { return k + ' ' + mix[k]; }).join(' · ') + ' |');
  out.push('| 봇 단수 | ' + Object.keys(dans).sort().map(function (k) { return k + ' ' + dans[k]; }).join(' · ') + ' |');
  out.push('');
  out.push('### 리더보드 (라이브 /stats)');
  out.push('');
  out.push('| 이름 | 게임 | 승률 | 점/라운드 | elo | 티츄 | 원투 |');
  out.push('|---|---|---|---|---|---|---|');
  (stats.board || []).forEach(function (p) {
    out.push('| ' + p.name + ' | ' + p.games + ' | ' + Math.round(p.rate * 100) + '% | ' +
      (p.ppr >= 0 ? '+' : '') + p.ppr.toFixed(1) + ' | ' + p.elo + ' | ' +
      (p.tichu ? p.tichuOk + '/' + p.tichu : '-') + ' | ' + p.oneTwo + ' |');
  });
  out.push('');
  out.push('### 선언 성공률 (기보 정산 기준)');
  out.push('');
  out.push('| 플레이어 | 성공/선언 | 성공률 |');
  out.push('|---|---|---|');
  Object.keys(decl).sort(function (a, b2) { return decl[b2].n - decl[a].n; }).forEach(function (nm) {
    var d = decl[nm];
    out.push('| ' + nm + ' | ' + d.ok + '/' + d.n + ' | ' + Math.round(100 * d.ok / d.n) + '% |');
  });
  var dk = Object.keys(byDan).filter(function (k) { return byDan[k].length >= 5; });
  if (dk.length) {
    out.push('');
    out.push('### 봇 혼합 판 — 사람 우세 팀 점수차/라운드');
    out.push('');
    out.push('| 봇 단수 | n | 평균 |');
    out.push('|---|---|---|');
    dk.sort().forEach(function (k) {
      var v = byDan[k], m = v.reduce(function (a, x) { return a + x; }, 0) / v.length;
      out.push('| ' + k + ' | ' + v.length + ' | ' + (m >= 0 ? '+' : '') + m.toFixed(1) + ' |');
    });
  }
  console.log(out.join('\n'));
})().catch(function (e) { console.error('★ 리뷰 실패: ' + (e && e.message)); process.exit(1); });
