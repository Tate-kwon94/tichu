/* 전적 저장 — 닉네임 기반, 계정·비밀번호 없음.
 *
 * 왜 닉네임인가: 동료끼리 하는 게임이라 도용 걱정이 적고, 폰↔PC를 오가도 전적이 이어진다.
 * (토큰 기반이면 기기가 바뀌는 순간 남이 된다.)
 *
 * 저장 2층:
 *   ① data/stats.json — 항상. 로컬 개발·자체 호스팅에선 이것만으로 충분.
 *   ② Cloudflare KV — 환경변수가 있을 때만. Render 무료는 배포뿐 아니라 15분 유휴 후에도
 *      컨테이너를 재생성해 디스크가 날아가므로, 외부에 두지 않으면 전적이 매일 초기화된다.
 * 클라이언트도 자기 전적을 localStorage에 백업한다(서버가 날아가도 개인 기록은 남음).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var KV = require('./kv.js');

// 테스트가 실 전적 파일을 오염시키지 않도록 경로를 열어둔다(미지정 시 기존 경로)
var FILE = process.env.TICHU_STATS_FILE || path.join(__dirname, '..', 'data', 'stats.json');
var KV_KEY = process.env.CF_KV_KEY || 'tichu:stats:v1';
var KV_PROBE_KEY = KV_KEY + ':probe';   // 권한 점검은 반드시 데이터 키 밖에서 (덮어쓰면 전량 소멸)
var MAX_PLAYERS = 500;          // 닉네임 수 상한 — 메모리·파일 비대 방지
var SAVE_DEBOUNCE_MS = 5000;
/* KV 쓰기 최소 간격 — 무료 한도가 쓰기 1,000/일이라 병적인 루프에 대비한 안전판.
 * 실사용(게임 종료마다 1회, 하루 수십 판)에선 걸리지 않는다. */
var KV_MIN_INTERVAL_MS = 120000;

var stats = Object.create(null);  // 닉네임 → 집계
var saveTimer = null;
var dirty = false;
var kvLastPut = 0;
var kvInflight = null;           // 진행 중인 PUT의 Promise — 종료 플러시가 이걸 기다려야 한다
var kvVer = 0;                   // 변경 카운터 — 낡은 스냅샷으로 dirty를 지우지 않기 위해
var kvCatchup = null;            // 간격 제한에 막힌 쓰기를 따라잡는 타이머
var kvAssumedEmpty = false;      // 하이드레이션이 "키 없음"으로 결론냈다 → 첫 덮어쓰기 전에 재확인
var kvDirty = false;             // 파일과 별개 추적 — KV는 간격 제한이 있어 밀릴 수 있다
var shuttingDown = false;        // 종료 플러시 후 쓰기 금지(신 인스턴스 데이터 덮어쓰기 방지)
var hydrated = !KV.enabled();    // KV 미사용이면 동기 load()로 끝 → 처음부터 준비 완료
var kvProbe = null;              // 부팅 점검 결과: read | write | readonly | error
var kvRestored = 0;              // KV에서 복원한 인원
var kvLastErr = null;
var kvHint = null;             // 401/403일 때 토큰 검증으로 얻은 원인 갈래
var pending = [];                // 하이드레이션 전 도착한 기록(부팅 직후 수초) — 순서대로 재생
var MAX_PENDING = 200;

/* ── Elo ──────────────────────────────────────────────────────────────
 * 봇을 고정 앵커로 쓴다. 봇 단수는 동결(1단·2단)이라 기준점이 흔들리지 않으므로,
 * 사람 실력을 절대 척도로 잴 수 있다("나는 2단을 40% 이긴다 → 2단보다 70점 아래").
 * 봇 Elo는 절대 갱신하지 않는다.
 *
 * 앵커 근거: 2단 vs 1단 실측 승률 60.0%(240판) → Elo 차 +70.
 * (점수차로는 66%지만 Elo는 승률 기반이라 +70이 맞다. 티츄는 운이 커서
 *  실력 우위가 승률로 잘 안 옮겨진다.)
 */
var ELO_START = 1000;
var BOT_ELO = { easy: 700, normal: 850, hard: 950, super: 1000, super2: 1070, super3: 1100, super4: 1130, devil: 1400 };
// super3 앵커 근거: 승단전 1,920게임 명목 승률 54.1% vs 2단 → Elo 차 +29 ≈ 1070+30.
// super4 앵커 근거: 3단 대비 예산 4배(3800ms). 승단전 2,880게임 3표본 풀링 +4.97±1.12(53.6%),
// 이질성 Q=3.55 임계 이하 = 표본 일관. 3단(1100)에서 같은 폭(+30)으로 1130.
var ELO_DAILY_CAP = 60;          // 하루 변동 상한 — 몰아치기 방지
/* 봇전 가중치 — 승패 '양쪽 모두' 절반. 대칭이어야 하는 이유:
 * 승리만 깎으면 억제가 아니라 편향이 된다(실측: 2단과 동급인 사람이 955로 수렴 →
 * 브론즈로 표시. 티어의 의미 "골드=2단 격파"가 깨진다). 대칭이면 수렴점은 실력 그대로이고
 * 봇 게임의 '학습 속도'만 절반이 되어, 순위는 사람끼리의 대전이 더 크게 좌우한다.
 * 파밍 자체는 Elo의 기대승률 보정(오를수록 이득 0에 수렴)과 일일 상한이 막는다. */
var BOT_GAME_FACTOR = 0.5;

function kFactor(games) { return games < 10 ? 32 : games < 30 ? 16 : 10; }
function expectedScore(mine, theirs) { return 1 / (1 + Math.pow(10, (theirs - mine) / 400)); }

function tierOf(elo) {
  if (elo >= BOT_ELO.super2 + 100) return 'diamond';
  if (elo >= BOT_ELO.super2) return 'gold';
  if (elo >= BOT_ELO.super) return 'silver';
  return 'bronze';
}

function blank() {
  return {
    games: 0, wins: 0,
    rounds: 0, pts: 0,             // 라운드 수, 누적 점수차(내 팀 기준)
    tichu: 0, tichuOk: 0,
    grand: 0, grandOk: 0,
    oneTwo: 0,                     // 우리 팀 원투 완주
    partners: Object.create(null), // 파트너 닉네임 → { g, w }
    elo: ELO_START, eloPeak: ELO_START,
    eloDay: '', eloToday: 0,       // 일일 상한 추적
    updated: 0
  };
}

function adopt(raw, where) {
  var n = 0;
  Object.keys(raw).forEach(function (k) {
    var s = raw[k];
    if (s && typeof s.games === 'number') {
      stats[k] = s;
      /* JSON.parse가 만든 객체는 Object.prototype을 상속한다. 파트너 맵에 '__proto__' 같은
       * 키가 섞이면 이후 대입이 프로토타입을 오염시켜 전혀 무관한 코드가 깨진다.
       * 널 프로토타입으로 다시 지어 그 통로를 막는다. */
      var pp = Object.create(null);
      var src = s.partners || {};
      Object.keys(src).forEach(function (pk) { pp[pk] = src[pk]; });
      s.partners = pp;
      if (typeof s.elo !== 'number') { s.elo = ELO_START; s.eloPeak = ELO_START; s.eloDay = ''; s.eloToday = 0; }
      n++;
    }
  });
  console.log('[tichu] 전적 로드 ' + n + '명 (' + where + ')');
}

function load() {
  try {
    var raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') adopt(raw, '파일');
  } catch (e) { /* 파일 없음/손상 — 빈 상태로 시작 */ }
}

/* KV에서 부팅 시 1회 복원. 원격이 정본이다 — 이 컨테이너의 파일은 방금 만들어진 빈 디스크거나
 * (드물게) 같은 인스턴스가 남긴 사본이라, 둘이 다르면 원격이 더 완전하다.
 * 하이드레이션 도중 들어온 기록은 pending에 쌓았다가 복원 뒤 순서대로 재생한다
 * (병합으로 때우면 "원격 50판 vs 메모리 1판" 충돌에서 한쪽을 반드시 잃는다). */
async function hydrate() {
  try {
    var body = await KV.get(KV_KEY);
    /* CF KV는 결과적 일관성이라 존재하는 키에도 일시적으로 "없음"이 올 수 있다.
     * 없음을 그대로 믿으면 이후 첫 저장이 전량을 덮어쓴다 — 한 번 더 물어본다. */
    if (body == null) {
      await new Promise(function (r) { setTimeout(r, 800); });
      body = await KV.get(KV_KEY);
    }
    if (body) {
      var raw = JSON.parse(body);
      if (raw && typeof raw === 'object') {
        Object.keys(stats).forEach(function (k) { delete stats[k]; });
        adopt(raw, 'KV');
        kvRestored = Object.keys(stats).length;
      }
      kvProbe = 'read';
    } else {
      /* 키가 없으면 빈 값을 한 번 써 본다 — 첫 실행 초기화 겸 쓰기 권한 점검.
       * 이게 없으면 토큰이 Read 전용이어도 부팅은 멀쩡히 되고, 몇 시간 뒤 첫 게임에서야
       * 조용히 저장에 실패한다. 권한 문제는 배포 직후에 드러나야 한다. */
      console.log('[tichu] KV에 전적 없음 — 새로 시작');
      kvAssumedEmpty = true;
      try {
        await KV.put(KV_PROBE_KEY, String(Date.now()));   // 데이터 키는 절대 건드리지 않는다
        kvProbe = 'write';
        console.log('[tichu] KV 쓰기 권한 확인 OK');
      } catch (e2) {
        kvProbe = 'readonly';
        kvLastErr = e2.message;
        console.error('[tichu] KV 쓰기 실패 — 토큰 권한이 Edit인지 확인:', e2.message);
      }
    }
  } catch (e) {
    kvProbe = 'error';
    kvLastErr = e.message;      // 밖에서 보여야 진단이 된다(/stats의 persist.lastError)
    console.error('[tichu] KV 복원 실패 — 파일 상태로 계속:', e.message);
    if (/40[13]/.test(e.message)) {
      try {
        var v = await KV.verifyToken();
        kvHint = v.why;
        console.error('[tichu] 토큰 검증: ' + (v.ok ? '유효' : '무효') + ' — ' + v.why);
      } catch (e3) { /* 진단 실패는 무시 */ }
    }
  } finally {
    hydrated = true;
    var q = pending; pending = [];
    q.forEach(function (job) { try { job(); } catch (e) { /* 개별 기록 실패는 무시 */ } });
    if (q.length) console.log('[tichu] 부팅 중 도착한 기록 ' + q.length + '건 재생');
  }
}

function saveFile() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(stats));
    fs.renameSync(FILE + '.tmp', FILE);   // 원자적 교체 — 쓰다 죽어도 기존 파일 보존
  } catch (e) { console.error('[tichu] 전적 저장 실패', e.message); }
}

/* KV 기록.
 * 세 가지를 지킨다:
 *   ① 종료 플러시(force)는 진행 중 PUT을 기다렸다가 다시 쓴다 — 그냥 건너뛰면 조용히 유실된다.
 *   ② dirty 해제는 "이 스냅샷 이후 변경이 없었을 때"만. PUT 왕복 중 들어온 기록을
 *      저장된 것으로 처리하면 그 기록은 어디에도 안 남는다.
 *   ③ 간격 제한에 막히면 따라잡기 타이머를 걸어, 세션 마지막 게임이 종료까지 미뤄지지 않게 한다. */
async function saveKV(force) {
  if (!KV.enabled() || !kvDirty || shuttingDown) return;
  if (kvInflight) {
    if (!force) return;                          // 평상시엔 다음 저장이 따라잡는다
    try { await kvInflight; } catch (e) { /* 진행 중 실패는 아래에서 다시 쓴다 */ }
    if (!kvDirty || shuttingDown) return;
  }
  var wait = KV_MIN_INTERVAL_MS - (Date.now() - kvLastPut);
  if (!force && wait > 0) {
    if (!kvCatchup) {
      kvCatchup = setTimeout(function () { kvCatchup = null; saveKV(false); }, wait + 100);
      if (kvCatchup.unref) kvCatchup.unref();
    }
    return;
  }
  var snapVer = kvVer;
  var p = (async function () {
    try {
      /* 하이드레이션이 "키 없음"으로 결론냈다면, 첫 덮어쓰기 직전에 한 번 더 확인한다.
       * 그 결론이 일시적 404였다면 지금 원격에 남의 전적이 있고, 그대로 쓰면 전량 소멸한다. */
      if (kvAssumedEmpty) {
        var cur = null;
        try { cur = await KV.get(KV_KEY); } catch (e0) { cur = null; }
        if (cur && cur.trim() && cur.trim() !== '{}') {
          console.error('[tichu] KV에 예상치 못한 기존 전적 발견 — 덮어쓰기 취소하고 복원한다');
          try {
            var raw2 = JSON.parse(cur);
            if (raw2 && typeof raw2 === 'object') {
              Object.keys(stats).forEach(function (k) { delete stats[k]; });
              adopt(raw2, 'KV 복구');
              kvRestored = Object.keys(stats).length;
            }
          } catch (e1) { /* 파싱 실패면 그냥 덮어쓰지 않는 것으로 충분 */ }
          kvAssumedEmpty = false;
          kvLastErr = '기존 전적 발견으로 덮어쓰기 취소(복원함)';
          return;
        }
        kvAssumedEmpty = false;
      }
      await KV.put(KV_KEY, JSON.stringify(stats));
      kvLastPut = Date.now();
      if (kvVer === snapVer) kvDirty = false;    // 그 사이 변경이 있었으면 dirty 유지
      kvLastErr = null;
    } catch (e) {
      kvLastErr = e.message;
      console.error('[tichu] KV 저장 실패(다음 기회에 재시도):', e.message);
    }
  })();
  kvInflight = p;
  try { await p; } finally { if (kvInflight === p) kvInflight = null; }
}

function save() {
  saveTimer = null;
  if (!dirty) return;
  dirty = false;
  saveFile();
  saveKV(false);
}
function scheduleSave() {
  dirty = true;
  kvDirty = true;
  kvVer++;                      // 진행 중 PUT의 스냅샷을 낡은 것으로 표시
  if (saveTimer) return;
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

/* 종료 직전 마지막 플러시 — Render는 배포·유휴 절전 전에 SIGTERM을 보낸다.
 * 플러시 후 shuttingDown을 세워, 교체된 신 인스턴스의 데이터를 뒤늦게 덮어쓰지 않게 한다. */
async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (kvCatchup) { clearTimeout(kvCatchup); kvCatchup = null; }
  if (dirty) { dirty = false; saveFile(); }
  await saveKV(true);
  shuttingDown = true;
}

// 닉네임 수가 상한을 넘으면 가장 오래된 것부터 정리
function evictIfNeeded() {
  var keys = Object.keys(stats);
  if (keys.length <= MAX_PLAYERS) return;
  keys.sort(function (a, b) { return (stats[a].updated || 0) - (stats[b].updated || 0); });
  for (var i = 0; i < keys.length - MAX_PLAYERS; i++) delete stats[keys[i]];
}

function get(name) {
  if (!stats[name]) { stats[name] = blank(); evictIfNeeded(); }
  return stats[name];
}

/* 하이드레이션 전 도착한 기록을 큐에 넣는다(부팅 직후 수백 ms 창).
 * KV가 죽어 하이드레이션이 안 끝나도 큐가 무한히 자라지 않게 상한을 둔다. */
function defer(job) {
  if (pending.length < MAX_PENDING) pending.push(job);
}

/* 라운드 종료 시 호출 — 라운드 단위 지표(티츄 성패·원투·점수차)를 쌓는다.
 * seatNames: [좌석0..3 이름 또는 null(봇)]. 봇은 집계하지 않는다. */
function recordRound(seatNames, summary) {
  if (!summary) return;
  if (!hydrated) return defer(function () { recordRound(seatNames, summary); });
  var d = summary.deltas || { teamA: 0, teamB: 0 };
  for (var s = 0; s < 4; s++) {
    var nm = seatNames[s];
    if (!nm) continue;                       // 봇 제외
    var st = get(nm);
    st.rounds++;
    st.pts += (s % 2 === 0) ? (d.teamA - d.teamB) : (d.teamB - d.teamA);
    if (summary.oneTwoTeam && ((summary.oneTwoTeam === 'A') === (s % 2 === 0))) st.oneTwo++;
    st.updated = Date.now();
  }
  (summary.bonuses || []).forEach(function (b) {
    var nm2 = seatNames[b.seat];
    if (!nm2) return;
    var st2 = get(nm2);
    if (b.call === 'grand') { st2.grand++; if (b.made) st2.grandOk++; }
    else { st2.tichu++; if (b.made) st2.tichuOk++; }
    st2.updated = Date.now();
  });
  scheduleSave();
}

/* 게임(목표점수 도달) 종료 시 호출 — 승패·파트너 궁합·Elo.
 * seatNames[s] = 사람 닉네임 또는 null(봇), seatBots[s] = 봇 단수 키('super2' 등) 또는 null. */
function recordGame(seatNames, winnerTeam, seatBots) {
  if (!winnerTeam) return;
  if (!hydrated) return defer(function () { recordGame(seatNames, winnerTeam, seatBots); });
  seatBots = seatBots || [];

  // 좌석별 현재 Elo — 사람은 기록값, 봇은 고정 앵커
  var seatElo = [0, 1, 2, 3].map(function (s) {
    if (seatNames[s]) return get(seatNames[s]).elo;
    return BOT_ELO[seatBots[s]] != null ? BOT_ELO[seatBots[s]] : BOT_ELO.normal;
  });
  var teamElo = [(seatElo[0] + seatElo[2]) / 2, (seatElo[1] + seatElo[3]) / 2];
  var teamHasBot = [!seatNames[0] || !seatNames[2], !seatNames[1] || !seatNames[3]];
  var today = new Date().toISOString().slice(0, 10);

  for (var s = 0; s < 4; s++) {
    var nm = seatNames[s];
    if (!nm) continue;                          // 봇은 갱신하지 않는다(앵커)
    var st = get(nm);
    var team = s % 2, won = (winnerTeam === 'A') === (team === 0);

    // Elo: 팀 평균끼리 겨룬 것으로 보고 개인에게 적용
    var exp = expectedScore(teamElo[team], teamElo[1 - team]);
    var delta = kFactor(st.games) * ((won ? 1 : 0) - exp);
    // 봇전은 승패 모두 절반 — 대칭이라 수렴점(=실력)은 그대로, 반영 속도만 느려진다
    if (teamHasBot[1 - team]) delta *= BOT_GAME_FACTOR;
    // 일일 상한
    if (st.eloDay !== today) { st.eloDay = today; st.eloToday = 0; }
    var room = ELO_DAILY_CAP - Math.abs(st.eloToday);
    if (room <= 0) delta = 0;
    else if (Math.abs(delta) > room) delta = delta > 0 ? room : -room;
    st.eloToday += delta;
    st.elo = Math.round((st.elo + delta) * 10) / 10;
    if (st.elo > st.eloPeak) st.eloPeak = st.elo;

    st.games++;
    if (won) st.wins++;
    var pn = seatNames[(s + 2) % 4];
    if (pn) {                                 // 파트너가 사람일 때만 궁합 집계
      var p = st.partners[pn] || (st.partners[pn] = { g: 0, w: 0 });
      p.g++; if (won) p.w++;
    }
    st.updated = Date.now();
  }
  scheduleSave();
}

// 리더보드 — 게임 3판 이상만(표본 부족한 100% 승률 배제), 승률 순
function board(limit) {
  return Object.keys(stats)
    .filter(function (n) { return stats[n].games >= 3; })
    .map(function (n) {
      var s = stats[n];
      return {
        name: n, games: s.games, wins: s.wins,
        rate: s.games ? s.wins / s.games : 0,
        ppr: s.rounds ? s.pts / s.rounds : 0,          // 라운드당 점수차
        elo: Math.round(s.elo), tier: tierOf(s.elo),
        provisional: s.games < 10,                     // 10판 미만은 잠정
        tichu: s.tichu, tichuOk: s.tichuOk,
        grand: s.grand, grandOk: s.grandOk,
        oneTwo: s.oneTwo
      };
    })
    .sort(function (a, b) { return b.elo - a.elo || b.games - a.games; })
    .slice(0, limit || 20);
}

/* 로비 표기용 경량 조회 — 없으면 null(첫 게임). detail()과 달리 파트너 목록 등 무거운 것 제외 */
function brief(name) {
  var s = stats[name];
  if (!s) return null;
  return { elo: Math.round(s.elo), tier: tierOf(s.elo), games: s.games, wins: s.wins, provisional: s.games < 10 };
}

// 개인 상세 — 파트너 궁합 포함
function detail(name) {
  var s = stats[name];
  if (!s) return null;
  var partners = Object.keys(s.partners).map(function (p) {
    return { name: p, games: s.partners[p].g, wins: s.partners[p].w };
  }).sort(function (a, b) { return b.games - a.games; }).slice(0, 8);
  return {
    name: name, games: s.games, wins: s.wins,
    rate: s.games ? s.wins / s.games : 0,
    elo: Math.round(s.elo), eloPeak: Math.round(s.eloPeak || s.elo),
    tier: tierOf(s.elo), provisional: s.games < 10,
    anchors: { dan1: BOT_ELO.super, dan2: BOT_ELO.super2, dan3: BOT_ELO.super3 },
    rounds: s.rounds, ppr: s.rounds ? s.pts / s.rounds : 0,
    tichu: s.tichu, tichuOk: s.tichuOk, grand: s.grand, grandOk: s.grandOk,
    oneTwo: s.oneTwo, partners: partners
  };
}

/* 저장 상태 — /stats에 함께 실어 보내 배포 직후 눈으로 확인할 수 있게 한다.
 * (Render 로그를 열지 않고도 "영구저장이 켜졌나"를 밖에서 확인할 수 있어야 한다.) */
function status(diagOk) {
  var st = {
    /* Render가 넣어주는 배포 커밋 — "새 코드가 실제로 떴는가"를 밖에서 확인하려면 필요하다.
     * 이게 없어서 방금 배포가 반영됐는지 아닌지로 한 번 헤맸다. */
    rev: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),
    mode: KV.enabled() ? 'kv' : 'file',
    ready: hydrated,
    probe: kvProbe,              // read=복원함 write=쓰기확인 readonly=권한부족 error=연결실패
    restored: kvRestored,
    players: Object.keys(stats).length,
    lastError: diagOk ? kvLastErr : (kvLastErr ? '있음(로그 확인)' : null)
  };
  /* 진단 세부(자격증명 길이·문자구성·CF 오류 본문)는 공개 엔드포인트에 실지 않는다.
   * TICHU_DIAG와 일치하는 키를 준 호출에만 — 로그(console.error)에는 항상 남는다. */
  if (KV.enabled() && (kvProbe === 'error' || kvProbe === 'readonly') && diagOk) {
    st.config = KV.shape();
    st.hint = kvHint;
  }
  return st;
}

load();
if (KV.enabled()) {
  console.log('[tichu] 전적 영구저장: Cloudflare KV (' + KV_KEY + ')');
  hydrate();
} else {
  console.log('[tichu] 전적 영구저장: 파일만 — 호스팅이 디스크를 지우면 초기화됨');
}

module.exports = {
  recordRound: recordRound, recordGame: recordGame,
  board: board, detail: detail, brief: brief,
  save: save, flush: flush, status: status, BOT_ELO: BOT_ELO
};
