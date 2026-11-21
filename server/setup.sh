#!/bin/bash
# ZapFunil – instalação do servidor 24h (Ubuntu 22.04/24.04, ARM ou x86).
# Uso no "cloud-init" da Oracle: este arquivo é baixado e rodado com o código de pareamento:
#   curl -fsSL https://gabrielfariason.github.io/zapfunil-app/server/setup.sh | ZF_PAIR=CODIGO bash
set -euo pipefail
exec > >(tee -a /var/log/zapfunil-setup.log) 2>&1
echo "== ZapFunil setup $(date)"
BASE="https://gabrielfariason.github.io/zapfunil-app/server"
DIR=/opt/zapfunil
export DEBIAN_FRONTEND=noninteractive

# memória extra de segurança (2 GB de swap)
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab || true
fi

apt-get update -y
apt-get install -y ca-certificates curl xvfb fonts-noto-color-emoji fonts-liberation tzdata
# Node.js 20 (NodeSource)
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
timedatectl set-timezone America/Sao_Paulo || true

id zapfunil >/dev/null 2>&1 || useradd -m -s /bin/bash zapfunil
mkdir -p $DIR
cd $DIR
curl -fsSL "$BASE/runner.js?t=$(date +%s)" -o runner.js
curl -fsSL "$BASE/package.json?t=$(date +%s)" -o package.json
if [ ! -f config.json ]; then
  cat > config.json <<EOF
{
  "url": "https://kjntxjencxxauhzulera.supabase.co",
  "anon": "sb_publishable_UsD2jKHI97zFRkSHkM87iA_G0KKfrWq",
  "pair": "${ZF_PAIR:-}"
}
EOF
fi
export PLAYWRIGHT_BROWSERS_PATH=$DIR/browsers
npm install --omit=dev --no-audit --no-fund
npx playwright install-deps chromium
npx playwright install chromium
chown -R zapfunil:zapfunil $DIR
chmod 600 $DIR/config.json

cat > /etc/systemd/system/zapfunil.service <<EOF
[Unit]
Description=ZapFunil servidor 24h (WhatsApp Web + extensão)
After=network-online.target
Wants=network-online.target

[Service]
User=zapfunil
WorkingDirectory=$DIR
Environment=PLAYWRIGHT_BROWSERS_PATH=$DIR/browsers
Environment=ZF_DIR=$DIR
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x900x24" /usr/bin/node $DIR/runner.js
Restart=always
RestartSec=15
MemoryMax=9G

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now zapfunil
echo "== ZapFunil instalado. Logs: journalctl -u zapfunil -f"
