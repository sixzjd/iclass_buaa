#!/usr/bin/env bash
#
# iClass 自动签到 —— 树莓派 / Linux 一键安装
#
# 这个脚本只做「无界面签到守护进程」的部署。它不碰 Electron 桌面端。
#
# 用法（在树莓派上执行，需要 root）：
#   sudo bash install-pi.sh --src /path/to/iclass_buaa-main     # 给整个仓库
#   sudo bash install-pi.sh --src /path/to/autosign.js          # 只给单个 bundle 也行
#
# 可选参数：
#   --user <name>          以哪个用户身份运行（默认：调用 sudo 的那个用户，绝不用 root）
#   --install-dir <path>   程序目录（默认 /opt/iclass）
#   --config-dir <path>    配置目录（默认 /etc/iclass）
#   --config <path>        直接指定配置文件路径（默认 <config-dir>/config.json）
#   --no-start             只安装，不启动
#
# 关键事实：server/dist/autosign.js 是 esbuild 打包的**自包含**单文件（约 3 MB），
# 所有依赖已内联。所以目标机器**不需要 npm install、不需要编译**，只要有 Node >= 18。

set -euo pipefail

INSTALL_DIR="/opt/iclass"
CONFIG_DIR="/etc/iclass"
CONFIG_FILE=""
SERVICE_NAME="iclass-autosign"
RUN_USER=""
SRC=""
START=1
MIN_NODE_MAJOR=18

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --src)         SRC="${2:-}"; shift 2 ;;
        --user)        RUN_USER="${2:-}"; shift 2 ;;
        --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
        --config-dir)  CONFIG_DIR="${2:-}"; shift 2 ;;
        --config)      CONFIG_FILE="${2:-}"; shift 2 ;;
        --no-start)    START=0; shift ;;
        -h|--help)     sed -n '2,19p' "$0"; exit 0 ;;
        *)             die "未知参数：$1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root：请用 sudo bash $0 --src <路径>"

# ---------- 1. 确定运行用户（绝不用 root 跑守护进程） ----------
if [ -z "$RUN_USER" ]; then
    RUN_USER="${SUDO_USER:-}"
fi
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
    # 退而求其次：找第一个 uid >= 1000 的普通用户
    RUN_USER="$(awk -F: '$3 >= 1000 && $3 < 60000 { print $1; exit }' /etc/passwd || true)"
fi
[ -n "$RUN_USER" ] || die "无法确定运行用户，请显式传 --user <name>"
id "$RUN_USER" >/dev/null 2>&1 || die "用户不存在：$RUN_USER"
log "运行用户：$RUN_USER"

# ---------- 2. 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
    warn "未检测到 Node.js，尝试用 apt 安装..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y nodejs || true
    fi
fi
command -v node >/dev/null 2>&1 || die "仍未安装 Node.js。请装 Node >= ${MIN_NODE_MAJOR}（Raspberry Pi OS Bookworm 可直接 apt install nodejs）"

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node 版本过低（当前 $(node -v)，需要 >= ${MIN_NODE_MAJOR}）。可用 NodeSource 装新版：curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
fi
log "Node：$($NODE_BIN -v)（$NODE_BIN）"

# ---------- 3. 准备 bundle ----------
[ -n "$SRC" ] || die "必须指定 --src（仓库目录，或直接指向 autosign.js）"
[ -e "$SRC" ] || die "路径不存在：$SRC"

TMP_BUNDLE="$(mktemp)"
trap 'rm -f "$TMP_BUNDLE"' EXIT

if [ -f "$SRC" ] && [ "${SRC##*.}" = "js" ]; then
    log "使用现成的 bundle：$SRC"
    cp "$SRC" "$TMP_BUNDLE"
elif [ -f "$SRC/server/dist/autosign.js" ]; then
    log "使用仓库里已打包好的 bundle：$SRC/server/dist/autosign.js"
    cp "$SRC/server/dist/autosign.js" "$TMP_BUNDLE"
elif [ -f "$SRC/server/src/cli/autosign.ts" ]; then
    log "仓库里没有打包产物，在本机现场编译（需要 npm，会装 devDependencies）..."
    ( cd "$SRC/server" && npm install --no-audit --no-fund && npx esbuild src/cli/autosign.ts --bundle --platform=node --outfile=dist/autosign.js --external:fsevents )
    cp "$SRC/server/dist/autosign.js" "$TMP_BUNDLE"
else
    die "在 $SRC 里找不到 autosign.js 或 server/src/cli/autosign.ts"
fi

# 冒烟：确认 bundle 能被 Node 解析且 --help 正常
"$NODE_BIN" "$TMP_BUNDLE" --help >/dev/null 2>&1 || die "bundle 无法运行，请检查 Node 版本"

# ---------- 4. 安装程序 ----------
mkdir -p "$INSTALL_DIR"
install -m 0644 -o root -g root "$TMP_BUNDLE" "$INSTALL_DIR/autosign.js"
log "已安装：$INSTALL_DIR/autosign.js"

# ---------- 5. 准备配置 ----------
mkdir -p "$CONFIG_DIR"
chmod 0755 "$CONFIG_DIR"
[ -n "$CONFIG_FILE" ] || CONFIG_FILE="$CONFIG_DIR/config.json"

if [ -f "$CONFIG_FILE" ]; then
    log "配置文件已存在，保留不动：$CONFIG_FILE"
else
    log "生成配置模板：$CONFIG_FILE"
    cat > "$CONFIG_FILE" <<'JSON'
{
  "studentId": "在这里填学号",
  "password": "在这里填密码",
  "useVpn": true,
  "vpnUsername": "",
  "vpnPassword": "",

  "leadMinutes": 3,
  "maxAttempts": 3,
  "retryIntervalSeconds": 60,
  "giveUpMinutesAfterStart": 0,
  "timetableRefreshMinutes": 10,
  "sessionMaxAgeMinutes": 30,

  "includeCourses": [],
  "excludeCourses": [],
  "logFile": "",

  "notify": {
    "type": "none",
    "on": ["failure"],
    "serverchanKey": "",
    "pushplusToken": "",
    "barkUrl": "",
    "ntfyUrl": "",
    "ntfyToken": "",
    "webhookUrl": ""
  }
}
JSON
    warn "请先编辑 $CONFIG_FILE 填入学号和密码，否则服务会启动失败"
    warn "通知默认关闭（notify.type = \"none\"）。想收失败提醒就把 type 改成 serverchan / pushplus / bark / ntfy / webhook"
fi
chown "$RUN_USER":"$RUN_USER" "$CONFIG_FILE" 2>/dev/null || chown "$RUN_USER" "$CONFIG_FILE"
chmod 0600 "$CONFIG_FILE"
log "配置权限：$(stat -c '%a %U' "$CONFIG_FILE" 2>/dev/null || stat -f '%Lp %Su' "$CONFIG_FILE")"

# ---------- 6. 安装 systemd 单元 ----------
UNIT_SRC="$SCRIPT_DIR/iclass-autosign.service"
[ -f "$UNIT_SRC" ] || UNIT_SRC="$SRC/scripts/iclass-autosign.service"
[ -f "$UNIT_SRC" ] || die "找不到 iclass-autosign.service 模板"

UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"
sed -e "s|@RUN_USER@|$RUN_USER|g" \
    -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    -e "s|@CONFIG_FILE@|$CONFIG_FILE|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    "$UNIT_SRC" > "$UNIT_DST"
log "已写入 systemd 单元：$UNIT_DST"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true

# ---------- 7. 启动 ----------
if [ "$START" -eq 1 ]; then
    if grep -q '在这里填' "$CONFIG_FILE" 2>/dev/null; then
        warn "配置还没填（仍是模板内容），先不启动。填好后执行："
        echo "    sudo systemctl start $SERVICE_NAME"
    else
        systemctl restart "$SERVICE_NAME"
        sleep 3
        systemctl --no-pager --lines=15 status "$SERVICE_NAME" || true
    fi
else
    log "--no-start 已指定，不启动服务"
fi

cat <<EOF

────────────────────────────────────────
安装完成。常用命令：

  填/改配置     sudo nano $CONFIG_FILE
  启动          sudo systemctl start $SERVICE_NAME
  停止          sudo systemctl stop $SERVICE_NAME
  开机自启      sudo systemctl enable $SERVICE_NAME
  看日志        sudo journalctl -u $SERVICE_NAME -f
  看今天课表    sudo -u $RUN_USER $NODE_BIN $INSTALL_DIR/autosign.js --list
  立刻签一次    sudo -u $RUN_USER $NODE_BIN $INSTALL_DIR/autosign.js --now
  测通知通道    sudo -u $RUN_USER $NODE_BIN $INSTALL_DIR/autosign.js --test-notify

签到行为（默认，可在配置文件里改）：课前 3 分钟开始，最多尝试 3 次、每次间隔 60 秒，
          三次没成就停手并发一条失败通知（通知在课前送达，还来得及手动补签）。

EOF
