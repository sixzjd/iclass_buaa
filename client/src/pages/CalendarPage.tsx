import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { logout } from "../api/auth";
import { fetchCourseDetails, generateSignQr, signNow as signCourse } from "../api/course";
import type { ApiResponse, CourseDetailItem, SignOutcomeData } from "../types/api";
import { clearSession, getUseVpnMode, getUserDisplay } from "../utils/session";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const timeSlots = [
    { key: "morning", label: "上午", range: "08:00-12:15" },
    { key: "afternoon", label: "下午", range: "14:00-18:15" },
    { key: "night", label: "晚上", range: "19:00-22:25" }
];

const formatYmd = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
};

const parseHour = (time: string): number => {
    const match = String(time).match(/^(\d{1,2}):/);
    return match ? Number(match[1]) : -1;
};

const parseMinute = (time: string): number => {
    const match = String(time).match(/^(\d{1,2}):(\d{2})/);
    if (!match) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Number(match[1]) * 60 + Number(match[2]);
};

const getSlotKey = (item: CourseDetailItem): "morning" | "afternoon" | "night" => {
    const hour = parseHour(item.startTime);
    if (hour >= 8 && hour < 12) {
        return "morning";
    }
    if (hour >= 14 && hour < 18) {
        return "afternoon";
    }
    return "night";
};

const toCellKey = (dateYmd: string, slot: string): string => `${dateYmd}|${slot}`;

const formatMonthDay = (date: Date): string => {
    return `${date.getMonth() + 1}/${date.getDate()}`;
};

const formatDateTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
};

/** 手动点「签到」时的重试参数：每 15s 一次，最多 60 次（15 分钟），期间可手动停止 */
const SIGN_RETRY_INTERVAL_MS = 15_000;
const SIGN_MAX_ATTEMPTS = 60;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });

/**
 * 课前自动签到（用户明确要求，别改）：
 *   课前 2 分钟开火 → 最多尝试 3 次、每次间隔 30 秒（即 T-2 / T-1:30 / T-1）→
 *   三次没成就停手，并弹出失败告警。
 * 这样告警在课前 1 分钟送达，用户还来得及手动补签；不再无限重试。
 * 另外：课前 5 分钟不要开始打（用户明确否决过）。
 */
const AUTO_SIGN_LEAD_MS = 2 * 60 * 1000;
const AUTO_SIGN_MAX_ATTEMPTS = 3;
const AUTO_SIGN_RETRY_INTERVAL_MS = 30_000;
/** 错过太久（超过开火时间 20 分钟）就不再自动追 */
const AUTO_SIGN_GIVE_UP_MS = 20 * 60 * 1000;
const AUTO_SIGN_STORAGE_KEY = "iclass_auto_sign";

/**
 * 桌面系统通知。拿不到权限就算了 —— 界面上的红色告警才是主通道，
 * 通知只是"用户切到别的窗口去了"时的兜底。
 */
const notifyDesktop = (title: string, body: string): void => {
    try {
        if (typeof Notification === "undefined") {
            return;
        }
        if (Notification.permission === "granted") {
            new Notification(title, { body });
        } else if (Notification.permission !== "denied") {
            void Notification.requestPermission().then((permission) => {
                if (permission === "granted") {
                    new Notification(title, { body });
                }
            });
        }
    } catch {
        // 忽略：通知失败不影响签到本身
    }
};

interface AutoSignPlan {
    courseSchedId: string;
    courseName: string;
    /** 上课时间（epoch ms） */
    startAt: number;
    /** 计划开火时间 = startAt - 3 分钟 */
    fireAt: number;
}

/** 把 "2026-09-22" + "19:00" 拼成 epoch ms；解析不了返回 null */
const parseCourseStartMs = (dateYmd: string, hhmm: string): number | null => {
    const d = String(dateYmd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const t = String(hhmm).match(/^(\d{1,2}):(\d{2})/);
    if (!d || !t) {
        return null;
    }
    const ms = new Date(
        Number(d[1]),
        Number(d[2]) - 1,
        Number(d[3]),
        Number(t[1]),
        Number(t[2]),
        0,
        0
    ).getTime();
    return Number.isFinite(ms) ? ms : null;
};

const formatClock = (ms: number): string =>
    new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });

/** 自动签到计划落 localStorage：刷新/重开窗口后还能继续生效 */
const readAutoSignPlan = (): AutoSignPlan | null => {
    try {
        const raw = window.localStorage.getItem(AUTO_SIGN_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<AutoSignPlan>;
        if (
            !parsed?.courseSchedId ||
            typeof parsed.fireAt !== "number" ||
            typeof parsed.startAt !== "number"
        ) {
            return null;
        }
        return {
            courseSchedId: String(parsed.courseSchedId),
            courseName: String(parsed.courseName ?? ""),
            startAt: parsed.startAt,
            fireAt: parsed.fireAt
        };
    } catch {
        return null;
    }
};

const writeAutoSignPlan = (plan: AutoSignPlan | null): void => {
    try {
        if (plan) {
            window.localStorage.setItem(AUTO_SIGN_STORAGE_KEY, JSON.stringify(plan));
        } else {
            window.localStorage.removeItem(AUTO_SIGN_STORAGE_KEY);
        }
    } catch {
        // localStorage 不可用时降级为仅内存状态，不影响本次会话
    }
};

/**
 * iClass 错误码字典（2026-09-22 实测）。
 * 注意 ERRCODE 100 是**通用参数校验失败**，实测发生在实体查找之前 ——
 * 请求形状正确之后，它通常意味着"当前不在签到窗口 / 老师未开启签到"，
 * 而不是"程序写错了"。真正的元凶是本机时间戳，已由服务端改为向 iClass 索取。
 */
const ICLASS_ERR_HINT: Record<string, string> = {
    "100": "iClass 拒绝了请求，通常是老师尚未开启签到或已关闭",
    "101": "时间戳已过期，或当前不是上课时间",
    "106": "账号标识不被 iClass 识别，该账号可能未绑定手机号"
};

/** iClass 的 ERRMSG 文案 -> 人话（措辞对照 Yiki21/iclass_buaa_tui 的实现） */
const ICLASS_MSG_HINT: Array<{ match: string; hint: string }> = [
    { match: "未开始", hint: "签到还没开始" },
    { match: "不是上课时间", hint: "当前不是上课时间，签到窗口未开" },
    { match: "已结束", hint: "签到已结束" },
    { match: "范围", hint: "不在签到范围内（可能受定位/校区限制）" },
    { match: "已签到", hint: "该节次已经签过了" },
    { match: "失效", hint: "二维码/时间戳已失效，需重新获取" }
];

/**
 * 把服务端的签到结果翻译成人能看懂的一句话。
 * 服务端已保证 ok === true 一定代表复检到 signStatus === '1'，这里只处理失败分支。
 */
const describeSignFailure = (res: ApiResponse<unknown>): string => {
    const payload = (res.data ?? null) as Partial<SignOutcomeData> | null;
    if (!payload || typeof payload !== "object") {
        return res.message || "未知原因";
    }

    const parts: string[] = [];

    // 时间戳来源不正常时先报这个：它是"参数错误"最常见的根因
    if (payload.timestampSource && payload.timestampSource !== "server") {
        parts.push(
            payload.timestampSource === "qr"
                ? "时间戳取自二维码"
                : `时间戳为本机时钟兜底（未能取到 iClass 下发的时间戳：${payload.timestampError ?? "未知原因"}）`
        );
    }

    const msgHint = ICLASS_MSG_HINT.find((item) =>
        String(payload.iclassErrMsg ?? "").includes(item.match)
    );

    if (payload.iclassErrCode) {
        const hint = msgHint?.hint ?? ICLASS_ERR_HINT[payload.iclassErrCode];
        const head = `iClass ERRCODE=${payload.iclassErrCode} ${payload.iclassErrMsg ?? ""}`.trim();
        parts.push(hint ? `${head}（${hint}）` : head);
    } else if (payload.iclassErrMsg) {
        parts.push(msgHint ? `${payload.iclassErrMsg}（${msgHint.hint}）` : payload.iclassErrMsg);
    }

    if (payload.verify) {
        parts.push(
            payload.verify.checked
                ? `复检 signStatus=${payload.verify.signStatus ?? "未查到该节次"}`
                : `复检失败（${payload.verify.error ?? "未知"}）`
        );
    }

    const detail = parts.join("，");
    return detail ? `${res.message}（${detail}）` : res.message || "未知原因";
};

const CalendarPage = () => {
    const navigate = useNavigate();
    const [weekOffset, setWeekOffset] = useState(0);
    const [selectedCourse, setSelectedCourse] = useState<CourseDetailItem | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [signMessage, setSignMessage] = useState("");
    const [qrImageDataUrl, setQrImageDataUrl] = useState("");
    const [qrGeneratedAt, setQrGeneratedAt] = useState<number | null>(null);
    const [isQrRefreshing, setIsQrRefreshing] = useState(false);
    const [detailItems, setDetailItems] = useState<CourseDetailItem[]>([]);
    const [isSigning, setIsSigning] = useState(false);
    const [signAttempt, setSignAttempt] = useState(0);
    const [qrLink, setQrLink] = useState("");
    const [qrResult, setQrResult] = useState("");
    const [isSigningByQr, setIsSigningByQr] = useState(false);
    const [autoSignPlan, setAutoSignPlan] = useState<AutoSignPlan | null>(null);
    /** 课前自动签到失败后的红色告警文案（非空即展示，用户手动签到成功后清掉） */
    const [autoSignAlert, setAutoSignAlert] = useState("");
    /** 每秒 +1，仅用于刷新倒计时显示 */
    const [autoSignTick, setAutoSignTick] = useState(0);
    const qrTimerRef = useRef<number | null>(null);
    const signStopRef = useRef(false);
    /** 防重入（自动签到与手动点击可能同时触发） */
    const isSigningRef = useRef(false);

    const user = useMemo(() => getUserDisplay(), []);
    const isVpnMode = useMemo(() => getUseVpnMode(), []);
    const isSelectedSigned = selectedCourse?.signStatus === "1";

    /** 自动签到倒计时文案（依赖 autoSignTick 每秒刷新） */
    const autoSignCountdown = useMemo(() => {
        if (!autoSignPlan) {
            return "";
        }
        const remain = autoSignPlan.fireAt - Date.now();
        if (remain <= 0) {
            return "即将开始";
        }
        const total = Math.ceil(remain / 1000);
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return minutes > 0
            ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒后开始`
            : `${seconds} 秒后开始`;
    }, [autoSignPlan, autoSignTick]);

    const weekStart = useMemo(() => {
        const now = new Date();
        const day = now.getDay();
        const mondayShift = day === 0 ? 6 : day - 1;
        const monday = new Date(now);
        monday.setHours(0, 0, 0, 0);
        monday.setDate(now.getDate() - mondayShift + weekOffset * 7);
        return monday;
    }, [weekOffset]);

    const weekDates = useMemo(() => {
        return weekdays.map((_, index) => {
            const date = new Date(weekStart);
            date.setDate(weekStart.getDate() + index);
            return date;
        });
    }, [weekStart]);

    const courseMapByCell = useMemo(() => {
        const map = new Map<string, CourseDetailItem[]>();
        for (const item of detailItems) {
            const cellKey = toCellKey(item.date, getSlotKey(item));
            const list = map.get(cellKey) ?? [];
            list.push(item);
            map.set(cellKey, list);
        }

        for (const list of map.values()) {
            list.sort((a, b) => {
                const startDiff = parseMinute(a.startTime) - parseMinute(b.startTime);
                if (startDiff !== 0) {
                    return startDiff;
                }

                const endDiff = parseMinute(a.endTime) - parseMinute(b.endTime);
                if (endDiff !== 0) {
                    return endDiff;
                }

                return String(a.name).localeCompare(String(b.name));
            });
        }

        return map;
    }, [detailItems]);

    const weekRangeLabel = useMemo(() => {
        const start = weekDates[0];
        const end = weekDates[6];
        const base = `${formatMonthDay(start)} - ${formatMonthDay(end)}`;
        if (weekOffset === 0) {
            return `${base} (本周)`;
        }
        return weekOffset > 0 ? `${base} (${weekOffset}周后)` : `${base} (${Math.abs(weekOffset)}周前)`;
    }, [weekDates, weekOffset]);

    const handleLogout = async () => {
        try {
            await logout();
        } finally {
            clearSession();
            navigate("/login", { replace: true });
        }
    };

    const loadCalendarData = async () => {
        setLoading(true);
        setError("");
        try {

            const detailRes = await fetchCourseDetails();
            if (!detailRes.ok || !detailRes.data) {
                throw new Error(detailRes.message || "课程详情获取失败");
            }

            setDetailItems(detailRes.data.details ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : "加载课程失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadCalendarData();
    }, []);

    useEffect(() => {
        return () => {
            if (qrTimerRef.current !== null) {
                window.clearInterval(qrTimerRef.current);
                qrTimerRef.current = null;
            }
        };
    }, []);

    // 启动时恢复上次未执行的自动签到计划（刷新/重开窗口后仍生效）
    useEffect(() => {
        const restored = readAutoSignPlan();
        if (restored) {
            setAutoSignPlan(restored);
        }
    }, []);

    // 倒计时心跳：只在有待执行的计划时运行
    useEffect(() => {
        if (!autoSignPlan) {
            return;
        }
        const timer = window.setInterval(() => setAutoSignTick((v) => v + 1), 1000);
        return () => window.clearInterval(timer);
    }, [autoSignPlan]);

    // 到点开火：课前 2 分钟开始，最多 3 次、每次间隔 30 秒（T-2 / T-1:30 / T-1），
    // 三次没成就停手，并弹出失败告警 —— 告警在课前 1 分钟送达，还来得及手动补签。
    useEffect(() => {
        if (!autoSignPlan || isSigningRef.current) {
            return;
        }

        const now = Date.now();
        if (now < autoSignPlan.fireAt) {
            return;
        }

        const plan = autoSignPlan;
        writeAutoSignPlan(null);
        setAutoSignPlan(null);

        if (now - plan.fireAt > AUTO_SIGN_GIVE_UP_MS) {
            setSignMessage(
                `「${plan.courseName}」的自动签到已错过太久（计划 ${formatClock(plan.fireAt)} 开始），本次跳过`
            );
            return;
        }

        void runSignLoop(plan.courseSchedId, `课前自动签到 ${plan.courseName}`, {
            maxAttempts: AUTO_SIGN_MAX_ATTEMPTS,
            intervalMs: AUTO_SIGN_RETRY_INTERVAL_MS
        }).then((ok) => {
            if (ok) {
                setAutoSignAlert("");
                return;
            }
            const text =
                `「${plan.courseName}」课前自动签到失败：已从 ${formatClock(plan.fireAt)} 起尝试 ` +
                `${AUTO_SIGN_MAX_ATTEMPTS} 次（每 ${Math.round(AUTO_SIGN_RETRY_INTERVAL_MS / 1000)} 秒一次），` +
                `程序已停止重试。上课时间 ${formatClock(plan.startAt)} —— 请手动签到！`;
            setAutoSignAlert(text);
            notifyDesktop("iClass 签到失败", text);
        });
    }, [autoSignPlan, autoSignTick]);

    const stopQrRefresh = () => {
        if (qrTimerRef.current !== null) {
            window.clearInterval(qrTimerRef.current);
            qrTimerRef.current = null;
        }
        setIsQrRefreshing(false);
    };

    const handleSelectCourse = (item: CourseDetailItem) => {
        stopQrRefresh();
        setSelectedCourse(item);
        setSignMessage("");
        setQrImageDataUrl("");
        setQrGeneratedAt(null);
    };

    const refreshQrOnce = async (courseSchedId: string) => {
        const res = await generateSignQr({ courseSchedId });
        if (!res.ok || !res.data) {
            throw new Error(res.message || "二维码生成失败");
        }

        const dataUrl = await QRCode.toDataURL(res.data.qrUrl, {
            width: 280,
            margin: 2
        });

        setQrImageDataUrl(dataUrl);
        setQrGeneratedAt(res.data.timestamp);
    };

    const handleGenerateQr = async () => {
        const courseSchedId = selectedCourse?.courseSchedId;
        if (!courseSchedId) {
            return;
        }

        if (isQrRefreshing) {
            stopQrRefresh();
            return;
        }
        setQrImageDataUrl("");
        setQrGeneratedAt(null);

        try {
            await refreshQrOnce(courseSchedId);
            setIsQrRefreshing(true);

            qrTimerRef.current = window.setInterval(() => {
                void refreshQrOnce(courseSchedId).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : "二维码刷新失败";
                    setSignMessage(`二维码刷新失败: ${message}`);
                    stopQrRefresh();
                });
            }, 2000);
        } catch (err) {
            setSignMessage(err instanceof Error ? `二维码生成失败: ${err.message}` : "二维码生成失败");
            stopQrRefresh();
        }
    };

    /**
     * 签到主循环。手动点击和「课前自动签到」都走这一个函数，但节奏不同：
     *   - 手动点击：每 15 秒一次、最多 60 次（用户主动发起、可随时点停）
     *   - 课前自动：每 60 秒一次、最多 3 次（用户要求"三次没成就停手"）
     *
     * 服务端只有在复检到 signStatus === '1' 时才返回 ok，
     * 因此这里不存在"接口通了就算成功"的误报。
     * 返回是否签到成功。
     */
    const runSignLoop = async (
        courseSchedId: string,
        label = "",
        options: { maxAttempts?: number; intervalMs?: number } = {}
    ): Promise<boolean> => {
        if (isSigningRef.current) {
            return false;
        }
        const maxAttempts = Math.max(1, options.maxAttempts ?? SIGN_MAX_ATTEMPTS);
        const intervalMs = Math.max(1000, options.intervalMs ?? SIGN_RETRY_INTERVAL_MS);
        isSigningRef.current = true;
        signStopRef.current = false;
        setIsSigning(true);
        setSignAttempt(0);

        const prefix = label ? `${label}｜` : "";
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                if (signStopRef.current) {
                    setSignMessage(`${prefix}已手动停止（共尝试 ${attempt - 1} 次）`);
                    return false;
                }

                setSignAttempt(attempt);
                setSignMessage(`${prefix}第 ${attempt}/${maxAttempts} 次签到中...`);

                let res: ApiResponse<unknown>;
                try {
                    res = await signCourse({ courseSchedId });
                } catch (err) {
                    res = {
                        ok: false,
                        code: "REQUEST_FAILED",
                        message: err instanceof Error ? err.message : "签到请求失败",
                        data: null
                    };
                }

                if (res.ok) {
                    setSignMessage(`${prefix}签到成功（第 ${attempt} 次尝试，已复检确认）`);
                    setSelectedCourse((prev) =>
                        prev && prev.courseSchedId === courseSchedId
                            ? { ...prev, signStatus: "1" }
                            : prev
                    );
                    await loadCalendarData();
                    return true;
                }

                const detail = describeSignFailure(res);
                if (attempt === maxAttempts) {
                    setSignMessage(
                        maxAttempts === AUTO_SIGN_MAX_ATTEMPTS
                            ? `${prefix}已尝试 ${attempt} 次仍未成功，程序停手：${detail}`
                            : `${prefix}已尝试 ${attempt} 次仍未成功：${detail}`
                    );
                    return false;
                }

                setSignMessage(
                    `${prefix}第 ${attempt} 次未成功：${detail}；${Math.round(intervalMs / 1000)} 秒后重试`
                );
                await sleep(intervalMs);
            }
            return false;
        } finally {
            isSigningRef.current = false;
            setIsSigning(false);
            setSignAttempt(0);
        }
    };

    const handleSignNow = async () => {
        const courseSchedId = selectedCourse?.courseSchedId;
        if (!courseSchedId) {
            return;
        }

        // 重试过程中再次点击 = 停止
        if (isSigning) {
            signStopRef.current = true;
            setSignMessage("正在停止重试...");
            return;
        }

        if (isSelectedSigned) {
            return;
        }

        const ok = await runSignLoop(courseSchedId);
        if (ok) {
            setAutoSignAlert("");
        }
    };

    /** 开/关「课前自动签到」 */
    const handleToggleAutoSign = () => {
        if (autoSignPlan) {
            writeAutoSignPlan(null);
            setAutoSignPlan(null);
            setSignMessage("已取消课前自动签到");
            return;
        }

        const course = selectedCourse;
        if (!course?.courseSchedId) {
            return;
        }

        const startAt = parseCourseStartMs(course.date, course.startTime);
        if (startAt === null) {
            setSignMessage(`无法解析「${course.date} ${course.startTime}」，不能设置自动签到`);
            return;
        }

        const fireAt = startAt - AUTO_SIGN_LEAD_MS;
        const plan: AutoSignPlan = {
            courseSchedId: course.courseSchedId,
            courseName: course.name,
            startAt,
            fireAt
        };
        writeAutoSignPlan(plan);
        setAutoSignPlan(plan);
        setAutoSignAlert("");
        setSignMessage(
            Date.now() >= fireAt
                ? `已设置「${course.name}」课前自动签到：已进入课前 ${Math.round(AUTO_SIGN_LEAD_MS / 60_000)} 分钟窗口，立即开始尝试`
                : `已设置「${course.name}」课前自动签到：${formatClock(fireAt)}（课前 ${Math.round(AUTO_SIGN_LEAD_MS / 60_000)} 分钟）开始，` +
                      `最多 ${AUTO_SIGN_MAX_ATTEMPTS} 次、每次间隔 ${Math.round(AUTO_SIGN_RETRY_INTERVAL_MS / 1000)} 秒，失败会弹告警`
        );
    };

    /**
     * 用老师二维码的链接签到：把链接里的参数**原样**透传给 iClass。
     * 时间戳由服务端决定（二维码里的那个若已过期会被自动换成 iClass 刚下发的时间戳），
     * 所以这里只提交一次，不做重试。
     */
    const handleSignByQrLink = async () => {
        const raw = qrLink.trim();
        if (!raw || isSigningByQr) {
            return;
        }

        setIsSigningByQr(true);
        setQrResult("提交中...");
        try {
            const res = await signCourse({ qrUrl: raw });
            const payload = (res.data ?? null) as Record<string, unknown> | null;
            const sent =
                payload && typeof payload === "object"
                    ? JSON.stringify(payload.submittedParams ?? payload.parsedParams ?? {})
                    : "（无）";

            if (res.ok) {
                setQrResult(`✅ 签到成功（已复检确认）。提交参数：${sent}`);
                await loadCalendarData();
                return;
            }

            setQrResult(`❌ ${describeSignFailure(res)}；提交参数：${sent}`);
        } catch (err) {
            setQrResult(err instanceof Error ? `签到失败: ${err.message}` : "签到失败");
        } finally {
            setIsSigningByQr(false);
        }
    };

    return (
        <main className="page calendar-page">
            <header className="topbar">
                <div>
                    <h2>北航 iClass 日历签到</h2>
                    <p className="hint">欢迎，{user.userName || user.userId || "同学"}</p>
                </div>
                <button className="logout-btn" onClick={handleLogout}>退出登录</button>
            </header>

            <section className="week-nav card">
                <button onClick={() => setWeekOffset((v) => v - 1)}>上一周</button>
                <strong>{weekRangeLabel}</strong>
                <button onClick={() => setWeekOffset((v) => v + 1)}>下一周</button>
                <button className="ghost" onClick={() => setWeekOffset(0)}>本周</button>
            </section>

            {loading && <section className="card selected-panel"><p>课程加载中...</p></section>}
            {error && <section className="card selected-panel"><p className="error-text">{error}</p></section>}

            <section className="calendar-shell card">
                <div className="calendar-scroll">
                    <div className="calendar-table">
                        <div className="table-head time-head">时间/星期</div>
                        {weekdays.map((day, index) => (
                            <div key={`head-${day}`} className="table-head day-head">
                                <span>{day}</span>
                                <small className={index <= 4 ? "day-date" : "day-date muted"}>
                                    {formatMonthDay(weekDates[index])}
                                </small>
                            </div>
                        ))}

                        {timeSlots.map((slot) => (
                            <Fragment key={slot.key}>
                                <div className="time-axis">
                                    <strong>{slot.label}</strong>
                                    <span>{slot.range}</span>
                                </div>
                                {weekdays.map((day, index) => {
                                    const dateYmd = formatYmd(weekDates[index]);
                                    const cellItems = courseMapByCell.get(toCellKey(dateYmd, slot.key)) ?? [];
                                    return (
                                        <div key={`${slot.key}-${day}`} className="day-slot">
                                            {cellItems.length === 0 && <small className="hint">-</small>}
                                            {cellItems.map((item) => (
                                                <button
                                                    key={item.courseSchedId}
                                                    className={`ghost small course-item ${item.signStatus === "1" ? "signed" : "unsigned"}`}
                                                    onClick={() => handleSelectCourse(item)}
                                                >
                                                    <span className="course-title">{item.name}</span>
                                                    <span className="course-time">{item.startTime}-{item.endTime}</span>
                                                </button>
                                            ))}
                                        </div>
                                    );
                                })}
                            </Fragment>
                        ))}
                    </div>
                </div>
            </section>

            <section className="card selected-panel">
                <h3>已选课程</h3>
                <p>{selectedCourse ? `${selectedCourse.name} (${selectedCourse.date} ${selectedCourse.startTime}-${selectedCourse.endTime})` : "未选择课程"}</p>
                <div className="actions">
                    <button
                        disabled={!selectedCourse || (isSelectedSigned && !isSigning)}
                        onClick={() => void handleSignNow()}
                    >
                        {isSigning
                            ? `停止重试（第 ${signAttempt} 次）`
                            : isSelectedSigned
                                ? "已签到"
                                : "签到（失败自动重试）"}
                    </button>
                    <button
                        className="secondary"
                        disabled={isSigning || (!selectedCourse && !autoSignPlan)}
                        onClick={handleToggleAutoSign}
                    >
                        {autoSignPlan
                            ? `取消课前自动签到（${autoSignCountdown}）`
                            : `课前 ${Math.round(AUTO_SIGN_LEAD_MS / 60_000)} 分钟自动签到`}
                    </button>
                    {!isVpnMode && (
                        <button className="secondary" disabled={!selectedCourse} onClick={() => void handleGenerateQr()}>
                            {isQrRefreshing ? "停止二维码刷新" : "生成二维码"}
                        </button>
                    )}
                </div>
                {autoSignPlan && (
                    <p className="hint">
                        已预约「{autoSignPlan.courseName}」在 {formatClock(autoSignPlan.fireAt)}（课前 3
                        分钟）自动开始签到，最多尝试 {AUTO_SIGN_MAX_ATTEMPTS} 次、每次间隔{" "}
                        {Math.round(AUTO_SIGN_RETRY_INTERVAL_MS / 1000)} 秒；上课时间{" "}
                        {formatClock(autoSignPlan.startAt)}，状态：{autoSignCountdown}。保持程序开着即可。
                    </p>
                )}
                {autoSignAlert && (
                    <div className="error-text auto-sign-alert">
                        <strong>⚠️ 自动签到失败，请手动签到</strong>
                        <p>{autoSignAlert}</p>
                        <button className="ghost small" onClick={() => setAutoSignAlert("")}>
                            知道了
                        </button>
                    </div>
                )}
                {signMessage && <p className="hint">{signMessage}</p>}
                {!isVpnMode && qrImageDataUrl && (
                    <div className="qr-preview">
                        <img src={qrImageDataUrl} alt="签到二维码" className="qr-image" />
                        <p className="hint">生成时间：{formatDateTime(qrGeneratedAt ?? Date.now())}</p>
                    </div>
                )}
            </section>

            <section className="card selected-panel">
                <h3>用老师二维码签到</h3>
                <p className="hint">
                    备用通道：把老师二维码的链接粘贴到下面（手机扫码后会显示 URL）。程序会把链接里的参数
                    透传给 iClass，时间戳仍以 iClass 下发的为准 —— 所以这个入口和直接点签到是等价的，
                    只在课程列表里找不到那节课时才有必要用。
                </p>
                <input
                    className="student-id-input"
                    value={qrLink}
                    onChange={(e) => setQrLink(e.target.value)}
                    placeholder="http://iclass.buaa.edu.cn:8081/app/course/stu_scan_sign.action?courseSchedId=...&timestamp=..."
                    autoComplete="off"
                    spellCheck={false}
                />
                <div className="actions">
                    <button
                        disabled={!qrLink.trim() || isSigningByQr}
                        onClick={() => void handleSignByQrLink()}
                    >
                        {isSigningByQr ? "提交中..." : "用二维码链接签到"}
                    </button>
                </div>
                {qrResult && <p className="hint">{qrResult}</p>}
            </section>
        </main>
    );
};

export default CalendarPage;
