# VPS(가상서버) 배포 — PC 없이 24시간 운영 + 원격 코드 수정

집 PC를 없애도 되는 구성입니다. 작은 VPS 한 대에 게임 서버를 올리고,
Cloudflare Tunnel로 `tichu.kwon.work` 에 연결합니다.

```
[친구들] → https://tichu.kwon.work (Cloudflare) → 터널 → [VPS: node server.js]
```

- 슬립 없음, 항상 켜져 있음
- VPS에 **인바운드 포트를 하나도 열 필요 없음** (SSH 22번 제외) — 터널이 나가는 연결이라 방화벽 걱정 최소
- 원격 코드 수정: VS Code Remote-SSH로 어디서든 편집 (아래 7번)

## 0. VPS 고르기

4인 카드게임 서버는 사양을 거의 안 탑니다. **가장 싼 등급이면 충분**합니다 (RAM 512MB~1GB).

| 업체 | 비용 | 비고 |
|---|---|---|
| Vultr (서울 리전) | 월 $6 안팎 | 가입 쉬움, 한국 핑 좋음 — 무난한 추천 |
| Azure (Korea Central) | 첫 12개월 무료 → 이후 월 $8~10 | 신규 계정 B1s VM 12개월 무료 + $200 크레딧. 포털이 복잡 |
| AWS Lightsail (서울) | 월 $5 안팎 | AWS 계정 있으면 편함 |
| Oracle Cloud Always Free | 무료 | 평생 무료지만 가입 심사가 까다롭고 용량 대기가 있을 수 있음 |

OS는 **Ubuntu 24.04 LTS** 선택. 생성 시 SSH 키를 등록하거나 비밀번호를 받아두세요.
(SSH 키가 처음이면, 업체 콘솔의 "비밀번호 접속" 옵션을 쓰면 키 없이 시작할 수 있습니다.)

### Azure로 만들 경우 (0-A단계)

포털(portal.azure.com) → **Virtual machines → Create → Azure virtual machine**:

| 항목 | 값 |
|---|---|
| Image | **Ubuntu Server 24.04 LTS** |
| Size | **B1s** ("Free services eligible" 표시 확인 — 12개월 무료 대상) |
| Authentication type | SSH public key (권장) 또는 Password |
| Username | `azureuser` (기본) |
| Public inbound ports | **SSH (22) 만** 선택 ← 8080은 절대 열지 말 것(터널이 처리) |
| Region | Korea Central |

생성 후 VM 개요 화면의 **공인 IP(Public IP)** 를 받아 1단계로. 접속 계정은 `azureuser`입니다
(`ssh azureuser@<공인IP>`). 12개월 후 과금을 피하려면 그 전에 VM을 삭제하거나 다른 업체로 옮기세요.

> **전제**: 4단계의 주소 연결은 본인 도메인(예: `kwon.work`)이 Cloudflare에 등록돼 있어야 합니다.
> 도메인이 없으면 서버 IP로 바로 접속(`http://<서버IP>:8080`)해 테스트할 수 있지만, HTTPS가 아니라
> 카톡 공유·PWA 설치에는 도메인+터널을 권장합니다.

## 1. 접속

```bash
ssh ubuntu@<서버IP>        # 업체에 따라 계정명이 다름: Vultr=root, AWS=ubuntu, Azure=azureuser
```

## 2. 게임 파일 올리기

내 컴퓨터(Mac) 터미널에서:

```bash
scp -r "tichu" ubuntu@<서버IP>:/tmp/
ssh ubuntu@<서버IP> "sudo mv /tmp/tichu /opt/tichu"
```

(GitHub에 올려뒀다면 서버에서 `sudo git clone https://github.com/<계정>/tichu /opt/tichu` 도 됩니다)

## 3. 셋업 스크립트 실행

서버에서:

```bash
sudo bash /opt/tichu/scripts/vps-setup.sh
```

이 스크립트가 Node 설치 → 전용 계정 생성 → systemd 서비스 등록(부팅 자동 시작, 죽으면 3초 후 재시작)까지 합니다.
끝나면 `journalctl -u tichu -f` 로 "티츄 서버 시작 — 포트 8080" 로그를 확인하세요.

## 4. Cloudflare Tunnel 연결

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** → 이름 `tichu-vps`
2. 환경에서 **Debian (64-bit)** 선택 → 표시되는 설치 명령 전체를 복사해 **서버에서 실행**
   (cloudflared가 서비스로 설치되어 재부팅에도 자동 연결)
3. **Public Hostname 추가**: Subdomain `tichu` / Domain `kwon.work` / Type `HTTP` / URL `localhost:8080`
   - 기존에 집 PC용 터널 레코드가 있다면 DNS에서 그 `tichu` 레코드를 먼저 지우세요
4. 폰 LTE로 `https://tichu.kwon.work` 접속 확인

## 5. 일상 운영 명령

```bash
journalctl -u tichu -f          # 실시간 로그
sudo systemctl restart tichu    # 서버 재시작 (코드 수정 후)
sudo systemctl status tichu     # 상태 확인
```

## 6. 게임 업데이트

내 컴퓨터에서 파일 수정 후:

```bash
scp -r tichu/* ubuntu@<서버IP>:/tmp/tichu-new/ && \
ssh ubuntu@<서버IP> "sudo cp -r /tmp/tichu-new/* /opt/tichu/ && sudo systemctl restart tichu"
```

## 7. 원격 코드 수정 (VS Code)

1. VS Code 설치 → 확장에서 **Remote - SSH** 설치
2. 좌측 하단 `><` → **Connect to Host** → `ubuntu@<서버IP>`
3. `/opt/tichu` 폴더 열기 → 어디서든 직접 편집
4. 내장 터미널에서 `sudo systemctl restart tichu` 로 반영

## 문제 해결

| 증상 | 확인 |
|---|---|
| 사이트 안 열림 | `systemctl status tichu` / Zero Trust 대시보드에서 터널 HEALTHY 여부 |
| 통신 이상 | 주소 뒤 `?transport=poll` 로 시험 |
| 서버 죽음 반복 | `journalctl -u tichu -n 100` 로 오류 로그 확인 |
| 보안 | 게임은 터널로만 노출. SSH는 키 인증 권장, `sudo apt update && sudo apt upgrade` 가끔 실행 |
