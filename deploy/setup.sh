#!/bin/bash
# ============================================================
# ClawMe Backend VPS 部署脚本
# 适用于: Ubuntu / Debian / OpenCloudOS / CentOS
#
# 用法:
#   scp deploy/setup.sh root@你的IP:/tmp/ && ssh root@你的IP 'bash /tmp/setup.sh'
#   或: ssh root@你的IP 'bash -s' < deploy/setup.sh
#
# 自动安装 Cloudflare Tunnel 暴露后端（无需开放防火墙端口）
# ============================================================

set -e

APP_DIR="/opt/clawme"
REPO="https://github.com/dongsheng123132/clawme.git"

echo "========================================="
echo "  ClawMe Backend 部署脚本"
echo "========================================="

# --- 检测包管理器 ---
if command -v apt-get &>/dev/null; then
  PKG="apt"
elif command -v yum &>/dev/null; then
  PKG="yum"
else
  echo "不支持的 OS，需要 apt 或 yum"
  exit 1
fi

# --- 1. 基础依赖 ---
echo "[1/6] 安装基础依赖..."
if [ "$PKG" = "apt" ]; then
  apt-get update -qq
  apt-get install -y -qq git curl
else
  yum install -y -q git curl
fi

# --- 2. 安装 Node.js 20 ---
echo "[2/6] 安装 Node.js..."
if ! command -v node &>/dev/null; then
  if [ "$PKG" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y -q nodejs
  fi
fi
echo "  Node: $(node -v), npm: $(npm -v)"

# --- 3. 安装 PM2 ---
echo "[3/6] 安装 PM2..."
npm install -g pm2 2>/dev/null || true

# --- 4. 拉取代码 & 构建 ---
echo "[4/6] 拉取代码并构建..."
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO" "$APP_DIR"
fi

cd "$APP_DIR/backend"
npm install --production=false
npx tsc
npm prune --production

# --- 5. 启动后端 ---
echo "[5/6] 启动后端..."
cd "$APP_DIR"
pm2 delete clawme-backend 2>/dev/null || true
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# --- 6. Cloudflare Tunnel（免端口暴露）---
echo "[6/6] 配置 Cloudflare Tunnel..."
if ! command -v cloudflared &>/dev/null; then
  curl -L --output /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
fi

pm2 delete clawme-tunnel 2>/dev/null || true
pm2 start /usr/local/bin/cloudflared --name clawme-tunnel -- tunnel --url http://127.0.0.1:31871
pm2 save

# 等待 tunnel 分配 URL
sleep 5
TUNNEL_URL=$(pm2 logs clawme-tunnel --lines 30 --nostream 2>&1 | grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' | tail -1)

# 验证
sleep 1
if curl -s http://127.0.0.1:31871/health | grep -q '"ok":true'; then
  echo ""
  echo "========================================="
  echo "  部署成功！"
  echo ""
  echo "  本地地址: http://127.0.0.1:31871"
  echo "  公网地址: ${TUNNEL_URL:-（等待分配中，运行 pm2 logs clawme-tunnel 查看）}"
  echo ""
  echo "  连接 OpenClaw："
  echo "    baseUrl:     ${TUNNEL_URL:-https://xxx.trycloudflare.com}"
  echo "    clientToken: test  (或修改 ecosystem.config.cjs 设置 CLAWME_TOKENS)"
  echo ""
  echo "  连接浏览器插件 / PWA："
  echo "    Backend URL: ${TUNNEL_URL:-https://xxx.trycloudflare.com}"
  echo "    Token:       test"
  echo ""
  echo "  管理命令："
  echo "    pm2 status          # 查看状态"
  echo "    pm2 logs            # 查看日志"
  echo "    pm2 restart all     # 重启"
  echo ""
  echo "  注意：Quick Tunnel URL 在重启后会变更。"
  echo "  如需固定域名，请配置 Cloudflare Named Tunnel。"
  echo "========================================="
else
  echo ""
  echo "  后端可能未启动成功，请运行 pm2 logs 查看错误"
fi
