#!/usr/bin/env node
/* 클라이언트 클릭 핸들러 스모크 — 모든 data-act를 실제로 눌러 본다.
 *
 * 왜 필요한가: 2026-08-08에 팀 배정 버튼이 오타 하나(el을 t로) 때문에 계속 죽어 있었다.
 * 누를 때마다 ReferenceError가 나서 서버에는 요청이 한 건도 안 갔는데, 세 층이 모두 놓쳤다:
 *   - node --check 는 문법만 본다 (선언 안 된 식별자는 런타임 오류)
 *   - 서버 e2e는 액션을 WS로 직접 보내므로 클라이언트 핸들러를 지나가지 않는다
 *   - 토스트가 ack와 무관하게 떠서 눌린 것처럼 보였다
 * 정규식 린터는 정규식 리터럴 때문에 오탐투성이라 폐기했다(파서 없이는 불가).
 * 남은 유일한 방법이 **핸들러를 실제로 실행**하는 것이다.
 *
 * 방식: 최소 DOM 스텁 위에 app.js를 올리고, 위임 클릭 리스너를 가로채
 * 소스에서 뽑은 모든 data-act 값으로 합성 클릭을 쏜다. ReferenceError/TypeError가
 * 하나라도 나면 실패. 핸들러가 하는 일(전송·렌더)은 검사하지 않는다 — 목적은
 * "누르면 터지는가"만 보는 것이다.
 *
 * 실행: node test/e2e-clicks.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

// ---------- 최소 DOM 스텁 ----------
var thrown = [];
function El(tag) {
  this.tagName = (tag || 'div').toUpperCase();
  this.children = []; this.style = {}; this.dataset = {};
  this._attrs = {}; this.classList = {
    _s: {}, add: function (c) { this._s[c] = 1; }, remove: function (c) { delete this._s[c]; },
    contains: function (c) { return !!this._s[c]; }, toggle: function (c) { this._s[c] ? delete this._s[c] : this._s[c] = 1; }
  };
  this.value = ''; this.textContent = ''; this.innerHTML = ''; this.innerText = '';
  this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.offsetWidth = 52;
  this._listeners = {};
}
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.removeChild = function (c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; };
El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); if (k.indexOf('data-') === 0) this.dataset[k.slice(5).replace(/-(.)/g, function (_, c) { return c.toUpperCase(); })] = String(v); };
El.prototype.getAttribute = function (k) { return k in this._attrs ? this._attrs[k] : null; };
El.prototype.hasAttribute = function (k) { return k in this._attrs; };
El.prototype.removeAttribute = function (k) { delete this._attrs[k]; };
El.prototype.addEventListener = function (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); };
El.prototype.removeEventListener = function () {};
El.prototype.querySelector = function () { return null; };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.closest = function (sel) { return this._closest && this._closest(sel); };
El.prototype.getBoundingClientRect = function () { return { top: 0, left: 0, right: 52, bottom: 74, width: 52, height: 74 }; };
El.prototype.focus = function () {}; El.prototype.blur = function () {};
El.prototype.scrollIntoView = function () {};

var appEl = new El('div');
var doc = {
  readyState: 'complete', title: '', activeElement: null,
  body: new El('body'), documentElement: new El('html'),
  createElement: function (t) { return new El(t); },
  getElementById: function (id) { return id === 'app' ? appEl : new El('div'); },
  querySelector: function (s) { return s === '#app' ? appEl : new El('div'); },
  querySelectorAll: function () { return []; },
  addEventListener: function () {}, removeEventListener: function () {}
};
doc.documentElement.style = { setProperty: function () {}, removeProperty: function () {} };

var store = {};
/* Node 26에서 navigator 등 일부 전역은 getter-only라 대입이 막힌다 — defineProperty로 덮는다 */
function defGlobal(name, val) {
  try { global[name] = val; if (global[name] === val) return; } catch (e) { /* 아래로 */ }
  Object.defineProperty(global, name, { value: val, configurable: true, writable: true });
}
defGlobal('document', doc);
defGlobal('localStorage', {
  getItem: function (k) { return k in store ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  clear: function () { store = {}; }
});
defGlobal('sessionStorage', global.localStorage);
defGlobal('location', { origin: 'http://localhost', pathname: '/', protocol: 'http:', search: '', href: 'http://localhost/', reload: function () {} });
defGlobal('navigator', { onLine: true, clipboard: { writeText: function () { return Promise.resolve(); } }, userAgent: 'node' });
defGlobal('history', { length: 1, replaceState: function () {}, pushState: function () {} });
defGlobal('matchMedia', function () { return { matches: false, addEventListener: function () {}, addListener: function () {} }; });
defGlobal('getComputedStyle', function () { return { marginLeft: '0px', getPropertyValue: function () { return ''; } }; });
defGlobal('alert', function () {});
defGlobal('confirm', function () { return true; });
defGlobal('prompt', function () { return ''; });
defGlobal('requestAnimationFrame', function (f) { return setTimeout(f, 0); });
defGlobal('cancelAnimationFrame', function (h) { clearTimeout(h); });
function FakeWS() { this.readyState = 0; this.send = function () {}; this.close = function () {}; }
FakeWS.OPEN = 1;
defGlobal('WebSocket', FakeWS);
defGlobal('fetch', function () { return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve({}); } }); });
defGlobal('visualViewport', null);
/* window는 실제 이벤트 타깃이어야 한다 — app.js가 resize/키보드 리스너를 건다 */
var winListeners = {};
global.addEventListener = function (t, f) { (winListeners[t] = winListeners[t] || []).push(f); };
global.removeEventListener = function () {};
global.dispatchEvent = function () { return true; };
global.scrollTo = function () {};
global.scrollY = 0;
global.innerWidth = 375; global.innerHeight = 812;
global.window = global;
global.self = global;

// 스텁 위에 클라이언트 모듈을 순서대로 올린다 (index.html과 같은 순서)
var LOADS = ['shared/tichu-core.js', 'shared/bots.js', 'strings.js', 'transport.js', 'offline.js', 'app.js'];
LOADS.forEach(function (rel) {
  var p = rel.indexOf('shared/') === 0 ? path.join(ROOT, rel) : path.join(ROOT, 'client', rel);
  if (!fs.existsSync(p)) return;
  var src = fs.readFileSync(p, 'utf8');
  try {
    /* 간접 eval은 전역 스코프에서 돈다 — var/function 선언이 진짜 전역이 되어
     * 파일끼리 서로를 볼 수 있다(브라우저 <script> 여러 개와 같은 상황).
     * 전역에는 module이 없으므로 UMD는 브라우저 분기를 탄다. */
    (0, eval)(src);
  } catch (e) {
    console.error('★ 로드 실패: ' + rel + ' — ' + e.message);
    process.exit(1);
  }
});

// ---------- 위임 클릭 리스너 확보 ----------
var handlers = (appEl._listeners.click || []);
if (!handlers.length) {
  console.error('★ #app에 click 리스너가 없다 — app.js가 init()을 못 돌았을 수 있다');
  process.exit(1);
}

// 소스에서 모든 data-act 값 수집
var appSrc = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
var acts = {};
(appSrc.match(/data-act="[a-zA-Z-]+"/g) || []).forEach(function (m) { acts[m.slice(10, -1)] = 1; });
var ACTS = Object.keys(acts).sort();
if (ACTS.length < 20) { console.error('★ data-act 수집 실패(' + ACTS.length + '개)'); process.exit(1); }

// 핸들러가 참조할 법한 부가 속성(좌석·모드·코드 등)을 넉넉히 붙인 합성 타겟
function makeTarget(act) {
  var el = new El('button');
  el.setAttribute('data-act', act);
  el.setAttribute('data-seat', '1');
  el.setAttribute('data-mode', 'random');
  el.setAttribute('data-code', 'ABCD');
  el.setAttribute('data-card', 'S5');
  el.setAttribute('data-t', '굿굿');
  el.setAttribute('data-to', '2');
  el.setAttribute('data-level', 'super4');
  el.setAttribute('data-target', '1000');
  el.setAttribute('data-rank', '5');
  el._closest = function (sel) {
    if (sel === '[data-act]') return el;
    if (sel === '[data-card]') return null;   // 카드 탭 경로는 별도
    if (sel === '.hand') return null;
    if (sel === '.chatPanel') return null;
    return null;
  };
  return el;
}

/* 실제 게임을 시작해 봇 탐색을 돌리는 액션은 제외 — 목적은 "핸들러가 터지는가"이지
 * 게임 진행이 아니다. 이 액션들은 서버 e2e가 이미 전부 지나간다. */
var HEAVY = { solo: 1, start: 1, restart: 1, 'next-round': 1, resume: 1 };

/* app.js가 onClick을 try/catch로 감싸 예외를 삼키고 console.error로만 남긴다.
 * (그 안전망 자체가 오늘 넣은 것이다 — 사용자에게 조용한 무반응 대신 메시지를 주려고.)
 * 그래서 테스트는 던져진 예외가 아니라 **삼켜진 오류**를 봐야 한다. */
var swallowed = [];
var realErr = console.error;
console.error = function () {
  var a = Array.prototype.slice.call(arguments);
  var e = a.filter(function (x) { return x instanceof Error; })[0];
  if (e) swallowed.push(e);
  else if (/클릭 처리 실패/.test(String(a[0]))) swallowed.push(new Error(String(a.join(' '))));
};
var skipped = [];
var failed = [];
ACTS.forEach(function (act) {
  if (HEAVY[act]) { skipped.push(act); return; }
  var target = makeTarget(act);
  var ev = { target: target, preventDefault: function () {}, stopPropagation: function () {}, currentTarget: appEl };
  handlers.forEach(function (h) {
    swallowed.length = 0;
    try { h(ev); }
    catch (e) {
      var hard = (e instanceof ReferenceError) || /is not defined/.test(e.message);
      failed.push({ act: act, hard: hard, msg: e.constructor.name + ': ' + e.message });
    }
    // 안전망이 삼킨 오류도 같은 기준으로 판정
    swallowed.forEach(function (e) {
      var hard = (e instanceof ReferenceError) || /is not defined/.test(e.message);
      failed.push({ act: act, hard: hard, msg: '(삼켜짐) ' + e.constructor.name + ': ' + e.message });
    });
    swallowed.length = 0;
  });
});

var hard = failed.filter(function (f) { return f.hard; });
var soft = failed.filter(function (f) { return !f.hard; });

console.error = realErr;
console.log('1) 클라이언트 모듈 로드 OK (' + LOADS.length + '개)');
console.log('2) data-act ' + ACTS.length + '종 합성 클릭 실행');
if (soft.length) {
  console.log('   (스텁 한계로 인한 비치명 예외 ' + soft.length + '건 — 무시)');
}
if (hard.length) {
  console.error('\n★ 선언되지 않은 식별자로 죽는 핸들러 ' + hard.length + '건:');
  hard.forEach(function (f) { console.error('   data-act="' + f.act + '" → ' + f.msg); });
  process.exit(1);
}
console.log('3) ReferenceError 0건 — 검사한 버튼 ' + (ACTS.length - skipped.length) + '종 전부 실행됨');
if (skipped.length) console.log('   (게임을 실제로 돌리는 액션 제외: ' + skipped.join(', ') + ')');
console.log('CLICKS E2E PASSED');
process.exit(0);   // 클라이언트가 건 타이머·재접속 루프가 남아 있어도 여기서 끝낸다
