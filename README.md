# 🎓 北航 iClass 签到系统

> **支持 校园网直连 / WebVPN 登录**
>
> ⚠️ **免责声明**：本项目为开源代码，使用者需自行选择是否使用，并应遵守北京航空航天大学的相关规定。因使用本项目产生的一切后果均由使用者本人承担。

## 📢 更新说明

### 2026-09-22

- **修复「签到永远报 `ERRCODE 100 参数错误!`」这个长期问题。** 根因：iClass 签到接口只接受落在 **[服务端时间 −3s, +1s]** 内的毫秒时间戳，而本机时钟可能比 iClass 快数秒，程序自造的 `Date.now()` 恒定落在窗口外。v1.0.4 用服务器 `Date` 响应头校正（方向对），但该头只有秒级精度，补不上几秒偏差。
  → 现在**签到前先向 iClass 索取服务端时间戳**（`GET /app/common/get_timestamp.action`）再提交。同一门课实测：本机时间戳 → `ERRCODE 100`；服务端时间戳 → `STATUS:0` 且复检 `signStatus=1`。
- **签到失败不再谎报成功**：只有复检到 `get_stu_course_sched` 的 `signStatus === '1'` 才显示「签到成功」，否则明确报出 `ERRCODE`/`ERRMSG`。
- **桌面端课前 2 分钟自动签到**：到点自动开始，最多尝试 3 次、每次间隔 30 秒（T-2 / T-1:30 / T-1），三次没成就停手并弹失败告警 + 桌面通知 —— 告警在课前 1 分钟送达，还来得及手动补签。
- 新增**无界面命令行**与**树莓派 / Linux 部署**（systemd）+ **失败通知推送**（Server酱 / pushplus / Bark / ntfy / webhook），见下方章节。

### 2026-06-01 — v1.0.4

修复 Windows 端 WebVPN 模式登录失败（[PR #20](https://github.com/zeroduhyy/iclass_buaa/pull/20)），优化 VPN 链路时间修正。感谢 [@Yiki21](https://github.com/Yiki21)。

> 提醒：学校服务器**不支持补签**，务必在上课时间内完成签到。

## 🛠️ 部署与打包

*注：原先的 Python 版本代码已迁移至 `python` 分支。*

**本地运行**（自动装依赖并打开客户端）

```bash
./scripts/setup.sh     # Linux / Mac
./scripts/setup.bat    # Windows
```

**打包 Windows 版**

```bash
npm run build:win      # 产物输出到 dist_exe/
```

**换图标**：替换根目录的 `icon.ico` 即可。

## 🍓 无界面部署（树莓派 / Linux）

桌面端是 Electron 程序，**树莓派上跑不了**。所以另提供一个无界面签到守护进程，复用同一套 `core`/`services`。

> **本节是备选方案，且同一账号只应部署一套。** 桌面端、本节的 Node 无界面版、以及 [`python` 分支](https://github.com/zeroduhyy/iclass_buaa/tree/python) 的 Flask Web 版三者**功能重叠**。若你已经有能用的部署（例如自行维护的 Python/Tkinter 版），直接沿用即可，不必再装本节这套。**两套同时运行会各自独立登录、重复签到并互相抢会话**，务必只保留一套。

**行为**：每天自动拉当天课表 → 对所有未签的课在课前 2 分钟开火 → 最多尝试 3 次、每次间隔 30 秒（T-2 / T-1:30 / T-1）→ 三次没成就停手并推一条失败通知。通知在课前 1 分钟送达，还来得及手动补签 —— 这是刻意的取舍：**不做无限重试，宁可早点告警**。成功与否以复检到的 `signStatus` 为准，不会谎报。

**依赖**：只要 **Node.js ≥ 18**。`server/dist/autosign.js` 是 esbuild 打包的**自包含单文件**（约 3 MB，依赖全内联），目标机**不需要 `npm install`、不需要编译**。

```bash
# 1) 把仓库（或仅仅 server/dist/autosign.js 一个文件）放到树莓派
#    rsync -av --exclude node_modules --exclude client/dist ./ pi@<IP>:/home/pi/iclass_buaa-main/

# 2) 安装（需要 root）
cd iclass_buaa-main && sudo bash scripts/install-pi.sh --src .

# 3) 填学号密码，然后启动
sudo nano /etc/iclass/config.json
sudo systemctl start iclass-autosign
```

装完即已 `systemctl enable`，开机自动运行。

**配置文件**：默认 `/etc/iclass/config.json`（权限 `600`）。除 `studentId`/`password` 外都有默认值：

```json
{
  "studentId": "", "password": "", "useVpn": true,
  "vpnUsername": "", "vpnPassword": "",

  "leadMinutes": 2, "maxAttempts": 3, "retryIntervalSeconds": 30,
  "giveUpMinutesAfterStart": 0, "timetableRefreshMinutes": 10, "sessionMaxAgeMinutes": 30,

  "includeCourses": [], "excludeCourses": [], "logFile": "",

  "notify": {
    "type": "none", "on": ["failure"],
    "serverchanKey": "", "pushplusToken": "", "barkUrl": "",
    "ntfyUrl": "", "ntfyToken": "", "webhookUrl": ""
  }
}
```

| 字段 | 说明 |
|---|---|
| `useVpn` | 走 WebVPN。**账号未绑手机号时必须为 `true`** —— iClass 直连登录只认 `phone` 字段。本实现严格按此值走，**不做**「先直连、失败再切 VPN」的自动探测，所以直连不通时不要指望它自己回退 |
| `vpnUsername` / `vpnPassword` | 留空则复用 `studentId` / `password` |
| `leadMinutes` | 课前几分钟开火（默认 2） |
| `maxAttempts` | 最多尝试几次。**默认 3，三次没成就停手** |
| `retryIntervalSeconds` | 尝试间隔（默认 30 秒）。配合 `leadMinutes: 2` 落在 T-2 / T-1:30 / T-1 |
| `giveUpMinutesAfterStart` | 上课后多少分钟放弃。**`0`（默认）= 一直跟到下课** |
| `timetableRefreshMinutes` / `sessionMaxAgeMinutes` | 课表刷新间隔 / 会话强制重登间隔 |
| `includeCourses` / `excludeCourses` | 按 `courseSchedId` 白/黑名单，留空 = 全部 |
| `logFile` | 可选，额外写日志文件；不填则只进 journald |

**失败通知**：默认关闭。把 `notify.type` 改成下表任一值并填对应字段：

| `type` | 要填 | 说明 |
|---|---|---|
| `serverchan` | `serverchanKey` | [Server酱³](https://sct.ftqq.com/) SendKey（也支持完整 URL） |
| `pushplus` | `pushplusToken` | [pushplus](https://www.pushplus.plus/) token |
| `bark` | `barkUrl` | 形如 `https://api.day.app/<key>` |
| `ntfy` | `ntfyUrl`（+可选 `ntfyToken`） | 形如 `https://ntfy.sh/<topic>`，手机装 ntfy App 订阅同名 topic |
| `webhook` | `webhookUrl` | 通用 POST JSON `{title, content, ...}`，可接企业微信/钉钉机器人 |

`notify.on` 决定通知哪些事件，默认 `["failure"]`。改完先自测：`--test-notify`。通知失败**不影响**签到主流程，只记一条日志。

**常用命令**

```bash
sudo journalctl -u iclass-autosign -f     # 实时日志
sudo -u pi node /opt/iclass/autosign.js --list          # 只看今天的课表与开火计划
sudo -u pi node /opt/iclass/autosign.js --now           # 立刻签今天所有未签的课
sudo -u pi node /opt/iclass/autosign.js --test-notify   # 只发一条测试通知
sudo systemctl restart iclass-autosign    # 改完配置后重启
```

**从源码构建**：`cd server && npm install && npm run build:cli` → 产出 `dist/autosign.js`。

## ⚠️ 注意事项

- 本项目仅用于个人学习和研究交流，**请勿用于违反学校规定的用途**。
- 会话 (Session) 仅在本地存储登录状态，**绝不会**收集或上传账号与密码。
- 若 iClass 接口更新，可能需要调整代码才能继续使用，不保证长期及时更新。

## ✨ 致谢

感谢 [@Yiki21](https://github.com/Yiki21)、[@el-ev](https://github.com/el-ev) 对本项目的贡献。
