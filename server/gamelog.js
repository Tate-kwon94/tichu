/* 기보 저장 — 온라인 게임의 라운드 단위 완전 기록 (사람 데이터 축의 원천).
 *
 * 왜: 지금까지 모든 학습·측정은 봇끼리였다. 전적(집계)만으론 "사람이 봇을 어디서
 * 이기는가"를 알 수 없다 — 기보가 쌓여야 국면 단위 분석이 가능하다.
 *
 * 무엇을 남기나(라운드당 ~2-3KB): 딜 직후 4인 손패 전체, 교환, 선언(시점 포함),
 * 전체 액션 순서, 라운드 결과. 봇만 있는 방은 기록하지 않는다.
 *
 * 저장 2층(stats와 동일 철학): data/gamelog.jsonl(항상) + KV(있으면).
 * KV는 부팅별 키(tichu:gamelog:<날짜>:<부팅ms>)에 누적 버퍼를 통째로 덮어쓴다 —
 * 읽기-수정-쓰기 경합이 없고, 유실 창은 플러시 간격(5분)뿐. 분석은 키 나열로 수거.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var KV = require('./kv.js');

var FILE = process.env.TICHU_GAMELOG_FILE || path.join(__dirname, '..', 'data', 'gamelog.jsonl');
var BOOT = Date.now();
function kvKey() {
  var d = new Date();
  var day = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  return 'tichu:gamelog:' + day + ':' + BOOT;
}
var FLUSH_MS = 300000;               // KV 쓰기 무료 한도(1,000/일) 대비 — 5분에 1회면 충분
var MAX_BUFFER = 400;                // 부팅당 기보 상한(~1MB) — 초과 시 오래된 것부터 파일에만

var buffer = [];                     // 완결된 라운드 기보
var fileQueue = [];                  // 파일 미기록분
var timer = null;
var kvDirty = false;

/* 방별 진행 중 기보 — trackHist 훅에서 채운다 */
function ensure(room, g) {
  var k = room._kibo;
  if (k && k.live) return k;
  k = room._kibo = { live: true, t: Date.now(), room: room.code, dan: room.botLevel || '',
    seats: room.seats.map(function (p) { return p ? { n: p.isBot ? null : p.name, b: !!p.isBot } : null; }),
    hands0: null, acts: [] };
  return k;
}

function compact(a, g) {
  var o = { s: a.seat };
  switch (a.type) {
    case 'play_cards': o.y = 'p'; o.c = a.cards; if (a.wish) o.w = a.wish; break;
    case 'pass_turn': o.y = 'x'; break;
    case 'call_tichu': o.y = 't'; break;
    case 'call_grand': o.y = 'g'; o.v = a.call ? 1 : 0; break;
    case 'submit_exchange': o.y = 'e'; o.give = a.give; break;
    case 'give_dragon': o.y = 'd'; o.to = a.toSeat; break;
    case 'reroll': o.y = 'r'; break;
    default: return null;
  }
  return o;
}

/* 모든 적용된 액션이 지나는 훅 (rooms.js trackHist에서 호출) */
function onAction(room, a, g) {
  try {
    if (!room || !g) return;
    // 사람이 한 명도 없으면 기록하지 않는다
    var hasHuman = room.seats.some(function (p) { return p && !p.isBot; });
    if (!hasHuman) return;
    if (a.type === 'next_round' || a.type === 'restart') { if (room._kibo) room._kibo.live = false; return; }
    var k = ensure(room, g);
    /* 리롤은 전원 재딜이라 이전 손패 스냅샷과 액션이 통째로 무효가 된다.
     * 그대로 두면 hands0(옛 패)과 acts(새 패 기준)가 어긋나 재생이 실패한다.
     * 리롤 횟수만 남기고 리셋한다. */
    if (a.type === 'reroll') {
      k.hands0 = null;
      k.acts = [];
      k.rerolls = (k.rerolls || 0) + 1;
      return;
    }
    // 딜 완료(전원 14장) 시점의 손패 스냅샷 — 교환 전 원 손패
    if (!k.hands0 && g.phase === 'exchange' &&
        g.hands[0].length === 14 && g.hands[1].length === 14 && g.hands[2].length === 14 && g.hands[3].length === 14) {
      k.hands0 = g.hands.map(function (h) { return h.slice(); });
    }
    var c = compact(a, g);
    if (c) k.acts.push(c);
    // 라운드 종료 — 완결 기보로 봉인
    if (g.roundSummary && room._kiboLastSum !== g.roundSummary) {
      room._kiboLastSum = g.roundSummary;
      var rs = g.roundSummary;
      k.sum = { d: rs.deltas, b: rs.bonuses, ot: rs.oneTwoTeam || null,
        fo: g.firstOutSeat, tot: rs.totals, over: !!rs.gameOver };
      k.live = false;
      if (k.hands0) {                      // 손패 스냅샷이 없으면(복구 게임 등) 버린다
        buffer.push(k);
        fileQueue.push(k);
        if (buffer.length > MAX_BUFFER) buffer.shift();
        kvDirty = true;
        schedule();
      }
    }
  } catch (e) { /* 기보는 게임을 절대 방해하지 않는다 */ }
}

function flushFile() {
  if (!fileQueue.length) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, fileQueue.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
    fileQueue = [];
  } catch (e) { /* 파일 실패 무시 — KV가 살아 있으면 그쪽에 남는다 */ }
}

var flushing = false;
async function flushKV() {
  if (!KV.enabled() || !kvDirty || flushing || !buffer.length) return;
  flushing = true;
  try {
    await KV.put(kvKey(), buffer.map(function (r) { return JSON.stringify(r); }).join('\n'));
    kvDirty = false;
  } catch (e) { /* 다음 플러시에 재시도 */ }
  finally { flushing = false; }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(function () { timer = null; flushFile(); flushKV(); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

async function flush() {                 // 종료 플러시 (server.js SIGTERM)
  if (timer) { clearTimeout(timer); timer = null; }
  flushFile();
  await flushKV();
}

function status() { return { buffered: buffer.length, key: kvKey() }; }
function recent(n) { return buffer.slice(-(n > 0 ? Math.min(n, MAX_BUFFER) : 50)); }

module.exports = { onAction: onAction, flush: flush, status: status, recent: recent };
