#!/usr/bin/env bash
#
# 2FA Extension —— 一键建仓并推送
#
# 与初版的关键差异：上游 v1.9.0 已原生支持 Authorization: Bearer，
# 且登录响应体本来就返回 token —— 因此**不需要 fork 上游、不需要打服务端补丁**。
# 本脚本建的是一个**独立仓库**，只包含扩展代码，可独立跟随上游升级。
#
# （当前执行环境无 GitHub 出站网络，这些步骤需在有网的机器上跑）
#
# 用法：
#   export GITHUB_TOKEN=<你的 token>      # 或先执行 gh auth login
#   ./scripts/bootstrap.sh [仓库名] [public|private]
#
# 仓库名默认 2fa-extension，可见性默认 private。

set -euo pipefail

REPO_NAME="${1:-2fa-extension}"
VISIBILITY="${2:-private}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> 项目目录: $PROJECT_DIR"
echo "==> 目标仓库: $REPO_NAME ($VISIBILITY)"
echo "==> 形态: 独立仓库（不 fork 上游，不改服务端）"

# ---------- 0. 前置检查 ----------
command -v git >/dev/null 2>&1 || { echo "缺少 git"; exit 1; }

if [ -z "${GITHUB_TOKEN:-}" ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    GITHUB_TOKEN="$(gh auth token)"
    export GITHUB_TOKEN
  else
    echo "错误: 未设置 GITHUB_TOKEN，且 gh 未登录。"
    echo "      export GITHUB_TOKEN=xxx  或   gh auth login"
    exit 1
  fi
fi

# ---------- 1. 先跑一遍验证 ----------
echo "==> 本地验证 ..."
command -v node >/dev/null 2>&1 && {
  node "$PROJECT_DIR/scripts/verify-otp.mjs" || { echo "OTP 验证失败，中止"; exit 1; }
  node "$PROJECT_DIR/scripts/verify-integration.mjs" || { echo "集成验证失败，中止"; exit 1; }
} || echo "    （未找到 node，跳过验证）"

API="https://api.github.com"
AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"

# ---------- 2. 解析用户名 ----------
OWNER="$(curl -fsS -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
  "$API/user" | python3 -c 'import sys,json;print(json.load(sys.stdin)["login"])')"
echo "==> GitHub 用户: $OWNER"

# ---------- 3. 创建仓库 ----------
PRIVATE_FLAG="true"
[ "$VISIBILITY" = "public" ] && PRIVATE_FLAG="false"

EXISTING="$(curl -fsS -o /dev/null -w '%{http_code}' -H "$AUTH_HEADER" \
  "$API/repos/$OWNER/$REPO_NAME" || echo 000)"

if [ "$EXISTING" = "200" ]; then
  echo "==> 仓库已存在，跳过创建"
else
  echo "==> 创建仓库 $OWNER/$REPO_NAME ..."
  curl -fsS -X POST -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
    "$API/user/repos" \
    -d "{\"name\":\"$REPO_NAME\",\"private\":$PRIVATE_FLAG,\"description\":\"Browser extension for wuzf/2fa (Cloudflare Workers 2FA manager) - no server changes required\",\"auto_init\":false}" \
    > /dev/null
  echo "==> 创建完成"
fi

# ---------- 4. 初始化并装配 ----------
cd "$PROJECT_DIR"
git init -q 2>/dev/null || true
git checkout -b main 2>/dev/null || git checkout main

cat > .gitignore <<'EOF'
node_modules/
*.log
.DS_Store
EOF

git add -A
git -c user.name="bootstrap" -c user.email="bootstrap@local" \
  commit -q -m "feat: MV3 浏览器扩展 for wuzf/2fa（服务端零改动）

- src/lib/api.js: 按上游 v1.9.0 源码核实的 API 契约
  （登录字段 credential、/api/secrets 裸数组、HOTP 快照上推）
- Bearer 认证：上游 verifyAuth() 原生支持，无需打补丁
- 跨域：靠 SW + 单 origin host 权限豁免 CORS，不放宽 SameSite
- 剪贴板三级降级：SW 无 Clipboard API，用 offscreen / content script 兜底
- 验证脚本 101 项：OTP 20 + 上游契约漂移 33 + 端到端集成 48（零依赖）

上游: wuzf/2fa (MIT)"

# ---------- 5. 推送 ----------
git remote remove origin 2>/dev/null || true
git remote add origin "https://oauth2:${GITHUB_TOKEN}@github.com/${OWNER}/${REPO_NAME}.git"
git push -u origin main

echo ""
echo "✅ 完成: https://github.com/$OWNER/$REPO_NAME"
echo ""
echo "下一步："
echo "  1. chrome://extensions → 加载已解压的扩展程序 → 选择 src/ 目录"
echo "  2. 选项页填入 Worker 地址 → 「授权访问该地址」→ 用主密码登录"
echo "  3. 若上游升级，先跑 node scripts/verify-contract.mjs 检查契约是否漂移"
echo ""
echo "仅 Firefox 需要服务端补丁，见 server-patch/README.md"
