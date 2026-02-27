#!/bin/bash
# ============================================================
# ClawMe VPS 部署脚本
# 适用于: Ubuntu 20.04+ / Debian 11+ (腾讯云轻量云)
# 用法:   ssh root@your-vps 'bash -s' < setup.sh
# ============================================================

set -e

DOMAIN="clawme.net"
APP_DIR="/opt/clawme"
REPO="https://github.com/dongsheng123132/clawme.git"

echo "========================================="
echo "  ClawMe 部署脚本"
echo "  域名: $DOMAIN"
echo "========================================="

# --- 1. 基础依赖 ---
echo "[1/7] 安装基础依赖..."
apt-get update -qq
apt-get install -y -qq git nginx certbot python3-certbot-nginx curl

# --- 2. 安装 Node.js 20 ---
echo "[2/7] 安装 Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v), npm: $(npm -v)"

# --- 3. 安装 PM2 ---
echo "[3/7] 安装 PM2..."
npm install -g pm2 2>/dev/null || true

# --- 4. 拉取代码 ---
echo "[4/7] 拉取代码..."
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO" "$APP_DIR"
fi

# --- 5. 构建后端 ---
echo "[5/7] 构建后端..."
cd "$APP_DIR/backend"
npm install --production=false
npx tsc
npm prune --production

# --- 6. 配置 Nginx + SSL ---
echo "[6/7] 配置 Nginx..."
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/clawme
ln -sf /etc/nginx/sites-available/clawme /etc/nginx/sites-enabled/clawme
rm -f /etc/nginx/sites-enabled/default

# 先用 HTTP 获取 SSL 证书
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  # 临时 Nginx 配置用于验证
  cat > /etc/nginx/sites-available/clawme-temp <<TMPCONF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    root $APP_DIR/web;
    location /.well-known/acme-challenge/ { allow all; }
}
TMPCONF
  ln -sf /etc/nginx/sites-available/clawme-temp /etc/nginx/sites-enabled/clawme
  nginx -t && systemctl restart nginx

  certbot certonly --webroot -w "$APP_DIR/web" -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos --email "admin@$DOMAIN" || {
    echo "⚠️  SSL 证书获取失败。请确保域名 A 记录已指向此服务器 IP。"
    echo "    手动运行: certbot certonly --nginx -d $DOMAIN -d www.$DOMAIN"
  }

  # 恢复正式配置
  rm -f /etc/nginx/sites-available/clawme-temp
  cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/clawme
  ln -sf /etc/nginx/sites-available/clawme /etc/nginx/sites-enabled/clawme
fi

nginx -t && systemctl restart nginx

# --- 7. 启动后端 ---
echo "[7/7] 启动后端..."
cd "$APP_DIR"
pm2 delete clawme-backend 2>/dev/null || true
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "========================================="
echo "  部署完成！"
echo ""
echo "  网站:  https://$DOMAIN"
echo "  API:   https://$DOMAIN/v1/"
echo "  健康:  https://$DOMAIN/health"
echo ""
echo "  下一步:"
echo "  1. 确保域名 A 记录指向此服务器 IP"
echo "  2. 编辑 Token:  pm2 env 0  或修改 ecosystem.config.cjs"
echo "  3. 连接 OpenClaw:  见下方说明"
echo ""
echo "  连接 OpenClaw:"
echo "  在 OpenClaw 的 clawme 插件配置中设置:"
echo "    baseUrl:     https://$DOMAIN"
echo "    clientToken:  你设置的 token"
echo "========================================="
