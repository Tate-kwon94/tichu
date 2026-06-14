# 통신 규약 (protocolVersion: 1)

클라이언트와 서버가 주고받는 메시지 계약. `client/transport.js` ↔ `server/rooms.js` 가 이 문서와 일치해야 한다.

## 기본 원칙

- 모든 메시지는 JSON. `type` 필드(snake_case) 필수.
- **스냅샷 전체 동기화**: 서버는 변경 시마다 플레이어별로 가려진(redacted) 전체 스냅샷을 보낸다.
  델타/리플레이 없음 → 재접속·폴백·복구가 전부 "최신 스냅샷 1개"로 해결된다.
- `version`: 방 단위 단조 증가. 클라이언트는 자신이 가진 것보다 낮거나 같은 버전은 버린다.
- `actionId`: `"<clientId>-<카운터>"`. 서버는 플레이어별 최근 32개를 기억해 재전송 시 같은 ack를 돌려준다(멱등).
- 카드 ID: `S|H|D|C` + `2-9,T,J,Q,K,A` (예: `"ST"`=♠10) + 특수 `"MJ","DG","PH","DR"`.
- 좌석 0–3. 팀 A = 0+2, 팀 B = 1+3. 차례 0→1→2→3.

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
| `join_room` | `code`, `name` | 빈 좌석 자동 배정. 오류: ROOM_NOT_FOUND / ROOM_FULL / GAME_IN_PROGRESS |
| `take_seat` | `seat` | 대기실에서만 |
| `set_name` | `name` | 대기실에서만, 12자 |
| `add_bot` / `remove_bot` | `seat` | 방장만, 대기실에서만 |
| `kick_player` | `seat` | 방장만. 게임 중이면 그 자리는 봇으로 전환 |
| `start_game` | `targetScore?`(300/500/1000), `botLevel?`(easy/normal/hard/devil) | 방장만. 빈자리 봇 채움 → grand 단계. hard=몬테카를로 탐색, devil=퍼펙트인포 |
| `list_rooms` | — | 방 목록. ack에 `rooms:[{code,host,occupied,humans,inGame,target}]` 포함 (최신순, 최대 30) |
| `leave_room` | — | 게임 중 나가면 영구 봇 전환 |
| `call_grand` | `call`(bool) | 8장 보고 응답. 4명 모두 응답하면 6장 추가 배분 → exchange |
| `call_tichu` | — | 자기 첫 플레이 전까지 |
| `submit_exchange` | `give`: {상대좌석: 카드ID} ×3 | 전원 제출 시 일괄 교환, 마작 보유자가 선 |
| `play_cards` | `cards[]`, `wish?`(2–14, MJ 포함 시), `version` | **차례 밖 폭탄 끼어들기도 이 메시지** — 서버가 판정 |
| `pass_turn` | `version` | 선두/소원 이행 가능 시 거부 |
| `give_dragon` | `toSeat` | 용 트릭 승자가 상대팀 좌석 지정 |
| `next_round` / `restart_game` | — | 방장(끊겨 있으면 아무 사람) |
| `chat` | `text`(≤200자) | 방 전체에 브로드캐스트. 제어문자 제거, 0.6초 레이트리밋. 게임 version은 올리지 않음 |

**version 규칙**: `pass_turn`은 version 불일치 시 `STALE_VERSION`(클라이언트는 조용히 무시).
`play_cards`는 불일치 시 폭탄(bomb4/bombstraight)일 때만 현재 상태 기준으로 재검증 허용.

## 서버 → 클라이언트

| type | 필드 |
|---|---|
| `welcome` | `token`, `resumed`, `protocolVersion`, `version`, `snapshot`(방에 있으면) |
| `room_state` | `version`, `snapshot` |
| `action_ack` | `actionId`, `ok`, `version`, `error?{code,message}` |
| `session_replaced` | — (같은 토큰의 새 연결이 생겨 이 연결이 대체됨) |
| `left_room` | `reason`: `kicked` / `room_closed` / `left` |
| `chat` | `seat`, `name`, `text`, `ts` — 스냅샷과 별개 이벤트(버전 무관). 모르는 type은 무시해도 됨 |

에러코드: `ROOM_NOT_FOUND, ROOM_FULL, GAME_IN_PROGRESS, SEAT_TAKEN, NOT_HOST, BAD_PHASE,
NOT_YOUR_TURN, CARDS_NOT_IN_HAND, INVALID_COMBO, COMBO_TOO_LOW, WISH_REQUIRED,
CANNOT_PASS_LEAD, STALE_VERSION, BAD_REQUEST, RATE_LIMITED`

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
