/**
 * 通知文案：与用户自用脚本 cdt.py 逐字对齐。
 *
 * 对应 Python `app/messages.py`。文案是用户长期打磨的，措辞、emoji、
 * 分隔线、字段顺序一律照抄，不做「优化」。本模块只做拼装，不查库、不调接口。
 *
 * 停机状态一律读实例真实返回的 StoppedMode（StopCharging 节省停机 /
 * KeepCharging 普通停机），不按脚本写死「Stopped (StopCharging)」。
 * 唯一在脚本之外统一加的一行是「📍 地域」。
 */

import type { Message } from "./notify";

export const SEP = "━━━━━━━━━━━━━━━";

// 阿里云 StoppedMode 的取值，面板与通知统一用这套说法。
// Not-applicable = 本实例不支持停机不收费，停机后照常收费，语义等同普通停机。
export const MODE_LABELS: Record<string, string> = {
  StopCharging: "节省停机",
  KeepCharging: "普通停机",
  Stop: "普通停机",
  "Not-applicable": "普通停机",
};

const TAG_RE = /<[^>]+>/g;

export function modeLabel(mode: string | null | undefined): string {
  const m = String(mode ?? "").trim();
  return m ? MODE_LABELS[m] ?? m : "";
}

export function stopPhrase(mode: string | null | undefined, prefix = "已"): string {
  const label = modeLabel(mode);
  return label ? `${prefix}${label}` : `${prefix}停机`;
}

// 实例状态的中文说法，事件进度文案用（Running 到位 = 运行中；停机到位 = 真实停机模式）。
export const STATUS_LABELS: Record<string, string> = {
  Running: "运行中",
  Stopped: "已停机",
  Starting: "启动中",
  Stopping: "停止中",
  Pending: "等待中",
};

export function statusSuffix(
  status: string | null | undefined,
  stoppedMode: string | null | undefined,
): string {
  const s = String(status ?? "").trim();
  if (!s) {
    return "";
  }
  if (s === "Running") {
    return "（运行中）";
  }
  if (s === "Stopped") {
    const label = modeLabel(stoppedMode);
    return label ? `（${label}）` : "（已停机）";
  }
  const label = STATUS_LABELS[s];
  return label ? `（${label}）` : "";
}

export function resultLabel(
  status: string | null | undefined,
  stoppedMode: string | null | undefined,
): string {
  const s = String(status ?? "").trim();
  if (!s) {
    return "已完成";
  }
  if (s === "Running") {
    return "运行中";
  }
  if (s === "Stopped") {
    const label = modeLabel(stoppedMode);
    return label ? `已停止（${label}）` : "已停止";
  }
  return STATUS_LABELS[s] ?? s;
}

export function stopTail(servers: ServerInfo[]): string {
  const modes = new Set(servers.map((s) => modeOf(s)));
  if (modes.has("-") || modes.has("")) {
    return "均已停机";
  }
  if (modes.size === 1 && modes.has("StopCharging")) {
    return "均已节省停机";
  }
  if (modes.size === 1) {
    const only = [...modes][0] as string;
    return `均已${modeLabel(only)}`;
  }
  return "均已停机";
}

// --------------------------------------------------------------------------
// 字段取值
// --------------------------------------------------------------------------

/** 服务器行（来自 repo.listServers / 阿里云实例快照的并集视图）。 */
export interface ServerInfo {
  id?: number | string;
  label?: string;
  instance_id?: string;
  public_ip?: string;
  stopped_mode?: string;
  instance_status?: string;
  traffic_used?: number | string | null;
  threshold_gb?: number | string | null;
  region_id?: string;
  quota_gb?: number | string | null;
  monthly_cost?: number | string | null;
  balance_amount?: number | string | null;
  billing_currency?: string;
  [key: string]: unknown;
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function labelOf(server: ServerInfo): string {
  return escapeHtml(String(server.label ?? ""));
}

/**
 * Plain (unescaped) label for notification titles: titles are inserted raw
 * into `<b>` by `titled()` (same as group names in `titleOf`), so the
 * escaped form would show up as `&amp;` in the plain-text version.
 */
function rawLabel(server: ServerInfo): string {
  return String(server.label ?? "").trim();
}

function rawInstanceId(server: ServerInfo): string {
  return String(server.instance_id ?? "").trim();
}

/**
 * What a notification title identifies a server by: the Aliyun instance
 * ID (`i-...`) first, falling back to the panel alias. The alias alone
 * (e.g. "CDT") does not tell several servers apart; the ID does.
 */
function titleServer(server: ServerInfo): string {
  return rawInstanceId(server) || rawLabel(server);
}

function instanceOf(server: ServerInfo): string {
  return escapeHtml(String(server.instance_id ?? ""));
}

function ipOf(server: ServerInfo): string {
  // 脚本里 get_ecs_info 取不到 IP 时给的就是这个字符串
  return String(server.public_ip ?? "N/A");
}

function modeOf(server: ServerInfo): string {
  // Not-applicable = 本实例不支持停机不收费，停机后照常收费，语义等同普通停机
  // （KeepCharging）。归一化后再走 modeLabel / _status，避免漏成英文。
  const mode = String(server.stopped_mode ?? "-");
  return mode === "Not-applicable" ? "KeepCharging" : mode;
}

function statusOf(server: ServerInfo): string {
  const status = String(server.instance_status ?? "Unknown");
  if (status === "Running") {
    return status;
  }
  const mode = modeOf(server);
  return mode && mode !== "-" ? `${status} (${mode})` : status;
}

function stateIcon(server: ServerInfo): string {
  return String(server.instance_status ?? "") === "Running" ? "🟢" : "⚪";
}

function usedOf(server: ServerInfo): number {
  return Number(server.traffic_used ?? 0) || 0;
}

function thresholdText(server: ServerInfo): string {
  const value = Number(server.threshold_gb ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  return value
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function usedLine(server: ServerInfo): string {
  const line = `┃ 📈 已用：${usedOf(server).toFixed(2)} GB`;
  const threshold = thresholdText(server);
  return threshold ? `${line}（阈值 ${threshold} GB）` : line;
}

// --------------------------------------------------------------------------
// 标题：CDT {事件}报告（{范围}）
// --------------------------------------------------------------------------

export const SCOPE_GROUP = "换班组";
export const SCOPE_KEEPALIVE = "单机保活";
export const SCOPE_IDLE = "闲散手动";
export const SCOPE_MANUAL = "手动";

export function scopeTag(
  groupName = "",
  scope: string = SCOPE_GROUP,
  note = "",
): string {
  let inner = groupName ? `${SCOPE_GROUP}：${groupName}` : scope || SCOPE_GROUP;
  if (note) {
    inner = `${inner}，${note}`;
  }
  return `（${inner}）`;
}

export function titleOf(
  event: string,
  groupName = "",
  scope: string = SCOPE_GROUP,
  note = "",
): string {
  return `CDT ${event}报告${scopeTag(groupName, scope, note)}`;
}

// --------------------------------------------------------------------------
// 事件标题：{结论}（{对象}）
// --------------------------------------------------------------------------

export function ev(conclusion: string, obj = ""): string {
  return `${conclusion}（${obj || "系统"}）`;
}

export function objServer(label: string): string {
  return String(label || "—");
}

export function objGroup(name: string): string {
  return `${SCOPE_GROUP}：${name || "—"}`;
}

export function objDuty(name: string, label: string): string {
  return `${SCOPE_GROUP}：${name || "—"}，当班 ${label || "—"}`;
}

export function objMember(name: string, label: string): string {
  return `${SCOPE_GROUP}：${name || "—"}，成员 ${label || "—"}`;
}

function makeMessage(kind: string, titleHtml: string, title: string, body: string): Message {
  const bodyHtml = `${titleHtml}\n\n${body}`;
  return {
    kind,
    title,
    titleHtml,
    body,
    bodyHtml,
    html: bodyHtml,
    text: bodyHtml.replace(TAG_RE, ""),
  };
}

function titled(kind: string, emoji: string, title: string, body: string): Message {
  return makeMessage(kind, `${emoji} <b>${title}</b>`, title, body);
}

// --------------------------------------------------------------------------
// 块
// --------------------------------------------------------------------------

export const REGION_LABELS: Record<string, string> = {
  // -- 中国内地 --
  "cn-qingdao": "华北 1（青岛）",
  "cn-beijing": "华北 2（北京）",
  "cn-zhangjiakou": "华北 3（张家口）",
  "cn-huhehaote": "华北 5（呼和浩特）",
  "cn-wulanchabu": "华北 6（乌兰察布）",
  "cn-hangzhou": "华东 1（杭州）",
  "cn-shanghai": "华东 2（上海）",
  "cn-nanjing": "华东 5（南京-本地地域）",
  "cn-fuzhou": "华东 6（福州-本地地域）",
  "cn-shenzhen": "华南 1（深圳）",
  "cn-heyuan": "华南 2（河源）",
  "cn-guangzhou": "华南 3（广州）",
  "cn-chengdu": "西南 1（成都）",
  "cn-wuhan-lr": "华中 1（武汉-本地地域）",
  // -- 中国港澳台 --
  "cn-hongkong": "中国香港",
  "cn-macau": "中国澳门",
  // -- 亚太 --
  "ap-southeast-1": "新加坡",
  "ap-southeast-2": "澳大利亚（悉尼）",
  "ap-southeast-3": "马来西亚（吉隆坡）",
  "ap-southeast-5": "印度尼西亚（雅加达）",
  "ap-southeast-6": "菲律宾（马尼拉）",
  "ap-southeast-7": "泰国（曼谷）",
  "ap-southeast-8": "马来西亚（柔佛）",
  "ap-northeast-1": "日本（东京）",
  "ap-northeast-2": "韩国（首尔）",
  "ap-south-1": "印度（孟买）",
  // -- 欧洲 --
  "eu-central-1": "德国（法兰克福）",
  "eu-west-1": "英国（伦敦）",
  // -- 美洲 --
  "us-west-1": "美国（硅谷）",
  "us-east-1": "美国（弗吉尼亚）",
  "na-south-1": "墨西哥",
  "sa-east-1": "巴西（圣保罗）",
  // -- 中东 --
  "me-east-1": "阿联酋（迪拜）",
  "me-central-1": "沙特阿拉伯（利雅得）",
};

function regionOf(server: ServerInfo): string {
  const raw = String(server.region_id ?? "").trim();
  if (!raw) {
    return "-";
  }
  return REGION_LABELS[raw] ?? raw;
}

export function runningBlock(heading: string, server: ServerInfo, ddnsStatus: string): string {
  return [
    `🟢 <b>${heading} </b>`,
    `┃ 🏷 别名：${labelOf(server)}`,
    `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
    `┃ 🌐 ＩＰ：${ipOf(server)}`,
    `┃ 📍 地域：${regionOf(server)}`,
    `┃ ☁️ DDNS：${ddnsStatus}`,
    "┃ 🟢 状态：Running",
  ].join("\n");
}

export function stoppedBlock(
  heading: string,
  server: ServerInfo,
  statusText: string,
  used: number | null = null,
): string {
  const lines = [
    `⚪ <b>${heading} </b>`,
    `┃ 🏷 别名：${labelOf(server)}`,
    `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
    `┃ 🌐 ＩＰ：${ipOf(server)}`,
    `┃ 📍 地域：${regionOf(server)}`,
  ];
  if (used !== null) {
    lines.push(`┃ 📈 已用：${used.toFixed(2)} GB`);
  }
  lines.push(`┃ ⚪ 状态：${statusText}`);
  return lines.join("\n");
}

function joinBlocks(parts: string[]): string {
  return parts.join(`\n${SEP}\n`) + `\n${SEP}`;
}

// --------------------------------------------------------------------------
// 各类报告
// --------------------------------------------------------------------------

export function shiftDone(
  duty: ServerInfo,
  stopped: ServerInfo[],
  period: string,
  ddnsStatus: string,
  groupName = "",
  delayed = false,
  manual = false,
): Message {
  const body =
    `🕒 <b>当前班次</b>：${period}\n${SEP}\n` +
    joinBlocks(
      [runningBlock("运行账号", duty, ddnsStatus)].concat(
        stopped.map((s) => stoppedBlock("停止账号", s, statusOf(s))),
      ),
    );
  if (delayed) {
    const server = titleServer(duty);
    const note = server ? `延迟恢复，${server}` : "延迟恢复";
    return titled("shift_done", "✅", titleOf("换班成功", groupName, SCOPE_GROUP, note), body);
  }
  const event = manual ? "手动换班完成" : "换班完成";
  return titled("shift_done", "✅", titleOf(event, groupName, SCOPE_GROUP, titleServer(duty)), body);
}

export function shiftFailover(
  duty: ServerInfo,
  over: ServerInfo[],
  standby: ServerInfo[],
  ddnsStatus: string,
  groupName = "",
  reason = "traffic",
): Message {
  const stall = reason === "stall";
  const cause = stall ? "当班实例疑被抢占，保活超时" : "当班实例流量超限";
  const takenLabel = stall ? "离线账号" : "超限账号";
  const parts = [runningBlock("接替账号", duty, ddnsStatus)]
    .concat(over.map((s) => stoppedBlock(takenLabel, s, statusOf(s), usedOf(s))))
    .concat(standby.map((s) => stoppedBlock("停止账号", s, statusOf(s))));
  return titled(
    "shift_failover",
    "⚠️",
    titleOf("故障转移", groupName, SCOPE_GROUP, titleServer(duty)),
    `📢 <b>故障转移</b>：${cause}，已启用备用实例。\n${SEP}\n` + joinBlocks(parts),
  );
}

export function breaker(servers: ServerInfo[], groupName = "", note = ""): Message {
  const count = servers.length === 2 ? "双实例" : `${servers.length} 台实例`;
  let warn: string;
  if (note) {
    warn = `当班流量已到达到阈值，${note}，按“全局熔断”处理，${stopTail(servers)}。`;
  } else {
    warn = `${count}流量均已到达到阈值，“全局熔断”，${stopTail(servers)}。`;
  }
  const blocks = servers.map((s) =>
    [
      `🖥 ${labelOf(s)}`,
      `┃ 📦 实例：<code>${instanceOf(s)}</code>`,
      `┃ 🌐 ＩＰ：${ipOf(s)}`,
      `┃ 📍 地域：${regionOf(s)}`,
      usedLine(s),
      `┃ ${stateIcon(s)} 状态：${statusOf(s)}`,
    ].join("\n"),
  );
  return titled(
    "breaker",
    "🚨",
    titleOf("全局熔断", groupName),
    `⚠ <b>警告：${warn}</b>\n\n` + joinBlocks(blocks),
  );
}

export function limitStop(
  server: ServerInfo,
  groupName = "",
  mode: string | null = null,
): Message {
  const stopped = stopPhrase(
    mode !== null ? mode : (server.stopped_mode as string | undefined),
    "已强制",
  );
  return titled(
    "limit_stop",
    "🚨",
    titleOf("全局熔断", groupName, SCOPE_GROUP, titleServer(server)),
    [
      `当班实例流量超限，该换班组没有启用故障转移，${stopped}。`,
      "如有需要，请开启故障转移或者去管理后台手动点击“立即换班”。",
      "",
      `🖥 ${labelOf(server)}`,
      `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
      `┃ 🌐 ＩＰ：${ipOf(server)}`,
      `┃ 📍 地域：${regionOf(server)}`,
      usedLine(server),
      `┃ ${stateIcon(server)} 状态：${statusOf(server)}`,
      SEP,
    ].join("\n"),
  );
}

export function overLimit(
  server: ServerInfo,
  scope: string,
  mode: string | null = null,
): Message {
  const stopped = stopPhrase(mode !== null ? mode : (server.stopped_mode as string | undefined));
  const paused = scope === SCOPE_KEEPALIVE ? `${stopped}，并暂停保活` : stopped;
  return titled(
    "limit_stop",
    "🚨",
    titleOf("超限停机", "", scope, titleServer(server)),
    [
      `流量已到阈值，${paused}，不再自动开机。`,
      "流量回落到阈值以下（流量包重置或调高阈值）后自动恢复。",
      "",
      `🖥 ${labelOf(server)}`,
      `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
      `┃ 🌐 ＩＰ：${ipOf(server)}`,
      `┃ 📍 地域：${regionOf(server)}`,
      usedLine(server),
      `┃ ${stateIcon(server)} 状态：${statusOf(server)}`,
      SEP,
    ].join("\n"),
  );
}

export function recovery(
  server: ServerInfo,
  ddnsStatus: string,
  headline = "当班实例疑被抢占，已自动恢复运行。",
  kind = "recovery",
  groupName = "",
): Message {
  const title =
    kind === "keepalive"
      ? titleOf("抢占恢复", "", SCOPE_KEEPALIVE, titleServer(server))
      : titleOf("抢占恢复", groupName, SCOPE_GROUP, titleServer(server));
  const lines = [
    headline,
    "",
    `🖥 ${labelOf(server)}`,
    `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
    `┃ 🌐 ＩＰ：${ipOf(server)}`,
    `┃ 📍 地域：${regionOf(server)}`,
    `┃ ☁️ DDNS：${ddnsStatus}`,
    "┃ 🟢 状态：Running",
    SEP,
  ];
  return titled(kind, "🟢", title, lines.join("\n"));
}

export function powerOn(
  server: ServerInfo,
  ddnsStatus: string,
  scope: string,
): Message {
  const lines = [
    "实例已开机，正在运行。",
    "",
    `🖥 ${labelOf(server)}`,
    `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
    `┃ 🌐 ＩＰ：${ipOf(server)}`,
    `┃ 📍 地域：${regionOf(server)}`,
    `┃ ☁️ DDNS：${ddnsStatus}`,
    "┃ 🟢 状态：Running",
    SEP,
  ];
  return titled(
    "power_on",
    "🟢",
    titleOf("已开机", "", scope, titleServer(server)),
    lines.join("\n"),
  );
}

export function powerOff(
  server: ServerInfo,
  scope: string,
  mode: string | null = null,
): Message {
  const modeText = mode ? modeLabel(mode) : "";
  const head = modeText ? `实例即将关机（${modeText}）。` : "实例即将关机。";
  const lines = [
    head,
    "",
    `🖥 ${labelOf(server)}`,
    `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
    `┃ 🌐 ＩＰ：${ipOf(server)}`,
    `┃ 📍 地域：${regionOf(server)}`,
    `┃ ${stateIcon(server)} 状态：${statusOf(server)}`,
    SEP,
  ];
  return titled(
    "power_off",
    "🛑",
    titleOf("即将关机", "", scope, titleServer(server)),
    lines.join("\n"),
  );
}

export function shiftError(
  duty: ServerInfo,
  stopped: ServerInfo[],
  minutes: number,
  groupName = "",
  ddnsStatus = "",
): Message {
  const dutyLines = [
    "🚩 <b>应当运行账号 </b>",
    `┃ 🏷 别名：${labelOf(duty)}`,
    `┃ 📦 实例：<code>${instanceOf(duty)}</code>`,
    `┃ 🌐 ＩＰ：${ipOf(duty)}`,
    `┃ 📍 地域：${regionOf(duty)}`,
  ];
  if (ddnsStatus) {
    dutyLines.push(`┃ ☁️ DDNS：${ddnsStatus}`);
  }
  dutyLines.push(`┃ ${stateIcon(duty)} 状态：${statusOf(duty)}`);
  const parts = [dutyLines.join("\n")];
  for (const server of stopped) {
    parts.push(
      [
        "🚩 <b>应当停止账号 </b>",
        `┃ 🏷 别名：${labelOf(server)}`,
        `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
        `┃ 🌐 ＩＰ：${ipOf(server)}`,
        `┃ 📍 地域：${regionOf(server)}`,
        `┃ ${stateIcon(server)} 状态：${statusOf(server)}`,
      ].join("\n"),
    );
  }
  return titled(
    "shift_error",
    "⚠️",
    titleOf("换班异常", groupName, SCOPE_GROUP, titleServer(duty)),
    `⏳ <b>换班超时：换班指令已执行 ${minutes} 分钟，但状态未就绪。</b>\n\n` +
      joinBlocks(parts),
  );
}

export const CURRENCY_SIGNS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  HKD: "HK$",
  JPY: "JP¥",
  EUR: "€",
  GBP: "£",
};

function currencySign(currency: string | null | undefined): string {
  const c = String(currency ?? "").trim().toUpperCase();
  return CURRENCY_SIGNS[c] ?? (c ? `${c} ` : "");
}

function money(value: unknown, currency: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "—";
  }
  return `${currencySign(currency)}${amount.toFixed(2)}`;
}

function balanceText(server: ServerInfo): string {
  return money(server.balance_amount, server.billing_currency);
}

export function reportBlock(server: ServerInfo): string {
  const used = usedOf(server);
  const quota = Number(server.quota_gb ?? 0) || 200.0;
  const remain = quota - used;
  const percent = quota > 0 ? (used / quota) * 100 : 0.0;
  const color = percent < 60 ? "🟢 正常" : percent < 90 ? "🟡 注意" : "🔴 危险";
  return [
    `🖥 ${labelOf(server)}`,
    `┃ 📦 实例：<code>${instanceOf(server)}</code>`,
    `┃ 🌐 ＩＰ：${ipOf(server)}`,
    `┃ 📍 地域：${regionOf(server)}`,
    `┃ 💰 费用：${money(server.monthly_cost, server.billing_currency)}`,
    `┃ 💳 余额：${balanceText(server)}`,
    `┃ 📈 流量：${used.toFixed(2)} GB`,
    `┃ 💾 剩余：${remain.toFixed(2)} GB`,
    `┃ 🔥 使用率：${percent.toFixed(2)}%  ${color}`,
  ].join("\n");
}

export function dailyReport(servers: ServerInfo[], timestamp: string): Message {
  return makeMessage(
    "daily_report",
    "📊 <b>CDT-Management 每日报告</b>",
    "CDT-Management 每日报告",
    servers.map((s) => reportBlock(s)).join("\n\n") + `\n\n⏰ 更新时间：${timestamp}`,
  );
}

/**
 * Traffic/cost footer appended to every event notification (not the daily
 * report, which already has these numbers per server): today's traffic,
 * month-to-date traffic against quota, this month's cost and the account
 * balance — the same four lines the CDT Monitor daily report shows.
 * `dailyById` is today's traffic per server id, computed against the
 * midnight baseline in `notify.ts`. Takes the minimal snapshot shape so
 * both `ServerView` (from the DB) and `ServerInfo` fit.
 */
export interface TrafficSnapshot {
  id?: number | string;
  label?: string;
  instance_id?: string;
  traffic_used?: number | string | null;
  quota_gb?: number | string | null;
  monthly_cost?: number | string | null;
  balance_amount?: number | string | null;
  billing_currency?: string;
}

export function trafficFooter(
  servers: TrafficSnapshot[],
  dailyById: Map<number, number>,
): string {
  const fmt = (value: number): string =>
    value
      .toFixed(2)
      .replace(/0+$/, "")
      .replace(/\.$/, "");
  const blocks = servers.map((server) => {
    const used = Number(server.traffic_used ?? 0) || 0;
    const quota = Number(server.quota_gb ?? 0) || 200.0;
    const percent = quota > 0 ? (used / quota) * 100 : 0.0;
    const daily = dailyById.get(Number(server.id ?? 0)) ?? 0;
    const label = escapeHtml(String(server.label ?? ""));
    const instanceId = escapeHtml(String(server.instance_id ?? ""));
    const head =
      label && instanceId
        ? `🖥 ${label}（${instanceId}）`
        : `🖥 ${label || instanceId}`;
    const lines = [
      head,
      `┃ 📈 当日流量：${daily.toFixed(2)} GB`,
      `┃ 📦 当月流量：${used.toFixed(2)} GB / ${fmt(quota)} GB (${percent.toFixed(2)}%)`,
      `┃ 💰 当月费用：${money(server.monthly_cost, server.billing_currency)}`,
      `┃ 💳 账户余额：${money(server.balance_amount, server.billing_currency)}`,
    ];
    return lines.join("\n");
  });
  return `📊 流量与费用\n${blocks.join("\n\n")}`;
}

export function shiftPeriod(slotName: string, start: string, end: string): string {
  const slot = (slotName ?? "").trim();
  const s = (start ?? "").trim();
  let e = (end ?? "").trim();
  if (!s && !e) {
    return slot || "—";
  }
  if (!e) {
    return slot ? `${slot}（${s}）` : s;
  }
  // 结束 00:00 就是「当天到午夜」，写成 24:00 才不会读成第二天凌晨。
  if (e === "00:00" && s !== "00:00") {
    e = "24:00";
  }
  const span = `${s}–${e}`;
  return slot ? `${slot}（${span}）` : span;
}
