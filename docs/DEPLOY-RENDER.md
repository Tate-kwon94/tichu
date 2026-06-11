# Render 무료 배포 안내 (비개발자용)

git 명령어 없이 **웹 브라우저만으로** 배포하는 방법입니다. 처음부터 끝까지 15분쯤 걸립니다.

## 준비물

- GitHub 계정 (github.com — 무료 가입)
- Render 계정 (render.com — GitHub 계정으로 로그인하면 됨)

## 1단계 — GitHub에 코드 올리기

1. github.com 로그인 → 오른쪽 위 **+** → **New repository**
2. Repository name: `tichu` / **Private** 선택 → **Create repository**
3. 만들어진 페이지에서 **"uploading an existing file"** 링크 클릭
4. 이 `tichu` 폴더를 열고 **안의 내용물 전부**를 브라우저 창에 드래그
   (Chrome에서는 폴더째 드래그하면 하위 폴더 구조도 함께 올라갑니다.
   `server/ shared/ client/ docs/ test/ scripts/` 폴더와
   `server.js package.json render.yaml README.md` 파일이 모두 보여야 합니다)
5. 아래 **Commit changes** 클릭

## 2단계 — Render에 연결

1. render.com → **Get Started** → GitHub로 로그인
2. 대시보드에서 **New +** → **Web Service**
3. 방금 만든 `tichu` 저장소 선택 (안 보이면 "Configure account"에서 저장소 접근 허용)
4. 설정 확인:
   - **Language**: Node
   - **Build Command**: `echo no-build` (또는 비워두기)
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free**
5. **Deploy Web Service** 클릭 → 1~2분 후 상단에 주소가 표시됩니다
   예: `https://tichu-xxxx.onrender.com`

## 3단계 — 플레이

1. 그 주소를 휴대폰/PC 브라우저로 열기
2. 닉네임 입력 → **방 만들기** → **초대 링크 복사** → 카톡 등으로 공유
3. 친구들은 링크만 누르면 같은 방으로 들어옵니다

## 4단계 (선택) — 내 도메인 연결: tichu.kwon.work

`onrender.com` 주소 대신 본인 도메인을 쓰면 주소도 깔끔하고, 회사 보안망이 호스팅
도메인을 통째로 차단하는 경우도 피할 수 있습니다. Render 무료 플랜에서 지원되며
HTTPS 인증서도 자동 발급됩니다. (기존 app.kwon.work는 건드리지 않습니다)

**Render 쪽:**
1. 배포한 서비스 → **Settings** → **Custom Domains** → **Add Custom Domain**
2. `tichu.kwon.work` 입력 → Render가 알려주는 CNAME 대상 확인 (예: `tichu-xxxx.onrender.com`)

**Cloudflare 쪽:**
3. dash.cloudflare.com → `kwon.work` → **DNS** → **레코드 추가**
   - Type: `CNAME` / Name: `tichu` / Target: `tichu-xxxx.onrender.com`
   - Proxy status: 일단 **DNS only(회색 구름)** 로 저장 ← 인증서 발급이 가장 매끄러움
4. 몇 분 뒤 Render의 Custom Domains에 **Certificate Issued**(초록)가 뜨면
   `https://tichu.kwon.work` 로 접속 확인

**(선택) Cloudflare 프록시 켜기 — 회사망 통과율을 더 높이고 싶을 때:**
5. 인증서 발급 확인 후, 같은 레코드의 구름을 **주황(Proxied)** 으로 전환
6. Cloudflare **SSL/TLS** 메뉴에서 모드가 **Full (strict)** 인지 확인
   (Flexible이면 무한 리다이렉트가 생기니 주의)
7. WebSocket은 Cloudflare 무료 플랜에서 기본 지원됩니다. 혹시 통신이 이상하면
   주소 뒤에 `?transport=poll` 로 확인해 보세요.

이후 친구 초대 링크는 `https://tichu.kwon.work/?room=코드` 형태가 됩니다.

## 알아둘 점

- **첫 접속이 느린 이유**: 무료 플랜은 15분간 접속이 없으면 잠듭니다. 첫 사람이 열면
  30–60초 후 깨어나요. **게임 시작 5분 전에 방장이 먼저 접속**해 두면 쾌적합니다.
- 잠들면 진행 중이던 방 정보는 사라집니다(게임 중에는 통신이 계속되므로 잠들지 않음).
- **수정/업데이트**: GitHub 저장소에서 파일을 다시 업로드(같은 이름으로 덮어쓰기)하면
  Render가 자동으로 다시 배포합니다.
- 회사 PC에서 접속이 안 되면: 주소 뒤에 `?transport=poll` 을 붙여 보세요.
  그래도 안 되면 사내 보안에서 도메인 자체를 막은 것이므로 휴대폰(LTE/5G)으로 접속하세요.
