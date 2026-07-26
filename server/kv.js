/* Cloudflare KV 최소 클라이언트 — 의존성 0(Node 18+ 내장 fetch).
 *
 * 왜 필요한가: Render 무료 티어는 배포뿐 아니라 15분 유휴 후에도 컨테이너를 재생성한다.
 * 디스크가 매번 초기화되므로 전적·Elo를 외부에 둬야 한다. KV는 무료 한도(읽기 10만/일,
 * 쓰기 1,000/일)가 우리 사용량의 수백 배라 사실상 무료다.
 *
 * 설정(전부 있어야 켜진다. 하나라도 없으면 비활성 → 기존 파일 저장만 동작):
 *   CF_ACCOUNT_ID       Cloudflare 계정 ID
 *   CF_KV_NAMESPACE_ID  KV 네임스페이스 ID
 *   CF_KV_TOKEN         API 토큰 (권한: Workers KV Storage:Edit 하나면 충분)
 *   CF_API_BASE         (선택) 테스트용 엔드포인트 치환
 */
'use strict';

var ACCOUNT = process.env.CF_ACCOUNT_ID || '';
var NS = process.env.CF_KV_NAMESPACE_ID || '';
var TOKEN = process.env.CF_KV_TOKEN || '';
var BASE = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';
var TIMEOUT_MS = 8000;

function enabled() { return !!(ACCOUNT && NS && TOKEN); }

function url(key) {
  return BASE + '/accounts/' + encodeURIComponent(ACCOUNT) +
    '/storage/kv/namespaces/' + encodeURIComponent(NS) +
    '/values/' + encodeURIComponent(key);
}

function withTimeout(ms) {
  // AbortSignal.timeout은 Node 17.3+. 없으면 수동 컨트롤러로 대체.
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return { signal: AbortSignal.timeout(ms) };
  var ac = new AbortController();
  var t = setTimeout(function () { ac.abort(); }, ms);
  if (t.unref) t.unref();
  return { signal: ac.signal, clear: function () { clearTimeout(t); } };
}

/* 값 읽기. 없으면 null, 오류면 예외(호출측이 파일 폴백을 쓰도록). */
async function get(key) {
  if (!enabled()) return null;
  var to = withTimeout(TIMEOUT_MS);
  try {
    var r = await fetch(url(key), {
      headers: { Authorization: 'Bearer ' + TOKEN },
      signal: to.signal
    });
    if (r.status === 404) return null;                 // 키 없음 = 첫 실행
    if (!r.ok) throw new Error('KV GET ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return await r.text();
  } finally { if (to.clear) to.clear(); }
}

/* 값 쓰기.
 * CF는 multipart/form-data(value 필드)를 문서화된 형식으로 받고, 원시 본문도 받아준다.
 * 배포처의 API 버전 차이로 실패하는 일이 없도록 multipart를 먼저 시도하고
 * 4xx면 원시 본문으로 한 번 더 시도한다(둘 다 실패해야 오류). */
async function put(key, value) {
  if (!enabled()) return false;
  var attempts = [];
  if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
    attempts.push(function () {
      var fd = new FormData();
      fd.append('value', new Blob([value], { type: 'application/json' }));
      fd.append('metadata', '{}');
      return { body: fd, headers: {} };
    });
  }
  attempts.push(function () {
    return { body: value, headers: { 'Content-Type': 'text/plain' } };
  });

  var lastErr = null;
  for (var i = 0; i < attempts.length; i++) {
    var spec = attempts[i]();
    var to = withTimeout(TIMEOUT_MS);
    try {
      var headers = Object.assign({ Authorization: 'Bearer ' + TOKEN }, spec.headers);
      var r = await fetch(url(key), { method: 'PUT', headers: headers, body: spec.body, signal: to.signal });
      if (r.ok) return true;
      lastErr = new Error('KV PUT ' + r.status + ' ' + (await r.text()).slice(0, 200));
      if (r.status >= 500) throw lastErr;              // 서버 오류는 형식 문제가 아니므로 재시도 무의미
    } catch (e) {
      lastErr = e;
    } finally { if (to.clear) to.clear(); }
  }
  throw lastErr || new Error('KV PUT 실패');
}

module.exports = { enabled: enabled, get: get, put: put };
