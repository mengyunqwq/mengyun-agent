#!/usr/bin/env bash
# ============================================================
#  梦云 Agent —— 一键启动（Linux / macOS）
#  默认打开网页界面
#
#  用法：
#    ./start.sh              打开网页界面（默认）
#    ./start.sh doctor       环境体检
#    ./start.sh tools        列出工具
#    ./start.sh chat         在终端里对话
#
#  注意：网页界面模式下这个终端要保持开着，Ctrl+C 即停止服务。
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "  梦云 Agent 启动中..."
echo "  ----------------------------------------"

# ---------- 1. 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "  [X] 没有找到 Node.js"
  echo ""
  echo "  请先安装 Node.js 18 或更高版本："
  echo "    macOS:  brew install node"
  echo "    Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  echo ""
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [X] Node.js 版本过低（$(node -v)），需要 18 或更高"
  exit 1
fi
echo "  [√] Node.js $(node -v)"

# ---------- 2. 检查配置 ----------
if [ ! -f config.json ]; then
  echo "  [X] 缺少 config.json，请确认文件完整"
  exit 1
fi

# ---------- 3. 首次运行生成 .env ----------
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "  [!] 已生成 .env，请填入你的 API Key"
  echo ""
  echo "  编辑命令：nano .env    （或 vim .env）"
  echo "  至少填上：MYA_API_KEY=sk-xxxx"
  echo ""
  exit 0
fi

# ---------- 4. 启动 ----------
if [ "$#" -eq 0 ]; then
  set -- web
fi
exec node bin/mya.js "$@"
