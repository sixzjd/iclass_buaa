#!/usr/bin/env bash
# check-pi.sh —— 一键判断"为什么连不上树莓派"
#
# 用法:
#   bash scripts/check-pi.sh                  # 默认查 10.135.46.146
#   bash scripts/check-pi.sh 10.135.47.88     # 指定 IP
#
# 为什么需要它：校园网里"连不上"有四种完全不同的原因，症状看起来一样，
# 处理方式却相反。本脚本按层往下测，最后给出一句结论。
#
#   1. 本机没网            → 查 Wi-Fi
#   2. 本机有网但二层不通  → 换了网段 / 客户端隔离（最常见，去同一个 AP 下）
#   3. 二层通但端口关闭    → 设备在线，是服务没起（去机器上看 systemctl）
#   4. 全通                → 直接 ssh 上去

set -u

TARGET="${1:-10.135.46.146}"
IFACE="${2:-en0}"

line()  { printf '%s\n' "============================================================"; }
ok()    { printf '  [ OK ]   %s\n' "$1"; }
fail()  { printf '  [FAIL]   %s\n' "$1"; }
info()  { printf '  [info]   %s\n' "$1"; }
probe() { nc -z -G "${NC_TIMEOUT:-3}" -w "${NC_TIMEOUT:-3}" "$1" "$2" >/dev/null 2>&1; }

line
printf '  诊断目标: %s\n' "$TARGET"
printf '  时间    : %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
line

# ---------- 0. 本机网络环境 ----------
printf '\n[0] 本机网络环境\n'
LOCAL_IP="$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)"
if [ -n "$LOCAL_IP" ]; then
    MASK="$(ifconfig "$IFACE" 2>/dev/null | awk '/inet /{print $4; exit}')"
    ok "网卡 $IFACE 地址 = $LOCAL_IP  掩码 = $MASK"
    case "$MASK" in
        0xffff0000)
            info "掩码是 /16 —— 系统会把整个 10.135.x.x 当作「本地」，"
            info "于是直接发 ARP 而不交给网关。跨网段时这必然失败。" ;;
    esac
else
    fail "网卡 $IFACE 没有 IP"
fi
GW="$(netstat -rn -f inet 2>/dev/null | awk '$1=="default"{print $2; exit}')"
[ -n "${GW:-}" ] && info "默认网关 = $GW" || fail "没有默认网关"

# ---------- 1. 本机是否真的在网 ----------
printf '\n[1] 本机连通性（先排除「自己没网」）\n'
if [ -n "${GW:-}" ] && ping -c 2 -W 1500 "$GW" >/dev/null 2>&1; then
    ok "网关 $GW 可达 —— 局域网链路正常"
    NET_OK=1
else
    fail "网关 ${GW:-?} 不可达"
    NET_OK=0
fi
if probe 223.5.5.5 53; then
    ok "公网可达（223.5.5.5:53）"
    WAN_OK=1
else
    fail "公网不可达"
    WAN_OK=0
fi

# ---------- 2. 目标是否可达（ICMP）----------
printf '\n[2] 目标主机 ICMP\n'
if ping -c 2 -W 1500 "$TARGET" >/dev/null 2>&1; then
    ok "$TARGET 能 ping 通"
    ICMP_OK=1
else
    fail "$TARGET ping 不通"
    ICMP_OK=0
fi

# ---------- 3. 二层是否通（ARP）----------
printf '\n[3] 二层可达性（ARP）—— 区分「换了网段」和「设备没开」\n'
ARP_RAW="$(arp -n "$TARGET" 2>/dev/null || true)"
if printf '%s' "$ARP_RAW" | grep -q '(incomplete)'; then
    fail "ARP 无应答（incomplete）"
    info "本机在本地网段广播了 ARP，没有任何设备认领这个 IP。"
    info "⇒ 大概率是二层不通：你换了网段，或该 AP 开了客户端隔离。"
    ARP_OK=0
elif [ -n "$ARP_RAW" ]; then
    MAC="$(printf '%s' "$ARP_RAW" | awk '{for(i=1;i<=NF;i++) if($i=="at"){print $(i+1)}}')"
    ok "ARP 已解析，MAC = ${MAC:-?} —— 二层是通的"
    ARP_OK=1
else
    fail "ARP 表里没有该地址的条目"
    ARP_OK=0
fi

# ---------- 4. 端口 ----------
printf '\n[4] 常用端口\n'
P22=0; P5900=0; P445=0
probe "$TARGET" 22   && { ok "22   (SSH)   开"; P22=1; }   || info "22   (SSH)   关/不可达"
probe "$TARGET" 5900 && { ok "5900 (VNC)   开"; P5900=1; } || info "5900 (VNC)   关/不可达"
probe "$TARGET" 445  && { ok "445  (SMB)   开"; P445=1; }  || info "445  (SMB)   关/不可达"

# ---------- 结论 ----------
printf '\n'
line
printf '  结论\n'
line
if [ "$NET_OK" = 0 ] && [ "$WAN_OK" = 0 ]; then
    printf '  本机没网。先修 Wi-Fi / 网线，别的都别查。\n'
elif [ "$ARP_OK" = 0 ] && [ "$ICMP_OK" = 0 ]; then
    printf '  二层不通 —— 你和树莓派不在同一个二层网段。\n\n'
    printf '  这是校园网最常见的情况：同一个 SSID，但教学区 / 寝室 / 不同楼栋\n'
    printf '  挂在不同 VLAN 上，而且宿舍区通常还开了客户端隔离（同网段也互不通）。\n\n'
    printf '  怎么办：\n'
    printf '    · 把 Mac 换到和树莓派同一个 AP / 同一片网络下再试\n'
    printf '    · 或登路由器管理页看设备列表，确认树莓派在不在、IP 是多少\n'
    printf '    · 想一劳永逸 → 在树莓派上跑 scripts/pi-tailscale-setup.sh\n'
    printf '  注意：这不影响树莓派自己签到，它不依赖你的 Mac 能连上它。\n'
elif [ "$ARP_OK" = 1 ] && [ "$P22" = 0 ]; then
    printf '  设备在线（二层通、ARP 已解析），但 22 端口没开。\n'
    printf '  ⇒ 树莓派是开着的，问题在服务侧：去机器上看\n'
    printf '     sudo systemctl status iclass-gui\n'
    printf '     sudo systemctl status ssh\n'
elif [ "$P22" = 1 ]; then
    printf '  全通。直接连：\n'
    printf '     ssh sunzhengnan@%s\n' "$TARGET"
else
    printf '  情况不明，请把上面的完整输出贴出来。\n'
fi
line
