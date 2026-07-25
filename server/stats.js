/* 전적 저장 — 닉네임 기반, 계정·비밀번호 없음.
 *
 * 왜 닉네임인가: 동료끼리 하는 게임이라 도용 걱정이 적고, 폰↔PC를 오가도 전적이 이어진다.
 * (토큰 기반이면 기기가 바뀌는 순간 남이 된다.)
 *
 * 저장: data/stats.json에 디바운스 기록. Render 무료는 재시작 시 디스크가 날아가므로
 * 클라이언트도 자기 전적을 localStorage에 백업한다(서버가 날아가도 개인 기록은 남음).
 */
'use strict';
var fs = require('fs');
var path = require('path');

var FILE = path.join(__dirname, '..', 'data', 'stats.json');
var MAX_PLAYERS = 500;          // 닉네임 수 상한 — 메모리·파일 비대 방지
var SAVE_DEBOUNCE_MS = 5000;

var stats = Object.create(null);  // 닉네임 → 집계
var saveTimer = null;
var dirty = false;

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
var BOT_ELO = { easy: 700, normal: 850, hard: 950, super: 1000, super2: 1070, devil: 1400 };
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

function load() {
  try {
    var raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) {
        var s = raw[k];
        if (s && typeof s.games === 'number') {
          stats[k] = s;
          s.partners = s.partners || Object.create(null);
          if (typeof s.elo !== 'number') { s.elo = ELO_START; s.eloPeak = ELO_START; s.eloDay = ''; s.eloToday = 0; }
        }
      });
      console.log('[tichu] 전적 로드 ' + Object.keys(stats).length + '명');
    }
  } catch (e) { /* 파일 없음/손상 — 빈 상태로 시작 */ }
}

function save() {
  saveTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(stats));
    fs.renameSync(FILE + '.tmp', FILE);   // 원자적 교체 — 쓰다 죽어도 기존 파일 보존
  } catch (e) { console.error('[tichu] 전적 저장 실패', e.message); }
}
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
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

/* 라운드 종료 시 호출 — 라운드 단위 지표(티츄 성패·원투·점수차)를 쌓는다.
 * seatNames: [좌석0..3 이름 또는 null(봇)]. 봇은 집계하지 않는다. */
function recordRound(seatNames, summary) {
  if (!summary) return;
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
    anchors: { dan1: BOT_ELO.super, dan2: BOT_ELO.super2 },
    rounds: s.rounds, ppr: s.rounds ? s.pts / s.rounds : 0,
    tichu: s.tichu, tichuOk: s.tichuOk, grand: s.grand, grandOk: s.grandOk,
    oneTwo: s.oneTwo, partners: partners
  };
}

load();
module.exports = { recordRound: recordRound, recordGame: recordGame, board: board, detail: detail, save: save, BOT_ELO: BOT_ELO };
