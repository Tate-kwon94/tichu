/* 티츄 UI — redacted 스냅샷만 소비 (온라인/오프라인 공용) */
/* global TichuCore, TichuBots, STR, OfflineSession, OnlineSession */
(function () {
'use strict';
var C = TichuCore;
var appEl, toastEl, toastTimer;

var state = {
  screen: 'home',        // home | game
  name: '',
  urlRoom: '',
  session: null,
  welcomed: false,
  pendingWelcome: null,
  snap: null,
  sel: {},               // 선택된 카드 id → true
  exch: [null, null, null], // 교환 슬롯 (왼쪽/파트너/오른쪽 = rel 1/2/3)
  wishCards: null,       // 소원 선택 대기 중인 플레이 카드
  help: false,
  helpFromModal: false,  // 모달 위에 띄운 도움말인지 (닫으면 원래 모달로)
  replaced: false,
  stats: null,           // 전적 { loaded, detail, board }
  office: false,         // 엑셀 위장 모드
  xlStyle: '',           // 위장 카드 시안: ''=기존 카드형, '1'=셀+무늬, '2'=셀+문자코드, '3'=셀+숫자만
  ghost: 0,              // 반투명 모드 0=끔 1=연하게 2=아주 연하게 (위장과 병행 가능)
  lastDeclKey: null,     // 마지막으로 알린 티츄/라지 선언 (중복 토스트 방지)
  passId: null,          // 마지막 패스 actionId — 경합 거부 시 자동 재시도
  retryPass: false,      // 새 상태 도착 시 패스 1회 재전송
  composing: false,      // 한글 IME 조합 중 (재렌더가 조합을 끊지 않게)
  renderQueued: false,   // 조합·타이핑 중 미뤄둔 렌더
  lastTypeAt: 0,         // 마지막 키 입력 시각 — 조합 이벤트가 불안정한 IME 안전망
  tichuArmed: 0,         // 티츄 2탭 확인: 1차 탭 시각(ms)
  lobbyTarget: 1000,     // 로비에서 고른 목표 점수
  showHistory: false,    // 점수 히스토리 패널
  chat: [],              // 채팅 메시지 (최근 80개)
  unread: 0,
  chatOpen: false,
  chatDraft: '',         // 작성 중 초안 (재렌더에도 보존)
  bubbles: {},           // seat → {text, until} 말풍선
  roomList: [],          // 홈 화면 열린 방 목록
  botLevel: 'super2',    // 봇 단수 (super=1단 | super2=2단 | devil) — 기본 최고단(2단)
  conn: { s: '', mode: '' }
};
var tichuArmTimer = null;

// ---------- 유틸 ----------
function $(s) { return document.querySelector(s); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function toast(msg, opts) {
  opts = opts || {};
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  toastEl.classList.toggle('warn', !!opts.warn);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove('on'); toastEl.classList.remove('warn'); }, opts.ms || 2200);
}
function game() { return state.snap && state.snap.game; }
function mySeat() { return state.snap ? state.snap.youSeat : -1; }
function myTeamKey() { return C.teamOf(mySeat()) === 0 ? 'teamA' : 'teamB'; }
function oppTeamKey() { return C.teamOf(mySeat()) === 0 ? 'teamB' : 'teamA'; }
function seatName(s) {
  if (!state.snap) return '';
  var rs = state.snap.roomSeats[s];
  if (!rs || !rs.occupied) return STR.empty;
  return rs.name || (rs.isBot ? STR.bot : '?');
}
function relSeat(rel) { return (mySeat() + rel) % 4; }
// 티츄/라지 티츄 선언을 눈에 띄게 알림 — 새 선언일 때 한 번만 토스트
function announceDeclare(snap) {
  var g = snap && snap.game;
  var la = g && g.lastAction;
  if (la && (la.kind === 'tichu' || la.kind === 'grand') && la.seat != null) {
    var key = la.kind + ':' + la.seat + ':' + g.round;
    if (key !== state.lastDeclKey) {
      state.lastDeclKey = key;
      var who = la.seat === snap.youSeat ? STR.you : seatName(la.seat);
      var what = la.kind === 'grand' ? STR.grandBadge + ' 티츄' : STR.tichuBadge + ' 티츄';
      var em = state.office ? '' : '🔴 ';
      toast(em + who + ' — ' + what + ' 선언!', { ms: 3500 });
      if (la.seat !== snap.youSeat && navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
    }
  } else if (la && la.kind !== 'tichu' && la.kind !== 'grand') {
    state.lastDeclKey = null; // 다음 선언(같은 사람이라도)을 다시 알릴 수 있게 리셋
  }
}
function isHost() { return state.snap && state.snap.hostSeat === mySeat(); }
function myTurn() {
  var g = game();
  return g && g.phase === 'play' && g.turnSeat === mySeat() && !seatInfo(mySeat()).out;
}
function seatInfo(s) {
  var g = game();
  return (g && g.seats[s]) || { handCount: 0, tichu: 'none', out: false, outRank: null };
}
function selectedIds() {
  var g = game();
  var hand = g && g.you ? g.you.hand : [];
  return hand.filter(function (id) { return state.sel[id]; });
}

// ---------- 카드 렌더 ----------
var SUIT_COLOR = { S: '#23262e', H: '#cf3434', D: '#2a62c4', C: '#1c7e46' };
// 위장 모드도 4색 구분 — 엑셀 조건부 서식 색감(검정/빨강/파랑/초록)이라 시트 위에서 자연스러움
var SUIT_COLOR_OFFICE = { S: '#222222', H: '#c00000', D: '#2a62c4', C: '#217346' };
var SP_INFO = { MJ: ['1', '🐦', 'spMJ', '마작'], DG: ['', '🐶', 'spDG', '개'], PH: ['', '🔥', 'spPH', '불사조'], DR: ['', '🐉', 'spDR', '용'] };
var SP_OFFICE = { MJ: '1', DG: 'DOG', PH: 'PHX', DR: 'DRG' };
// 특수 카드 일러스트 (인라인 SVG — 외부 리소스 0 유지)
var SP_SVG = {
  // 마작: 참새
  MJ: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M10 26 Q3 28 1.5 33 Q8 33.5 12.5 29 Z" fill="#7a5e2a"/>' +
    '<ellipse cx="18" cy="24" rx="10.5" ry="8.3" fill="#9c7b3c"/>' +
    '<path d="M13 22 Q18.5 14.5 27 18.5 Q24 27 13 25.5 Z" fill="#c2a25e"/>' +
    '<circle cx="26.5" cy="14" r="6" fill="#b08e49"/>' +
    '<circle cx="28.8" cy="12.5" r="1.25" fill="#26200f"/>' +
    '<path d="M32.2 13.2 L38 15 L32.2 16.6 Z" fill="#e2a93b"/>' +
    '<path d="M21 31.5 l-1.4 4 M25.5 31.5 l-1.4 4" stroke="#6e5526" stroke-width="1.6" stroke-linecap="round" fill="none"/>' +
    '</svg>',
  // 개
  DG: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M10 9 Q4 5.5 4.5 14 Q5 19.5 11 18 Z" fill="#7c5a33"/>' +
    '<path d="M30 9 Q36 5.5 35.5 14 Q35 19.5 29 18 Z" fill="#7c5a33"/>' +
    '<circle cx="20" cy="21" r="11.2" fill="#c79a63"/>' +
    '<ellipse cx="20" cy="26.2" rx="6.4" ry="5" fill="#ecdcc3"/>' +
    '<circle cx="15.4" cy="17.6" r="1.7" fill="#2a1f14"/>' +
    '<circle cx="24.6" cy="17.6" r="1.7" fill="#2a1f14"/>' +
    '<ellipse cx="20" cy="24" rx="2.5" ry="1.9" fill="#3a2a1a"/>' +
    '<path d="M20 25.8 Q20 28.8 16.6 29.3 M20 25.8 Q20 28.8 23.4 29.3" stroke="#3a2a1a" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
    '</svg>',
  // 불사조: 3겹 불꽃새
  PH: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M20 36.5 C7.5 30.5 8 17 15.5 8.5 C14.5 16 18.5 18 19.5 11.5 C20.5 16 23.5 17 23.5 10 C26 14.5 24.5 18 28 13.5 C34 20 32.5 30.5 20 36.5 Z" fill="#e2521f"/>' +
    '<path d="M20 33.5 C12 28.8 13 20.5 17.2 15 C17.2 20 20.2 21 20.7 16 C22.4 20 24.4 20 24.9 17 C28.4 22 27 29 20 33.5 Z" fill="#f59b3e"/>' +
    '<path d="M20 30.2 C16.2 27.4 16.7 22.5 19.2 19.5 C19.6 23.2 22 23.2 21.6 20.4 C23.9 23.2 23 28 20 30.2 Z" fill="#ffd34d"/>' +
    '</svg>',
  // 용: S커브 몸통 + 큰 머리·뿔2·콧등·눈
  DR: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M6 33.5 C10 25 23.5 28.5 26.5 19.5 C28 15 26 12.5 22.5 12.5" stroke="#1f7a4f" stroke-width="5.4" fill="none" stroke-linecap="round"/>' +
    '<path d="M6.5 34 L2 36 L4 31.5 Z" fill="#15573a"/>' +
    '<path d="M12.5 27.8 l2.1 -3.6 1.7 2.9 Z M18 27.2 l2.1 -3.6 1.7 2.9 Z M23.4 23.6 l2 -3.5 1.6 2.8 Z" fill="#15573a"/>' +
    '<circle cx="17.5" cy="11.8" r="6.4" fill="#2e8b57"/>' +
    '<ellipse cx="11.2" cy="13.6" rx="3.8" ry="2.7" fill="#3da06b"/>' +
    '<circle cx="9.8" cy="12.8" r="0.8" fill="#15462e"/>' +
    '<path d="M8.2 15.2 Q11.5 17 15 16.2" stroke="#15462e" stroke-width="1.2" fill="none" stroke-linecap="round"/>' +
    '<circle cx="16.8" cy="9.8" r="2" fill="#fff"/>' +
    '<circle cx="17.2" cy="10" r="1.05" fill="#1b130a"/>' +
    '<path d="M20 5.8 Q21 1.8 24.5 1.5 Q23.8 5 21.8 6.8 Z" fill="#c9a227"/>' +
    '<path d="M23 7.6 Q25.5 4.8 28.5 5.2 Q27 8.2 24.8 9.4 Z" fill="#c9a227"/>' +
    '</svg>'
};
function cardHtml(id, cls, attrs) {
  cls = cls || '';
  attrs = attrs || '';
  if (C.isSpecial(id)) {
    if (state.office) { // 위장 모드: 데이터 코드처럼
      return '<div class="card sp ' + cls + '" data-card="' + id + '" ' + attrs + '>' +
        '<span class="cr">' + SP_OFFICE[id] + '</span></div>';
    }
    var sp = SP_INFO[id];
    return '<div class="card sp ' + sp[2] + ' ' + cls + '" data-card="' + id + '" ' + attrs + '>' +
      '<span class="spBand">' + sp[3] + '</span>' +
      '<span class="spArt">' + SP_SVG[id] + '</span>' +
      (id === 'MJ' ? '<span class="spRank">1</span>' : '') +
      '</div>';
  }
  var r = C.rankOf(id), su = id[0];
  var col = (state.office ? SUIT_COLOR_OFFICE : SUIT_COLOR)[su];
  if (state.office && state.xlStyle === '3') { // 셀+숫자만 — 무늬는 색으로만 구분
    return '<div class="card ' + cls + '" data-card="' + id + '" ' + attrs + ' style="color:' + col + '">' +
      '<span class="cr">' + C.rankLabel(r) + '</span></div>';
  }
  if (state.office && state.xlStyle === '2') { // 셀+문자코드 — 무늬를 S/H/D/C 글자로
    return '<div class="card ' + cls + '" data-card="' + id + '" ' + attrs + ' style="color:' + col + '">' +
      '<span class="cr">' + C.rankLabel(r) + '<span class="su">' + su + '</span></span></div>';
  }
  return '<div class="card ' + cls + '" data-card="' + id + '" ' + attrs + ' style="color:' + col + '">' +
    '<span class="cr">' + C.rankLabel(r) + '<span class="su">' + C.SUIT_SYMBOL[su] + '</span></span>' +
    '<span class="cp">' + C.SUIT_SYMBOL[su] + '</span>' +
    '<span class="cr flip">' + C.rankLabel(r) + '<span class="su">' + C.SUIT_SYMBOL[su] + '</span></span>' +
    '</div>';
}
function comboLabel(combo) {
  if (!combo) return '';
  // 특수 싱글 먼저 — 용/불사조는 "싱글 X"식 표기가 오해를 부름
  if (combo.type === 'single' && typeof combo.rank === 'number') {
    if (combo.rank >= 15) return '용';
    if (combo.rank === 1.5) return '불사조'; // 턴 시작 리드 — 괄호 표기 불필요
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
// "지금 깔린 조합을 이기려면" 안내 문구 — 용/불사조/폭탄은 일반 문구가 틀림
function beatHint(cur) {
  if (C.isBomb(cur.type)) return comboLabel(cur) + '이 깔림, 더 큰 폭탄만 가능';
  if (cur.type === 'single' && typeof cur.rank === 'number') {
    if (cur.rank >= 15) return '용은 폭탄으로만 이길 수 있어요';
    if (cur.rank % 1 !== 0) {
      if (cur.rank >= 14) return comboLabel(cur) + ', 용 또는 폭탄만 가능'; // A 위 불사조
      return comboLabel(cur) + ', ' + C.rankLabel(Math.ceil(cur.rank)) + ' 이상 싱글로';
    }
  }
  return comboLabel(cur) + '보다 높게';
}

// ---------- 선택 평가 ----------
function evalSelection() {
  var g = game();
  if (!g || g.phase !== 'play') return null;
  var ids = selectedIds();
  if (!ids.length) return null;
  var combo = C.identify(ids);
  if (!combo) return { legal: false, label: '유효하지 않은 조합' };
  var cur = g.currentCombo;
  if (combo.type === 'single' && combo.rank === 'PH') {
    if (cur) {
      if (C.isBomb(cur.type) || cur.type !== 'single' || cur.rank >= 15) return { legal: false, label: '불사조로 이길 수 없음' };
      combo = { type: 'single', rank: cur.rank + 0.5, length: 1 };
    } else combo = { type: 'single', rank: 1.5, length: 1 };
    if (myTurn()) return { legal: true, combo: combo, label: comboLabel(combo) + ' 싱글' };
    return { legal: false, label: '차례가 아닙니다' };
  }
  var label = comboLabel(combo);
  if (combo.type === 'dog') {
    if (myTurn() && !cur) return { legal: true, combo: combo, label: '개 — 파트너에게 선' };
    return { legal: false, label: '개는 선일 때만' };
  }
  if (myTurn()) {
    if (cur && !C.beats(combo, cur)) return { legal: false, label: label + ' — 못 이깁니다' };
    if (g.you.mustFulfillWish && g.wish) {
      var hasWish = ids.some(function (id) { return !C.isSpecial(id) && C.rankOf(id) === g.wish; });
      if (!hasWish) return { legal: false, label: '소원(' + C.rankLabel(g.wish) + ') 포함 필요' };
    }
    return { legal: true, combo: combo, label: label };
  }
  if (C.isBomb(combo.type) && cur && C.beats(combo, cur)) {
    return { legal: true, combo: combo, label: label + ' — 끼어들기!' };
  }
  return { legal: false, label: '차례가 아닙니다' };
}
function availableBomb() {
  var g = game();
  if (!g || g.phase !== 'play' || myTurn() || !g.currentCombo || !g.you) return null;
  if (seatInfo(mySeat()).out) return null;
  var ms = C.genMoves(g.you.hand, g.currentCombo, null).moves.filter(function (m) { return C.isBomb(m.combo.type); });
  if (!ms.length) return null;
  ms.sort(function (a, b) { return a.combo.rank - b.combo.rank; });
  return ms[0];
}

// ---------- 세션 ----------
var handlers = {
  onState: function (snap) {
    state.snap = snap;
    state.screen = 'game';
    announceDeclare(snap);
    reconcile();
    render();
    // 패스가 봇 수와 경합해 STALE로 거부됐다면, 새 상태에서 여전히 유효할 때 1회 자동 재전송
    if (state.retryPass) {
      state.retryPass = false;
      var g2 = game();
      if (g2 && myTurn() && g2.currentCombo && !(g2.you && g2.you.mustFulfillWish)) {
        var pa2 = { type: 'pass_turn' };
        send(pa2);
        state.passId = pa2.actionId || null;
      }
    }
  },
  onWelcome: function (msg) {
    state.welcomed = true;
    var cb = state.pendingWelcome;
    state.pendingWelcome = null;
    if (!msg.snapshot) {
      if (cb) cb();
      else if (state.urlRoom && state.name) joinRoom(state.urlRoom);
      else { state.screen = 'home'; render(); }
      requestRooms();
    }
  },
  onAck: function (m) {
    if (m.rooms) { // list_rooms 응답
      state.roomList = m.rooms;
      if (state.screen === 'home') render();
      return;
    }
    if (!m.ok && m.error && m.error.code === 'STALE_VERSION' && state.passId && m.actionId === state.passId) {
      state.retryPass = true; // 다음 상태 도착 시 자동 재패스 (봇 수와의 경합 해소)
      state.passId = null;
      return;
    }
    if (!m.ok && m.error && m.error.code !== 'STALE_VERSION') {
      // 규칙에 의한 거부는 "왜 안 되는지"를 놓치지 않게 길고 눈에 띄게
      var ruleCodes = ['WISH_REQUIRED', 'COMBO_TOO_LOW', 'CANNOT_PASS_LEAD', 'NOT_YOUR_TURN', 'CARDS_NOT_IN_HAND'];
      var isRule = ruleCodes.indexOf(m.error.code) >= 0;
      toast(m.error.message || m.error.code, isRule ? { ms: 4500, warn: true } : null);
      render();
    }
  },
  onChat: function (m) {
    state.chat.push({ seat: m.seat, name: m.name, text: m.text, ts: Date.now() });
    if (state.chat.length > 80) state.chat.shift();
    if (!state.chatOpen) state.unread = Math.min(99, state.unread + 1);
    if (m.seat !== mySeat()) {
      state.bubbles[m.seat] = { text: m.text, until: Date.now() + 4500 };
      setTimeout(function () { render(); }, 4600); // 말풍선 자동 소멸
    }
    render();
  },
  onReplaced: function () { state.replaced = true; render(); },
  onLeft: function (reason) {
    state.screen = 'home';
    state.snap = null;
    state.chat = []; state.unread = 0; state.chatOpen = false; state.bubbles = {};
    toast(reason === 'kicked' ? STR.kicked : STR.roomClosed);
    render();
    requestRooms();
  },
  onStatus: function (s, mode) {
    state.conn = { s: s, mode: mode };
    renderConn();
    // 홈에서 연결 안내 문구("연결 중…")가 갱신되도록
    if (state.screen === 'home' && !state.welcomed) render();
  },
  onStale: function () { toast(STR.refreshNew); }
};

function destroySession() {
  if (state.session) { state.session.destroy(); state.session = null; }
  state.welcomed = false;
  state.snap = null;
  state.chat = [];
  state.unread = 0;
  state.chatOpen = false;
  state.bubbles = {};
}
function ensureOnline(cb) {
  saveName();
  if (!state.name) { toast('닉네임을 입력하세요'); return; }
  if (state.session && state.session.mode === 'online') {
    if (state.welcomed) cb();
    else state.pendingWelcome = cb;
    return;
  }
  destroySession();
  state.pendingWelcome = cb;
  state.session = OnlineSession.create(handlers);
  state.session.connect(state.name);
}
var superHyCache = null;   // 초고수 신경망 — 첫 사용 시 가중치(~3MB) 내려받아 캐시
var declNetCache = null;   // 선언 신경망(~130KB)
function startSolo(resume) {
  destroySession();
  if (!resume) OfflineSession.clearSave();
  if (state.botLevel === 'super' || state.botLevel === 'super2') {
    var danKey = state.botLevel, danNum = danKey === 'super2' ? '2단' : '1단';
    if (superHyCache) {
      state.session = OfflineSession.create(handlers, resume, danKey, superHyCache, declNetCache);
      state.conn = { s: '', mode: 'offline' };
      return;
    }
    toast(danNum + ' 봇 준비 중…', { ms: 4000 });
    Promise.all([
      fetch('shared/weights-super.json').then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }),
      fetch('shared/weights-declare.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ])
      .then(function (ws) {
        superHyCache = TichuHybrid.create(TichuNet.create(ws[0]));
        if (ws[1]) declNetCache = TichuDeclare.create(ws[1]);
        state.session = OfflineSession.create(handlers, resume, danKey, superHyCache, declNetCache);
        state.conn = { s: '', mode: 'offline' };
      })
      .catch(function () {
        toast(danNum + ' 봇 로드 실패 — 기본 봇으로 시작합니다', { ms: 4000, warn: true });
        state.session = OfflineSession.create(handlers, resume, 'hard');
        state.conn = { s: '', mode: 'offline' };
      });
    return;
  }
  state.session = OfflineSession.create(handlers, resume, state.botLevel);
  state.conn = { s: '', mode: 'offline' };
}
function requestRooms() {
  if (state.screen === 'home' && isOnline() && state.welcomed) send({ type: 'list_rooms' });
}
function joinRoom(code) {
  ensureOnline(function () {
    state.session.send({ type: 'join_room', code: code, name: state.name });
  });
}
function send(a) { if (state.session) state.session.send(a); }
function saveName() {
  var inp = $('#nick');
  if (inp) state.name = inp.value.trim().slice(0, 12);
  if (state.name) try { localStorage.setItem('tichu.name', state.name); } catch (e) {}
}
function reconcile() {
  var g = game();
  var hand = g && g.you ? g.you.hand : [];
  var inHand = {};
  hand.forEach(function (id) { inHand[id] = true; });
  Object.keys(state.sel).forEach(function (id) { if (!inHand[id]) delete state.sel[id]; });
  if (!g || g.phase !== 'exchange') state.exch = [null, null, null];
  else state.exch = state.exch.map(function (id) { return id && inHand[id] ? id : null; });
  if (!g || g.phase !== 'play') state.wishCards = null;
}

// ---------- 렌더 ----------
var lastMyTurn = false;
var renderFlushTimer = null;
function typingNow() { // 텍스트 입력창에 포커스 + 최근 350ms 내 키 입력
  var ae = document.activeElement;
  if (!(ae && (ae.id === 'chatIn' || ae.id === 'nick' || ae.id === 'code'))) return false;
  return Date.now() - state.lastTypeAt < 350;
}
// 조합·타이핑 중 보호할 입력창 — innerHTML 전체 교체가 이 노드를 갈아치우면 IME 조합이 끊김
function editingEl() {
  if (!(state.composing || typingNow())) return null;
  var ae = document.activeElement;
  if (ae && (ae.id === 'chatIn' || ae.id === 'nick' || ae.id === 'code') && appEl.contains(ae)) return ae;
  return null;
}
// 부분 교체 사전 검사: keepEl까지의 조상 체인에서 자식 수·태그가 새 렌더와 일치해야 함
// (채팅 패널 개폐·모달 등장 등 구조 변화 시 false → 호출부가 유예 폴백)
function morphOk(oldP, newP, keepEl) {
  if (oldP.childNodes.length !== newP.childNodes.length) return false;
  var oc = oldP.childNodes;
  for (var i = 0; i < oc.length; i++) {
    var o = oc[i];
    if (o.nodeType === 1 && o.contains(keepEl)) { // contains는 자기 자신 포함
      if (o === keepEl) return true;
      var n = newP.childNodes[i];
      if (!(n && n.nodeType === 1 && o.nodeName === n.nodeName)) return false;
      return morphOk(o, n, keepEl);
    }
  }
  return false;
}
// 부분 교체 실행: keepEl(입력창)만 그대로 두고 형제 노드는 새 렌더 결과로 통째 교체
// → 조합을 안 끊으면서 채팅 목록·게임 화면은 실시간 갱신
function morphApply(oldP, newP, keepEl) {
  var oArr = Array.prototype.slice.call(oldP.childNodes);
  var nArr = Array.prototype.slice.call(newP.childNodes);
  for (var i = 0; i < oArr.length; i++) {
    var o = oArr[i], n = nArr[i];
    if (o.nodeType === 1 && o.contains(keepEl)) {
      if (o === keepEl) continue; // 입력창 자체는 절대 건드리지 않음
      o.className = (n.nodeType === 1 && n.className) || '';
      morphApply(o, n, keepEl);
    } else {
      oldP.replaceChild(n, o);
    }
  }
}
function render() {
  // 내 차례가 막 됐는데 채팅이 가리고 있으면(입력 중이 아닐 때) 자동으로 닫기
  var mt = myTurn();
  if (mt && !lastMyTurn && state.chatOpen && !(state.chatDraft && state.chatDraft.trim())) {
    state.chatOpen = false;
  }
  // 입력 중 재렌더돼도 입력값·포커스 유지 (채팅/닉네임/방코드)
  var keep = null;
  var ae = document.activeElement;
  if (ae && (ae.id === 'chatIn' || ae.id === 'nick' || ae.id === 'code')) {
    keep = { id: ae.id, v: ae.value, s: ae.selectionStart };
  }
  // 채팅 스크롤: 바닥 근처일 때만 바닥 고정 (옛 메시지 읽는 중엔 위치 유지)
  var stickChat = true, prevChatTop = 0;
  var oldList = $('#chatList');
  if (oldList) {
    stickChat = oldList.scrollHeight - oldList.scrollTop - oldList.clientHeight < 40;
    prevChatTop = oldList.scrollTop;
  }
  document.body.classList.toggle('office', !!state.office);
  document.body.classList.toggle('xl1', !!state.office && state.xlStyle === '1');
  document.body.classList.toggle('xl2', !!state.office && state.xlStyle === '2');
  document.body.classList.toggle('xl3', !!state.office && state.xlStyle === '3');
  document.body.classList.toggle('ghost1', state.ghost === 1);
  document.body.classList.toggle('ghost2', state.ghost === 2);
  applyDisguise();
  var inner = state.screen === 'home' ? renderHome() : renderGame();
  if (state.office) inner = officeTop() + '<div class="officeBody">' + inner + '</div>' + officeBottom();
  // 한글 조합·타이핑 중: 입력창 노드만 남기고 나머지 영역을 부분 교체 — 채팅·게임은 실시간 갱신 유지
  var editing = editingEl();
  if (editing) {
    var tmp = document.createElement('div');
    tmp.innerHTML = inner;
    if (morphOk(appEl, tmp, editing)) {
      morphApply(appEl, tmp, editing);
      renderConn();
      fitHand();
      var cl0 = $('#chatList');
      if (cl0) cl0.scrollTop = stickChat ? cl0.scrollHeight : prevChatTop;
      if (mt && !lastMyTurn && navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
      lastMyTurn = mt;
      return;
    }
    // 구조가 달라짐(모달·패널 개폐, 화면 전환 등) → 이번 렌더만 유예 후 재시도.
    // 조합 중에도 반드시 타이머를 건다 — compositionend가 유실되는 변칙 IME에서
    // 영구 멈춤 방지: 3초 이상 키 입력이 없으면 조합이 죽은 것으로 보고 강제 플러시.
    state.renderQueued = true;
    clearTimeout(renderFlushTimer);
    renderFlushTimer = setTimeout(function retryFlush() {
      if (!state.renderQueued) return;
      if (state.composing && Date.now() - state.lastTypeAt < 3000) {
        renderFlushTimer = setTimeout(retryFlush, 500); // 실제 조합 진행 중 — 대기
        return;
      }
      state.composing = false;
      state.renderQueued = false;
      render();
    }, 400);
    return;
  }
  appEl.innerHTML = inner;
  renderConn();
  fitHand();
  if (keep) {
    var ki = document.getElementById(keep.id);
    if (ki) { ki.value = keep.v; ki.focus(); try { ki.setSelectionRange(keep.s, keep.s); } catch (e) {} }
  }
  var cl = $('#chatList');
  if (cl) cl.scrollTop = stickChat ? cl.scrollHeight : prevChatTop;
  // 내 차례로 막 전환되면 살짝 진동 (모바일 — iOS는 미지원이라 채팅 자동닫기가 주 신호)
  if (mt && !lastMyTurn && navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
  lastMyTurn = mt;
}

// 위장 모드 ON/OFF에 맞춰 탭 제목·파비콘·테마색 교체
function applyDisguise() {
  var title = state.office ? '통합 문서1 - Excel' : '티츄';
  if (document.title !== title) document.title = title;
  var theme = state.office ? '#f3f2f1' : '#14352a';
  var mt = document.querySelector('meta[name="theme-color"]');
  if (mt) mt.setAttribute('content', theme);
  var icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    var want = state.office ? 'icons/xlsx.svg' : 'icons/icon.svg';
    if (icon.getAttribute('href') !== want) icon.setAttribute('href', want);
  }
}

// 위장 카드 표시 버튼 — 위장 모드에서만 노출: 카드형→셀(무늬)→숫자 순환 (사용자 선택 반영)
function xlStyleBtnHtml() {
  if (!state.office) return '';
  var lbl = state.xlStyle === '1' ? '셀' : state.xlStyle === '3' ? '숫자' : '카드';
  return '<button class="btn small ghost" data-act="xl-style" title="위장 카드 표시">' + lbl + '</button>';
}

// 반투명 버튼 — 누를 때마다 끔→연하게→아주 연하게 순환
function ghostBtnHtml() {
  var icon = state.ghost === 0 ? '◐' : state.ghost === 1 ? '◑' : '○';
  return '<button class="btn small ghost" data-act="ghost-toggle" title="' + STR.ghostBtn + '">' + icon + '</button>';
}

// ---------- 엑셀 위장 모드 장식 ----------
function officeTop() {
  var cols = '';
  'ABCDEFGHIJ'.split('').forEach(function (c) { cols += '<span>' + c + '</span>'; });
  return '<div class="xl xlTitle">자동 저장 <span class="xlOnOff">켬</span><span class="xlDoc">통합 문서1 - Excel</span></div>' +
    '<div class="xl xlMenu">파일&nbsp;&nbsp;홈&nbsp;&nbsp;삽입&nbsp;&nbsp;페이지 레이아웃&nbsp;&nbsp;수식&nbsp;&nbsp;데이터&nbsp;&nbsp;검토&nbsp;&nbsp;보기</div>' +
    '<div class="xl xlFormula"><span class="xlName">B4</span><span class="xlFx">fx</span><span class="xlInput">=SUM(B2:B3)</span></div>' +
    '<div class="xl xlCols">' + cols + '</div>';
}
function officeBottom() {
  return '<div class="xl xlTabs"><span class="xlTab on">Sheet1</span><span class="xlTab">집계</span><span class="xlTab">백업</span>' +
    '<span class="xlPlus">+</span><span class="xlReady">준비</span></div>';
}

// 손패가 화면 폭에 항상 다 들어오도록 겹침 간격을 카드 수에 맞춰 계산
// (가운데 정렬 + 넘침 조합은 왼쪽 카드가 잘리고 스크롤도 닿지 않는 문제가 있음)
function fitHand() {
  if (state.office && state.xlStyle) return; // 셀형 시안은 겹침 없이 줄바꿈 배치
  var hand = appEl.querySelector('.hand');
  if (!hand) return;
  var cards = hand.querySelectorAll('.card');
  var n = cards.length;
  if (n < 2) return;
  var W = cards[0].offsetWidth || 52;
  var avail = hand.clientWidth - 14; // 좌우 패딩 여유
  var s = Math.floor((avail - W) / (n - 1)); // 카드당 보이는 폭
  s = Math.max(12, Math.min(30, s));
  for (var i = 1; i < n; i++) cards[i].style.marginLeft = (s - W) + 'px';
}
function renderConn() {
  var el = $('#connTxt'), dot = $('#connDot');
  if (!el) return;
  var map = { connecting: STR.connecting, reconnecting: STR.reconnecting, connected: STR.connected, offline: STR.offline };
  var txt = state.conn.mode === 'offline' ? '혼자 연습' : (map[state.conn.s] || '');
  if (state.conn.s === 'connected' && state.conn.mode && state.conn.mode !== 'ws' && state.conn.mode !== 'offline') txt += ' (' + state.conn.mode + ')';
  el.textContent = txt;
  if (dot) dot.className = 'connDot' + (state.conn.s === 'connected' || state.conn.mode === 'offline' ? '' : state.conn.s === 'offline' ? ' bad' : ' warn');
}

function renderHome() {
  var canResume = OfflineSession.hasSave();
  return '<div class="home">' +
    '<h1>' + STR.appName + '</h1>' +
    '<div class="sub">' + STR.subtitle + '</div>' +
    '<input id="nick" maxlength="12" placeholder="' + STR.nickname + '" value="' + esc(state.name) + '">' +
    roomListHtml() +
    '<button class="btn primary" data-act="create">' + STR.createRoom + '</button>' +
    '<div class="codeRow">' +
      '<input id="code" maxlength="4" placeholder="' + STR.roomCode + '" value="' + esc(state.urlRoom) + '" autocapitalize="characters">' +
      '<button class="btn" data-act="join">' + STR.joinRoom + '</button>' +
    '</div>' +
    '<button class="btn ghost" data-act="solo">' + STR.solo + '</button>' +
    (canResume ? '<button class="btn ghost" data-act="solo-resume">' + STR.soloResume + '</button>' : '') +
    botLevelPicker(true) +
    '<div class="row"><button class="btn ghost grow" data-act="stats-open">' + STR.statsBtn + '</button>' +
    '<button class="btn ghost grow" data-act="help-open">' + STR.rulesBtn + '</button></div>' +
    '<div class="row"><button class="btn ghost grow" data-act="office-toggle">' + (state.office ? '위장 끄기' : '▦ 위장') + '</button>' +
    xlStyleBtnHtml() +
    ghostBtnHtml() + '</div>' +
    '<div class="connStatus"><span id="connTxt"></span></div>' +
  '</div>' + (state.help ? helpModal() : '') + (state.statsOpen ? statsModal() : '');
}

// 열린 방 목록 — 홈의 중심. 연결 중에도 영역을 보여주고, 게임중 방도 표시(비활성)
function roomListHtml() {
  if (!(state.session && state.session.mode === 'online')) return '';
  var inner;
  if (!state.welcomed) {
    inner = '<div class="rlEmpty">' + (state.conn.s === 'offline'
      ? '서버에 연결할 수 없습니다 — 잠시 후 자동 재시도'
      : '서버 연결 중… (서버가 자고 있으면 30초쯤 걸려요)') + '</div>';
  } else {
    var L = state.roomList || [];
    var open = L.filter(function (r) { return !r.inGame && r.occupied < 4; });
    // 게임 중이라도 봇 자리가 있으면 이어받기 가능(팅김·실수 퇴장 복구)
    var rejoin = L.filter(function (r) { return r.inGame && r.bots > 0; });
    var busy = L.filter(function (r) {
      return (r.inGame && !(r.bots > 0)) || (!r.inGame && r.occupied >= 4);
    });
    var rows = open.map(function (r) {
      return '<button class="roomRow" data-act="join-room" data-code="' + esc(r.code) + '">' +
        '<b>' + esc(r.host) + '</b>의 방' +
        '<span class="chip dim">' + r.occupied + '/4</span>' +
        '<span class="grow"></span><span class="chip gold">입장 ›</span></button>';
    }).join('') + rejoin.map(function (r) {
      return '<button class="roomRow" data-act="join-room" data-code="' + esc(r.code) + '">' +
        '<b>' + esc(r.host) + '</b>의 방' +
        '<span class="chip dim">' + STR.inGameCount + '</span>' +
        '<span class="grow"></span><span class="chip gold">' + STR.rejoinChip + '</span></button>';
    }).join('') + busy.map(function (r) {
      return '<div class="roomRow rrBusy"><b>' + esc(r.host) + '</b>의 방' +
        '<span class="chip dim">' + (r.inGame ? STR.inGameCount : '4/4') + '</span>' +
        '<span class="grow"></span><span class="chip dim">' + esc(r.code) + '</span></div>';
    }).join('');
    inner = rows || '<div class="rlEmpty">' + STR.roomListEmpty + '</div>';
  }
  return '<div class="roomList"><div class="rlHead">' + STR.roomListTitle +
    '<span class="grow"></span><button class="btn small ghost" data-act="rooms-refresh">↻</button></div>' +
    inner + '</div>';
}
// full=true(혼자 연습): 4단계 전부. full=false(온라인 로비): 쉬움/보통만(서버 보호·공정성)
function botLevelPicker(full) {
  // 단(段) 체계: 1단(super)·2단(super2) — 승급전(직전 단 점수차 65% 격파) 통과 시 3단 추가.
  // 혼자 연습엔 악마(상대 패 열람, 등급 밖 치트) 포함. 온라인은 공정성 위해 단만.
  // (내부 봇키 super=1단, super2=2단. 쉬움/보통/고수 엔진은 코드에 남아있으나 피커에서 제외)
  var opts = full
    ? [['super', STR.botDan1], ['super2', STR.botDan2], ['devil', STR.botDevil]]
    : [['super', STR.botDan1], ['super2', STR.botDan2]];
  var lv = (['super2', 'devil'].indexOf(state.botLevel) >= 0 && (state.botLevel !== 'devil' || full)) ? state.botLevel : 'super';
  var hint = (lv === 'devil') ? STR.botHintDevil : (lv === 'super2') ? STR.botHintDan2 : STR.botHintDan1;
  return '<div class="targetRow botRow"><span class="targetLbl">' + STR.botLevelLbl + '</span>' +
    opts.map(function (o) {
      return '<button class="btn small ' + (lv === o[0] ? (o[0] === 'devil' ? 'danger' : 'gold') : 'ghost') +
        '" data-act="botlevel" data-l="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>' +
    '<div class="botHint">' + hint + '</div>' +
    '<div class="botHint" style="opacity:.6">' + STR.botHintDanNext + '</div>';
}

function renderGame() {
  var snap = state.snap;
  if (!snap) return renderHome();
  var html = snap.phase === 'lobby' ? renderLobby() : renderTable();
  if (state.chatOpen && isOnline()) html += chatPanel();
  html += renderModal();
  return html;
}
function isOnline() { return !!(state.session && state.session.mode === 'online'); }
function chatBtnHtml() {
  if (!isOnline()) return '';
  return '<button class="btn small ghost chatBtn" data-act="chat-open">' + (state.office ? '메모' : '💬') +
    (state.unread ? '<span class="unbadge">' + state.unread + '</span>' : '') + '</button>';
}
function chatPanel() {
  var rows = state.chat.map(function (m) {
    var mine = m.seat === mySeat();
    return '<div class="chatRow' + (mine ? ' mine' : '') + '"><b>' + esc(mine ? STR.you : m.name) + '</b>' + esc(m.text) + '</div>';
  }).join('');
  var presets = ['굿굿', 'ㅋㅋㅋ', '나이스~', '잠시만요!', '미안ㅠ', '빨리요!'].map(function (p) {
    return '<button class="btn small ghost" data-act="chat-preset" data-t="' + esc(p) + '">' + esc(p) + '</button>';
  }).join('');
  return '<div class="chatPanel">' +
    '<div class="row chatHead"><b>' + (state.office ? '메모' : STR.chat) + '</b>' +
    (myTurn() ? '<span class="chip gold" style="margin-left:8px">▶ 내 차례!</span>' : '') +
    '<span class="grow"></span>' +
    '<button class="btn small ghost" data-act="chat-close">✕</button></div>' +
    '<div class="chatList" id="chatList">' + (rows || '<div class="chatEmpty">' + STR.chatEmpty + '</div>') + '</div>' +
    '<div class="row chatPresets">' + presets + '</div>' +
    '<div class="row chatInRow"><input id="chatIn" maxlength="200" placeholder="' + STR.chatPlaceholder + '" autocomplete="off" value="' + esc(state.chatDraft || '') + '">' +
    '<button class="btn primary" data-act="chat-send">' + STR.chatSend + '</button></div>' +
    '</div>';
}
var lastChatSendAt = 0;
function sendChat(text) {
  text = String(text || '').trim();
  if (!text) return;
  // 서버 레이트리밋(0.6초)에 걸려 입력이 증발하지 않게 클라에서 선차단
  if (Date.now() - lastChatSendAt < 700) { toast('천천히 보내주세요'); return; }
  lastChatSendAt = Date.now();
  send({ type: 'chat', text: text });
  state.chatDraft = '';
  var el = $('#chatIn');
  if (el) el.value = '';
}

function renderLobby() {
  var snap = state.snap;
  var seats = '';
  for (var s = 0; s < 4; s++) {
    var rs = snap.roomSeats[s];
    var team = C.teamOf(s) === 0 ? 'teamA' : 'teamB';
    var me = s === mySeat();
    var inner = '<div class="nm">' + (rs.occupied ? esc(rs.name) : '<span style="opacity:.4">' + STR.empty + '</span>') +
      (rs.isBot ? ' <span class="chip dim">' + STR.bot + '</span>' : '') +
      (s === snap.hostSeat && rs.occupied && !rs.isBot ? ' <span class="chip gold">' + STR.host + '</span>' : '') +
      (me ? ' <span class="chip gold">' + STR.you + '</span>' : '') + '</div>';
    inner += '<div class="tag">' + (C.teamOf(s) === C.teamOf(mySeat()) ? STR.myTeam : STR.oppTeam) + ' 팀 · 좌석 ' + (s + 1) + '</div>';
    var btns = '<div class="row" style="margin-top:auto">';
    if (!rs.occupied) {
      btns += '<button class="btn small" data-act="sit" data-seat="' + s + '">' + STR.sit + '</button>';
      if (isHost()) btns += '<button class="btn small ghost" data-act="bot-add" data-seat="' + s + '">' + STR.addBot + '</button>';
    } else if (rs.isBot && isHost()) {
      btns += '<button class="btn small ghost" data-act="bot-del" data-seat="' + s + '">' + STR.removeBot + '</button>';
    } else if (!me && isHost() && rs.occupied && !rs.isBot) {
      btns += '<button class="btn small danger" data-act="kick" data-seat="' + s + '">' + STR.kick + '</button>';
    }
    btns += '</div>';
    seats += '<div class="seatCard ' + team + (me ? ' me' : '') + '">' + inner + btns + '</div>';
  }
  return '<div class="lobby">' +
    '<div class="row"><span class="connDot" id="connDot"></span><span id="connTxt" style="font-size:12px;opacity:.7"></span>' +
    '<span class="grow"></span>' +
    chatBtnHtml() +
    '<button class="btn small ghost" data-act="office-toggle" title="위장 모드">▦</button>' +
    xlStyleBtnHtml() +
    ghostBtnHtml() +
    '<button class="btn small ghost" data-act="leave">' + STR.leave + '</button></div>' +
    '<div class="codeBig">' + esc(snap.code || '') + '</div>' +
    '<button class="btn ghost" data-act="copy">' + STR.copyLink + '</button>' +
    '<div class="seatGrid">' + seats + '</div>' +
    '<div class="lobbyHint">' + STR.teamHint + '</div>' +
    (isHost()
      ? targetPicker() + botLevelPicker(false) + '<button class="btn primary" data-act="start">' + STR.start + ' (빈자리는 봇)</button>'
      : '<div class="lobbyHint">' + STR.waitingHost + '</div>') +
  '</div>';
}

function renderTable() {
  var snap = state.snap, g = game();
  if (!g) return '';
  var ms = mySeat();
  var sc = g.scores;
  var my = myTeamKey() === 'teamA' ? sc.teamA : sc.teamB;
  var op = myTeamKey() === 'teamA' ? sc.teamB : sc.teamA;

  // 헤더
  var html = '<div class="ghead">' +
    '<span class="connDot" id="connDot"></span>' +
    '<span class="score"><span class="a">' + STR.myTeam + ' ' + my + '</span> : <span class="b">' + op + ' ' + STR.oppTeam + '</span></span>' +
    '<span class="chip dim">' + g.round + 'R · ' + g.targetScore + '점</span>' +
    '<span class="grow"></span>' +
    '<span id="connTxt" style="font-size:11px;opacity:.6"></span>' +
    (snap.code ? '<span class="chip dim">' + esc(snap.code) + '</span>' : '') +
    chatBtnHtml() +
    '<button class="btn small ghost" data-act="office-toggle" title="위장 모드">▦</button>' +
    xlStyleBtnHtml() +
    ghostBtnHtml() +
    '<button class="btn small ghost" data-act="help-open">?</button>' +
    '<button class="btn small ghost" data-act="leave">' + STR.leave + '</button>' +
  '</div>';

  // 상대 패널 (왼쪽 / 파트너 / 오른쪽)
  html += '<div class="opps">';
  [1, 2, 3].forEach(function (rel) {
    var s = relSeat(rel);
    var rs = snap.roomSeats[s], si = seatInfo(s);
    var cls = 'opp' + (rel === 2 ? ' partner' : '') + (g.turnSeat === s && g.phase === 'play' ? ' turn' : '');
    var badges = '';
    if (si.tichu === 'grand') badges += '<span class="chip red">' + STR.grandBadge + '</span>';
    else if (si.tichu === 'tichu') badges += '<span class="chip red">' + STR.tichuBadge + '</span>';
    if (si.out) badges += '<span class="chip gold">' + STR.finishRank[si.outRank - 1] + '</span>';
    var minis = '';
    for (var i = 0; i < Math.min(si.handCount, 14); i++) minis += '<span class="mini"></span>';
    var offline = rs.occupied && !rs.isBot && !rs.connected;
    var hour = state.office ? '' : '⏳ ';
    var timerTxt = '';
    if (snap.botTimer && snap.botTimer.seat === s) timerTxt = '<div class="off">' + hour + Math.ceil(snap.botTimer.msLeft / 1000) + STR.botActsIn + '</div>';
    else if (offline) timerTxt = '<div class="off">' + STR.disconnected + '</div>';
    // 봇 차례엔 "생각 중" 표시 — 탐색이 1초 가까이 걸려 표시가 없으면 멈춘 줄 알고 다시 탭하게 된다
    else if (rs.isBot && g.turnSeat === s && g.phase === 'play' && !si.out) {
      timerTxt = '<div class="off thinking">' + STR.botThinking + '</div>';
    }
    // 게임 중 끊긴 사람을 방장이 봇으로 교체 (서버 kick_player가 봇 전환)
    if (offline && isHost()) timerTxt += '<button class="btn small ghost" data-act="kick-seat" data-seat="' + s + '" style="margin-top:4px">' + STR.toBot + '</button>';
    var partnerMark = rel === 2 ? (state.office ? '' : ' ♥') : '';
    var bub = state.bubbles[s];
    var bubbleHtml = (bub && bub.until > Date.now()) ? '<div class="bubble">' + esc(bub.text.slice(0, 60)) + '</div>' : '';
    html += '<div class="' + cls + '">' +
      '<div class="badges">' + badges + '</div>' +
      '<div class="nm">' + esc(rs.name) + partnerMark + '</div>' +
      '<div class="cnt">' + si.handCount + '장 · ' + si.trickPoints + STR.pilePts + '</div>' +
      '<div class="minis">' + minis + '</div>' + timerTxt + bubbleHtml +
    '</div>';
  });
  html += '</div>';

  // 중앙 테이블
  html += '<div class="table">';
  var info = '';
  if (g.wish) info += '<span class="chip gold">' + STR.wishChip + ': ' + C.rankLabel(g.wish) + '</span>';
  if (g.trickPilePoints) info += '<span class="chip dim">바닥 ' + g.trickPilePoints + STR.pilePts + '</span>';
  if (g.phase === 'play' && g.waitingOn.length && !myTurn()) {
    info += '<span class="chip dim">차례: ' + esc(seatName(g.turnSeat)) + '</span>';
  }
  if (g.phase === 'grand' || g.phase === 'exchange') {
    var waitNames = g.waitingOn.map(function (s2) { return s2 === ms ? STR.you : seatName(s2); }).join(', ');
    info += '<span class="chip dim">대기: ' + esc(waitNames) + '</span>';
  }
  html += '<div class="tableInfo">' + info + '</div>';

  // 현재 트릭의 모든 플레이를 순서대로, 마지막(현재 이기는 수)을 강조
  html += '<div class="trickCards">';
  if (g.trick.length) {
    html += g.trick.map(function (p, i) {
      var win = i === g.trick.length - 1;
      var who = '<span class="playWho">' + esc(seatName(p.seat)) + '</span>';
      return '<div class="play' + (win ? ' win' : '') + '">' +
        p.cards.map(function (id) { return cardHtml(id, 'sm'); }).join('') + who + '</div>';
    }).join('');
  } else if (g.phase === 'play') {
    html += '<span style="opacity:.45;font-size:13px">새 턴 — ' + esc(seatName(g.turnSeat)) + '부터</span>';
  }
  html += '</div>';

  html += '<div class="lastLine">' + lastActionLine() + '</div>';
  if (myTurn()) {
    html += '<div class="turnBanner">▶ ' + STR.yourTurn + ' — ' + (g.currentCombo ? beatHint(g.currentCombo) : STR.leadFree) + '</div>';
  }
  html += '</div>';

  // 내 영역
  html += renderMeArea();
  return html;
}

function lastActionLine() {
  var g = game();
  var la = g.lastAction;
  if (!la) return '';
  var nm = la.seat != null ? esc(seatName(la.seat)) : '';
  var em = function (s) { return state.office ? '' : s; }; // 위장 모드에서는 이모지 제거
  switch (la.kind) {
    case 'play': return nm + ': ' + (la.combo ? comboLabel(la.combo) : '');
    case 'bomb': return em('💥 ') + nm + ': ' + comboLabel(la.combo || { type: 'bomb4' });
    case 'pass': return nm + ' ' + STR.passChip;
    case 'tichu': return em('🔴 ') + nm + ' 스몰 티츄 선언!';
    case 'grand': return em('🔴 ') + nm + ' 라지 티츄 선언!';
    case 'grand_pass': return '';
    case 'dog': return em('🐶 ') + nm + ' 개 — ' + (la.toSeat != null ? esc(seatName(la.toSeat)) + ' 턴으로' : '파트너 턴으로');
    case 'trick_won': return nm + ' 카드 가져감' + (la.dragon ? ' (용 — 증정 대기)' : '');
    case 'dragon_give': return em('🐉 ') + nm + ' → ' + esc(seatName(la.toSeat)) + ' 카드 증정' + (la.auto ? ' (남은 상대 자동)' : '');
    case 'exchange_done': return '교환 완료 — ' + esc(seatName(la.leader)) + ' 턴부터 (1 보유)';
    case 'round_end': return '';
    default: return '';
  }
}

function renderMeArea() {
  var snap = state.snap, g = game();
  var ms = mySeat();
  var si = seatInfo(ms);
  var you = g.you || { hand: [] };
  var html = '<div class="meArea' + (myTurn() ? ' myturn' : '') + '">';

  // 내 정보 줄
  var inf = '<b>' + esc(seatName(ms)) + '</b>';
  if (si.tichu === 'grand') inf += ' <span class="chip red">' + STR.grandBadge + '</span>';
  else if (si.tichu === 'tichu') inf += ' <span class="chip red">' + STR.tichuBadge + '</span>';
  if (si.out) inf += ' <span class="chip gold">' + STR.finishRank[si.outRank - 1] + ' ' + STR.out + '!</span>';
  inf += ' <span class="chip dim">' + si.trickPoints + STR.pilePts + '</span>';
  if (you.received && you.received.length && si.handCount === 14 && g.phase === 'play' && !state.office) {
    inf += ' <span class="chip dim">' + STR.received + ': ' +
      you.received.map(function (r) { return esc(C.cardName(r.card)); }).join(' ') + '</span>';
  }
  var bomb = availableBomb();
  if (bomb) inf += ' <button class="btn small danger" data-act="bomb-hint">' + (state.office ? '' : '💥 ') + STR.bombHint + '</button>';
  html += '<div class="meInfo">' + inf + '</div>';

  // 손패
  var exMode = g.phase === 'exchange' && !you.exchangeSubmitted;
  html += '<div class="hand">';
  var wishR = (!exMode && you.mustFulfillWish && g.wish) ? g.wish : null;
  you.hand.forEach(function (id) {
    var cls = '', attrs = '';
    if (exMode) {
      var slot = state.exch.indexOf(id);
      if (slot >= 0) {
        cls = 'give';
        attrs = 'data-to="' + esc(exTargetName(slot)) + '"';
      }
    } else if (state.sel[id]) cls = 'sel';
    // 소원 의무 시 내야 하는 랭크 카드 강조
    if (wishR && !C.isSpecial(id) && C.rankOf(id) === wishR) cls += ' wishhi';
    html += cardHtml(id, cls, attrs);
  });
  html += '</div>';

  // 액션 영역
  if (exMode) {
    html += '<div class="exRow">';
    for (var i = 0; i < 3; i++) {
      var id2 = state.exch[i];
      html += '<div class="exSlot' + (id2 ? ' filled' : '') + '" data-act="ex-slot" data-i="' + i + '">' +
        '<span class="who">' + esc(exTargetName(i)) + '</span>' +
        (id2 ? '<span>' + esc(C.cardName(id2)) + '</span>' : '<span style="opacity:.5">카드 선택</span>') + '</div>';
    }
    html += '</div>';
    html += '<div class="actions">' +
      (you.canCallTichu ? tichuBtnHtml() : '') +
      '<button class="btn primary" data-act="ex-confirm"' + (state.exch.every(Boolean) ? '' : ' disabled') + '>' + STR.exchangeConfirm + '</button></div>';
    html += '<div class="comboHint">' + (state.tichuArmed ? STR.confirmHint : STR.exchangeTitle) + '</div>';
  } else if (g.phase === 'exchange') {
    html += '<div class="comboHint">' + STR.exchangeWaiting + '</div>';
  } else if (g.phase === 'play' || g.phase === 'dragon') {
    var ev = evalSelection();
    var canPass = myTurn() && g.currentCombo && !(you.mustFulfillWish);
    html += '<div class="actions">' +
      (you.canCallTichu ? tichuBtnHtml() : '') +
      '<button class="btn' + (canPass ? '' : ' dimmed') + '" data-act="pass">' + STR.pass + '</button>' +
      '<button class="btn primary' + (ev && ev.legal ? '' : ' dimmed') + '" data-act="play">' + STR.play + '</button>' +
    '</div>';
    html += '<div class="comboHint">' + (state.tichuArmed ? STR.confirmHint : (ev ? esc(ev.label) : '')) + '</div>';
  } else if (g.phase === 'grand') {
    html += '<div class="comboHint">처음 8장입니다</div>';
  }
  html += '</div>';
  return html;
}
function targetPicker() {
  return '<div class="targetRow"><span class="targetLbl">' + STR.targetScore + '</span>' +
    [300, 500, 1000].map(function (n) {
      return '<button class="btn small ' + (state.lobbyTarget === n ? 'primary' : 'ghost') +
        '" data-act="target" data-n="' + n + '">' + n + '</button>';
    }).join('') + '</div>';
}
function tichuBtnHtml() {
  return state.tichuArmed
    ? '<button class="btn danger" data-act="tichu">' + STR.tichuConfirm + '</button>'
    : '<button class="btn ghost" data-act="tichu">' + STR.tichuBtn + '</button>';
}
function exTargetName(slot) {
  var labels = ['왼쪽', '파트너', '오른쪽'];
  return labels[slot] + ' · ' + seatName(relSeat(slot + 1));
}

// ---------- 모달 ----------
function renderModal() {
  if (state.replaced) {
    return '<div class="backdrop center"><div class="sheet"><h2>' + STR.replaced + '</h2></div></div>';
  }
  var g = game();
  if (state.help) return helpModal();
  if (!g) return '';
  if (g.phase === 'grand' && g.you && g.you.canCallGrand) {
    var eight = g.you.hand.map(function (id) { return cardHtml(id, 'sm'); }).join('');
    // 위험한 선택(그랜드)은 강조하지 않고, 안전한 '선언 안 함'을 기본 강조 — 초심자 오터치 방지
    return '<div class="backdrop"><div class="sheet"><h2>' + STR.grandTitle + '</h2>' +
      '<div class="desc">' + STR.grandDesc + '</div>' +
      '<div class="grandCards">' + eight + '</div>' +
      '<div class="row"><button class="btn primary grow" data-act="grand-no">' + STR.grandPass + '</button>' +
      '<button class="btn danger grow" data-act="grand-yes">' + STR.grandCall + '</button></div>' +
      '<div class="comboHint" style="margin-top:10px">' + STR.firstTimeHint + '</div>' +
      '<button class="btn ghost" style="width:100%;margin-top:6px" data-act="help-modal">' + STR.rulesBtn + '</button>' +
      '</div></div>';
  }
  if (state.wishCards) {
    var btns = '';
    for (var r = 2; r <= 14; r++) btns += '<button class="btn ghost" data-act="wish" data-r="' + r + '">' + C.rankLabel(r) + '</button>';
    return '<div class="backdrop" data-dismiss="wish-cancel"><div class="sheet"><h2>' + STR.wishTitle + '</h2>' +
      '<div class="desc">' + STR.wishDesc + '</div>' +
      '<div class="wishGrid">' + btns + '</div>' +
      '<div class="row"><button class="btn ghost grow" data-act="wish-cancel">' + STR.wishCancel + '</button>' +
      '<button class="btn grow" data-act="wish" data-r="0">' + STR.wishNone + '</button></div></div></div>';
  }
  if (g.phase === 'dragon' && g.dragonChooser === mySeat()) {
    var a = relSeat(1), b = relSeat(3);
    return '<div class="backdrop"><div class="sheet"><h2>' + STR.dragonTitle + '</h2>' +
      '<div class="row">' +
      '<button class="btn grow" data-act="dragon" data-seat="' + a + '">' + esc(seatName(a)) + '</button>' +
      '<button class="btn grow" data-act="dragon" data-seat="' + b + '">' + esc(seatName(b)) + '</button>' +
      '</div></div></div>';
  }
  if (g.phase === 'roundEnd' || g.phase === 'gameEnd') return summaryModal(g);
  return '';
}

function summaryModal(g) {
  var sum = g.roundSummary;
  if (!sum) return '';
  var meA = myTeamKey() === 'teamA';
  function pair(o) { return meA ? [o.teamA, o.teamB] : [o.teamB, o.teamA]; }
  var html = '<div class="backdrop center"><div class="sheet">';
  if (g.phase === 'gameEnd') {
    var won = (sum.winnerTeam === 'A') === meA;
    html += '<div class="winBig">' + (won ? (state.office ? '' : '🏆 ') + '우리 팀 ' + STR.winA : '상대 팀 승리') + '</div>';
  }
  html += '<h2>' + STR.roundEndTitle + ' (' + sum.round + 'R)</h2><table class="sumTable">';
  if (sum.oneTwoTeam) {
    var otMine = (sum.oneTwoTeam === 'A') === meA;
    html += '<tr><td>' + STR.oneTwo + '</td><td colspan="2">' + (otMine ? STR.myTeam : STR.oppTeam) + ' 팀</td></tr>';
  } else if (sum.cardPoints) {
    var cp = pair(sum.cardPoints);
    html += '<tr><td>' + STR.cardPts + '</td><td>' + cp[0] + '</td><td>' + cp[1] + '</td></tr>';
  }
  sum.bonuses.forEach(function (b) {
    var lbl = (b.call === 'grand' ? '라지 티츄' : '스몰 티츄') + ' — ' + esc(seatName(b.seat));
    html += '<tr><td>' + lbl + ' ' + (b.made ? '성공' : '실패') + '</td><td colspan="2">' + (b.delta > 0 ? '+' : '') + b.delta + '</td></tr>';
  });
  var d = pair(sum.deltas), t = pair(sum.totals);
  html += '<tr><td>이번 라운드</td><td>' + (d[0] > 0 ? '+' : '') + d[0] + '</td><td>' + (d[1] > 0 ? '+' : '') + d[1] + '</td></tr>';
  html += '<tr class="tot"><td>' + STR.total + ' (' + STR.myTeam + ':' + STR.oppTeam + ')</td><td>' + t[0] + '</td><td>' + t[1] + '</td></tr>';
  html += '</table>';
  // 방장이 끊겨 있으면 다른 사람도 진행 가능 (서버도 허용) — 결과창 무한 대기 방지
  var hsi = state.snap.roomSeats[state.snap.hostSeat];
  var canAdvance = isHost() || (hsi && !hsi.connected);
  if (g.phase === 'gameEnd') {
    html += canAdvance ? '<button class="btn primary" style="width:100%" data-act="restart">' + STR.newGame + '</button>'
                       : '<div class="desc">' + STR.hostWillContinue + '</div>';
  } else {
    html += canAdvance ? '<button class="btn primary" style="width:100%" data-act="next-round">' + STR.nextRound + '</button>'
                       : '<div class="desc">' + STR.hostWillContinue + '</div>';
  }
  if (g.history && g.history.length) {
    html += '<button class="btn ghost" style="width:100%;margin-top:8px" data-act="history-toggle">' +
      STR.historyBtn + (state.showHistory ? ' ▲' : ' ▼') + '</button>';
    if (state.showHistory) html += historyTable(g);
  }
  html += '</div></div>';
  return html;
}

function historyTable(g) {
  var meA = myTeamKey() === 'teamA';
  var rows = g.history.map(function (h) {
    var d = meA ? [h.deltas.teamA, h.deltas.teamB] : [h.deltas.teamB, h.deltas.teamA];
    var t = meA ? [h.totals.teamA, h.totals.teamB] : [h.totals.teamB, h.totals.teamA];
    return '<tr><td>' + h.round + 'R</td>' +
      '<td>' + (d[0] > 0 ? '+' : '') + d[0] + ' / ' + (d[1] > 0 ? '+' : '') + d[1] + '</td>' +
      '<td>' + t[0] + ' : ' + t[1] + '</td></tr>';
  }).join('');
  return '<table class="sumTable" style="margin-top:6px"><tr style="opacity:.7"><td>라운드</td><td>증감(우리/상대)</td><td>누적</td></tr>' + rows + '</table>';
}

/* 전적 조회 — 서버가 집계원본. Render 무료는 재시작 시 디스크가 날아가므로
 * 조회할 때마다 내 기록을 localStorage에 백업하고, 서버가 비었으면 그 백업을 보여준다. */
function openStats() {
  state.statsOpen = true;
  state.stats = { loaded: false };
  render();
  var nm = (state.name || '').trim();
  var urls = ['/stats'];
  if (nm) urls.push('/stats?name=' + encodeURIComponent(nm));
  Promise.all(urls.map(function (u) {
    return fetch(u).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
  })).then(function (rs) {
    var board = (rs[0] && rs[0].board) || [];
    var detail = (rs[1] && rs[1].detail) || null;
    if (detail) {                                    // 서버 기록 → 로컬 백업
      try { localStorage.setItem('tichu.stats.' + nm, JSON.stringify(detail)); } catch (e) {}
    } else if (nm) {                                 // 서버가 비었으면 백업본 사용
      try {
        var bk = localStorage.getItem('tichu.stats.' + nm);
        if (bk) { detail = JSON.parse(bk); detail.fromBackup = true; }
      } catch (e) {}
    }
    state.stats = { loaded: true, board: board, detail: detail };
    render();
  });
}

/* 전적 모달 — 닉네임 기준. 서버가 날아가도 개인 기록은 남도록 localStorage 백업본도 병합.
 * 디자인: 상단에 내 요약 카드(큰 숫자), 아래 리더보드. 위장 모드에선 숫자만 남는 표로 바뀐다. */
function pct(n, d) { return d ? Math.round(100 * n / d) + '%' : '–'; }
var TIER_LBL = { bronze: '브론즈', silver: '실버', gold: '골드', diamond: '다이아' };
// 티어 기준은 봇 단수 — 동결돼 있어 흔들리지 않는 절대 척도
function tierHint(t) {
  return t === 'diamond' ? '2단보다 확실히 강함'
    : t === 'gold' ? '2단 격파권'
    : t === 'silver' ? '1단 ~ 2단 사이'
    : '1단 아래';
}

/* 봇 앵커 위의 내 위치 — 이 설계의 요점.
 * 1단·2단은 동결이라 눈금이 흔들리지 않는다. "나는 2단보다 30점 아래"가 절대적 의미를 갖는다. */
function eloScaleHtml(me) {
  var a = me.anchors || { dan1: 1000, dan2: 1070 };
  var lo = a.dan1 - 180, hi = a.dan2 + 180;             // 눈금 범위
  function pos(v) { return Math.max(0, Math.min(100, 100 * (v - lo) / (hi - lo))); }
  var mine = Math.max(lo, Math.min(hi, me.elo != null ? me.elo : 1000));
  return '<div class="stScale">' +
    '<div class="stScaleBar">' +
      '<i class="stFill" style="width:' + pos(mine) + '%"></i>' +
      '<i class="stTick" style="left:' + pos(a.dan1) + '%"><b>1단</b></i>' +
      '<i class="stTick" style="left:' + pos(a.dan2) + '%"><b>2단</b></i>' +
      '<i class="stYou" style="left:' + pos(mine) + '%"></i>' +
    '</div></div>';
}

function statsModal() {
  var S = state.stats || {};
  var me = S.detail, board = S.board || [];
  var loading = !S.loaded;
  var body = '';

  if (loading) {
    body = '<div class="stEmpty">불러오는 중…</div>';
  } else if (!me && !board.length) {
    body = '<div class="stEmpty">아직 기록이 없습니다<br><span style="opacity:.6;font-size:12px">' +
      '온라인 방에서 게임을 끝내면 전적이 쌓입니다</span></div>';
  } else {
    if (me) {
      // 내 요약 — 큰 숫자 3개 + 세부 배지
      var tier = me.tier || 'bronze';
      body += '<div class="stMe">' +
        '<div class="stMeHead">' +
          '<span class="stMeName">' + esc(me.name) + '</span>' +
          '<span class="stTier ' + tier + '">' + TIER_LBL[tier] + '</span>' +
        '</div>' +
        '<div class="stElo">' +
          '<b>' + (me.elo != null ? me.elo : 1000) + '</b>' +
          '<span>' + tierHint(tier) + (me.provisional ? ' · 잠정(10판 미만)' : '') + '</span>' +
        '</div>' +
        eloScaleHtml(me) +
        '<div class="stBig">' +
          '<div class="stBigCell"><b>' + pct(me.wins, me.games) + '</b><span>승률</span></div>' +
          '<div class="stBigCell"><b>' + me.wins + '<i>/' + me.games + '</i></b><span>승/판</span></div>' +
          '<div class="stBigCell"><b>' + (me.ppr >= 0 ? '+' : '') + me.ppr.toFixed(1) + '</b><span>라운드당</span></div>' +
        '</div>' +
        '<div class="stTags">' +
          '<span class="stTag">스몰 티츄 <b>' + pct(me.tichuOk, me.tichu) + '</b> <i>' + me.tichuOk + '/' + me.tichu + '</i></span>' +
          '<span class="stTag">라지 <b>' + pct(me.grandOk, me.grand) + '</b> <i>' + me.grandOk + '/' + me.grand + '</i></span>' +
          '<span class="stTag">원투 <b>' + me.oneTwo + '</b>회</span>' +
        '</div>';
      if (me.partners && me.partners.length) {
        body += '<div class="stSub">파트너 궁합</div><div class="stPartners">' +
          me.partners.map(function (p) {
            return '<div class="stPRow"><span class="stPName">' + esc(p.name) + '</span>' +
              '<span class="stBar"><i style="width:' + Math.round(100 * p.wins / Math.max(p.games, 1)) + '%"></i></span>' +
              '<span class="stPNum">' + pct(p.wins, p.games) + ' <i>' + p.wins + '/' + p.games + '</i></span></div>';
          }).join('') + '</div>';
      }
      body += '</div>';
    }
    if (board.length) {
      body += '<div class="stSub">순위 <span style="opacity:.55;font-weight:400">· 3판 이상</span></div>' +
        '<div class="stBoard">' + board.map(function (r, i) {
          var medal = i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : '';
          var isMe = me && r.name === me.name;
          return '<div class="stRow' + (isMe ? ' me' : '') + '">' +
            '<span class="stRank ' + medal + '">' + (i + 1) + '</span>' +
            '<span class="stName">' + esc(r.name) + '</span>' +
            '<span class="stDot ' + (r.tier || 'bronze') + '" title="' + TIER_LBL[r.tier || 'bronze'] + '"></span>' +
            '<span class="stElo2">' + (r.elo != null ? r.elo : '–') + (r.provisional ? '?' : '') + '</span>' +
            '<span class="stRate">' + pct(r.wins, r.games) + '</span>' +
            '<span class="stGames">' + r.games + '판</span></div>';
        }).join('') + '</div>';
    }
  }

  return '<div class="backdrop center" data-act="stats-close"><div class="sheet stSheet" data-stop="1">' +
    '<h2>' + STR.statsTitle + '</h2>' + body +
    '<button class="btn ghost" style="width:100%;margin-top:12px" data-act="stats-close">닫기</button>' +
    '</div></div>';
}

function helpModal() {
  return '<div class="backdrop center"><div class="sheet" style="max-height:80vh;overflow:auto">' +
    '<h2>티츄 간단 규칙</h2>' +
    '<div style="font-size:13px;line-height:1.7;opacity:.9">' +
    '<b>게임 흐름</b><br>' +
    '① 처음 8장을 보고 라지 티츄 여부 결정(보통 「선언 안 함」).<br>' +
    '② 나머지 6장을 받고, 양옆·파트너에게 1장씩 <b>교환</b>(파트너에겐 좋은 카드, 상대에겐 낮은 카드).<br>' +
    '③ 돌아가며 카드를 냄. <b>이전 사람보다 높게</b> 내거나 <b>패스</b>. 나머지 3명이 모두 패스하면 마지막에 낸 사람이 깔린 카드를 전부 가져가고 새 턴을 시작.<br>' +
    '④ 손패를 먼저 비우는 순서대로 1~4등. 같은 팀이 1·2등이면 즉시 라운드 종료(원투).<br><br>' +
    '<b>규칙 상세</b><br>' +
    '· 2:2 팀전. 마주 보는 자리가 한 팀, 1000점(또는 방장이 정한 점수) 선취.<br>' +
    '· 조합: 싱글/페어/트리플/풀하우스/스트레이트(5+)/연속페어. 같은 형태·장수만 더 높게 낼 수 있음.<br>' +
    '· 폭탄: 같은 숫자 4장, 같은 무늬 연속 5장+. 무엇이든 이기고 차례 없이 끼어들기 가능.<br>' +
    '· <b>1(참새)</b>: 가장 낮은 카드, 가진 사람이 첫 턴 시작. 내면서 소원 숫자 선언 → 다른 사람은 낼 수 있으면 반드시 그 숫자를 내야 함.<br>' +
    '· <b>개</b>: 턴을 시작할 때만. 파트너에게 턴을 넘김.<br>' +
    '· <b>불사조</b>: 어떤 카드든 대신(폭탄 제외). 싱글로는 직전 카드+0.5 (용은 못 이김). -25점.<br>' +
    '· <b>용</b>: 가장 높은 싱글, +25점. 용으로 가져온 카드는 상대팀에게 줘야 함.<br>' +
    '· 점수 카드: 5(5점), 10·K(10점). 꼴찌가 가져온 카드는 1등에게, 남은 손패는 상대팀에게.<br>' +
    '· <b>스몰 티츄</b>(첫 카드 전 선언, ±100) / <b>라지 티츄</b>(8장 보고, ±200): 선언자가 1등 완주해야 성공.<br>' +
    '· <b>원투</b>: 한 팀이 1·2등 완주 시 +200 (카드점수 무시).' +
    '</div>' +
    '<div class="row"><button class="btn grow" data-act="help-close">닫기</button></div>' +
  '</div></div>';
}

// ---------- 인터랙션 ----------
function onCardTap(id) {
  var g = game();
  if (!g || !g.you) return;
  if (g.phase === 'exchange' && !g.you.exchangeSubmitted) {
    var idx = state.exch.indexOf(id);
    if (idx >= 0) state.exch[idx] = null;
    else {
      var empty = state.exch.indexOf(null);
      if (empty < 0) { toast('슬롯이 가득 찼습니다 — 슬롯을 눌러 비우세요'); return; }
      state.exch[empty] = id;
    }
    render();
    return;
  }
  if (g.phase === 'play') {
    if (state.sel[id]) delete state.sel[id];
    else state.sel[id] = true;
    render();
  }
}

function doPlay() {
  var ev = evalSelection();
  if (!ev || !ev.legal) {
    // 침묵하는 비활성 버튼 대신 "왜 안 되는지"를 말해줌 — '카드 안 내져요' 혼동 방지
    var g0 = game(), why;
    if (!ev) why = !myTurn() ? '아직 내 차례가 아닙니다' : '낼 카드를 먼저 선택하세요';
    else why = ev.label;
    if (g0 && g0.you && g0.you.mustFulfillWish && ev) why += ' — 소원(' + C.rankLabel(g0.wish) + ') 포함 필수';
    toast(why, { ms: 4000, warn: true });
    return;
  }
  var ids = selectedIds();
  if (ids.indexOf('MJ') >= 0) {
    state.wishCards = ids;
    render();
    return;
  }
  state.sel = {};
  send({ type: 'play_cards', cards: ids });
  render();
}

function onClick(e) {
  // 반투명 모드 중 모달이 떠 있으면 backdrop이 헤더의 ◐ 버튼을 덮음 →
  // 흐린 화면 아무 곳(backdrop) 탭으로 반투명을 해제할 수 있게 탈출구 제공
  if (state.ghost && e.target.classList && e.target.classList.contains('backdrop')) {
    state.ghost = 0;
    try { localStorage.setItem('tichu.ghost', '0'); } catch (eg) {}
    render();
    return;
  }
  // 모달 바깥(backdrop) 직접 클릭 → 지정된 닫기 동작
  if (e.target.dataset && e.target.dataset.dismiss) {
    if (e.target.dataset.dismiss === 'wish-cancel') { state.wishCards = null; render(); }
    return;
  }
  var card = e.target.closest('[data-card]');
  if (card && card.closest('.hand')) { onCardTap(card.getAttribute('data-card')); return; }
  var el = e.target.closest('[data-act]');
  if (!el) return;
  var act = el.getAttribute('data-act');
  var seat = el.hasAttribute('data-seat') ? +el.getAttribute('data-seat') : null;
  switch (act) {
    case 'create':
      ensureOnline(function () { send({ type: 'create_room', name: state.name }); });
      break;
    case 'join': {
      saveName();
      var code = ($('#code') ? $('#code').value : '').trim().toUpperCase();
      if (code.length !== 4) { toast('방 코드 4자리를 입력하세요'); break; }
      joinRoom(code);
      break;
    }
    case 'solo': saveName(); startSolo(false); break;
    case 'solo-resume': saveName(); startSolo(true); break;
    case 'sit': send({ type: 'take_seat', seat: seat }); break;
    case 'bot-add': send({ type: 'add_bot', seat: seat }); break;
    case 'bot-del': send({ type: 'remove_bot', seat: seat }); break;
    case 'kick': send({ type: 'kick_player', seat: seat }); break;
    case 'start': {
      // 온라인은 단(段)만 공정 — 악마/구등급 선택값은 1단으로. 2단(super2)까지 허용.
      var onlineLv = state.botLevel === 'super2' ? 'super2' : 'super';
      send({ type: 'start_game', targetScore: state.lobbyTarget, botLevel: onlineLv });
      break;
    }
    case 'target': state.lobbyTarget = +el.getAttribute('data-n'); render(); break;
    case 'botlevel': {
      var lv = el.getAttribute('data-l');
      state.botLevel = ['devil', 'super', 'super2'].indexOf(lv) >= 0 ? lv : 'super'; // 1단(super) 기본
      try { localStorage.setItem('tichu.botlevel', state.botLevel); } catch (e3) {}
      render();
      break;
    }
    case 'join-room': joinRoom(el.getAttribute('data-code')); break;
    case 'rooms-refresh': requestRooms(); break;
    case 'copy': {
      var url = location.origin + location.pathname + '?room=' + (state.snap ? state.snap.code : '');
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
        function () { toast(STR.copied); },
        function () { toast(url); }
      );
      break;
    }
    case 'leave': {
      var g0 = game();
      var inGame = g0 && g0.phase !== 'lobby' && g0.phase !== 'gameEnd';
      if (inGame && typeof confirm === 'function' && !confirm(STR.leaveConfirm)) break;
      if (state.session && state.session.mode === 'online') {
        // 연결은 유지한 채 방만 나가기 — 홈의 방 목록이 계속 동작해야 함
        send({ type: 'leave_room' });
        state.snap = null;
        state.screen = 'home';
        state.chat = []; state.unread = 0; state.chatOpen = false; state.chatDraft = ''; state.bubbles = {};
        render();
        requestRooms();
      } else {
        destroySession();
        state.screen = 'home';
        state.conn = { s: '', mode: '' };
        render();
      }
      break;
    }
    case 'grand-yes': send({ type: 'call_grand', call: true }); break;
    case 'grand-no': send({ type: 'call_grand', call: false }); break;
    case 'tichu':
      // 2탭 확인 — 오터치로 -100 확정 방지
      if (!state.tichuArmed) {
        state.tichuArmed = Date.now();
        clearTimeout(tichuArmTimer);
        tichuArmTimer = setTimeout(function () { state.tichuArmed = 0; render(); }, 3000);
        render();
      } else {
        state.tichuArmed = 0;
        clearTimeout(tichuArmTimer);
        send({ type: 'call_tichu' });
        render();
      }
      break;
    case 'pass': {
      var gp = game();
      if (!myTurn()) { toast('아직 내 차례가 아닙니다', { ms: 3500, warn: true }); break; }
      if (gp && !gp.currentCombo) { toast('선두는 패스할 수 없습니다 — 아무 조합이나 내세요', { ms: 4000, warn: true }); break; }
      if (gp && gp.you && gp.you.mustFulfillWish) { toast('소원(' + C.rankLabel(gp.wish) + ')을 낼 수 있어 패스할 수 없습니다', { ms: 4500, warn: true }); break; }
      var pa = { type: 'pass_turn' };
      send(pa);
      state.passId = pa.actionId || null; // 상태 경합 거부 시 자동 재시도용
      break;
    }
    case 'play': doPlay(); break;
    case 'wish': {
      var r = +el.getAttribute('data-r');
      var cards = state.wishCards || [];
      state.wishCards = null;
      state.sel = {};
      var a = { type: 'play_cards', cards: cards };
      if (r >= 2) a.wish = r;
      send(a);
      render();
      break;
    }
    case 'dragon': send({ type: 'give_dragon', toSeat: seat }); break;
    case 'ex-slot': {
      var i = +el.getAttribute('data-i');
      state.exch[i] = null;
      render();
      break;
    }
    case 'ex-confirm': {
      if (!state.exch.every(Boolean)) break;
      var give = {};
      give[relSeat(1)] = state.exch[0];
      give[relSeat(2)] = state.exch[1];
      give[relSeat(3)] = state.exch[2];
      send({ type: 'submit_exchange', give: give });
      break;
    }
    case 'bomb-hint': {
      var bomb = availableBomb();
      if (bomb) {
        state.sel = {};
        bomb.cards.forEach(function (id) { state.sel[id] = true; });
        render();
      }
      break;
    }
    case 'next-round': send({ type: 'next_round' }); break;
    case 'restart': send({ type: 'restart_game' }); break;
    case 'stats-open': openStats(); break;
    case 'stats-close': state.statsOpen = false; render(); break;
    case 'help-open': state.help = true; state.helpFromModal = false; render(); break;
    case 'help-modal': state.help = true; state.helpFromModal = true; render(); break;
    case 'help-close': state.help = false; state.helpFromModal = false; render(); break;
    case 'wish-cancel': state.wishCards = null; render(); break;
    case 'history-toggle': state.showHistory = !state.showHistory; render(); break;
    case 'chat-open': state.chatOpen = !state.chatOpen; if (state.chatOpen) state.unread = 0; render(); break;
    case 'chat-close': state.chatOpen = false; render(); break;
    case 'chat-send': sendChat(($('#chatIn') || {}).value); break;
    case 'chat-preset': sendChat(el.getAttribute('data-t')); break;
    case 'kick-seat': send({ type: 'kick_player', seat: seat }); break;
    case 'office-toggle':
      state.office = !state.office;
      try { localStorage.setItem('tichu.office', state.office ? '1' : '0'); } catch (e2) {}
      render();
      break;
    case 'ghost-toggle':
      state.ghost = (state.ghost + 1) % 3;
      try { localStorage.setItem('tichu.ghost', String(state.ghost)); } catch (e3) {}
      render();
      break;
    case 'xl-style': // 카드형('') → 셀+무늬('1') → 숫자만('3') 순환 — 문자코드('2')는 미채택
      state.xlStyle = state.xlStyle === '' ? '1' : state.xlStyle === '1' ? '3' : '';
      try { localStorage.setItem('tichu.xlstyle', state.xlStyle); } catch (e4) {}
      render();
      break;
  }
}

// ---------- 초기화 ----------
function init() {
  appEl = $('#app');
  toastEl = $('#toast');
  appEl.addEventListener('click', onClick);
  appEl.addEventListener('keydown', function (e) {
    var tid = e.target && e.target.id;
    if (tid === 'chatIn' || tid === 'nick' || tid === 'code') state.lastTypeAt = Date.now(); // keyCode 229 포함 모든 키
    if (e.key === 'Enter' && tid === 'chatIn') {
      if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 Enter 무시
      e.preventDefault();
      sendChat(e.target.value);
    }
  });
  appEl.addEventListener('input', function (e) {
    var tid = e.target && e.target.id;
    if (tid === 'chatIn' || tid === 'nick' || tid === 'code') state.lastTypeAt = Date.now();
    if (tid === 'chatIn') state.chatDraft = e.target.value; // 초안 보존
  });
  // 한글 IME 조합 추적 — 조합 중 재렌더를 미뤄 자모 끊김 방지
  function endCompose() {
    if (!state.composing) return;
    state.composing = false;
    if (state.renderQueued) { state.renderQueued = false; render(); }
  }
  appEl.addEventListener('compositionstart', function () { state.composing = true; });
  appEl.addEventListener('compositionend', endCompose);
  appEl.addEventListener('focusout', endCompose); // 조합 중 포커스 이탈 등 예외 경로 안전망
  state.name = '';
  try { state.name = localStorage.getItem('tichu.name') || ''; } catch (e) {}
  try { state.office = localStorage.getItem('tichu.office') === '1'; } catch (e) {}
  try { var xs = localStorage.getItem('tichu.xlstyle'); state.xlStyle = (xs === '1' || xs === '2' || xs === '3') ? xs : ''; } catch (e) {}
  try { var gh = parseInt(localStorage.getItem('tichu.ghost') || '0', 10); state.ghost = (gh === 1 || gh === 2) ? gh : 0; } catch (e) {}
  try { var bl = localStorage.getItem('tichu.botlevel'); state.botLevel = ['easy', 'normal', 'hard', 'devil', 'super', 'super2'].indexOf(bl) >= 0 ? bl : 'super2'; } catch (e) {}
  state.urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
    // 새 버전이 배포돼 새 서비스워커가 제어를 넘겨받으면 한 번만 자동 새로고침
    // (첫 설치는 제외 — controller가 이미 있을 때만 = 업데이트)
    var hadController = !!navigator.serviceWorker.controller, swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (swReloaded || !hadController) return;
      swReloaded = true;
      location.reload();
    });
  }
  window.addEventListener('resize', fitHand);
  // 항상 접속 시도 — 방 목록 표시 + 진행 중 게임 자동 복귀 (오프라인이면 조용히 실패)
  if (navigator.onLine !== false) {
    state.session = OnlineSession.create(handlers);
    state.session.connect(state.name);
  }
  // 홈 화면 방 목록 주기 갱신
  setInterval(requestRooms, 4000);
  render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
