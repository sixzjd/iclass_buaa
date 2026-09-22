#!/usr/bin/env node
/**
 * iClass 无界面自动签到（树莓派 / 服务器 / 任何能跑 Node 的机器）
 *
 * 为什么需要它：主仓库是 Electron 桌面程序（main.js 起后端 + 载 GUI），没有无界面入口，
 * 树莓派上跑不了。这个 CLI 复用同一套 core/services，把"每天自动签所有课"做成守护进程。
 *
 * ── 行为（用户明确要求，别改）──
 *   课前 3 分钟开火 → 最多尝试 3 次，每次间隔 60 秒（即 T-3 / T-2 / T-1）→ 仍失败就停手，
 *   并发一条**失败通知**。这样通知在课前 1 分钟送达，用户还来得及手动补签。
 *   三次没成就不再无限重试。
 *
 * 用法：
 *   node dist/autosign.js               # 守护进程
 *   node dist/autosign.js --list        # 只打印今天的课表与计划，不签到
 *   node dist/autosign.js --now         # 立刻把今天未签的课签一遍，然后退出
 *   node dist/autosign.js --now --course 2486830 --attempts 2
 *   node dist/autosign.js --test-notify # 只发一条测试通知，验证通知配置
 *   node dist/autosign.js --config /etc/iclass/config.json
 *
 * 关键前提（2026-09-22 实测，别改）：iClass 的签到接口只接受 [服务端时间 −3s, +1s] 内的
 * 毫秒时间戳，所以签到时间戳一律由 signCore 向 iClass 索取，绝不用本机 Date.now()。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CourseDetailItem } from '../core/courseCore';
import {
    DEFAULT_NOTIFY_CONFIG,
    NotifyConfig,
    sendNotification,
    shouldNotify
} from '../core/notifyCore';
import { loginAndBuildContext, LoginContext } from '../services/authService';
import { signNowForFrontend, SignOutcomeData } from '../services/courseService';
import logger from '../utils/logger';

interface AutoSignConfig {
    /** 学号（也用于 VPN 登录） */
    studentId: string;
    /** 密码（VPN 模式即 VPN 密码） */
    password: string;
    /** 是否走 WebVPN。直连登录只认已绑定的手机号，未绑号的账号必须用 VPN 模式 */
    useVpn: boolean;
    /** 留空则用 studentId / password */
    vpnUsername: string;
    vpnPassword: string;

    /** 课前几分钟开始尝试 */
    leadMinutes: number;
    /** 最多尝试几次（用户要求：3 次没成就停） */
    maxAttempts: number;
    /** 每次尝试的间隔（秒）。默认 60，配合 leadMinutes=3 正好落在 T-3 / T-2 / T-1 */
    retryIntervalSeconds: number;
    /**
     * 上课时间过去多少分钟就不再尝试。
     * **0 = 一直跟到下课**（守护进程启动晚了也不会漏）。
     */
    giveUpMinutesAfterStart: number;
    /** 课表刷新间隔（分钟） */
    timetableRefreshMinutes: number;
    /** 会话最长存活多少分钟后强制重新登录 */
    sessionMaxAgeMinutes: number;

    /** 只处理这些 courseSchedId（留空 = 全部） */
    includeCourses: string[];
    /** 跳过这些 courseSchedId */
    excludeCourses: string[];
    /** 可选的日志文件（systemd 下一般不需要，journald 已经收了） */
    logFile: string;

    /** 通知配置 */
    notify: NotifyConfig;
}

const DEFAULT_CONFIG: AutoSignConfig = {
    studentId: '',
    password: '',
    useVpn: true,
    vpnUsername: '',
    vpnPassword: '',

    leadMinutes: 3,
    maxAttempts: 3,
    retryIntervalSeconds: 60,
    giveUpMinutesAfterStart: 0,
    timetableRefreshMinutes: 10,
    sessionMaxAgeMinutes: 30,

    includeCourses: [],
    excludeCourses: [],
    logFile: '',

    notify: { ...DEFAULT_NOTIFY_CONFIG }
};

const TICK_MS = 5_000;

type CourseState = 'waiting' | 'done' | 'failed' | 'skipped';

interface TrackedCourse {
    courseSchedId: string;
    name: string;
    startAt: number;
    endAt: number;
    fireAt: number;
    state: CourseState;
    note: string;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatClock = (ms: number): string => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const formatDateYmd = (date: Date): string =>
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;

const errText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** 把 "2026-09-22" + "19:00" 拼成 epoch ms；解析不了返回 null */
const parseStartMs = (dateYmd: string, hhmm: string): number | null => {
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

const resolveConfigPath = (override?: string): string =>
    override ||
    process.env.ICLASS_CONFIG ||
    path.join(os.homedir(), '.config', 'iclass', 'config.json');

const loadConfig = (override?: string): AutoSignConfig => {
    const configPath = resolveConfigPath(override);
    let fromFile: Partial<AutoSignConfig> = {};

    if (fs.existsSync(configPath)) {
        try {
            fromFile = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AutoSignConfig>;
            logger.info(`[autosign] 已读取配置：${configPath}`);
        } catch (error) {
            throw new Error(`配置文件解析失败：${configPath}（${errText(error)}）`);
        }
    } else {
        logger.warn(`[autosign] 配置文件不存在：${configPath}（将只依赖环境变量）`);
    }

    const merged: AutoSignConfig = {
        ...DEFAULT_CONFIG,
        ...fromFile,
        studentId: String(fromFile.studentId ?? process.env.ICLASS_STUDENT_ID ?? ''),
        password: String(fromFile.password ?? process.env.ICLASS_PASSWORD ?? ''),
        vpnUsername: String(fromFile.vpnUsername ?? process.env.ICLASS_VPN_USERNAME ?? ''),
        vpnPassword: String(fromFile.vpnPassword ?? process.env.ICLASS_VPN_PASSWORD ?? ''),
        logFile: String(fromFile.logFile ?? process.env.ICLASS_LOG_FILE ?? ''),
        notify: { ...DEFAULT_NOTIFY_CONFIG, ...(fromFile.notify ?? {}) }
    };

    merged.vpnUsername = merged.vpnUsername || merged.studentId;
    merged.vpnPassword = merged.vpnPassword || merged.password;

    if (!merged.studentId || !merged.password) {
        throw new Error(
            `缺少 studentId / password。请在 ${configPath} 里填写，` +
            '或设置环境变量 ICLASS_STUDENT_ID / ICLASS_PASSWORD。'
        );
    }

    return merged;
};

/**
 * 把 iClass 的错误翻译成"用户看了知道该干什么"的一句话。
 * 关键点：ERRCODE 101 有两种语义，`当前时间不是上课时间` 意味着老师还没发起签到，
 * 不是程序坏了 —— 必须说清楚，否则用户会以为工具失效。
 */
const explainFailure = (result: { code?: string; message?: string; data?: unknown } | null): string => {
    if (!result) {
        return '请求异常（网络或登录问题）';
    }
    const data = (result.data ?? null) as SignOutcomeData | null;
    const code = String(data?.iclassErrCode ?? '');
    const msg = String(data?.iclassErrMsg ?? '');
    const verifyStatus = data?.verify?.signStatus ?? null;

    if (code === '101' && msg.includes('上课时间')) {
        return '签到窗口还没开（iClass 回「当前时间不是上课时间」）。通常是老师还没发起签到 —— 请在上课前手动确认一次。';
    }
    if (code === '101') {
        return '时间戳被 iClass 判为失效（回「二维码已失效」）。';
    }
    if (code === '100') {
        return 'iClass 回「参数错误」，一般是签到窗口未开或请求不被接受。';
    }
    if (code === '106') {
        return '会话失效、账号标识不被识别。';
    }
    if (code) {
        return `iClass 回 ERRCODE=${code}${msg ? ` ${msg}` : ''}。`;
    }
    if (data?.verify?.checked === false) {
        return `签到状态复检失败：${data.verify.error ?? '未知原因'}。`;
    }
    if (verifyStatus === '0') {
        return 'iClass 接受了请求，但复检 signStatus 仍是未签到。';
    }
    return result.message || '未知原因';
};

class AutoSigner {
    private context: LoginContext | null = null;
    private lastLoginAt = 0;
    private tracked: TrackedCourse[] = [];
    private trackedDate = '';
    private lastRefreshAt = 0;

    constructor(private readonly config: AutoSignConfig) {}

    /** 登录（默认复用，超过 sessionMaxAgeMinutes 或 force 时重登） */
    async ensureLogin(force = false): Promise<LoginContext> {
        const ageMinutes = (Date.now() - this.lastLoginAt) / 60_000;
        if (this.context && !force && ageMinutes < this.config.sessionMaxAgeMinutes) {
            return this.context;
        }

        logger.info(
            `[autosign] 登录中（${force ? '强制重登' : `会话已 ${ageMinutes.toFixed(1)} 分钟`}）...`
        );
        const context = await loginAndBuildContext({
            studentId: this.config.studentId,
            useVpn: this.config.useVpn,
            vpnUsername: this.config.vpnUsername,
            vpnPassword: this.config.vpnPassword
        });
        this.context = context;
        this.lastLoginAt = Date.now();
        logger.info(`[autosign] 登录成功：${context.userName}（userId=${context.userId}）`);
        return context;
    }

    /** 拉当天课表，重建待办列表。已处于终态（done/failed/skipped）的节次会被保留，避免重复签 */
    async refreshTimetable(): Promise<void> {
        const context = await this.ensureLogin();
        const dateYmd = formatDateYmd(new Date());
        const items: CourseDetailItem[] = await context.client.getCourseByDate(dateYmd);

        const previous = new Map(this.tracked.map((item) => [item.courseSchedId, item]));
        const next: TrackedCourse[] = [];

        for (const item of items) {
            const courseSchedId = String(item.courseSchedId ?? '').trim();
            if (!courseSchedId) {
                continue;
            }
            if (
                this.config.includeCourses.length > 0 &&
                !this.config.includeCourses.includes(courseSchedId)
            ) {
                continue;
            }
            if (this.config.excludeCourses.includes(courseSchedId)) {
                continue;
            }

            const startAt = parseStartMs(item.date, item.startTime);
            if (startAt === null) {
                logger.warn(`[autosign] 无法解析上课时间，跳过：${item.name} ${item.date} ${item.startTime}`);
                continue;
            }
            const endAt = parseStartMs(item.date, item.endTime) ?? startAt;

            const old = previous.get(courseSchedId);
            if (old && old.state !== 'waiting') {
                next.push(old);
                continue;
            }

            if (item.signStatus === '1') {
                next.push({
                    courseSchedId,
                    name: item.name,
                    startAt,
                    endAt,
                    fireAt: startAt - this.config.leadMinutes * 60_000,
                    state: 'done',
                    note: '课表显示已签到'
                });
                continue;
            }

            next.push({
                courseSchedId,
                name: item.name,
                startAt,
                endAt,
                fireAt: startAt - this.config.leadMinutes * 60_000,
                state: 'waiting',
                note: ''
            });
        }

        this.tracked = next.sort((a, b) => a.startAt - b.startAt);
        this.trackedDate = dateYmd;
        this.lastRefreshAt = Date.now();

        logger.info(`[autosign] 课表已刷新（${dateYmd}），共 ${this.tracked.length} 节：`);
        for (const course of this.tracked) {
            logger.info(
                `[autosign]   ${formatClock(course.startAt)}-${formatClock(course.endAt)} ` +
                `${course.name} [${course.courseSchedId}] ` +
                `状态=${course.state}${course.state === 'waiting' ? ` 开火=${formatClock(course.fireAt)}` : ''}` +
                `${course.note ? `（${course.note}）` : ''}`
            );
        }
    }

    get courses(): TrackedCourse[] {
        return this.tracked;
    }

    /** 该节次最晚尝试到什么时候。giveUpMinutesAfterStart > 0 时用它；= 0 表示「一直跟到下课」 */
    private giveUpAt(course: TrackedCourse): number {
        const minutes = Number(this.config.giveUpMinutesAfterStart) || 0;
        if (minutes > 0) {
            return course.startAt + minutes * 60_000;
        }
        return Math.max(course.endAt, course.startAt + 60_000);
    }

    /**
     * 对一节尝试最多 maxAttempts 次。返回是否成功。
     * 每次尝试之间间隔 retryIntervalSeconds（默认 60 秒）——配合 leadMinutes=3，
     * 三次正好落在 T-3 / T-2 / T-1，最后一次失败的通知赶在上课前发出。
     */
    async runSignSequence(
        course: TrackedCourse,
        options: { maxAttempts?: number } = {}
    ): Promise<boolean> {
        const maxAttempts = Math.max(1, options.maxAttempts ?? this.config.maxAttempts);
        const intervalMs = Math.max(1, this.config.retryIntervalSeconds) * 1000;
        const deadline = this.giveUpAt(course);

        logger.info(
            `[autosign] === 开始签到：${course.name} [${course.courseSchedId}]，` +
            `上课 ${formatClock(course.startAt)}，最多尝试 ${maxAttempts} 次，间隔 ${intervalMs / 1000} 秒 ===`
        );

        const attemptTimes: string[] = [];
        let lastResult: Awaited<ReturnType<typeof signNowForFrontend>> | null = null;
        let lastError = '';

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            // 上课太久（giveUpMinutesAfterStart > 0 时）就没必要继续了
            if (Date.now() > deadline) {
                lastError = '已超过允许的尝试时间';
                logger.warn(`[autosign] 已超过允许时间，停止尝试：${course.name}`);
                break;
            }

            attemptTimes.push(formatClock(Date.now()));

            let context: LoginContext | null = null;
            try {
                context = await this.ensureLogin();
            } catch (error) {
                lastError = `登录失败：${errText(error)}`;
                logger.error(`[autosign] 第 ${attempt}/${maxAttempts} 次登录失败：${errText(error)}`);
            }

            if (context) {
                try {
                    lastResult = await signNowForFrontend(context.client, course.courseSchedId);
                } catch (error) {
                    lastResult = null;
                    lastError = `请求异常：${errText(error)}`;
                    logger.warn(`[autosign] 第 ${attempt}/${maxAttempts} 次签到请求异常：${errText(error)}`);
                }
            }

            if (lastResult?.ok) {
                course.state = 'done';
                course.note = `第 ${attempt} 次成功`;
                logger.info(
                    `[autosign] 签到成功：${course.name}（第 ${attempt}/${maxAttempts} 次尝试，已复检确认）`
                );
                await this.notify('success', course, attempt, maxAttempts, attemptTimes, '');
                return true;
            }

            if (lastResult) {
                const data = (lastResult.data ?? null) as SignOutcomeData | null;
                logger.warn(
                    `[autosign] 第 ${attempt}/${maxAttempts} 次未成功：${course.name} -> ` +
                    `${lastResult.code} ${lastResult.message}`
                );

                // 会话失效（106 用户不存在）→ 强制重登，下一轮就是新会话
                if (/106|用户不存在/.test(`${data?.iclassErrCode ?? ''}${data?.iclassErrMsg ?? ''}`)) {
                    logger.warn('[autosign] 会话疑似失效，强制重新登录');
                    this.lastLoginAt = 0;
                }
            }

            if (attempt < maxAttempts) {
                await sleep(intervalMs);
            }
        }

        course.state = 'failed';
        course.note = `尝试 ${attemptTimes.length} 次均未成功`;
        logger.error(
            `[autosign] 签到失败：${course.name}，已尝试 ${attemptTimes.length} 次（${attemptTimes.join(' / ')}），不再重试`
        );
        await this.notify(
            'failure',
            course,
            attemptTimes.length,
            maxAttempts,
            attemptTimes,
            lastError || explainFailure(lastResult)
        );
        return false;
    }

    /** 组装并发通知。失败不抛异常，只影响通知本身 */
    private async notify(
        event: 'success' | 'failure',
        course: TrackedCourse,
        attempts: number,
        maxAttempts: number,
        attemptTimes: string[],
        reason: string
    ): Promise<void> {
        if (!shouldNotify(this.config.notify, event)) {
            return;
        }

        const isFailure = event === 'failure';
        const title = isFailure
            ? `【iClass 签到失败】${course.name}`
            : `【iClass 签到成功】${course.name}`;

        const lines = [
            `课程：${course.name}`,
            `时间：${formatClock(course.startAt)}-${formatClock(course.endAt)}`,
            `节次：${course.courseSchedId}`,
            `尝试：${attempts}/${maxAttempts} 次（${attemptTimes.join('、')}）`
        ];

        if (isFailure) {
            lines.push('');
            lines.push(`原因：${reason}`);
            lines.push('');
            lines.push('👉 程序已停止重试。请在上课前手动确认一下，必要时打开 App 手动签到。');
        } else {
            lines.push('');
            lines.push('已复检确认 signStatus=1，无需操作。');
        }

        await sendNotification(this.config.notify, event, {
            title,
            body: lines.join('\n')
        });
    }

    /** 守护模式主循环 */
    async loop(): Promise<void> {
        logger.info(
            `[autosign] 守护进程启动：课前 ${this.config.leadMinutes} 分钟开火；` +
            `最多尝试 ${this.config.maxAttempts} 次、间隔 ${this.config.retryIntervalSeconds} 秒；` +
            `通知=${this.config.notify.type}` +
            (shouldNotify(this.config.notify, 'failure') ? '（失败时）' : '')
        );

        await this.ensureLogin(true);
        await this.refreshTimetable();

        for (;;) {
            await sleep(TICK_MS);
            try {
                const now = Date.now();
                const todayYmd = formatDateYmd(new Date());

                if (
                    todayYmd !== this.trackedDate ||
                    now - this.lastRefreshAt > this.config.timetableRefreshMinutes * 60_000
                ) {
                    await this.refreshTimetable();
                }

                const due = this.tracked.find(
                    (course) => course.state === 'waiting' && now >= course.fireAt
                );
                if (!due) {
                    continue;
                }

                if (now > this.giveUpAt(due)) {
                    due.state = 'skipped';
                    due.note = `已过签到窗口（上课 ${((now - due.startAt) / 60_000).toFixed(0)} 分钟）`;
                    logger.warn(`[autosign] 跳过：${due.name} —— ${due.note}`);
                    continue;
                }

                await this.runSignSequence(due);
                this.lastRefreshAt = 0; // 签完立刻刷新课表
            } catch (error) {
                logger.error(`[autosign] 主循环异常（下一轮重试）：${errText(error)}`);
                this.lastLoginAt = 0; // 登录态可能坏了，下轮强制重登
            }
        }
    }

    /** --now 模式：立刻把今天未签的课签一遍 */
    async signNowImmediately(courseId?: string, maxAttempts?: number): Promise<void> {
        await this.ensureLogin(true);
        await this.refreshTimetable();

        const targets = this.tracked.filter(
            (course) =>
                course.state === 'waiting' && (!courseId || course.courseSchedId === courseId)
        );

        if (targets.length === 0) {
            logger.info('[autosign] 没有需要立刻签到的节次');
            return;
        }

        for (const course of targets) {
            await this.runSignSequence(course, { maxAttempts });
        }
    }
}

const printHelp = (): void => {
    process.stdout.write(
        [
            'iClass 无界面自动签到',
            '',
            '用法：',
            '  node dist/autosign.js                          守护进程（每天自动拉课表并按时签到）',
            '  node dist/autosign.js --list                   只打印今天的课表与计划',
            '  node dist/autosign.js --now                    立刻签今天所有未签的课，然后退出',
            '  node dist/autosign.js --now --course <id>      只签指定的一节',
            '  node dist/autosign.js --now --attempts <n>     覆盖最多尝试次数',
            '  node dist/autosign.js --test-notify            只发一条测试通知，验证通知配置',
            '  node dist/autosign.js --config <path>          指定配置文件',
            '',
            `默认配置文件：${path.join(os.homedir(), '.config', 'iclass', 'config.json')}`,
            '环境变量：ICLASS_CONFIG / ICLASS_STUDENT_ID / ICLASS_PASSWORD / ICLASS_LOG_FILE / ICLASS_LOG_LEVEL',
            ''
        ].join('\n')
    );
};

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const hasFlag = (flag: string): boolean => args.includes(flag);
    const valueOf = (flag: string): string | undefined => {
        const index = args.indexOf(flag);
        if (index < 0) {
            return undefined;
        }
        const next = args[index + 1];
        return next && !next.startsWith('--') ? next : undefined;
    };

    if (hasFlag('--help') || hasFlag('-h')) {
        printHelp();
        return;
    }

    const config = loadConfig(valueOf('--config'));

    if (config.logFile) {
        const winston = require('winston');
        logger.add(new winston.transports.File({ filename: config.logFile, level: 'debug' }));
        logger.info(`[autosign] 同时写入日志文件：${config.logFile}`);
    }

    // 只测通知通道，不碰签到
    if (hasFlag('--test-notify')) {
        logger.info(`[autosign] 发送测试通知（type=${config.notify.type}）...`);
        // 故意忽略 notify.on 的过滤：测的是"通道通不通"，不是"这个事件要不要发"
        const probeConfig = { ...config.notify, on: ['failure'] as NotifyConfig['on'] };
        const sent = await sendNotification(probeConfig, 'failure', {
            title: '【iClass 测试】通知通道可用',
            body: [
                '这是一条测试通知。',
                '',
                `通道：${config.notify.type}`,
                `时间：${formatClock(Date.now())}`,
                '',
                '收到即说明配置正确。'
            ].join('\n')
        });
        if (!sent) {
            logger.error(
                config.notify.type === 'none'
                    ? '[autosign] notify.type 还是 "none"，没有可用的通知通道'
                    : '[autosign] 测试通知未发出，请检查 notify 配置（key/token/url 是否填对）'
            );
            process.exit(2);
        }
        return;
    }

    const signer = new AutoSigner(config);

    if (hasFlag('--list') || hasFlag('--dry-run')) {
        await signer.ensureLogin(true);
        await signer.refreshTimetable();
        return;
    }

    if (hasFlag('--now')) {
        const attemptsRaw = Number(valueOf('--attempts'));
        await signer.signNowImmediately(
            valueOf('--course'),
            Number.isFinite(attemptsRaw) && attemptsRaw > 0 ? attemptsRaw : undefined
        );
        return;
    }

    await signer.loop();
};

main().catch((error) => {
    logger.error(`[autosign] 启动失败：${errText(error)}`);
    process.exit(1);
});
