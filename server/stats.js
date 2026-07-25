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

function blank() {
  return {
    games: 0, wins: 0,
    rounds: 0, pts: 0,             // 라운드 수, 누적 점수차(내 팀 기준)
    tichu: 0, tichuOk: 0,
    grand: 0, grandOk: 0,
    oneTwo: 0,                     // 우리 팀 원투 완주
    partners: Object.create(null), // 파트너 닉네임 → { g, w }
    updated: 0
  };
}

function load() {
  try {
    var raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) {
        var s = raw[k];
        if (s && typeof s.games === 'number') { stats[k] = s; s.partners = s.partners || Object.create(null); }
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

/* 게임(목표점수 도달) 종료 시 호출 — 승패와 파트너 궁합. */
function recordGame(seatNames, winnerTeam) {
  if (!winnerTeam) return;
  for (var s = 0; s < 4; s++) {
    var nm = seatNames[s];
    if (!nm) continue;
    var st = get(nm);
    var won = (winnerTeam === 'A') === (s % 2 === 0);
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
        tichu: s.tichu, tichuOk: s.tichuOk,
        grand: s.grand, grandOk: s.grandOk,
        oneTwo: s.oneTwo
      };
    })
    .sort(function (a, b) { return b.rate - a.rate || b.games - a.games; })
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
    rounds: s.rounds, ppr: s.rounds ? s.pts / s.rounds : 0,
    tichu: s.tichu, tichuOk: s.tichuOk, grand: s.grand, grandOk: s.grandOk,
    oneTwo: s.oneTwo, partners: partners
  };
}

load();
module.exports = { recordRound: recordRound, recordGame: recordGame, board: board, detail: detail, save: save };
