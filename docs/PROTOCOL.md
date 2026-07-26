# 통신 규약 (protocolVersion: 1)

클라이언트와 서버가 주고받는 메시지 계약. `client/transport.js` ↔ `server/rooms.js` 가 이 문서와 일치해야 한다.

## 기본 원칙

- 모든 메시지는 JSON. `type` 필드(snake_case) 필수.
- **스냅샷 전체 동기화**: 서버는 변경 시마다 플레이어별로 가려진(redacted) 전체 스냅샷을 보낸다.
  델타/리플레이 없음 → 재접속·폴백·복구가 전부 "최신 스냅샷 1개"로 해결된다.
- `version`: 방 단위 단조 증가(스냅샷 순번 — 재접속·참석 변화에도 오름). 클라이언트는 자신이 가진 것보다 낮거나 같은 버전은 버린다.
- `gver`: 게임 상태 버전 — 성공한 게임 액션에만 증가. 플레이의 STALE 판정은 이것으로만 한다(재접속으로 version만 급증해도 정당한 플레이가 거부되지 않게).
- `actionId`: `"<clientId>-<카운터>"`. 서버는 플레이어별 최근 32개를 기억해 재전송 시 같은 ack를 돌려준다(멱등).
- 카드 ID: `S|H|D|C` + `2-9,T,J,Q,K,A` (예: `"ST"`=♠10) + 특수 `"MJ","DG","PH","DR"`.
- 좌석 0–3. 팀 A = 0+2, 팀 B = 1+3. 차례 0→1→2→3 = **반시계 방향**(공식 규칙).
  좌석+1 = 그 사람의 **오른쪽** 사람. 클라이언트는 나를 아래에 두고 좌석+1을 화면 **오른쪽**에
  그린다(왼쪽에 그리면 화면상 시계 방향이 된다). 교환 라벨·`botExchange`의 left/right도 같은 규약.

## 전송 계층 (3단 폴백)

| 순서 | 방식 | 서버 엔드포인트 | 클라→서버 |
|---|---|---|---|
| 1 | WebSocket | `GET /ws` (업그레이드) | WS 프레임 |
| 2 | SSE | `GET /events?token=&since=` | `POST /action` |
| 3 | long-poll | `GET /poll?token=&since=` (최대 25초 대기) | `POST /action` |

- `?transport=ws|sse|poll` URL 파라미터로 강제 가능.
- POST 본문: `{token, action:{type, actionId, ...}}` → 응답 본문이 곧 `action_ack`(또는 hello면 `welcome`).
- SSE: `id:` = version, `event: hb` 하트비트 15초, 본문 `data:` = JSON envelope.
- poll 응답: `{messages:[envelope...]}` 또는 변화 없으면 `{type:'noop', version}`.

## 클라이언트 → 서버

| type | 필드 | 비고 |
|---|---|---|
| `hello` | `token?`, `name?`, `protocolVersion` | 모든 (재)연결의 첫 메시지. 토큰이 방에 묶여 있으면 그대로 복귀 |
| `create_room` | `name` | 생성자가 방장, 좌석 0 |
| `join_room` | `code`, `name` | 빈 좌석 자동 배정. 게임 중이면 봇 자리 이어받기: 본인 세션 토큰으로 전환된 자리(origToken 일치) > 일반 봇 > 타인 전환 자리 순 — 이름은 표시용일 뿐 좌석 권리가 아님. 강퇴 토큰은 재입장 불가. 오류: ROOM_NOT_FOUND / ROOM_FULL / GAME_IN_PROGRESS(봇 자리 없음) / KICKED |
| `take_seat` | `seat` | 대기실에서만 |
| `set_name` | `name` | 대기실에서만, 12자 |
| `add_bot` / `remove_bot` | `seat` | 방장만, 대기실에서만 |
| `kick_player` | `seat` | 방장만. 게임 중이면 그 자리는 봇으로 전환 |
| `start_game` | `targetScore?`(300/500/1000), `botLevel?`(easy/normal/hard/super/super2/super3) | 방장만. 빈자리 봇 채움 → grand. 단(段) 봇: super=1단, super2=2단(+교환 개선), super3=3단(+종반 완전탐색·티츄 가드·트리플 보존) — 탐색 950ms 시간컷, 가중치 shared/weights-super*.json. devil(악마, 상대 패 열람)은 불공정 → 서버에서 거부, 혼자 연습에서만 |
| `list_rooms` | — | 방 목록. ack에 `rooms:[{code,host,occupied,humans,bots,inGame,target}]` 포함 (최신순, 최대 30) |
| `leave_room` | — | 게임 중 나가면 영구 봇 전환 |
| `call_grand` | `call`(bool) | 8장 보고 응답. 4명 모두 응답하면 6장 추가 배분 → exchange |
| `call_tichu` | — | 자기 첫 플레이 전까지 |
| `submit_exchange` | `give`: {상대좌석: 카드ID} ×3 | 전원 제출 시 일괄 교환, 마작 보유자가 선 |
| `play_cards` | `cards[]`, `wish?`(2–14, MJ 포함 시), `version` | **차례 밖 폭탄 끼어들기도 이 메시지** — 서버가 판정 |
| `pass_turn` | `version` | 선두/소원 이행 가능 시 거부 |
| `give_dragon` | `toSeat` | 용 트릭 승자가 상대팀 좌석 지정 |
| `next_round` / `restart_game` | — | 방장(끊겨 있으면 아무 사람) |
| `arrange_seats` | `mode`('order'|'random') | 방장·대기실 전용. 좌석을 참가 순서대로 정렬하거나 무작위로 섞는다(마주 보는 자리 = 한 팀이므로 팀 배정과 같다). 방장 권한은 사람을 따라감 |
| `to_lobby` | — | 게임 종료(또는 라운드 종료) 후 대기실 복귀. 봇 좌석은 비우고 사람은 유지 |
| `chat` | `text`(≤200자) | 방 전체에 브로드캐스트. 제어문자 제거, 0.6초 레이트리밋. 게임 version은 올리지 않음 |

**version/gver 규칙**: `pass_turn`은 버전 게이트 없음 — 엔진(_pass)이 차례·선두·소원을 재검증(정당한 패스가 버전 지연으로 거부되던 버그 해결). `play_cards`는 `gver` 불일치 시 `STALE_VERSION`(gver 없는 구클라이언트는 version 폴백), 단 폭탄(bomb4/bombstraight)은 현재 상태 기준으로 재검증 통과.

## 서버 → 클라이언트

| type | 필드 |
|---|---|
| `welcome` | `token`, `resumed`, `protocolVersion`, `version`, `gver`, `snapshot`(방에 있으면) |
| `room_state` | `version`, `gver`, `snapshot` |
| `action_ack` | `actionId`, `ok`, `version`, `error?{code,message}` |
| `session_replaced` | — (같은 토큰의 새 연결이 생겨 이 연결이 대체됨) |
| `left_room` | `reason`: `kicked` / `room_closed` / `left` |
| `chat` | `seat`, `name`, `text`, `ts` — 스냅샷과 별개 이벤트(버전 무관). 모르는 type은 무시해도 됨 |

에러코드: `ROOM_NOT_FOUND, ROOM_FULL, GAME_IN_PROGRESS, SEAT_TAKEN, NOT_HOST, BAD_PHASE,
NOT_YOUR_TURN, CARDS_NOT_IN_HAND, INVALID_COMBO, COMBO_TOO_LOW, WISH_REQUIRED,
CANNOT_PASS_LEAD, STALE_VERSION, BAD_REQUEST, RATE_LIMITED, KICKED`

## GET /stats — 전적·Elo (인증 없음, 동료 내부용)
- `GET /stats` → `{ board: [...상위 20], persist: {rev, mode, ready, probe, restored, players, lastError} }`
  - `persist`는 영구저장(Cloudflare KV) 운영 상태 — rev=배포 커밋 7자, probe=read/write/readonly/error.
  - 진단 세부(config·hint)는 `?diag=<TICHU_DIAG>` 일치 시에만 포함.
- `GET /stats?name=<닉네임>` → `{ detail: {games, wins, elo, tier, anchors{dan1,dan2,dan3}, partners...} }`

## 스냅샷 구조 (플레이어별 redacted)

```js
{
  mode: 'online',
  code: 'ABCD',
  phase: 'lobby' | 'grand' | 'exchange' | 'play' | 'dragon' | 'roundEnd' | 'gameEnd',
  hostSeat, youSeat,
  roomSeats: [ {seat, name, isBot, connected, occupied} ×4 ],
  botTimer: {seat, msLeft} | null,      // 끊긴 사람 대행 카운트다운
  game: {                                // 대기실이면 null
    round, turnSeat, leaderSeat,
    you: { seat, hand:[카드ID],          // ★ 자기 손패만 — 타인 패는 절대 미포함
           canCallGrand, canCallTichu, exchangeSubmitted,
           received:[{fromSeat,card}], mustFulfillWish },
    seats: [ {seat, handCount, tichu:'none|tichu|grand', out, outRank, trickPoints} ×4 ],
    scores: {teamA, teamB}, targetScore,
    trick: [{seat, cards}],              // 현재 트릭의 플레이 내역
    currentCombo: {type, rank, length} | null,
    trickPilePoints, wish, dragonChooser, firstOutSeat,
    waitingOn: [좌석...], lastAction,
    roundSummary: { round, oneTwoTeam, cardPoints, bonuses, deltas, totals,
                    finishOrder, gameOver, winnerTeam } | null,
    gameOver, winnerTeam
  }
}
```

## 수명주기 정책

| 상황 | 동작 |
|---|---|
| 대기실에서 연결 끊김 | 60초 후 자리 비움 |
| 게임 중 연결 끊김 | 자리 무기한 유지. 그 사람 차례가 되면 30초 카운트다운 후 봇이 **그 결정 1건만** 대행. 복귀 즉시 인간 제어 |
| 명시적 나가기/강퇴 (게임 중) | 영구 봇 전환, 토큰 해제 |
| 같은 토큰 중복 접속 | 최신 연결 승리, 이전 연결에 `session_replaced` |
| 방장 끊김 | next_round/restart는 다른 사람도 가능 |
| 방 GC | 접속한 사람 0명 10분 지속 또는 활동 없이 2시간 → 방 삭제 |
| 남용 제한 | 방 100개, 생성 5회/분/IP, 메시지 16KB, 닉네임 12자 |

## 게임 단계 흐름

```
lobby → start_game → grand → (4명 응답) → exchange → (4명 제출) → play
play ↔ dragon(용 트릭 증정) 
play → roundEnd (3명 완주 / 원투는 즉시) → next_round → grand
roundEnd → gameEnd (한 팀 ≥1000 & 동점 아님) → restart_game
```
