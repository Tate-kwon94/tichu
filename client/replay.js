/* 기보 뷰어 — /gamelog/* 를 읽어 라운드를 수 단위로 되살린다.
 *
 * 왜 별도 페이지인가: 분석 도구는 게임 클라이언트(app.js·sw.js)와 생명주기가 다르다.
 * 정적 핸들러가 client/ 파일을 그대로 서빙하므로 서버 무수정으로 /replay.html에 뜬다.
 *
 * 재생 원리(ml/gamelog-replay.js와 동일): Game 생성 직후 hands(앞 8장)와
 * _restDeck(좌석당 6장)을 기보 hands0으로 치환 — 이후 acts를 순서대로 apply.
 * 스텝 이동은 매번 처음부터 재적용한다(라운드 ~60수 × apply µs = 1ms 미만, 캐시 불요).
 */
(function () {
'use strict';
var C = window.TichuCore;
var $ = function (sel) { return document.querySelector(sel); };
var root = document.getElementById('rv');

var DAN_LABEL = { '': '?', easy: '쉬움', normal: '보통', hard: '고수', devil: '악마',
  super: '1단', super2: '2단', super3: '3단', super4: '4단' };
var PHASE_LABEL = { grand: '라지 선언', exchange: '교환', play: '플레이' };

var S = {
  sources: [],      // [{id, label}] — recent + KV 키
  srcId: 'recent',
  records: [],      // 현재 소스의 기보 (원본 순서 = 시간순)
  sel: -1,          // 선택된 기보 인덱스 (-1 = 목록)
  step: 0,          // 현재 위치: acts[0..step-1] 적용된 상태
  log: [],          // 수 라벨 (선택 시 1회 생성)
  maxStep: 0,       // 재생 가능한 최대 스텝 (재생 실패 시 acts.length보다 작음)
  replayErr: null,
  playing: null     // 자동 재생 타이머
};

// ---------- 데이터 ----------
function parseJsonl(text) {
  var out = [];
  text.split('\n').forEach(function (l) {
    if (!l) return;
    try { var r = JSON.parse(l); if (r && r.hands0 && r.acts) out.push(r); } catch (e) { /* 깨진 줄 무시 */ }
  });
  return out;
}
function keyLabel(key) { // tichu:gamelog:YYYYMMDD:bootMs
  var p = key.split(':'), day = p[2] || '', boot = +p[3] || 0;
  var d = boot ? new Date(boot) : null;
  return day.slice(4, 6) + '/' + day.slice(6, 8) + ' 부팅' +
    (d ? ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) : '');
}
function loadSources() {
  return fetch('gamelog/status').then(function (r) { return r.json(); }).then(function (st) {
    var srcs = [{ id: 'recent', label: '이번 부팅 (' + st.buffered + ')' }];
    var keys = (st.kv && st.kv.keys) || [];
    keys.slice().sort().reverse().forEach(function (k) {
      if (k !== st.key) srcs.push({ id: k, label: keyLabel(k) });
    });
    S.sources = srcs;
  }).catch(function () { S.sources = [{ id: 'recent', label: '이번 부팅' }]; });
}
function loadRecords() {
  var p = S.srcId === 'recent'
    ? fetch('gamelog/recent?n=400').then(function (r) { return r.text(); })
    : fetch('gamelog/get?key=' + encodeURIComponent(S.srcId)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
  return p.then(function (t) { S.records = parseJsonl(t); })
    .catch(function () { S.records = []; });
}

// ---------- 재생 (ml/gamelog-replay.js 브라우저 포트 — 알고리즘 동일 유지) ----------
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
function newGame(rec) {
  var g = new C.Game({ seed: 1, targetScore: 100000 }); // 점수 상한 무관 — 라운드만 본다
  g.hands = rec.hands0.map(function (h) { return h.slice(0, 8); });
  g._restDeck = [];
  rec.hands0.forEach(function (h) { g._restDeck = g._restDeck.concat(h.slice(8)); });
  return g;
}
function stateAt(rec, n) {
  var g = newGame(rec);
  for (var i = 0; i < n; i++) {
    var a = decompact(rec.acts[i]);
    if (!a || !g.apply(a).ok) break; // maxStep이 이미 여기서 멈추게 한다
  }
  return g;
}

// ---------- 수 라벨 (전체 1회 패스 — apply 후의 lastAction.combo가 정확한 표기) ----------
function comboLabel(combo) {
  if (!combo) return '';
  if (combo.type === 'single' && combo.rank === 'PH') return '불사조';
  if (combo.type === 'single' && typeof combo.rank === 'number') {
    if (combo.rank >= 15) return '용';
    if (combo.rank === 1.5) return '불사조';
    if (combo.rank % 1 !== 0) return '불사조(' + C.rankLabel(Math.floor(combo.rank)) + '+0.5)';
    if (combo.rank === 1) return '싱글 1';
  }
  var t = { single: '싱글', pair: '페어', triple: '트리플', fullhouse: '풀하우스',
    straight: '스트레이트', pairseq: '연속페어', bomb4: '폭탄', bombstraight: '스트플 폭탄', dog: '개' }[combo.type] || combo.type;
  var r = combo.rank;
  var rl = (typeof r === 'number' && r % 1 === 0 && r >= 1 && r <= 15) ? ' ' + C.rankLabel(r) : '';
  if (combo.type === 'straight' || combo.type === 'bombstraight') rl = ' ' + combo.length + '장 (' + C.rankLabel(combo.rank) + '까지)';
  if (combo.type === 'dog') rl = '';
  return t + rl;
}
function seatName(rec, s) {
  var p = rec.seats && rec.seats[s];
  if (!p) return '좌석' + (s + 1);
  return p.b ? '봇' + (s + 1) : (p.n || '?');
}
function buildLog(rec) {
  var g = newGame(rec), log = [], err = null, i;
  for (i = 0; i < rec.acts.length; i++) {
    var o = rec.acts[i], a = decompact(o);
    if (!a) { err = '알 수 없는 수 @' + (i + 1); break; }
    var who = seatName(rec, o.s), txt;
    // 라운드 종료 수는 apply 후 lastAction이 덮여 combo가 사라진다 — apply 전에 식별해 둔다
    var pre = o.y === 'p' ? C.identify(o.c) : null;
    var r = g.apply(a);
    if (!r.ok) { err = '재생 실패 @' + (i + 1) + ' (' + ((r.error && r.error.code) || '?') + ')'; break; }
    switch (o.y) {
      case 'p':
        txt = comboLabel((g.lastAction && g.lastAction.combo) || pre) || '플레이';
        if (o.w) txt += ' · 소원 ' + C.rankLabel(o.w);
        break;
      case 'x': txt = '패스'; break;
      case 't': txt = '티츄!'; break;
      case 'g': txt = o.v ? '라지 티츄!' : '라지 안 함'; break;
      case 'e': txt = '교환 제출'; break;
      case 'd': txt = '용 트릭 증정 → ' + seatName(rec, o.to); break;
      default: txt = o.y;
    }
    log.push({ s: o.s, who: who, txt: txt });
  }
  S.log = log;
  S.maxStep = log.length;
  S.replayErr = err;
  if (!err && !g.roundSummary) S.replayErr = '라운드가 끝까지 기록되지 않음';
}

// ---------- 카드 렌더 (app.js 클래식 스타일 축약 — 위장·xl 변형 없음) ----------
var SUIT_COLOR = { S: '#23262e', H: '#cf3434', D: '#2a62c4', C: '#1c7e46' };
var SP_VIEW = { MJ: ['마작', '🐦', 'spMJ'], DG: ['개', '🐶', 'spDG'], PH: ['불사조', '🔥', 'spPH'], DR: ['용', '🐉', 'spDR'] };
function cardHtml(id) {
  if (C.isSpecial(id)) {
    var sp = SP_VIEW[id];
    return '<div class="card sm sp ' + sp[2] + '">' +
      '<span class="spBand">' + sp[0] + '</span>' +
      '<span class="cp" style="font-size:17px;padding-top:8px">' + sp[1] + '</span>' +
      (id === 'MJ' ? '<span class="spRank">1</span>' : '') + '</div>';
  }
  var su = id[0], rl = C.rankLabel(C.rankOf(id)), sym = C.SUIT_SYMBOL[su];
  return '<div class="card sm" style="color:' + SUIT_COLOR[su] + '">' +
    '<span class="cr">' + rl + '<span class="su">' + sym + '</span></span>' +
    '<span class="cp">' + sym + '</span></div>';
}
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

// ---------- 목록 화면 ----------
function fmtTime(t) {
  var d = new Date(t);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
    ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function tichuBadges(rec) {
  var out = '';
  (rec.acts || []).forEach(function (o) {
    if (o.y !== 't' && !(o.y === 'g' && o.v)) return;
    var ok = rec.sum && rec.sum.fo === o.s;
    out += ' <span class="rvBadge ' + (ok ? 'gold' : '') + '">' +
      (o.y === 'g' ? '라지' : '티츄') + ' ' + esc(seatName(rec, o.s)) + (ok ? ' 성공' : ' 실패') + '</span>';
  });
  if (rec.sum && rec.sum.ot) out += ' <span class="rvBadge gold">원투 ' + (rec.sum.ot === 'A' ? '팀A' : '팀B') + '</span>';
  return out;
}
function renderList() {
  var opts = S.sources.map(function (s) {
    return '<option value="' + esc(s.id) + '"' + (s.id === S.srcId ? ' selected' : '') + '>' + esc(s.label) + '</option>';
  }).join('');
  var items = '';
  for (var i = S.records.length - 1; i >= 0; i--) { // 최신부터
    var rec = S.records[i], d = rec.sum && rec.sum.d;
    items += '<button class="rvItem" data-i="' + i + '">' +
      '<div class="l1"><b>' + fmtTime(rec.t) + '</b>' +
      '<span>방 ' + esc(rec.room || '?') + '</span>' +
      '<span class="rvBadge">' + (DAN_LABEL[rec.dan] || esc(rec.dan)) + '</span>' +
      (d ? '<span><span class="rvBadge a">A ' + (d.teamA > 0 ? '+' : '') + d.teamA + '</span> <span class="rvBadge b">B ' + (d.teamB > 0 ? '+' : '') + d.teamB + '</span></span>' : '') +
      '</div>' +
      '<div class="l2">' + [0, 1, 2, 3].map(function (s2) { return esc(seatName(rec, s2)); }).join(' · ') +
      tichuBadges(rec) + '</div></button>';
  }
  root.innerHTML =
    '<div class="rvTop"><h1>기보</h1>' +
    '<select class="rvSrc" id="rvSrcSel">' + opts + '</select>' +
    '<button class="btn small ghost" id="rvReload">↻</button></div>' +
    (S.records.length ? '<div class="rvList">' + items + '</div>'
      : '<div class="rvEmpty">기보가 없습니다.<br>사람이 참여한 온라인 라운드가 끝나면 여기 쌓입니다.</div>') +
    '<div class="rvNote">라운드가 끝난 손패는 공개 정보 — 4인 전체 패를 보며 복기할 수 있습니다.</div>';
  $('#rvSrcSel').onchange = function () {
    S.srcId = this.value;
    loadRecords().then(renderList);
  };
  $('#rvReload').onclick = function () { boot(); };
  root.querySelectorAll('.rvItem').forEach(function (el) {
    el.onclick = function () { openRound(+el.dataset.i); };
  });
}

// ---------- 재생 화면 ----------
function openRound(i) {
  stopAuto();
  S.sel = i;
  S.step = 0;
  buildLog(S.records[i]);
  renderRound();
}
function setStep(n) {
  S.step = Math.max(0, Math.min(S.maxStep, n));
  renderRound();
}
function stopAuto() {
  if (S.playing) { clearInterval(S.playing); S.playing = null; }
}
function renderRound() {
  var rec = S.records[S.sel];
  if (!rec) { S.sel = -1; renderList(); return; }
  var g = stateAt(rec, S.step);
  var actNext = S.step < S.maxStep ? rec.acts[S.step] : null; // 이제 둘 사람
  var seats = [0, 1, 2, 3].map(function (s) {
    var fin = g.finished.indexOf(s);
    var badges =
      (g.tichu[s] ? '<span class="rvBadge gold">' + (g.tichu[s] === 200 ? '라지' : '티츄') + '</span>' : '') +
      (fin >= 0 ? '<span class="rvBadge">' + (fin + 1) + '등</span>' : '') +
      (g.phase === 'exchange' && g.exchangeGive && g.exchangeGive[s] ? '<span class="rvBadge">교환완료</span>' : '');
    return '<div class="rvSeat' + (actNext && actNext.s === s ? ' act' : '') + '">' +
      '<div class="hd"><span class="rvBadge ' + (s % 2 === 0 ? 'a' : 'b') + '">' + (s % 2 === 0 ? 'A' : 'B') + '</span>' +
      '<b>' + esc(seatName(rec, s)) + '</b>' + badges +
      '<span style="margin-left:auto;font-size:12px;opacity:.7">' + g.hands[s].length + '장</span></div>' +
      '<div class="rvHand">' + g.hands[s].map(cardHtml).join('') + '</div></div>';
  }).join('');

  var trick = '';
  if (g.trick.length) {
    trick = g.trick.slice(-5).map(function (t) {
      return '<div class="rvPlay"><span class="who">' + esc(seatName(rec, t.seat)) + '</span>' +
        '<span class="cs">' + t.cards.map(cardHtml).join('') + '</span></div>';
    }).join('');
  } else {
    trick = '<div style="opacity:.5;font-size:13px;padding:8px 2px">' +
      (g.phase === 'play' ? '새 턴 — ' + esc(seatName(rec, g.turnSeat)) + ' 선' : (PHASE_LABEL[g.phase] || '') + ' 단계') + '</div>';
  }
  var tHd = '<span>' + (PHASE_LABEL[g.phase] || '결과') + '</span>' +
    (g.currentCombo ? '<span>' + comboLabel(g.currentCombo) + '</span>' : '') +
    (g.wish ? '<span class="rvBadge gold">소원 ' + C.rankLabel(g.wish) + '</span>' : '') +
    (g.trickPile.length ? '<span>더미 ' + C.sumPoints(g.trickPile) + '점</span>' : '');

  var sum = '';
  if (S.step >= S.maxStep && rec.sum) {
    var d = rec.sum.d || {}, tot = rec.sum.tot || {};
    sum = '<div class="rvSum">' +
      '<b>라운드 결과</b> — 팀A ' + (d.teamA > 0 ? '+' : '') + d.teamA + ' (누계 ' + tot.teamA + ') · ' +
      '팀B ' + (d.teamB > 0 ? '+' : '') + d.teamB + ' (누계 ' + tot.teamB + ')' +
      (rec.sum.ot ? '<br>원투 완주 — 팀' + rec.sum.ot : '') +
      (rec.sum.fo != null ? '<br>1등 완주: ' + esc(seatName(rec, rec.sum.fo)) : '') +
      (rec.sum.over ? '<br><b>게임 종료</b>' : '') + '</div>';
  }

  var logHtml = S.log.map(function (l, i2) {
    return '<div class="ln' + (i2 === S.step - 1 ? ' cur' : '') + '" data-i="' + (i2 + 1) + '">' +
      '<span class="n">' + (i2 + 1) + '</span><span><b>' + esc(l.who) + '</b> ' + esc(l.txt) + '</span></div>';
  }).join('');

  root.innerHTML =
    '<div class="rvTop"><button class="btn small ghost" id="rvBack">← 목록</button>' +
    '<h1>방 ' + esc(rec.room || '?') + '</h1>' +
    '<span class="rvBadge">' + (DAN_LABEL[rec.dan] || esc(rec.dan)) + '</span>' +
    '<span style="font-size:12.5px;opacity:.75">' + fmtTime(rec.t) + '</span></div>' +
    (S.replayErr ? '<div class="rvErr">' + esc(S.replayErr) + ' — ' + S.maxStep + '수까지만 재생됩니다</div>' : '') +
    seats +
    '<div class="rvTrick"><div class="tHd">' + tHd + '</div>' + trick + '</div>' +
    sum +
    '<div class="rvCtl">' +
    '<button class="btn small ghost" id="rvFirst">⏮</button>' +
    '<button class="btn small ghost" id="rvPrev">◀</button>' +
    '<input type="range" id="rvRange" min="0" max="' + S.maxStep + '" value="' + S.step + '">' +
    '<button class="btn small ghost" id="rvNext">▶</button>' +
    '<button class="btn small ghost" id="rvLast">⏭</button>' +
    '<button class="btn small" id="rvAuto">' + (S.playing ? '⏸' : '재생') + '</button>' +
    '<span class="rvStep">' + S.step + '/' + S.maxStep + '</span></div>' +
    '<div class="rvLog" id="rvLog">' + logHtml + '</div>';

  $('#rvBack').onclick = function () { stopAuto(); S.sel = -1; renderList(); };
  $('#rvFirst').onclick = function () { stopAuto(); setStep(0); };
  $('#rvPrev').onclick = function () { stopAuto(); setStep(S.step - 1); };
  $('#rvNext').onclick = function () { stopAuto(); setStep(S.step + 1); };
  $('#rvLast').onclick = function () { stopAuto(); setStep(S.maxStep); };
  // input이 아니라 change — 매 틱 전체 재렌더가 드래그 중인 range를 갈아치워 드래그가 끊긴다
  $('#rvRange').onchange = function () { stopAuto(); setStep(+this.value); };
  $('#rvAuto').onclick = function () {
    if (S.playing) { stopAuto(); renderRound(); return; }
    S.playing = setInterval(function () {
      if (S.step >= S.maxStep) { stopAuto(); renderRound(); return; }
      setStep(S.step + 1);
    }, 700);
    renderRound();
  };
  // scrollIntoView는 창까지 스크롤해 손패가 시야에서 벗어난다 — 로그 상자 안에서만 따라가게
  var lg = $('#rvLog'), cur = lg && lg.querySelector('.ln.cur');
  if (cur) lg.scrollTop = Math.max(0, cur.offsetTop - (lg.clientHeight - cur.offsetHeight) / 2);
  root.querySelectorAll('.rvLog .ln').forEach(function (el) {
    el.onclick = function () { stopAuto(); setStep(+el.dataset.i); };
  });
}

document.addEventListener('keydown', function (e) {
  if (S.sel < 0) return;
  if (e.key === 'ArrowRight') { stopAuto(); setStep(S.step + 1); }
  else if (e.key === 'ArrowLeft') { stopAuto(); setStep(S.step - 1); }
  else if (e.key === 'Escape') { stopAuto(); S.sel = -1; renderList(); }
});

function boot() {
  root.innerHTML = '<div class="rvEmpty">불러오는 중…</div>';
  loadSources().then(loadRecords).then(renderList);
}
boot();
})();
