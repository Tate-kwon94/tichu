/* 온라인 통신 계층 — WebSocket → SSE → long-poll 자동 폴백, 재접속, 액션 직렬화 */
var OnlineSession = (function () {
'use strict';
var PROTO = 1;

function create(handlers) {
  var params = new URLSearchParams(location.search);
  var forcedT = params.get('transport');
  var tiers = (forcedT === 'ws' || forcedT === 'sse' || forcedT === 'poll') ? [forcedT] : ['ws', 'sse', 'poll'];

  var token = localStorage.getItem('tichu.token') || '';
  var clientId = localStorage.getItem('tichu.cid');
  if (!clientId) {
    clientId = Math.random().toString(36).slice(2, 10);
    localStorage.setItem('tichu.cid', clientId);
  }
  var actionCounter = 0;
  // 페이지 로드마다 새 salt — 카운터가 0부터 다시 시작해도 이전 로드의 actionId와
  // 겹치지 않게 함 (서버 세션의 멱등 ack 캐시가 새 액션을 옛 ack으로 잘못 응답하는 것 방지)
  var runSalt = Math.random().toString(36).slice(2, 6);
  var lastVersion = 0;
  var lastGver = 0;    // 게임상태 버전 — 서버 STALE 판정은 이걸로만 (version은 전송 dedup용)
  var lastRoom = null; // 버전 게이트는 방 단위 — 방이 바뀌면 리셋 (이어받기 직행 시 스냅샷 드롭 방지)
  var mode = null, tierIdx = 0;
  var ws = null, es = null, pollRun = 0;
  var alive = true, retries = 0, reconnectTimer = null;
  var lastEventAt = Date.now();
  var myName = '';
  var postQueue = [], posting = false;

  function status(s) { if (handlers.onStatus) handlers.onStatus(s, mode); }

  function route(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'welcome':
        if (msg.token) { token = msg.token; try { localStorage.setItem('tichu.token', token); } catch (e) {} }
        lastVersion = msg.version || 0;
        lastGver = msg.gver || 0;
        lastRoom = (msg.snapshot && msg.snapshot.code) || null;
        if (msg.protocolVersion && msg.protocolVersion !== PROTO && handlers.onStale) handlers.onStale();
        if (handlers.onWelcome) handlers.onWelcome(msg);
        if (msg.snapshot) handlers.onState(msg.snapshot);
        break;
      case 'room_state':
        if (msg.version != null) {
          var rc = msg.snapshot && msg.snapshot.code;
          if (rc && rc !== lastRoom) { lastRoom = rc; lastVersion = 0; lastGver = 0; }
          if (msg.version <= lastVersion) return;
          lastVersion = msg.version;
          if (msg.gver != null) lastGver = msg.gver;
        }
        handlers.onState(msg.snapshot);
        break;
      case 'action_ack':
        if (handlers.onAck) handlers.onAck(msg);
        break;
      case 'chat':
        if (handlers.onChat) handlers.onChat(msg);
        break;
      case 'session_replaced':
        alive = false;
        teardown();
        if (handlers.onReplaced) handlers.onReplaced();
        break;
      case 'left_room':
        lastVersion = 0;
        lastGver = 0;
        lastRoom = null;
        if (handlers.onLeft) handlers.onLeft(msg.reason || 'left');
        break;
    }
  }

  function teardown() {
    clearTimeout(reconnectTimer);
    pollRun++;
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
    if (es) { try { es.close(); } catch (e) {} es = null; }
  }

  // ---------- POST 헬퍼 ----------
  function postJSON(body, cb) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
    fetch('action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store'
    }).then(function (r) { return r.json(); })
      .then(function (m) { clearTimeout(to); cb(null, m); })
      .catch(function (e) { clearTimeout(to); cb(e, null); });
  }

  function helloAction() {
    return { type: 'hello', token: token, name: myName, protocolVersion: PROTO, since: lastVersion };
  }

  // ---------- WebSocket ----------
  function tryWS() {
    mode = 'ws';
    status('connecting');
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    var gotWelcome = false;
    try { ws = new WebSocket(url); } catch (e) { nextTier(); return; }
    var sock = ws;
    var watchdog = setTimeout(function () {
      if (!gotWelcome) { try { sock.close(); } catch (e) {} }
    }, 5000);
    sock.onopen = function () {
      sock.send(JSON.stringify({ type: 'hello', token: token, name: myName, protocolVersion: PROTO }));
    };
    sock.onmessage = function (ev) {
      lastEventAt = Date.now();
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'welcome') { gotWelcome = true; clearTimeout(watchdog); retries = 0; status('connected'); }
      route(m);
    };
    sock.onclose = function () {
      clearTimeout(watchdog);
      if (ws !== sock) return;
      ws = null;
      if (!alive) return;
      if (!gotWelcome) nextTier();
      else scheduleReconnect();
    };
    sock.onerror = function () { /* onclose에서 처리 */ };
  }

  // ---------- SSE ----------
  function trySSE() {
    mode = 'sse';
    status('connecting');
    postJSON({ token: token, action: helloAction() }, function (err, m) {
      if (err || !m || m.type !== 'welcome') { nextTier(); return; }
      route(m);
      openES();
    });
  }
  function openES() {
    if (!alive) return;
    var src = new EventSource('events?token=' + encodeURIComponent(token) + '&since=' + lastVersion);
    es = src;
    var got = false;
    var watchdog = setTimeout(function () {
      if (!got) { try { src.close(); } catch (e) {} if (es === src) { es = null; nextTier(); } }
    }, 6000);
    src.onopen = function () { status('connected'); };
    src.onmessage = function (ev) {
      got = true;
      lastEventAt = Date.now();
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      route(m);
    };
    src.addEventListener('hb', function () { got = true; lastEventAt = Date.now(); });
    src.onerror = function () {
      if (!got) {
        clearTimeout(watchdog);
        try { src.close(); } catch (e) {}
        if (es === src) { es = null; nextTier(); }
      } else {
        status('reconnecting'); // EventSource가 자동 재시도
      }
    };
  }

  // ---------- long-poll ----------
  function tryPoll() {
    mode = 'poll';
    status('connecting');
    postJSON({ token: token, action: helloAction() }, function (err, m) {
      if (err || !m || m.type !== 'welcome') { failAll(); return; }
      route(m);
      status('connected');
      pollLoop(++pollRun);
    });
  }
  function pollLoop(run) {
    if (!alive || mode !== 'poll' || run !== pollRun) return;
    fetch('poll?token=' + encodeURIComponent(token) + '&since=' + lastVersion, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (m) {
        if (run !== pollRun) return;
        lastEventAt = Date.now();
        status('connected');
        if (m && m.messages) m.messages.forEach(route);
        else if (m && m.type) route(m);
        pollLoop(run);
      })
      .catch(function () {
        if (run !== pollRun) return;
        status('reconnecting');
        setTimeout(function () { pollLoop(run); }, 2500);
      });
  }

  // ---------- 연결 흐름 ----------
  function connect(name) {
    if (name != null) myName = name;
    if (!alive) return;
    teardown();
    tierIdx = 0;
    tryTier();
  }
  function tryTier() {
    var t = tiers[tierIdx];
    if (t === 'ws') tryWS();
    else if (t === 'sse') trySSE();
    else if (t === 'poll') tryPoll();
    else failAll();
  }
  function nextTier() {
    tierIdx++;
    if (tierIdx >= tiers.length) failAll();
    else tryTier();
  }
  function failAll() {
    status('offline');
    retries++;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () { connect(); }, Math.min(12000, 1500 * retries));
  }
  function scheduleReconnect() {
    if (!alive) return;
    status('reconnecting');
    var d = Math.min(8000, 800 * Math.pow(2, retries++));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () { connect(); }, d);
  }

  // 화면 복귀 시 즉시 재동기화 (모바일 백그라운드 대응)
  function onVisible() {
    if (document.visibilityState !== 'visible' || !alive) return;
    if (mode === 'ws' && (!ws || ws.readyState !== 1)) { clearTimeout(reconnectTimer); retries = 0; connect(); }
    else if (mode === 'sse' && Date.now() - lastEventAt > 45000) { connect(); }
    else if (mode === 'poll' && Date.now() - lastEventAt > 60000) { connect(); }
  }
  document.addEventListener('visibilitychange', onVisible);

  // ---------- 액션 전송 ----------
  function needsVersion(t) { return t === 'play_cards' || t === 'pass_turn'; }
  function send(action) {
    var a = {};
    for (var k in action) a[k] = action[k];
    a.actionId = clientId + '-' + runSalt + '-' + (++actionCounter);
    if (needsVersion(a.type) && a.version == null) a.version = lastVersion;
    if (needsVersion(a.type) && a.gver == null) a.gver = lastGver;
    if (mode === 'ws' && ws && ws.readyState === 1) {
      ws.send(JSON.stringify(a));
      return;
    }
    a._try = 0;
    postQueue.push(a);
    drainQueue();
  }
  function drainQueue() {
    if (posting || !postQueue.length) return;
    posting = true;
    var a = postQueue.shift();
    postJSON({ token: token, action: a }, function (err, m) {
      posting = false;
      if (err) {
        a._try++;
        if (a._try <= 2) { postQueue.unshift(a); setTimeout(drainQueue, 1200); }
        else if (handlers.onAck) handlers.onAck({ type: 'action_ack', actionId: a.actionId, ok: false, error: { code: 'NETWORK', message: '전송 실패 — 연결을 확인하세요' } });
        return;
      }
      if (m) route(m);
      drainQueue();
    });
  }

  function destroy() {
    alive = false;
    teardown();
    document.removeEventListener('visibilitychange', onVisible);
  }

  return {
    mode: 'online',
    connect: connect,
    send: send,
    destroy: destroy,
    getTransport: function () { return mode; }
  };
}

return { create: create, PROTO: PROTO };
})();
