/* 기보 재생 — 서버 기보 레코드(hands0 + 압축 acts)를 Game 상태로 복원한다.
 *
 * 왜: 사람 기보 축(4단 3차)의 기반. 라운드를 결정 시점 단위로 되살려야
 * "사람이 봇과 어디서 갈리고, 갈린 수가 실제로 더 좋았나"를 잴 수 있다.
 *
 * 코어 무변경 원칙: Game 생성 직후 hands(앞 8장)와 _restDeck(좌석당 6장 순서)을
 * 외부에서 치환한다 — 8/6 분할은 그랜드 선언 이후 상태에 영향이 없다.
 * 무결성: 모든 액션 apply ok + 최종 roundSummary.deltas가 기보 sum.d와 일치해야 한다.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'tichu-core.js'));

/* 압축 액션(gamelog.js compact) → Game 액션 */
function decompact(o) {
  switch (o.y) {
    case 'p': { var a = { type: 'play_cards', seat: o.s, cards: o.c }; if (o.w) a.wish = o.w; return a; }
    case 'x': return { type: 'pass_turn', seat: o.s };
    case 't': return { type: 'call_tichu', seat: o.s };
    case 'g': return { type: 'call_grand', seat: o.s, call: !!o.v };
    case 'e': return { type: 'submit_exchange', seat: o.s, give: o.give };
    case 'd': return { type: 'give_dragon', seat: o.s, toSeat: o.to };
    default: return null;
  }
}

/* 기보 한 라운드를 재생. onStep(g, act, i, hist)를 각 액션 "적용 전"에 호출 —
 * 그 시점이 곧 결정 시점의 상태다. 반환: { ok, error, game, applied } */
function replay(rec, onStep) {
  if (!rec || !rec.hands0 || !rec.acts) return { ok: false, error: 'BAD_RECORD' };
  var g = new C.Game({ seed: 1, targetScore: 100000 });   // 점수 상한 무관 — 라운드만 본다
  g.hands = rec.hands0.map(function (h) { return h.slice(0, 8); });
  g._restDeck = [];
  rec.hands0.forEach(function (h) { g._restDeck = g._restDeck.concat(h.slice(8)); });
  var hist = [];                                           // PUCT 재현용 액션 이력
  for (var i = 0; i < rec.acts.length; i++) {
    var a = decompact(rec.acts[i]);
    if (!a) return { ok: false, error: 'UNKNOWN_ACT@' + i, game: g, applied: i };
    if (onStep) onStep(g, a, i, hist);
    var r = g.apply(a);
    if (!r.ok) return { ok: false, error: (r.error && r.error.code || 'APPLY_FAIL') + '@' + i, game: g, applied: i };
    if (a.type === 'pass_turn') hist.push({ s: a.seat, t: 'pass', r: 0, l: 0 });
    else if (a.type === 'play_cards') {
      var la = g.lastAction;
      if (la && la.combo) hist.push({ s: a.seat, t: la.combo.type, r: la.combo.rank, l: la.combo.length });
      else if (la && la.kind === 'dog') hist.push({ s: a.seat, t: 'dog', r: 0, l: 1 });
    }
  }
  if (!g.roundSummary) return { ok: false, error: 'NO_ROUND_END', game: g, applied: rec.acts.length };
  if (rec.sum && rec.sum.d) {
    var d = g.roundSummary.deltas;
    if (d.teamA !== rec.sum.d.teamA || d.teamB !== rec.sum.d.teamB)
      return { ok: false, error: 'SUM_MISMATCH ' + JSON.stringify(d) + ' != ' + JSON.stringify(rec.sum.d), game: g, applied: rec.acts.length };
  }
  return { ok: true, game: g, applied: rec.acts.length };
}

function load(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
}

/* 직접 실행: 파일 전체 라운드트립 검증 */
if (require.main === module) {
  var f = process.argv[2] || path.join(__dirname, '..', 'data', 'gamelog.jsonl');
  var recs = load(f), pass = 0, fail = 0;
  recs.forEach(function (rec, i) {
    var r = replay(rec);
    if (r.ok) pass++;
    else { fail++; console.error('  #' + i + ' 실패: ' + r.error + ' (방 ' + rec.room + ', acts ' + rec.acts.length + ')'); }
  });
  console.log('재생 검증: ' + pass + '/' + recs.length + ' 통과' + (fail ? ' — 실패 ' + fail : ''));
  process.exit(fail ? 1 : 0);
}

module.exports = { replay: replay, decompact: decompact, load: load };
