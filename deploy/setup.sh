#!/bin/bash
# ============================================================
# ClawMe Backend VPS 部署脚本
# 适用于: Ubuntu 20.04+ / Debian 11+ (腾讯云轻量云)
#
# 用法:
#   方式1: scp 到服务器再运行
#     scp deploy/setup.sh root@你的IP:/tmp/ && ssh root@你的IP 'bash /tmp/setup.sh'
#
#   方式2: 直接管道
#     ssh root@你的IP 'bash -s' < deploy/setup.sh
# ============================================================

set -e

APP_DIR="/opt/clawme"
REPO="https://github.com/dongsheng123132/clawme.git"

echo "========================================="
echo "  ClawMe Backend 部署脚本"
echo "========================================="

# --- 1. 基础依赖 ---
echo "[1/5] 安装基础依赖..."
apt-get update -qq
apt-get install -y -qq git curl

# --- 2. 安装 Node.js 20 ---
echo "[2/5] 安装 Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v), npm: $(npm -v)"

# --- 3. 安装 PM2 ---
echo "[3/5] 安装 PM2..."
npm install -g pm2 2>/dev/null || true

# --- 4. 拉取代码 & 构建 ---
echo "[4/5] 拉取代码并构建..."
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
echo "[5/5] 启动后端..."
cd "$APP_DIR"
pm2 delete clawme-backend 2>/dev/null || true
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# 验证
sleep 2
if curl -s http://127.0.0.1:31871/health | grep -q '"ok":true'; then
  echo ""
  echo "========================================="
  echo "  部署成功！"
  echo ""
  echo "  后端运行在: http://127.0.0.1:31871"
  echo "  健康检查:   curl http://127.0.0.1:31871/health"
  echo ""
  echo "  如果要外网访问，确保防火墙开放 31871 端口："
  echo "    # 腾讯云轻量云：在控制台「防火墙」添加 31871 端口"
  echo ""
  echo "  连接 OpenClaw："
  echo "    在 OpenClaw 的 clawme 插件配置中设置："
  echo "    baseUrl:     http://你的VPS-IP:31871"
  echo "    clientToken: test  (或修改 ecosystem.config.cjs 设置 CLAWME_TOKENS)"
  echo ""
  echo "  连接浏览器插件 / PWA："
  echo "    Backend URL: http://你的VPS-IP:31871"
  echo "    Token:       test"
  echo ""
  echo "  管理命令："
  echo "    pm2 status          # 查看状态"
  echo "    pm2 logs            # 查看日志"
  echo "    pm2 restart all     # 重启"
  echo "========================================="
else
  echo ""
  echo "  ⚠️ 后端可能未启动成功，请运行 pm2 logs 查看错误"
fi
