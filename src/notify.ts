/**
 * 通知渠道：Telegram / 邮件（经 Webhook 转发）/ Webhook。
 *
 * 对应 Python `app/notify.py`。文案由 `messages.ts` 统一构造
 * （HTML + 纯文本双版本），这里只负责把消息送出去。
 * 所有渠道失败只记日志，绝不阻塞换班主流程。
 *
 * SIMPLIFIED: Workers 里没有 SMTP。邮件不走 SMTP 直发，见 `sendEmail`：
 *   - 设置了 `EMAIL_WEBHOOK_URL` 时，把消息 JSON POST 到该地址
 *     （应指向 Resend / MailChannels / 自建中继等外部发信服务）；
 *   - 未设置时返回 `"email_not_configured"`，调用方把该结果记进事件，
 *     不要谎称「已发送」。
 * SIMPLIFIED: Workers `fetch` 不支持 HTTP 代理，`notify_tg_proxy`
 *   配置项被忽略（原 Python 用 requests proxies）。
 */

import type { Env } from "./env";
import * as repo from "./repo";

/** 与 Python `notify.Message` 对应。`titleHtml`/`body` 是 CONTRACT 约定的字段名，
 *  `html`/`text` 保留 Python 字段名作兼容（notify 内部用 bodyHtml/body）。 */
export interface Message {
  kind: string;
  title: string;
  /** 标题的 HTML 版，如 `✅ <b>CDT 换班完成报告（换班组：X）</b>` */
  titleHtml: string;
  /** 正文的 HTML 版 */
  body: string;
  /** 完整 HTML = titleHtml + "\n\n" + body（Python `Message.html`） */
  bodyHtml?: string;
  /** 纯文本版（去标签，Python `Message.text`） */
  text?: string;
  /** Python `Message.html` 的别名，等同 bodyHtml */
  html?: string;
  fields?: Record<string, unknown>;
}

export type NotifyChannel = "telegram" | "email" | "webhook";

export const BRAND = "CDT-Management";
/** 与 Python `settings.HTTP_TIMEOUT`（12 秒）一致。 */
export const HTTP_TIMEOUT_MS = 12_000;

function cfg(config: Record<string, string>): Record<string, string> {
  return config;
}

function isDryRun(env: Env): boolean {
  return env.CDT_DRY_RUN === "1";
}

/** Telegram Bot Token：优先用 Worker Secret，其次用设置里的 token。 */
export function telegramToken(env: Env, config: Record<string, string>): string {
  return (env.TELEGRAM_BOT_TOKEN ?? "").trim() || (config["notify_tg_token"] ?? "").trim();
}

export function telegramChatId(env: Env, config: Record<string, string>): string {
  return (env.TELEGRAM_CHAT_ID ?? "").trim() || (config["notify_tg_chat_id"] ?? "").trim();
}

export function enabledChannels(
  env: Env,
  config: Record<string, string>,
): NotifyChannel[];
export function enabledChannels(config: Record<string, string>): NotifyChannel[];
export function enabledChannels(
  envOrConfig: Env | Record<string, string>,
  config?: Record<string, string>,
): NotifyChannel[] {
  const cfg = config ?? (envOrConfig as Record<string, string>);
  const env = config ? (envOrConfig as Env) : ({} as Env);
  const channels: NotifyChannel[] = [];
  if (
    cfg["notify_tg_enabled"] === "1" &&
    telegramToken(env, cfg) &&
    telegramChatId(env, cfg)
  ) {
    channels.push("telegram");
  }
  // 邮件：Workers 没有 SMTP，改为 EMAIL_WEBHOOK_URL 转发；仍要求填了收件人，
  // 否则 webhook 收到消息也不知道发给谁。
  if (
    cfg["notify_mail_enabled"] === "1" &&
    cfg["notify_mail_to"] &&
    (env.EMAIL_WEBHOOK_URL || cfg["notify_mail_host"])
  ) {
    channels.push("email");
  }
  if (cfg["notify_wh_enabled"] === "1" && cfg["notify_wh_url"]) {
    channels.push("webhook");
  }
  return channels;
}

/** 兼容旧调用：只传 config 时按「无 env」处理（token/hook 均取自 config）。 */
export function enabledChannelsFromConfig(config: Record<string, string>): NotifyChannel[] {
  return enabledChannels({} as Env, config);
}

// 对外展示 / 写日志前先把凭据抹掉：异常原文可能带完整 URL，
// Telegram token 就在 /bot<token>/sendMessage 这段 path 里。
const SECRET_KEYS = [
  "notify_tg_token",
  "notify_tg_proxy",
  "notify_mail_password",
  "notify_mail_username",
  "notify_wh_url",
  "notify_wh_headers",
  "ddns_cf_token",
  "ddns_cf_key",
] as const;
const BOT_PATH_RE = /(\/bot)[^/\s]+/gi;

export function safeError(
  exc: unknown,
  config?: Record<string, string> | null,
): string {
  let text = exc instanceof Error ? exc.message : String(exc);
  const c = config ?? {};
  for (const key of SECRET_KEYS) {
    const value = String(c[key] ?? "").trim();
    if (value.length >= 4) {
      text = text.split(value).join("***");
    }
  }
  // 配置里没带 token（草稿为空、或异常来自别的渠道）时，兜底打码 /bot<token>/ 路径
  text = text.replace(BOT_PATH_RE, "$1***");
  return text.slice(0, 300);
}

/** 逐个渠道发送，返回 {渠道: 结果}。换班通知里要回显这个结果。 */
export async function sendAll(
  env: Env,
  config: Record<string, string>,
  message: Message,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const channel of enabledChannels(env, config)) {
    try {
      await send(env, config, channel, message);
      results[channel] = "ok";
    } catch (exc) {
      const safe = safeError(exc, config);
      results[channel] = `failed: ${safe}`;
      console.warn(`通知发送失败 channel=${channel} error=${safe}`);
    }
  }
  return results;
}

/** 把 sendAll 的返回值翻成一句写进事件进度的话。
 *  没启用任何渠道时返回空串 —— 什么都没发，不必在事件里占一行。 */
export function resultText(results: Record<string, string>, what = "通知"): string {
  const failed = Object.entries(results)
    .filter(([, state]) => state !== "ok")
    .map(([channel]) => channel);
  if (failed.length > 0) {
    return `${what}发送失败：${failed.join("、")}`;
  }
  if (Object.keys(results).length === 0) {
    return "";
  }
  return `${what}已发送`;
}

/** 把发送结果写成事件的最后一条进度。没渠道 / 没有事件时不做任何事。 */
export async function noteNotify(
  env: Env,
  eventId: number,
  results: Record<string, string>,
  what = "通知",
): Promise<void> {
  const text = resultText(results, what);
  if (!text || !eventId) {
    return;
  }
  await repo.addEventProgress(env, eventId, text);
}

export async function send(
  env: Env,
  config: Record<string, string>,
  channel: string,
  message: Message,
): Promise<void> {
  if (channel === "telegram") {
    await sendTelegram(env, config, message);
  } else if (channel === "email") {
    const result = await sendEmail(env, config, message);
    if (result !== "ok") {
      throw new Error(result);
    }
  } else if (channel === "webhook") {
    await sendWebhook(config, message);
  } else {
    throw new Error(`未知通知渠道 ${channel}`);
  }
}

// --------------------------------------------------------------------------
// Telegram
// --------------------------------------------------------------------------

/** Telegram 单条消息上限 4096 字符，留点余量给结尾提示 */
export const TG_LIMIT = 4000;

const TAG_RE = /<[^>]+>/g;

export function stripTags(text: string): string {
  return text.replace(TAG_RE, "");
}

/** 按行截断：直接切字符串会把 <b> / <code> 切成两半，Telegram 就会 400。 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const kept: string[] = [];
  let size = 0;
  for (const line of text.split("\n")) {
    if (size + line.length + 1 > limit - 20) {
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join("\n") + "\n…（内容过长已截断）";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fullHtml(message: Message): string {
  return message.bodyHtml ?? message.html ?? `${message.titleHtml}\n\n${message.body}`;
}

function plainText(message: Message): string {
  return message.text ?? stripTags(fullHtml(message));
}

async function sendTelegram(
  env: Env,
  config: Record<string, string>,
  message: Message,
): Promise<void> {
  const token = telegramToken(env, config);
  const chatId = telegramChatId(env, config);
  if (!token || !chatId) {
    throw new Error("Telegram token 或 chat_id 未配置");
  }
  if (isDryRun(env)) {
    console.info("DRY RUN：跳过 Telegram 推送");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let payload: Record<string, unknown> = {
    chat_id: chatId,
    text: clip(fullHtml(message), TG_LIMIT),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (response.status === 200) {
        return;
      }
      const bodyText = await response.text().catch(() => "");
      lastError = new Error(`HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
      // 400 一般是 HTML 解析或格式问题：去掉 parse_mode 用纯文本来一次，还失败就不再重试
      if (response.status === 400 && payload["parse_mode"]) {
        payload = {
          chat_id: chatId,
          text: stripTags(String(payload["text"])),
          disable_web_page_preview: true,
        };
        continue;
      }
      if (response.status >= 400 && response.status < 500) {
        break;
      }
    } catch (exc) {
      lastError = exc;
    }
    if (attempt < 2) {
      await sleep(2000);
    }
  }
  throw new Error(`Telegram 推送失败：${safeError(lastError, config)}`);
}

// --------------------------------------------------------------------------
// 邮件（经 Webhook 转发 —— Workers 没有 SMTP）
// --------------------------------------------------------------------------

/**
 * 邮件发送（Workers 版）。
 *
 * SIMPLIFIED: Cloudflare Workers 没有 SMTP 能力，原 Python 的 smtplib 直发
 * 无法移植，也不做「假装发出」的实现。
 *   - `EMAIL_WEBHOOK_URL` 已设置：把消息 JSON POST 到该地址，返回 `"ok"`。
 *     该地址应指向 Resend / MailChannels / 自建中继等外部发信服务，
 *     由对方按 `to` / `subject` / `html` 发信。
 *   - 未设置：返回 `"email_not_configured"`，`send()` 会把它转成异常，
 *     `sendAll()` 记为 `email: failed: email_not_configured`，事件里如实写
 *     「通知发送失败：email」，不谎称已发送。
 */
export async function sendEmail(
  env: Env,
  config: Record<string, string>,
  message: Message,
): Promise<string> {
  const hookUrl = (env.EMAIL_WEBHOOK_URL ?? "").trim();
  if (!hookUrl) {
    return "email_not_configured";
  }
  if (isDryRun(env)) {
    console.info("DRY RUN：跳过邮件 Webhook 推送");
    return "ok";
  }
  const recipient = (config["notify_mail_to"] ?? "").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.EMAIL_API_KEY) {
    headers["Authorization"] = `Bearer ${env.EMAIL_API_KEY}`;
  }
  const response = await fetch(hookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: recipient,
      subject: `${BRAND} · ${message.title}`,
      title: message.title,
      text: plainText(message),
      html: fullHtml(message),
      kind: message.kind,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (response.status >= 300) {
    throw new Error(`邮件 Webhook 返回 HTTP ${response.status}`);
  }
  return "ok";
}

// --------------------------------------------------------------------------
// Webhook
// --------------------------------------------------------------------------

/** 把值转义成「能安全放进 JSON 字符串字面量」的形式（去掉首尾引号）。 */
export function jsonInner(value: string): string {
  const dumped = JSON.stringify(String(value));
  return dumped.slice(1, -1);
}

async function sendWebhook(
  config: Record<string, string>,
  message: Message,
): Promise<void> {
  const url = config["notify_wh_url"] ?? "";
  const method = (config["notify_wh_method"] ?? "POST").toUpperCase();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const rawHeaders = config["notify_wh_headers"] ?? "";
  if (rawHeaders) {
    try {
      Object.assign(headers, JSON.parse(rawHeaders) as Record<string, string>);
    } catch {
      console.warn("Webhook 自定义 headers 不是合法 JSON，已忽略");
    }
  }

  let body = config["notify_wh_body"] ?? "";
  if (!body) {
    body = JSON.stringify({
      title: message.title,
      text: plainText(message),
      kind: message.kind,
    });
  } else {
    body = body
      .split("{title}")
      .join(jsonInner(message.title))
      .split("{text}")
      .join(jsonInner(plainText(message)))
      .split("{kind}")
      .join(jsonInner(message.kind));
  }

  const response = await fetch(url, {
    method: method === "GET" ? "GET" : method,
    headers,
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (response.status >= 300) {
    throw new Error(`Webhook 返回 HTTP ${response.status}`);
  }
}
