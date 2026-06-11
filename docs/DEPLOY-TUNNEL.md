# Cloudflare Tunnel 배포 — 24시간 켜둔 PC를 서버로

렌더 같은 호스팅 없이, 집/사무실에 켜둔 PC 한 대로 `https://tichu.kwon.work` 를 운영하는 방법입니다.

```
[친구들] → https://tichu.kwon.work (Cloudflare) → 터널 → [내 PC: node server.js]
```

- 비용 0원, 슬립 없음
- **공인 IP·포트포워딩·방화벽 개방 불필요** — 터널은 PC에서 Cloudflare로 "나가는" 연결이라 공유기 설정을 건드리지 않습니다
- HTTPS 인증서는 Cloudflare가 자동 처리
- 단점: PC가 꺼지거나 잠들면 접속 불가 (아래 6번 절전 설정 참고)

Windows PC 기준으로 설명하고, 맨 아래에 Mac용 요약이 있습니다.

> **전제**: 본인 도메인(예: `kwon.work`)을 Cloudflare에 등록해 두어야 합니다.
> 도메인이 없으면 4단계(주소 연결)를 건너뛰고, 터널이 발급하는 임시 주소
> `https://<랜덤>.trycloudflare.com` 로도 플레이는 가능합니다(주소가 매번 바뀜).

## 1. PC에 Node.js 설치

nodejs.org → **LTS 버전** 다운로드 → 기본 옵션으로 설치.
설치 확인: 명령 프롬프트(cmd)에서 `node --version` → `v22.x` 같은 버전이 나오면 OK.

## 2. 게임 폴더 복사 후 동작 확인

1. 이 `tichu` 폴더를 통째로 PC에 복사 (예: `C:\tichu`)
2. cmd에서:
   ```
   cd C:\tichu
   node server.js
   ```
3. 그 PC 브라우저에서 `http://localhost:8080` 이 열리면 성공. (창은 일단 닫아도 됨 — 5번에서 자동 실행 등록)

## 3. Cloudflare Tunnel 만들기 (웹 화면에서)

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) 접속 (처음이면 Zero Trust **Free 플랜** 선택 — 무료)
2. **Networks → Tunnels → Create a tunnel → Cloudflared** 선택 → 이름 `tichu` → Save
3. 설치 화면에서 **Windows 64-bit** 선택 → 표시되는 설치 명령을 복사
4. PC에서 **PowerShell을 관리자 권한으로** 열고 붙여넣기 실행
   - cloudflared가 **Windows 서비스로 설치**되어 부팅할 때마다 자동으로 터널이 살아납니다
5. 대시보드에 Connector 상태가 **Connected** 로 바뀌면 다음 단계로

## 4. 주소 연결 (Public Hostname)

터널 설정 화면의 **Public Hostnames → Add a public hostname**:

| 항목 | 값 |
|---|---|
| Subdomain | `tichu` |
| Domain | `kwon.work` |
| Type | `HTTP` |
| URL | `localhost:8080` |

저장하면 DNS 레코드(`tichu.kwon.work`)가 **자동으로 생성**됩니다. 따로 DNS 만질 필요 없음.

## 5. 게임 서버 자동 실행 등록

`scripts\start-windows.bat` 가 서버를 실행하고, 죽으면 5초 후 자동 재시작합니다.

**방법 A — 시작프로그램 (간단, 로그인하면 실행):**
1. `Win+R` → `shell:startup` → 엔터
2. 열린 폴더에 `C:\tichu\scripts\start-windows.bat` 의 **바로가기**를 넣기

**방법 B — 작업 스케줄러 (로그인 없이도 실행):**
1. 작업 스케줄러 → 기본 작업 만들기 → 이름 `tichu`
2. 트리거: **컴퓨터 시작 시** / 동작: 프로그램 시작 → `C:\tichu\scripts\start-windows.bat`
3. 만든 작업 속성에서 "사용자의 로그온 여부에 관계없이 실행" 선택

## 6. 절전 끄기 (중요)

설정 → 시스템 → 전원 → **절전 모드: 안 함** (화면 끄기는 켜둬도 됨).
노트북이면 "덮개를 닫을 때: 아무 것도 안 함"도 설정.

## 7. 확인

휴대폰을 **LTE/5G**(와이파이 끄고)로 `https://tichu.kwon.work` 접속 → 방 만들기까지 되면 끝.
친구 초대는 `https://tichu.kwon.work/?room=코드` 링크 공유.

## 문제 해결

| 증상 | 확인 |
|---|---|
| 사이트가 안 열림 | Zero Trust 대시보드에서 터널 상태가 HEALTHY인지 / PC에서 `http://localhost:8080` 열리는지(node 실행 여부) |
| 게임 통신이 끊김/이상 | 주소 뒤에 `?transport=poll` 붙여 확인 — 이걸로 되면 중간 장비가 WS를 막는 것 |
| 게임 업데이트 | `C:\tichu` 파일 교체 → bat 창 닫고 다시 실행 (또는 PC 재부팅) |
| 보안 걱정 | 터널은 8080을 인터넷에 직접 열지 않습니다. 외부 노출은 Cloudflare를 거친 tichu.kwon.work뿐 |

## Mac을 서버로 쓸 경우 (요약)

```bash
brew install cloudflared node
sudo cloudflared service install <대시보드가 주는 토큰>   # 부팅 시 자동 시작
cd ~/tichu && node server.js                              # 서버 실행 (이 창을 닫지 말 것)
caffeinate -s &                                           # 절전 방지
```
Public Hostname 설정(4번)은 동일. 부팅 자동 실행까지 원하면 `node server.js`를 launchd
또는 로그인 항목에 등록하세요(맥을 상시 서버로 쓸 거면 VPS 가이드 방식이 더 깔끔합니다).
