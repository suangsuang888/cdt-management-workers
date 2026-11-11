#!/usr/bin/env bash
# 一键部署 cdt-management-workers 到 Cloudflare。
#
# 用法：
#   ./scripts/deploy.sh            # 全程交互式：一路回车/填空即可
#   ./scripts/deploy.sh --dry-run  # 只检查 + 演练，不建 D1、不设密钥、不部署
#
# 脚本会依次做：
#   1. 检查 node / npm / wrangler 登录
#   2. npm install + 构建前端 (npm run build:web)
#   3. 创建 D1 数据库（若 wrangler.toml 里的 database_id 还是占位符），
#      并把真实 database_id 写回 wrangler.toml
#   4. 应用 D1 迁移（本地 + 远端）
#   5. 设置 Secrets：ADMIN_PASSWORD（必填，会问你）、SESSION_SECRET、
#      ENCRYPTION_KEY（后两个不填就自动生成随机值）
#      可选：CLOUDFLARE_API_TOKEN、TELEGRAM_BOT_TOKEN（留空跳过）
#   6. npx wrangler deploy
#
# 注意：密钥只会通过 `wrangler secret put` 进 Cloudflare，不会写进任何文件。
# 部署前请先在不重要的实例上测试；本项目尚未用真实阿里云账号验证过。

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "== dry-run 模式：只检查 + 演练，不建库、不设密钥、不部署 =="
fi

step() { echo; echo "== $1 =="; }

# ---------- 1. 检查 ----------
step "检查环境"
command -v node >/dev/null || { echo "找不到 node，请先安装 Node.js 18+"; exit 1; }
command -v npm >/dev/null || { echo "找不到 npm"; exit 1; }
echo "node: $(node --version)  npm: $(npm --version)"

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! npx wrangler whoami >/dev/null 2>&1; then
    echo "还未登录 Cloudflare，请先跑一次："
    echo "  npx wrangler login"
    echo "登录完成后再跑 ./scripts/deploy.sh"
    exit 1
  fi
  echo "Cloudflare 已登录"
fi

# ---------- 2. 安装 + 构建 ----------
step "安装依赖并构建前端"
npm install
npm run build:web
npx tsc --noEmit
echo "类型检查通过，前端已构建到 web/dist"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "dry-run 完成：上面这些步骤都通过了。正式部署请跑："
  echo "  ./scripts/deploy.sh"
  exit 0
fi

# ---------- 3. D1 ----------
step "D1 数据库"
DB_ID=$(grep -oE 'database_id = "[^"]+"' wrangler.toml | cut -d'"' -f2 || true)
if [[ "$DB_ID" == "00000000-0000-0000-0000-000000000000" || -z "$DB_ID" ]]; then
  echo "正在创建 D1 数据库 cdt-management …"
  CREATE_OUT=$(npx wrangler d1 create cdt-management)
  echo "$CREATE_OUT"
  NEW_ID=$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1)
  if [[ -z "$NEW_ID" ]]; then
    echo "没能从 wrangler 输出里拿到 database_id，请手动创建并填进 wrangler.toml"
    exit 1
  fi
  # 把占位符换成真实 ID（只替换 database_id 这一行）
  python3 - "$NEW_ID" <<'PY'
import re, sys
new_id = sys.argv[1]
p = "wrangler.toml"
s = open(p).read()
s, n = re.subn(r'database_id = "[^"]+"', f'database_id = "{new_id}"', s, count=1)
assert n == 1, "wrangler.toml 里没找到 database_id"
open(p, "w").write(s)
print(f"database_id 已写入 wrangler.toml: {new_id}")
PY
else
  echo "D1 已配置，database_id: $DB_ID"
fi

# ---------- 4. 迁移 ----------
step "应用 D1 迁移"
npx wrangler d1 migrations apply cdt-management --local
npx wrangler d1 migrations apply cdt-management --remote

# ---------- 5. Secrets ----------
step "设置 Secrets（只进 Cloudflare，不写文件）"

ask_secret() {
  # ask_secret NAME "提示" [默认值]
  local name="$1" prompt="$2" default="${3:-}"
  local value=""
  if [[ -n "$default" ]]; then
    read -r -s -p "$prompt（留空则用自动生成的值）: " value || true
    echo
    [[ -z "$value" ]] && value="$default"
  else
    read -r -s -p "$prompt: " value || true
    echo
  fi
  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
  echo "$name 已设置"
}

ask_optional_secret() {
  # ask_optional_secret NAME "提示" — 留空跳过
  local name="$1" prompt="$2" value=""
  read -r -s -p "$prompt（可选，留空跳过）: " value || true
  echo
  if [[ -z "$value" ]]; then
    echo "$name 跳过"
    return
  fi
  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
  echo "$name 已设置"
}

rand_hex() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
rand_b64() { node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"; }

echo "面板登录密码（首次初始化用，之后登录就用它）："
ask_secret ADMIN_PASSWORD "ADMIN_PASSWORD"
ask_secret SESSION_SECRET "SESSION_SECRET" "$(rand_hex)"
ask_secret ENCRYPTION_KEY "ENCRYPTION_KEY（加密 AccessKey Secret 用）" "$(rand_b64)"
ask_optional_secret CLOUDFLARE_API_TOKEN "CLOUDFLARE_API_TOKEN（DDNS 用）"
ask_optional_secret TELEGRAM_BOT_TOKEN "TELEGRAM_BOT_TOKEN（通知用）"

echo
echo "提示：ENCRYPTION_KEY 丢了，库里存的 AccessKey Secret 就解不出来，"
echo "请把它和 SESSION_SECRET 一起记到你自己的密码管理器里。"

# ---------- 6. 部署 ----------
step "部署到 Cloudflare Workers"
npx wrangler deploy

echo
echo "部署完成。打开上面输出的 workers.dev 地址，用 ADMIN_PASSWORD 登录，"
echo "首次登录会进初始化向导，然后在面板里加阿里云账号（先拿不重要的实例试）。"
