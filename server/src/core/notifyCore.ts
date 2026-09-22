import got from 'got';
import logger from '../utils/logger';

/**
 * 签到结果通知。支持几个国内常用通道，全部走 HTTP，不需要装额外依赖。
 *
 * 设计取舍：所有通道都失败也**不能**影响签到主流程 —— 通知只是锦上添花，
 * 所以 sendNotification 内部吞掉异常，只打日志。
 */

export type NotifyType = 'none' | 'serverchan' | 'pushplus' | 'bark' | 'ntfy' | 'webhook';
export type NotifyEvent = 'success' | 'failure';

export interface NotifyConfig {
    type: NotifyType;
    /** 哪些事件要通知。默认只通知失败 */
    on: NotifyEvent[];
    /** Server酱³ SendKey，也可直接填完整 URL */
    serverchanKey: string;
    /** pushplus 的 token */
    pushplusToken: string;
    /** Bark：填 https://api.day.app/<你的key> */
    barkUrl: string;
    /** ntfy：填 https://ntfy.sh/<topic>（自建则换域名） */
    ntfyUrl: string;
    /** ntfy 若开了鉴权则填 */
    ntfyToken: string;
    /** 通用 webhook：POST JSON {title, content}，可接企业微信/钉钉/自定义服务 */
    webhookUrl: string;
}

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
    type: 'none',
    on: ['failure'],
    serverchanKey: '',
    pushplusToken: '',
    barkUrl: '',
    ntfyUrl: '',
    ntfyToken: '',
    webhookUrl: ''
};

export interface NotifyMessage {
    title: string;
    body: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** 允许用户直接填完整 URL，方便自建/换域名 */
const asUrl = (value: string, fallback: (raw: string) => string): string =>
    /^https?:\/\//i.test(value) ? value : fallback(value);

const sendViaServerChan = async (config: NotifyConfig, message: NotifyMessage): Promise<string> => {
    if (!config.serverchanKey) {
        throw new Error('serverchanKey 未配置');
    }
    const url = asUrl(config.serverchanKey, (key) => `https://sctapi.ftqq.com/${key}.send`);
    const res = await got.post(url, {
        form: { title: message.title, desp: message.body },
        timeout: { request: REQUEST_TIMEOUT_MS },
        throwHttpErrors: false
    });
    return `http=${res.statusCode}`;
};

const sendViaPushPlus = async (config: NotifyConfig, message: NotifyMessage): Promise<string> => {
    if (!config.pushplusToken) {
        throw new Error('pushplusToken 未配置');
    }
    const res = await got.post('https://www.pushplus.plus/send', {
        json: {
            token: config.pushplusToken,
            title: message.title,
            content: message.body,
            template: 'txt'
        },
        timeout: { request: REQUEST_TIMEOUT_MS },
        throwHttpErrors: false
    });
    return `http=${res.statusCode}`;
};

const sendViaBark = async (config: NotifyConfig, message: NotifyMessage): Promise<string> => {
    if (!config.barkUrl) {
        throw new Error('barkUrl 未配置');
    }
    // Bark 的 base 里通常已经带 key，所以只发 title/body
    const res = await got.post(config.barkUrl.replace(/\/+$/, ''), {
        json: {
            title: message.title,
            body: message.body,
            group: 'iClass 签到'
        },
        timeout: { request: REQUEST_TIMEOUT_MS },
        throwHttpErrors: false
    });
    return `http=${res.statusCode}`;
};

const sendViaNtfy = async (config: NotifyConfig, message: NotifyMessage): Promise<string> => {
    if (!config.ntfyUrl) {
        throw new Error('ntfyUrl 未配置');
    }
    const isFailure = message.title.includes('失败');
    // ntfy 的 JSON 发布格式：POST 到 topic URL，body 带 topic/title/message
    const topic = config.ntfyUrl.replace(/\/+$/, '').split('/').pop() ?? '';
    const res = await got.post(config.ntfyUrl, {
        json: {
            topic,
            title: message.title,
            message: message.body,
            priority: isFailure ? 4 : 3,
            tags: isFailure ? ['warning'] : ['white_check_mark']
        },
        headers: config.ntfyToken ? { Authorization: `Bearer ${config.ntfyToken}` } : {},
        timeout: { request: REQUEST_TIMEOUT_MS },
        throwHttpErrors: false
    });
    return `http=${res.statusCode}`;
};

const sendViaWebhook = async (config: NotifyConfig, message: NotifyMessage): Promise<string> => {
    if (!config.webhookUrl) {
        throw new Error('webhookUrl 未配置');
    }
    const res = await got.post(config.webhookUrl, {
        json: {
            title: message.title,
            content: message.body,
            // 企业微信/钉钉机器人常用字段名，一并带上，多数自定义服务也能忽略多余字段
            text: `${message.title}\n${message.body}`,
            msgtype: 'text',
            markdown: { content: `${message.title}\n${message.body}` }
        },
        timeout: { request: REQUEST_TIMEOUT_MS },
        throwHttpErrors: false
    });
    return `http=${res.statusCode}`;
};

const SENDERS: Record<Exclude<NotifyType, 'none'>, (c: NotifyConfig, m: NotifyMessage) => Promise<string>> = {
    serverchan: sendViaServerChan,
    pushplus: sendViaPushPlus,
    bark: sendViaBark,
    ntfy: sendViaNtfy,
    webhook: sendViaWebhook
};

export const shouldNotify = (config: NotifyConfig, event: NotifyEvent): boolean => {
    if (!config || config.type === 'none') {
        return false;
    }
    const on = Array.isArray(config.on) && config.on.length > 0 ? config.on : ['failure'];
    return on.includes(event);
};

/**
 * 发通知。**永不抛异常** —— 通知失败不能影响签到本身。
 * 返回是否成功（供日志使用）。
 */
export const sendNotification = async (
    config: NotifyConfig,
    event: NotifyEvent,
    message: NotifyMessage
): Promise<boolean> => {
    if (!shouldNotify(config, event)) {
        return false;
    }

    const sender = SENDERS[config.type as Exclude<NotifyType, 'none'>];
    if (!sender) {
        logger.warn(`[notify] 未知的通知类型：${config.type}`);
        return false;
    }

    try {
        const detail = await sender(config, message);
        logger.info(`[notify] 已通过 ${config.type} 发送通知（${detail}）：${message.title}`);
        return true;
    } catch (error) {
        logger.error(
            `[notify] 通过 ${config.type} 发送通知失败：${error instanceof Error ? error.message : String(error)}`
        );
        return false;
    }
};
