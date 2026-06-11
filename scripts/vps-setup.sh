#!/usr/bin/env bash
# 티츄 VPS 셋업 (Ubuntu 22.04 / 24.04)
# 사용법: tichu 폴더를 /opt/tichu 로 올린 뒤  →  sudo bash /opt/tichu/scripts/vps-setup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tichu}"

if [ "$(id -u)" -ne 0 ]; then
  echo "sudo로 실행하세요: sudo bash $0"
  exit 1
fi

echo "== 1) Node.js 확인/설치 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== 2) 앱 폴더 확인 =="
if [ ! -f "$APP_DIR/server.js" ]; then
  echo "[중단] $APP_DIR/server.js 가 없습니다."
  echo "  내 컴퓨터에서:  scp -r tichu ubuntu@<서버IP>:/tmp/"
  echo "  서버에서:       sudo mv /tmp/tichu /opt/  후 다시 실행"
  exit 1
fi
id -u tichu >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin tichu
chown -R tichu:tichu "$APP_DIR"

echo "== 3) systemd 서비스 등록 (부팅 자동 시작 + 죽으면 재시작) =="
cat >/etc/systemd/system/tichu.service <<EOF
[Unit]
Description=Tichu game server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
Environment=PORT=8080
User=tichu
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now tichu
sleep 1
systemctl --no-pager --lines=3 status tichu || true

echo ""
echo "== 완료 =="
echo "다음 단계: Cloudflare Tunnel 연결 (docs/DEPLOY-VPS.md 4단계)"
echo "  로그 보기:   journalctl -u tichu -f"
echo "  재시작:      sudo systemctl restart tichu"
