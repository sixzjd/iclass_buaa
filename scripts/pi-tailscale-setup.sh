#!/usr/bin/env bash
# pi-tailscale-setup.sh —— 在树莓派上装 Tailscale
#
# 解决什么问题：校园网里，你的 Mac 和树莓派经常不在同一个二层网段
# （同一个 SSID，但教学区 / 寝室 / 不同楼栋挂在不同 VLAN），于是 SSH / VNC 全连不上。
# Tailscale 组一张覆盖网络（overlay），两台设备只要各自能上网就能直连，
# 不再受网段和客户端隔离影响。树莓派继续用校园网 Wi-Fi 签到，不受任何影响。
#
# 用法（在树莓派上执行）:
#   sudo bash pi-tailscale-setup.sh
#
# 装完后：
#   1) 脚本会打印一个 https://login.tailscale.com/... 的授权链接，在浏览器里打开并登录
#   2) 之后在 Mac 上也装 Tailscale（App Store 搜 Tailscale，或 brew install --cask tailscale）
#   3) 两边登录同一个账号，就能直接 ssh 过去

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "请用 root 跑： sudo bash $0" >&2
    exit 1
fi

echo "============================================================"
echo "  树莓派 Tailscale 安装"
echo "============================================================"
echo

# ---------- 0. 先报告本机现状（万一后面出问题，这些信息有用）----------
echo "[0] 本机现状"
echo "  主机名 : $(hostname)"
echo "  系统   : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"
echo "  架构   : $(uname -m)"
echo -n "  IPv4   : "
hostname -I 2>/dev/null || ip -4 -o addr show scope global | awk '{print $4}' | tr '\n' ' '
echo
echo -n "  外网   : "
if curl -fsS --max-time 8 -o /dev/null https://tailscale.com 2>/dev/null; then
    echo "可达"
else
    echo "不可达 —— 先修好树莓派的网络再装（Tailscale 必须能连外网）"
    exit 1
fi
echo

# ---------- 1. 已装过就跳过 ----------
if command -v tailscale >/dev/null 2>&1; then
    echo "[1] Tailscale 已安装，跳过安装步骤"
else
    echo "[1] 安装 Tailscale（官方脚本）"
    curl -fsSL https://tailscale.com/install.sh | sh
    echo "  安装完成"
fi
echo

# ---------- 2. 启动并加入网络 ----------
echo "[2] 加入 Tailscale 网络"
echo "  注意：--ssh 会启用 Tailscale SSH，之后从你的 Mac 连它不用配密钥、不用输密码。"
echo "  下面会打印一个授权链接 —— 在浏览器里打开，用你的账号登录即可。"
echo
# --accept-routes 让树莓派也能走别的节点的子网路由；--ssh 启用免密钥 SSH
tailscale up --ssh --accept-routes || {
    echo
    echo "  'tailscale up' 没成功。手动重试一次： sudo tailscale up --ssh"
    exit 1
}
echo

# ---------- 3. 结果 ----------
echo "============================================================"
echo "  完成。下面是你在 Mac 上要用的信息"
echo "============================================================"
tailscale status || true
echo
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
echo "  Tailscale IP : ${TS_IP:-（见上方 status 输出）}"
echo "  主机名       : $(hostname)"
echo
echo "  在 Mac 上连接（Tailscale 装好并登录同一账号后）："
echo "     ssh sunzhengnan@$(hostname)"
if [ -n "${TS_IP:-}" ]; then
    echo "     ssh sunzhengnan@${TS_IP}"
fi
echo
echo "  VNC（要图形界面时）：连 ${TS_IP:-<Tailscale-IP>}:5900"
echo
echo "  验证签到服务还在跑："
echo "     systemctl is-active iclass-gui"
echo
echo "  提示：Tailscale 是开机自启的，装一次就行，以后不用管。"
echo "============================================================"
