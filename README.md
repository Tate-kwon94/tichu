# 티츄 (Tichu) — 웹 멀티플레이어 카드게임

4인 파트너 카드게임 티츄를 브라우저에서 플레이합니다. 모바일(아이폰·갤럭시)과 PC 모두 지원하며,
**npm 패키지 0개 / 빌드 과정 없음 / 외부 리소스 0개**의 자급자족 구성입니다.

## 플레이 방법 (3가지)

| 방식 | 필요한 것 | 사용처 |
|---|---|---|
| ① 클라우드 | Render 무료 배포 → `https://…` URL 공유 | 외부망 어디서나 (권장) |
| ② 같은 네트워크 | PC 한 대에서 `node server.js` → `http://호스트IP:8080` | 같은 공유기/사무실 |
| ③ 혼자 연습 | 서버 접속 후 "혼자 연습" — 이후엔 오프라인도 가능(PWA) | 봇 3명과 연습 |

- 방장이 **방 만들기** → 4자리 코드(또는 초대 링크)를 공유 → 친구들이 입장
- 4명이 안 모이면 **빈자리는 AI 봇**이 채웁니다
- 새로고침·화면 꺼짐·앱 전환에도 **같은 자리로 자동 복귀**합니다
- 자리를 비운 사람의 차례는 30초 후 봇이 그 한 수만 대신 둡니다 (돌아오면 즉시 복귀)

## 📱 휴대폰에 앱처럼 설치 (PWA)

- **아이폰**: Safari로 접속 → 공유 버튼(⬆︎) → **"홈 화면에 추가"**
- **갤럭시**: Chrome으로 접속 → 메뉴(⋮) → **"앱 설치"** 또는 "홈 화면에 추가"

설치하면 홈 화면 아이콘으로 전체 화면 실행되며, 혼자 연습 모드는 오프라인에서도 동작합니다.

## 서버 실행

```bash
node server.js          # http://localhost:8080 (PORT 환경변수로 변경 가능)
```

Node.js 18 이상만 있으면 됩니다. 설치형 의존성이 전혀 없습니다.

## 인터넷 공개 (셋 중 하나)

| 방법 | 안내서 | 특징 |
|---|---|---|
| **VPS + Cloudflare Tunnel** | [docs/DEPLOY-VPS.md](docs/DEPLOY-VPS.md) | 월 5천원대(또는 Oracle 무료), 슬립 없음, PC 불필요, 원격 코드 수정(SSH) — **상시 운영 추천** |
| 켜둔 PC + Cloudflare Tunnel | [docs/DEPLOY-TUNNEL.md](docs/DEPLOY-TUNNEL.md) | 비용 0, 슬립 없음. 단 PC가 켜져 있어야 함 |
| Render 무료 호스팅 | [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md) | 비용 0, 장비 불필요. 15분 유휴 시 잠들어 첫 접속 30–60초 |

세 방법 모두 코드 수정이 필요 없고, 서로 갈아탈 수 있습니다(DNS만 변경, 주소는 `tichu.kwon.work` 유지).

## 테스트

```bash
node test/run-tests.js          # 규칙 엔진: 픽스처 + 직렬화 + 봇 자가대전 1,000라운드
node test/run-tests.js 10000    # 라운드 수 지정
node test/e2e-online.js         # 서버 E2E: 4클라이언트(WS+poll) 게임 완주
node test/e2e-resilience.js     # 재접속 / SSE / 중복 접속
```

## 폴더 구조

```
server.js          서버 진입점 (정적 서빙 + 게임 서버)
server/            ws.js(자체 WebSocket) · transports.js(SSE/poll/POST) · rooms.js(방·좌석·봇·재접속)
shared/            tichu-core.js(규칙 엔진) · bots.js(AI) — 서버와 브라우저 공용
client/            UI (모바일 퍼스트, 한국어) + PWA(manifest/sw/아이콘)
test/              규칙 픽스처, 시뮬레이션, 서버 E2E
docs/              PROTOCOL.md(통신 규약) · DEPLOY-RENDER.md(배포 안내)
scripts/           make-icons.js (아이콘 재생성)
```

## 통신 방식

WebSocket을 기본으로 쓰고, 회사 프록시가 막으면 **SSE → long-poll**로 자동 전환됩니다.
`?transport=ws|sse|poll` 을 주소에 붙여 강제할 수 있습니다 (문제 진단용).
패(손 카드)는 서버에만 있으며 각자에게 자기 패만 전송됩니다.

## 구현된 규칙

56장 덱(마작·개·불사조·용), 모든 조합과 폭탄(차례 무관 끼어들기 포함), 마작 소원 강제,
개(파트너 선 이양), 용 트릭 증정, 그랜드 티츄/티츄, 3장 교환, 원투 피니시 +200,
막내 처리(트릭→1등, 손패→상대팀), 카드점수(5/10/K/용/불사조), 1000점 선취.
