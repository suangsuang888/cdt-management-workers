/**
 * HTTP API — TypeScript port of `app/api.py` (BeacherZ/cdt-management).
 *
 * Mirrors the Python routes and JSON response shapes. Error envelope is
 * `{ok:false, code, message}` (the Python handlers returned
 * `{"error": {"code", "message"}}`; the Workers port normalises to the
 * `{ok:false, ...}` shape used by the frontend contract).
 *
 * Auth: `cdt_mgmt_session` cookie, HMAC-signed via `security.ts`
 * (`issueSession` / `readSession`), plus CSRF double-submit cookie
 * `cdt_mgmt_csrf` checked against the `x-cdt-csrf` header on every
 * non-GET request, exactly like `_current_user` / `require_admin` /
 * `require_csrf` in api.py.
 *
 * Login rate limiting is in-memory (per isolate): it resets when the
 * isolate is recycled, so it is a best-effort guard, not a durable
 * lockout. See `rateLimited` below.
 *
 * NOTE (import assumptions — coordinator): sibling modules do not exist
 * yet. This file is written against CONTRACT.md and assumes:
 * - every `repo.*` / `dns.*` / `ddns.*` / `billing.*` function takes
 *   `env` as its first argument (D1 / bindings come from `env`);
 * - `shift.ts` exports named functions (no `engine` object):
 *   `reconcileAll(env): Promise<void>`,
 *   `refreshServer(env, serverId)`, `manualAction(env, serverId, action)`,
 *   `bootstrapGroup(env, groupId)`, `dissolveGroup(env, groupId)`,
 *   `manualSwitch(env, groupId)`, `dailyReport(env)`, plus the pure
 *   helpers used below (`activeMembers`, `actualDuty(env, group, nowTs, tz)`,
 *   `currentMemberIndex(env, group, nowTs, tz)`, `memberSpanLabel`,
 *   `nextSwitchAt`, `keepaliveWindow(keepalive, now, tz)`) and the
 *   `PHASE_*` constants. `TRANSIENT_STATUS` is private to shift.ts, so
 *   this file mirrors it locally (same three values).
 * - `security.issueSession/readSession` take the session secret as a
 *   third argument (`env.SESSION_SECRET`); `notify.enabledChannels`
 *   takes `(env, config)`; `repo.addEvent` takes an options object
 *   (`{detail}`); `repo.setFlag(env, key)` stores no value (flags are
 *   presence-only with a `created_at` timestamp).
 * - `security.*` / `repo.*` helpers are awaited (works whether the
 *   sibling implementation is sync or async);
 * - `notify.send(env, config, channel, message)` is async and
 *   `Message = {kind, title, titleHtml, body, bodyHtml?}` per CONTRACT.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

import type { Env } from "./env";
import * as repo from "./repo";
import * as security from "./security";
import * as dns from "./dns";
import * as ddns from "./ddns";
import * as notify from "./notify";
import * as messages from "./messages";
import * as billing from "./billing";
import * as aliyun from "./aliyun";
import {
  BRAND,
  CSRF_COOKIE,
  REPO,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  UPSTREAM_REPO,
  VERSION,
} from "./settings";
import {
  PHASE_BREAKER,
  PHASE_ERROR,
  PHASE_FAILOVER,
  PHASE_MANUAL,
  PHASE_SETTLED,
  PHASE_SWITCHING,
  activeMembers,
  actualDuty,
  bootstrapGroup,
  currentMemberIndex,
  dissolveGroup,
  keepaliveWindow,
  manualAction,
  manualSwitch,
  memberSpanLabel,
  nextSwitchAt,
  reconcileAll,
  refreshServer,
} from "./shift";
import type { Keepalive, Member, ShiftGroup as ShiftGroupT } from "./shift";
import type {
  KeepaliveView,
  ServerView,
  ShiftGroup as RepoGroup,
} from "./repo";
import type { RecordBooks } from "./dns";

type Bindings = { Bindings: Env };
type Ctx = Context<Bindings>;

// ---------------------------------------------------------------------------
// Small narrowing helpers (repo rows are plain objects)
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

const isRow = (v: unknown): v is AnyRow =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const rowOf = (v: unknown): AnyRow => (isRow(v) ? v : {});
const rowsOf = (v: unknown): AnyRow[] =>
  Array.isArray(v) ? v.filter(isRow) : [];
const strOf = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v);
const numOf = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const boolOf = (v: unknown): boolean => v === true || v === 1 || v === "1";

// ---------------------------------------------------------------------------
// Errors — converted to `{ok:false, code, message}` by the onError handler
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new ApiError(400, "invalid_request", message);
const httpErr = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);

// ---------------------------------------------------------------------------
// Timezone helpers (Asia/Shanghai is the display timezone; store epoch secs)
// ---------------------------------------------------------------------------

interface TzNow {
  epoch: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  iso: string;
  label: string;
  dateStr: string;
  monthDays: number;
}

function tzNow(tzName: string, at?: Date): TzNow {
  const date = at ?? new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  // hour can come back as "24" for midnight with hour12:false; normalise.
  let hour = Number(parts["hour"]);
  if (hour === 24) hour = 0;
  const minute = Number(parts["minute"]);
  const second = Number(parts["second"]);
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    epoch: Math.floor(date.getTime() / 1000),
    year,
    month,
    day,
    hour,
    minute,
    iso: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
    label: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`,
    dateStr: `${year}-${pad(month)}-${pad(day)}`,
    monthDays,
  };
}

function hhmmToMinutes(value: unknown): number {
  const text = strOf(value).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

const fmtMinute = (minute: number): string =>
  minute >= 1440
    ? "24:00"
    : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function sessionEpoch(env: Env): Promise<number> {
  try {
    return Number.parseInt((await repo.getSetting(env, "session_epoch")) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

async function isInitialized(env: Env): Promise<boolean> {
  return (await repo.getSetting(env, "initialized")) === "1";
}

async function currentUser(c: Ctx): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE) ?? "";
  if (!token) return null;
  const user = await security.readSession(
    token,
    await sessionEpoch(c.env),
    c.env.SESSION_SECRET,
  );
  if (!user) return null;
  try {
    if (await repo.isSessionRevoked(c.env, await security.sessionId(token))) {
      return null;
    }
  } catch (e) {
    // Blacklist lookup failing (e.g. D1 hiccup) must not turn the whole
    // request into a 500: the signature itself already verified.
    console.warn("session revocation check failed, treating as not revoked", e);
  }
  return user;
}

async function requireAdmin(c: Ctx): Promise<string> {
  const user = await currentUser(c);
  if (!user) throw httpErr(401, "unauthorized", "未登录");
  return user;
}

function requireCsrf(c: Ctx): void {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  const cookie = getCookie(c, CSRF_COOKIE) ?? "";
  const header = c.req.header("x-cdt-csrf") ?? "";
  if (!cookie || cookie !== header) {
    throw httpErr(403, "forbidden", "CSRF 校验失败");
  }
}

async function attachSession(c: Ctx, username: string, epoch?: number): Promise<void> {
  const ep = epoch ?? (await sessionEpoch(c.env));
  const token = await security.issueSession(username, ep, c.env.SESSION_SECRET);
  setCookie(c, SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
  setCookie(c, CSRF_COOKIE, await security.newCsrfToken(), {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
  });
}

// ---------------------------------------------------------------------------
// Login rate limiting (in-memory — resets per isolate; see file header)
// ---------------------------------------------------------------------------

const LOGIN_WINDOW = 300;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map<string, number[]>();

function clientIp(c: Ctx): string {
  // Workers always sits behind the Cloudflare edge, so cf-connecting-ip is
  // authoritative here. (Python used the direct peer, falling back to
  // X-Forwarded-For only when the peer was a private address.)
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || "unknown";
}

function rateLimited(client: string): boolean {
  const now = Date.now() / 1000;
  // Prune stale entries when the map grows, so it cannot grow unboundedly
  // with distinct visitor IPs (mirrors the Python cleanup).
  if (loginFailures.size > 256) {
    for (const [key, times] of loginFailures) {
      const last = times[times.length - 1] ?? 0;
      if (!times.length || now - last >= LOGIN_WINDOW) {
        loginFailures.delete(key);
      }
    }
  }
  const attempts = (loginFailures.get(client) ?? []).filter((t) => now - t < LOGIN_WINDOW);
  if (attempts.length) loginFailures.set(client, attempts);
  else loginFailures.delete(client);
  return attempts.length >= LOGIN_MAX_FAILURES;
}

function recordFailure(client: string): void {
  const list = loginFailures.get(client) ?? [];
  list.push(Date.now() / 1000);
  loginFailures.set(client, list);
}

function resetFailures(client: string): void {
  loginFailures.delete(client);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function jsonBody(c: Ctx): Promise<AnyRow> {
  try {
    const data: unknown = await c.req.json();
    return rowOf(data);
  } catch {
    return {};
  }
}

function paramInt(c: Ctx, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n)) throw invalid(`${name}应为整数`);
  return n;
}

function asInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalid(`${label}应为整数`);
  return n;
}

// ---------------------------------------------------------------------------
// Setting labels (for the "配置已更新" event summary)
// ---------------------------------------------------------------------------

const SETTING_LABELS: Record<string, string> = {
  timezone: "时区",
  traffic_threshold_pct: "流量阈值",
  reconcile_interval: "同步间隔",
  reconcile_offset: "巡检起始秒",
  daily_report_enabled: "每日汇总",
  daily_report_time: "汇总时间",
  notify_on_shift: "换班通知",
  notify_on_failover: "故障转移通知",
  notify_on_recovery: "抢占恢复通知",
  notify_on_breaker: "全局熔断通知（全部成员）",
  notify_on_limit_stop: "超限停机通知（单台）",
  notify_on_error: "异常通知",
  notify_on_keepalive: "保活通知",
  notify_on_power: "开关机通知",
  ddns_enabled: "DDNS 开关",
  ddns_provider: "DDNS 服务商",
  ddns_cf_auth_mode: "DDNS 认证方式",
  ddns_cf_email: "DDNS 账号",
  ddns_cf_token: "DDNS Token",
  ddns_cf_key: "DDNS Global Key",
  ddns_zone_id: "Zone ID",
  ddns_record: "默认域名",
  ddns_records: "DDNS 记录名",
  ddns_ttl: "TTL",
  ddns_proxied: "CDN 代理",
  billing_enabled: "费用查询",
  billing_interval: "费用查询间隔",
  notify_tg_enabled: "Telegram 开关",
  notify_tg_token: "Telegram Token",
  notify_tg_chat_id: "Telegram Chat",
  notify_tg_proxy: "Telegram 代理",
  notify_mail_enabled: "邮件开关",
  notify_mail_host: "SMTP 主机",
  notify_mail_port: "SMTP 端口",
  notify_mail_security: "SMTP 加密",
  notify_mail_username: "SMTP 账号",
  notify_mail_password: "SMTP 密码",
  notify_mail_to: "收件人",
  notify_wh_enabled: "Webhook 开关",
  notify_wh_url: "Webhook 地址",
  notify_wh_method: "Webhook 方法",
  notify_wh_body: "Webhook 请求体",
  notify_wh_headers: "Webhook 请求头",
  admin_username: "用户名",
  admin_password: "登录密码",
};

const SETTING_LABELS_SKIP = new Set(["session_epoch", "initialized"]);

function settingLabels(keys: string[]): string {
  const names = keys
    .filter((k) => !SETTING_LABELS_SKIP.has(k))
    .map((k) => SETTING_LABELS[k] ?? k)
    .sort();
  if (names.length > 8) return `${names.slice(0, 8).join("、")} 等 ${names.length} 项`;
  return names.join("、");
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function finiteGb(value: unknown, fallback = 0): number {
  const n = numOf(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function serverSummary(
  server: ServerView,
  managed?: Map<number, AnyRow>,
  dnsMap?: Record<number, string[]>,
): AnyRow {
  const used = server.traffic_used;
  const quotaRaw = server.quota_gb;
  const quota = finiteGb(quotaRaw) || 1;
  const id = numOf(server.id);
  const owner = managed?.get(id);
  return {
    id: server.id,
    label: server.label || "",
    access_key_masked: server.access_key_masked || "",
    region_id: server.region_id || "",
    site: repo.normalizeSite(server.site),
    instance_id: server.instance_id || "",
    quota_gb: finiteGb(quotaRaw),
    threshold_gb: finiteGb(server.threshold_gb),
    remark: server.remark || "",
    traffic_used: used ?? null,
    traffic_percent:
      used !== null && used !== undefined
        ? Math.round((numOf(used) / quota) * 100 * 100) / 100
        : null,
    instance_status: server.instance_status || "Unknown",
    stop_mode: repo.normalizeStopMode(server.stop_mode),
    stopped_mode: server.stopped_mode || "",
    public_ip: server.public_ip || "",
    traffic_checked_at: server.traffic_checked_at || 0,
    status_checked_at: server.status_checked_at || 0,
    secret_configured: server.secret_configured ?? false,
    managed: owner ?? null,
    billing: billing.summaryOf(server),
    dns_record: (dnsMap?.[id] ?? []).join("、"),
  };
}

const PHASE_LABELS: Record<string, string> = {
  [PHASE_SWITCHING]: "换班中",
  [PHASE_SETTLED]: "已就绪",
  [PHASE_FAILOVER]: "故障转移",
  [PHASE_MANUAL]: "手动换班",
  [PHASE_BREAKER]: "熔断停机",
  [PHASE_ERROR]: "异常",
  pending: "待执行",
};

const GROUP_STATES: Record<string, string> = {
  scheduled: "正常排班中",
  switching: "换班中",
  failover: "故障转移中",
  manual: "手动换班中",
  recovering: "恢复中",
  breaker: "已熔断停机",
  error: "换班异常",
  disabled: "已停用",
  idle: "待排班",
  unknown: "状态未知",
};

function isTransient(status: string): boolean {
  // shift.ts keeps TRANSIENT_STATUS private; same three values.
  return status === "Starting" || status === "Pending" || status === "Stopping";
}

function groupState(
  group: RepoGroup,
  run: AnyRow,
  picked: [Member, number] | null,
  members: Member[],
  servers: Map<number, ServerView>,
): string {
  if (!group.enabled) return "disabled";
  if (!picked || members.length < 2) return "idle";

  const phase = strOf(run["phase"]);
  if (phase === PHASE_ERROR) return "error";
  if (phase === PHASE_BREAKER) return "breaker";

  const dutyId = numOf(picked[0]["server_id"]);
  const duty = servers.get(dutyId);
  const dutyStatus = duty?.instance_status ?? "";
  if (!dutyStatus) return "unknown";

  const override = run["failover"] ? "failover" : run["manual"] ? "manual" : "";

  if (isTransient(dutyStatus)) return override || "switching";
  if (dutyStatus !== "Running") return "recovering";
  let unknownMember = false;
  for (const member of members) {
    const otherId = numOf(member["server_id"]);
    if (otherId === dutyId) continue;
    const other = servers.get(otherId);
    const otherStatus = other?.instance_status ?? "";
    if (otherStatus === "Running" || isTransient(otherStatus)) return override || "switching";
    if (!otherStatus) unknownMember = true;
  }
  if (unknownMember) return "unknown";
  return override || "scheduled";
}

async function memberLabels(env: Env, members: unknown[]): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  for (const m of members) {
    const member = rowOf(m);
    const serverId = numOf(member["server_id"]);
    if (!serverId || labels.has(serverId)) continue;
    const server = await repo.getServer(env, serverId);
    labels.set(serverId, strOf(server?.label) || `#${serverId}`);
  }
  return labels;
}

async function groupPayload(
  env: Env,
  group: RepoGroup,
  config: Record<string, string>,
  nowTs: number,
  managed?: Map<number, AnyRow>,
  books?: RecordBooks,
): Promise<AnyRow> {
  const tzName = config["timezone"] || "Asia/Shanghai";
  const shiftGroup = group as unknown as ShiftGroupT;
  const members = activeMembers(shiftGroup);
  const picked = await actualDuty(env, shiftGroup, nowTs, tzName);
  const dutyId = picked ? numOf(picked[0]["server_id"]) : 0;
  const shiftStart = picked ? picked[1] : 0;
  const slotKey = String(shiftStart);
  const run = picked ? rowOf(await repo.getRun(env, numOf(group["id"]), slotKey)) : {};
  const nxt = nextSwitchAt(shiftGroup, nowTs, tzName);
  const servers = new Map<number, ServerView>();
  for (const s of await repo.listServers(env)) {
    servers.set(numOf(s["id"]), s);
  }

  const memberPayload = [];
  for (const member of group.members ?? []) {
    const server = servers.get(numOf(member["server_id"]));
    memberPayload.push({
      id: member["id"],
      server_id: member["server_id"],
      position: member["position"],
      hours: member["hours"],
      days: member["days"] ?? 0,
      span_label: memberSpanLabel(
        shiftGroup,
        member as unknown as Member,
        nowTs,
        tzName,
      ),
      slot_name: member["slot_name"] || "",
      start_time: member["start_time"] || "",
      end_time: member["end_time"] || "",
      enabled: boolOf(member["enabled"]),
      is_duty: numOf(member["server_id"]) === dutyId,
      server: server ? serverSummary(server, managed, books?.servers) : null,
    });
  }

  const state = groupState(group, run, picked, members, servers);
  const phase = strOf(run["phase"]) || "pending";
  return {
    id: group["id"],
    name: group["name"] || "",
    enabled: boolOf(group["enabled"]),
    failover_enabled: boolOf(group["failover_enabled"]),
    cycle: strOf(group["cycle"]) || "day",
    ddns_record: (books?.groups?.[numOf(group["id"])] ?? []).join("、"),
    anchor_at: group["anchor_at"] || 0,
    cycle_hours:
      Math.round(
        members.reduce((sum, m) => sum + numOf(m["hours"]), 0) * 100,
      ) / 100,
    members: memberPayload,
    duty_server_id: dutyId,
    shift_started_at: shiftStart,
    next_switch_at: nxt ? Math.floor(nxt) : 0,
    phase,
    phase_label: PHASE_LABELS[phase] ?? "待执行",
    state,
    state_label: GROUP_STATES[state] ?? "状态未知",
    note: run["note"] || "",
    updated_at: run["updated_at"] || 0,
    current_index: await currentMemberIndex(env, shiftGroup, nowTs, tzName),
  };
}

function managedMap(
  groups: RepoGroup[],
  keepalives: KeepaliveView[],
): Map<number, AnyRow> {
  // Group membership wins over single keepalive, same as Python.
  const managed = new Map<number, AnyRow>();
  for (const group of groups) {
    for (const member of group.members ?? []) {
      if (!member["enabled"]) continue;
      managed.set(numOf(member["server_id"]), {
        kind: "group",
        group_id: numOf(group["id"]),
        name: group["name"] || "",
        active: boolOf(group["enabled"]),
      });
    }
  }
  for (const item of keepalives) {
    const serverId = numOf(item["server_id"]);
    if (managed.has(serverId)) continue;
    managed.set(serverId, {
      kind: "keepalive",
      keepalive_id: numOf(item["id"]),
      name: item["label"] || "",
      active: boolOf(item["enabled"]),
    });
  }
  return managed;
}

// ---------------------------------------------------------------------------
// Validation helpers (ported from api.py)
// ---------------------------------------------------------------------------

async function validateTimetableCoverage(env: Env, members: AnyRow[]): Promise<void> {
  const spans: Array<[number, number]> = [];
  for (const member of members) {
    const start = hhmmToMinutes(member["start_time"]);
    const end = hhmmToMinutes(member["end_time"]);
    if (start < 0 || end < 0) return; // malformed format: repo.upsertGroup reports it
    spans.push([start, end]);
  }
  const labels = await memberLabels(env, members);
  const texts = members.map((m) => [
    labels.get(numOf(m["server_id"])) ?? "",
    strOf(m["start_time"]),
    strOf(m["end_time"]),
  ]);
  const textOf = (i: number): [string, string, string] => {
    const t = texts[i];
    return [t?.[0] ?? "", t?.[1] ?? "", t?.[2] ?? ""];
  };

  const owner = new Array<number>(1440).fill(-1);
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    if (!span) continue;
    const [start, end] = span;
    const t = textOf(index);
    if (start === end) {
      throw invalid(`「${t[0]}」的起止时刻不能相同`);
    }
    if (end < start && end !== 0) {
      throw invalid(
        `「${t[0]}」${t[1]}–${t[2]} 的结束时刻早于开始时刻；排班按一天 0–24 点分，到午夜请把结束填成 24:00`,
      );
    }
    const ranges: Array<[number, number]> =
      end < start ? [[start, 1440], [0, end]] : [[start, end]];
    for (const [lo, hi] of ranges) {
      for (let minute = lo; minute < hi; minute++) {
        if ((owner[minute] ?? -1) >= 0) {
          const other = owner[minute] ?? -1;
          const o = textOf(other);
          throw invalid(
            `「${t[0]}」${t[1]}–${t[2]} 与「${o[0]}」${o[1]}–${o[2]} 在 ${fmtMinute(minute)} 重叠，同一时刻只能有一台当班`,
          );
        }
        owner[minute] = index;
      }
    }
  }

  let minute = 0;
  while (minute < 1440) {
    if ((owner[minute] ?? -1) >= 0) {
      minute++;
      continue;
    }
    const begin = minute;
    while (minute < 1440 && (owner[minute] ?? -1) < 0) minute++;
    throw invalid(
      `排班表在 ${fmtMinute(begin)}–${fmtMinute(minute)} 没有安排当班，一天 24 小时要刚好分完`,
    );
  }
}

async function validateGroupTimetable(env: Env, payload: AnyRow): Promise<void> {
  const allMembers = rowsOf(payload["members"]);
  for (const member of allMembers) {
    if (strOf(member["end_time"]).trim() === "24:00") member["end_time"] = "00:00";
  }
  const members = allMembers.filter((m) => m["enabled"] !== false);
  const filled = members.filter(
    (m) => strOf(m["start_time"]).trim() && strOf(m["end_time"]).trim(),
  );
  if (filled.length && filled.length !== members.length) {
    throw invalid("要么每台成员都填起止时刻，要么全部留空（按班次时长轮换）");
  }
  if (filled.length) await validateTimetableCoverage(env, members);
}

function keepaliveWindowParts(payload: AnyRow): [string, string, number, number] {
  const startRaw = strOf(payload["start_time"]).trim();
  const endRaw = strOf(payload["end_time"]).trim();
  if (Boolean(startRaw) !== Boolean(endRaw)) {
    throw invalid("运行时段的起止时刻要成对填写，或都留空（全天）");
  }
  if (startRaw) {
    if (!repo.isHhmm(startRaw) || !repo.isHhmm(endRaw)) {
      throw invalid("运行时段要用 HH:MM 格式，例如 08:00");
    }
    let startMin = Number(startRaw.slice(0, 2)) * 60 + Number(startRaw.slice(3));
    let endMin = Number(endRaw.slice(0, 2)) * 60 + Number(endRaw.slice(3));
    if (endMin === 0 && startMin > 0) endMin = 24 * 60;
    if (endMin <= startMin) {
      throw invalid("运行时段的结束时刻必须晚于开始时刻（不支持跨零点；结束填 00:00 表示到 24:00）");
    }
  }
  let startDay: number;
  let endDay: number;
  try {
    startDay = Number(payload["start_day"] ?? 0);
    endDay = Number(payload["end_day"] ?? 0);
    if (!Number.isInteger(startDay) || !Number.isInteger(endDay)) throw new Error("nan");
  } catch {
    throw invalid("运行日期必须是 1–31 的数字");
  }
  if (Boolean(startDay) !== Boolean(endDay)) {
    throw invalid("运行日期的起止日要成对填写，或都留空（全月）");
  }
  if (startDay) {
    if (!(startDay >= 1 && startDay <= 31 && endDay >= 1 && endDay <= 31)) {
      throw invalid("运行日期必须在 1–31 之间");
    }
    if (endDay < startDay) {
      throw invalid("运行日期的结束日不能早于开始日（不支持跨月）");
    }
  }
  return [startRaw, endRaw, startDay, endDay];
}

/** Draft settings form → config dict, for the "test connection" endpoints. */
async function configFromDraft(env: Env, payload: AnyRow): Promise<Record<string, string>> {
  const saved = await repo.getSettings(env);
  const cfg: Record<string, string> = { ...saved };
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) cfg[key] = String(value);
  };
  const putBool = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) cfg[key] = value ? "1" : "0";
  };

  put("timezone", payload["timezone"]);
  put("traffic_threshold_pct", payload["traffic_threshold_pct"]);
  put("reconcile_interval", payload["reconcile_interval"]);
  putBool("billing_enabled", payload["billing_enabled"]);
  putBool("daily_report_enabled", payload["daily_report_enabled"]);
  put("daily_report_time", payload["daily_report_time"]);
  for (const key of [
    "notify_on_shift",
    "notify_on_failover",
    "notify_on_recovery",
    "notify_on_breaker",
    "notify_on_limit_stop",
    "notify_on_error",
    "notify_on_keepalive",
    "notify_on_power",
  ]) {
    putBool(key, payload[key]);
  }

  const ddnsPayload = rowOf(payload["ddns"]);
  if (Object.keys(ddnsPayload).length) {
    putBool("ddns_enabled", ddnsPayload["enabled"]);
    put("ddns_cf_auth_mode", ddnsPayload["cf_auth_mode"]);
    put("ddns_cf_email", ddnsPayload["cf_email"]);
    put("ddns_zone_id", ddnsPayload["zone_id"]);
    put("ddns_ttl", ddnsPayload["ttl"]);
    putBool("ddns_proxied", ddnsPayload["proxied"]);
    if (ddnsPayload["cf_token"]) cfg["ddns_cf_token"] = String(ddnsPayload["cf_token"]);
    if (ddnsPayload["cf_key"]) cfg["ddns_cf_key"] = String(ddnsPayload["cf_key"]);
  }

  const tg = rowOf(payload["telegram"]);
  if (Object.keys(tg).length) {
    putBool("notify_tg_enabled", tg["enabled"]);
    put("notify_tg_chat_id", tg["chat_id"]);
    put("notify_tg_proxy", tg["proxy"]);
    if (tg["token"]) cfg["notify_tg_token"] = String(tg["token"]);
  }

  const mail = rowOf(payload["email"]);
  if (Object.keys(mail).length) {
    putBool("notify_mail_enabled", mail["enabled"]);
    put("notify_mail_host", mail["host"]);
    put("notify_mail_port", mail["port"]);
    put("notify_mail_security", mail["security"]);
    put("notify_mail_username", mail["username"]);
    put("notify_mail_to", mail["to"]);
    if (mail["password"]) cfg["notify_mail_password"] = String(mail["password"]);
  }

  const wh = rowOf(payload["webhook"]);
  if (Object.keys(wh).length) {
    putBool("notify_wh_enabled", wh["enabled"]);
    put("notify_wh_url", wh["url"]);
    put("notify_wh_method", wh["method"]);
    put("notify_wh_body", wh["body"]);
    if (wh["headers"]) cfg["notify_wh_headers"] = String(wh["headers"]);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// App + routes
// ---------------------------------------------------------------------------

export const app = new Hono<Bindings>();

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return new Response(
      JSON.stringify({ ok: false, code: err.code, message: err.message }),
      { status: err.status, headers: { "Content-Type": "application/json" } },
    );
  }
  console.error("unhandled API error", err);
  return c.json(
    { ok: false, code: "internal_error", message: "服务器内部错误，请查看日志" },
    500,
  );
});

app.notFound((c) => c.json({ ok: false, code: "not_found", message: "接口不存在" }, 404));

// -- System ---------------------------------------------------------------

app.get("/api/health", (c) => c.json({ status: "ok", version: VERSION }));

app.get("/api/v1/system/init-status", async (c) => {
  return c.json({
    initialized: await isInitialized(c.env),
    brand: BRAND,
    version: VERSION,
    repo: REPO,
  });
});

app.post("/api/v1/setup", async (c) => {
  if (await isInitialized(c.env)) {
    throw httpErr(409, "conflict", "系统已初始化");
  }
  const payload = await jsonBody(c);
  const username = strOf(payload["username"]).trim();
  const password = strOf(payload["password"]);
  if (username.length < 3) throw invalid("用户名至少 3 个字符");
  if (password.length < 10) throw invalid("密码至少 10 个字符");
  await repo.setSettings(c.env, {
    admin_username: username,
    admin_password: await security.hashPassword(password),
    initialized: "1",
  });
  await repo.addEvent(c.env, "system", messages.ev("系统初始化完成"), {
    detail: `已初始化 / 管理员 ${username}`,
  });
  await attachSession(c, username);
  return c.json({ ok: true });
});

// -- Auth -----------------------------------------------------------------

app.post("/api/v1/auth/login", async (c) => {
  const client = clientIp(c);
  if (rateLimited(client)) {
    throw httpErr(429, "rate_limited", "尝试过于频繁，请 5 分钟后再试");
  }
  const payload = await jsonBody(c);
  const username = strOf(payload["username"]).trim();
  const password = strOf(payload["password"]);
  const storedUser = await repo.getSetting(c.env, "admin_username");
  const storedHash = await repo.getSetting(c.env, "admin_password");
  if (username !== storedUser || !(await security.verifyPassword(password, storedHash ?? ""))) {
    recordFailure(client);
    throw httpErr(401, "unauthorized", "用户名或密码不正确");
  }
  resetFailures(client);
  await attachSession(c, username);
  return c.json({ ok: true, username });
});

app.post("/api/v1/auth/logout", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const token = getCookie(c, SESSION_COOKIE) ?? "";
  await repo.revokeSession(
    c.env,
    await security.sessionId(token),
    Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  );
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/v1/auth/me", async (c) => {
  const user = await requireAdmin(c);
  return c.json({ username: user });
});

// -- Overview ---------------------------------------------------------------

app.get("/api/v1/overview", async (c) => {
  await requireAdmin(c);
  const env = c.env;
  const config = await repo.getSettings(env);
  const tzName = config["timezone"] || "Asia/Shanghai";
  const now = tzNow(tzName);
  const channels = notify.enabledChannels(env, config);
  const keepalives = await repo.listKeepalives(env);
  const groups = await repo.listGroups(env);
  const servers = await repo.listServers(env);
  const managed = managedMap(groups, keepalives);
  const books = await dns.recordBooks(env);
  const cards = await dns.booksForCards(env, now.epoch, books);
  const nowDate = new Date(now.epoch * 1000);

  return c.json({
    now: now.iso,
    now_ts: now.epoch,
    now_label: now.label,
    today: now.dateStr,
    month_days: now.monthDays,
    timezone: config["timezone"],
    version: VERSION,
    brand: BRAND,
    repo: REPO,
    servers: servers.map((s) => serverSummary(s, managed, cards)),
    keepalives: keepalives.map((item) => ({
      ...item,
      in_window: keepaliveWindow(item as unknown as Keepalive, nowDate, tzName),
      dns_record: (books.servers[numOf(item["server_id"])] ?? []).join("、"),
    })),
    groups: await Promise.all(
      groups.map((g) => groupPayload(env, g, config, now.epoch, managed, books)),
    ),
    dns: await dns.snapshot(env, config, now.epoch),
    notifications: {
      channels,
      telegram: channels.includes("telegram"),
      email: channels.includes("email"),
      webhook: channels.includes("webhook"),
    },
    events: await repo.listEvents(env, 20, "", ""),
  });
});

app.post("/api/v1/reconcile", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  // SIMPLIFIED: shift.reconcileAll() returns void — the TS engine drops
  // Python's lock/None protocol, so there is no per-item `results` list
  // and no `busy` flag. The round still runs exactly once per call.
  await reconcileAll(c.env);
  // Manual reconcile also sweeps DNS, same as Python.
  return c.json({
    results: [],
    busy: false,
    dns: await dns.reconcile(c.env, await repo.getSettings(c.env)),
  });
});

// -- Servers ----------------------------------------------------------------

app.get("/api/v1/servers", async (c) => {
  await requireAdmin(c);
  const managed = managedMap(
    await repo.listGroups(c.env),
    await repo.listKeepalives(c.env),
  );
  const cards = await dns.booksForCards(c.env);
  return c.json({
    items: (await repo.listServers(c.env)).map((s) =>
      serverSummary(s, managed, cards),
    ),
  });
});

app.post("/api/v1/servers", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  return c.json({ id: await repo.upsertServer(c.env, payload) });
});

app.post("/api/v1/servers/reorder", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const ids = payload["ids"];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpErr(400, "invalid_request", "ids 必须是非空的有序数组");
  }
  let ordered: number[];
  try {
    ordered = ids.map((i) => {
      const n = Number(i);
      if (!Number.isInteger(n)) throw new Error("nan");
      return n;
    });
  } catch {
    throw httpErr(400, "invalid_request", "ids 里的元素必须是数字");
  }
  await repo.reorderServers(c.env, ordered);
  return c.json({ ok: true });
});

app.delete("/api/v1/servers/:serverId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  await repo.deleteServer(c.env, paramInt(c, "serverId"));
  return c.json({ ok: true });
});

app.post("/api/v1/servers/:serverId/refresh", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  return c.json(await refreshServer(c.env, paramInt(c, "serverId")));
});

app.post("/api/v1/servers/:serverId/billing", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const snapshot = await billing.refreshServer(c.env, paramInt(c, "serverId"), {
    force: true,
  });
  if (snapshot === null || snapshot === undefined) {
    throw httpErr(400, "invalid_request", "费用查询已关闭，或服务器不存在");
  }
  const snap = rowOf(snapshot);
  if (snap["error"] && snap["monthly_cost"] == null) {
    throw httpErr(502, "bad_gateway", strOf(snap["error"]));
  }
  return c.json(snap);
});

app.post("/api/v1/servers/:serverId/actions/:action", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  return c.json(
    await manualAction(c.env, paramInt(c, "serverId"), c.req.param("action")),
  );
});

app.get("/api/v1/servers/:serverId/samples", async (c) => {
  await requireAdmin(c);
  const hoursRaw = Number(c.req.query("hours") ?? 72);
  const hours = Math.max(1, Math.min(Number.isFinite(hoursRaw) ? hoursRaw : 72, 720));
  return c.json({
    items: await repo.listSamples(c.env, paramInt(c, "serverId"), hours),
  });
});

// -- Single keepalive ---------------------------------------------------------

app.get("/api/v1/keepalives", async (c) => {
  await requireAdmin(c);
  const config = await repo.getSettings(c.env);
  const tzName = config["timezone"] || "Asia/Shanghai";
  const now = tzNow(tzName);
  const nowDate = new Date(now.epoch * 1000);
  const items = await repo.listKeepalives(c.env);
  return c.json({
    items: items.map((item) => ({
      ...item,
      in_window: keepaliveWindow(item as unknown as Keepalive, nowDate, tzName),
    })),
  });
});

app.post("/api/v1/keepalives", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const serverId = numOf(payload["server_id"]);
  if (!serverId) throw invalid("请选择服务器");
  const [startTime, endTime, startDay, endDay] = keepaliveWindowParts(payload);
  return c.json({
    id: await repo.addKeepalive(
      c.env,
      serverId,
      payload["enabled"] !== false,
      { startTime, endTime, startDay, endDay },
    ),
  });
});

app.post("/api/v1/keepalives/:keepaliveId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const keepaliveId = paramInt(c, "keepaliveId");
  const payload = await jsonBody(c);
  if ((await repo.getKeepalive(c.env, keepaliveId)) === null) {
    throw invalid("保活任务不存在");
  }
  const [startTime, endTime, startDay, endDay] = keepaliveWindowParts(payload);
  await repo.updateKeepalive(c.env, keepaliveId, {
    enabled: payload["enabled"] !== false,
    startTime,
    endTime,
    startDay,
    endDay,
  });
  // Deliberately do NOT clear keepalive_rest here: the next reconcile round
  // treats the window change as a quiet window-resume instead of a
  // preemption recovery (see Python comment in api.py).
  const item = rowOf(await repo.getKeepalive(c.env, keepaliveId));
  const serverId = numOf(item["server_id"]);
  if (serverId) {
    await repo.setFlag(c.env, `keepalive_resume_pending:${serverId}`);
  }
  return c.json({ ok: true });
});

app.post("/api/v1/keepalives/:keepaliveId/toggle", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  await repo.setKeepaliveEnabled(
    c.env,
    paramInt(c, "keepaliveId"),
    payload["enabled"] !== false,
  );
  return c.json({ ok: true });
});

app.delete("/api/v1/keepalives/:keepaliveId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  await repo.deleteKeepalive(c.env, paramInt(c, "keepaliveId"));
  return c.json({ ok: true });
});

// -- Shift groups -------------------------------------------------------------

app.get("/api/v1/groups", async (c) => {
  await requireAdmin(c);
  const config = await repo.getSettings(c.env);
  const nowTs = tzNow(config["timezone"] || "Asia/Shanghai").epoch;
  const books = await dns.recordBooks(c.env);
  return c.json({
    items: await Promise.all(
      (await repo.listGroups(c.env)).map((g) =>
        groupPayload(c.env, g, config, nowTs, undefined, books),
      ),
    ),
  });
});

app.post("/api/v1/groups", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  if (strOf(payload["cycle"] || "day") !== "month") {
    await validateGroupTimetable(c.env, payload);
  }
  const isNew = !numOf(payload["id"]);
  const groupId = await repo.upsertGroup(c.env, payload);
  if (!isNew) return c.json({ id: groupId });
  // New group: immediately settle members into their scheduled positions.
  // Failure does not roll back the saved group, only the reason is returned.
  let result: unknown;
  try {
    result = await bootstrapGroup(c.env, groupId);
  } catch (e) {
    console.error("bootstrap group failed", e);
    result = { error: e instanceof Error ? e.message : String(e) };
  }
  return c.json({ id: groupId, bootstrap: result });
});

app.delete("/api/v1/groups/:groupId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const groupId = paramInt(c, "groupId");
  if ((await repo.getGroup(c.env, groupId)) === null) {
    throw httpErr(404, "not_found", "换班组不存在");
  }
  // Dissolving only deletes config: members keep their current state.
  return c.json(await dissolveGroup(c.env, groupId));
});

app.post("/api/v1/groups/:groupId/switch", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  return c.json({ result: await manualSwitch(c.env, paramInt(c, "groupId")) });
});

// -- DNS ----------------------------------------------------------------------

app.get("/api/v1/dns", async (c) => {
  await requireAdmin(c);
  return c.json(await dns.snapshot(c.env, await repo.getSettings(c.env)));
});

app.post("/api/v1/dns/reorder", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const records = payload["records"];
  if (!Array.isArray(records) || records.length === 0) {
    throw httpErr(400, "invalid_request", "records 必须是非空的有序数组");
  }
  if (!records.every((item) => typeof item === "string")) {
    throw httpErr(400, "invalid_request", "records 里的元素必须是记录名");
  }
  await repo.reorderDnsRecords(c.env, records as string[]);
  return c.json({ ok: true });
});

app.post("/api/v1/dns/records", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const name = await dns.addRecord(c.env, strOf(payload["record"]), await repo.getSettings(c.env));
  await repo.addEvent(c.env, "dns", messages.ev("DNS 记录已添加", messages.objServer(name)), {
    detail: `已添加 / ${name}`,
  });
  return c.json({ record: name });
});

app.delete("/api/v1/dns/records/:record", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const record = c.req.param("record");
  const row = await repo.getDnsRecord(c.env, record);
  if (row === null || row === undefined) {
    throw httpErr(404, "not_found", "记录不存在");
  }
  await dns.removeRecord(c.env, record, await repo.getSettings(c.env));
  const hadTarget = Boolean(rowOf(row)["target_kind"]);
  await repo.addEvent(c.env, "dns", messages.ev("DNS 记录已删除", messages.objServer(record)), {
    detail: hadTarget
      ? `已删除 / ${record}（绑定已一并解除）`
      : `已删除 / ${record}`,
  });
  return c.json({ ok: true });
});

app.post("/api/v1/dns/records/:record/bind", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const record = c.req.param("record");
  const payload = await jsonBody(c);
  const kind = strOf(payload["kind"]);
  const targetId = numOf(payload["id"]);
  if (kind && !targetId) throw invalid("请选择绑定目标");
  const config = await repo.getSettings(c.env);
  await dns.syncRegistry(c.env, config);
  // Bind then sync immediately: the user should not wait a reconcile round.
  return c.json(await dns.bind(c.env, record, kind, targetId, config));
});

app.post("/api/v1/dns/records/:record/sync", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const record = c.req.param("record");
  const config = await repo.getSettings(c.env);
  if (config["ddns_enabled"] !== "1") {
    throw httpErr(400, "invalid_request", "DDNS 未启用，请先在设置里打开");
  }
  const result = await dns.syncRecord(c.env, record, config, { force: true });
  return c.json({
    record,
    status: result.status,
    detail: result.detail,
    ip: result.ip,
  });
});

app.post("/api/v1/dns/sync", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const config = await repo.getSettings(c.env);
  if (config["ddns_enabled"] !== "1") {
    throw httpErr(400, "invalid_request", "DDNS 未启用，请先在设置里打开");
  }
  return c.json({ items: await dns.reconcile(c.env, config, true) });
});

// -- Settings -----------------------------------------------------------------

app.get("/api/v1/settings", async (c) => {
  await requireAdmin(c);
  const config = await repo.getSettings(c.env);
  return c.json({
    admin_username: config["admin_username"] || "",
    timezone: config["timezone"],
    traffic_threshold_pct: config["traffic_threshold_pct"],
    reconcile_interval: config["reconcile_interval"],
    reconcile_offset: config["reconcile_offset"] || "0",
    billing_enabled: (config["billing_enabled"] ?? "1") === "1",
    billing_interval: config["billing_interval"] || "600",
    daily_report_enabled: config["daily_report_enabled"] === "1",
    daily_report_time: config["daily_report_time"],
    notify_on_shift: config["notify_on_shift"] === "1",
    notify_on_failover: config["notify_on_failover"] === "1",
    notify_on_recovery: config["notify_on_recovery"] === "1",
    notify_on_breaker: config["notify_on_breaker"] === "1",
    notify_on_limit_stop: config["notify_on_limit_stop"] === "1",
    notify_on_error: config["notify_on_error"] === "1",
    notify_on_keepalive: config["notify_on_keepalive"] === "1",
    notify_on_power: (config["notify_on_power"] ?? "1") === "1",
    ddns: {
      enabled: config["ddns_enabled"] === "1",
      provider: config["ddns_provider"] || "cloudflare",
      cf_auth_mode: config["ddns_cf_auth_mode"] || "token",
      cf_token_configured: Boolean(config["ddns_cf_token"]),
      cf_email: config["ddns_cf_email"] || "",
      cf_key_configured: Boolean(config["ddns_cf_key"]),
      zone_id: config["ddns_zone_id"] || "",
      record: ddns.defaultRecord(config),
      records: ddns.records(config),
      ttl: config["ddns_ttl"],
      proxied: config["ddns_proxied"] === "1",
      last_ip: config["ddns_last_ip"] || "",
      last_status: config["ddns_last_status"] || "",
    },
    telegram: {
      enabled: config["notify_tg_enabled"] === "1",
      token_configured: Boolean(config["notify_tg_token"]),
      chat_id: config["notify_tg_chat_id"] || "",
      proxy: config["notify_tg_proxy"] || "",
    },
    email: {
      enabled: config["notify_mail_enabled"] === "1",
      host: config["notify_mail_host"] || "",
      port: config["notify_mail_port"],
      security: config["notify_mail_security"] || "ssl",
      username: config["notify_mail_username"] || "",
      password_configured: Boolean(config["notify_mail_password"]),
      to: config["notify_mail_to"] || "",
    },
    webhook: {
      enabled: config["notify_wh_enabled"] === "1",
      url: config["notify_wh_url"] || "",
      method: config["notify_wh_method"] || "POST",
      headers_configured: Boolean(config["notify_wh_headers"]),
      body: config["notify_wh_body"] || "",
    },
    channels: notify.enabledChannels(c.env, config),
    sdk_ready: await aliyun.sdkReady(c.env),
    dry_run: c.env.CDT_DRY_RUN === "1",
    repo: REPO,
    upstream_repo: UPSTREAM_REPO,
    version: VERSION,
  });
});

app.post("/api/v1/settings", async (c) => {
  const user = await requireAdmin(c);
  requireCsrf(c);
  const env = c.env;
  const payload = await jsonBody(c);
  const updates: Record<string, string> = {};

  const putStr = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) updates[key] = String(value);
  };
  const putBool = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) updates[key] = value ? "1" : "0";
  };

  putStr("timezone", payload["timezone"]);
  if (payload["traffic_threshold_pct"] !== null && payload["traffic_threshold_pct"] !== undefined) {
    const percent = asInt(payload["traffic_threshold_pct"], "流量阈值百分比");
    if (percent < 50 || percent > 100) throw invalid("流量阈值百分比应在 50–100 之间");
    updates["traffic_threshold_pct"] = String(percent);
  }
  if (payload["reconcile_interval"] !== null && payload["reconcile_interval"] !== undefined) {
    const interval = asInt(payload["reconcile_interval"], "同步间隔");
    if (interval < 30 || interval > 3600) throw invalid("同步间隔应在 30–3600 秒之间");
    updates["reconcile_interval"] = String(interval);
  }
  if (payload["reconcile_offset"] !== null && payload["reconcile_offset"] !== undefined) {
    const offset = asInt(payload["reconcile_offset"], "巡检起始秒");
    if (offset < 0 || offset > 59) throw invalid("巡检起始秒应在 0–59 之间");
    updates["reconcile_offset"] = String(offset);
  }

  putBool("billing_enabled", payload["billing_enabled"]);
  if (payload["billing_interval"] !== null && payload["billing_interval"] !== undefined) {
    const interval = asInt(payload["billing_interval"], "费用查询间隔");
    if (interval < 60 || interval > 86400) throw invalid("费用查询间隔应在 60–86400 秒之间");
    updates["billing_interval"] = String(interval);
  }

  putBool("daily_report_enabled", payload["daily_report_enabled"]);
  const reportTime = payload["daily_report_time"];
  if (reportTime !== null && reportTime !== undefined) {
    const text = String(reportTime).trim();
    if (text) {
      if (!repo.isHhmm(text)) throw invalid("日报时间格式应为 HH:MM（00:00–23:59）");
      const [h, m] = text.split(":").map(Number);
      updates["daily_report_time"] = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    } else {
      updates["daily_report_time"] = text;
    }
  }
  for (const key of [
    "notify_on_shift",
    "notify_on_failover",
    "notify_on_recovery",
    "notify_on_breaker",
    "notify_on_limit_stop",
    "notify_on_error",
    "notify_on_keepalive",
    "notify_on_power",
  ]) {
    putBool(key, payload[key]);
  }

  const ddnsPayload = rowOf(payload["ddns"]);
  if (Object.keys(ddnsPayload).length) {
    putBool("ddns_enabled", ddnsPayload["enabled"]);
    putStr("ddns_provider", ddnsPayload["provider"]);
    putStr("ddns_cf_auth_mode", ddnsPayload["cf_auth_mode"]);
    putStr("ddns_cf_email", ddnsPayload["cf_email"]);
    putStr("ddns_zone_id", ddnsPayload["zone_id"]);
    const recordsPayload = ddnsPayload["records"];
    if (recordsPayload !== null && recordsPayload !== undefined) {
      if (!Array.isArray(recordsPayload)) throw invalid("DDNS 记录名需要是列表");
      const cleaned: string[] = [];
      const seen = new Set<string>();
      for (const item of recordsPayload) {
        const name = String(item ?? "").trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        if (!ddns.isValidRecord(name)) {
          throw invalid(`DDNS 记录名要是完整域名（至少一层点、不带空格）：${name}`);
        }
        seen.add(name.toLowerCase());
        cleaned.push(name);
      }
      updates["ddns_records"] = JSON.stringify(cleaned);
      updates["ddns_record"] = cleaned[0] ?? "";
    } else {
      putStr("ddns_record", ddnsPayload["record"]);
    }
    putStr("ddns_ttl", ddnsPayload["ttl"]);
    putBool("ddns_proxied", ddnsPayload["proxied"]);
    if (ddnsPayload["cf_token"]) updates["ddns_cf_token"] = String(ddnsPayload["cf_token"]);
    if (ddnsPayload["cf_key"]) updates["ddns_cf_key"] = String(ddnsPayload["cf_key"]);
  }

  const tg = rowOf(payload["telegram"]);
  if (Object.keys(tg).length) {
    putBool("notify_tg_enabled", tg["enabled"]);
    putStr("notify_tg_chat_id", tg["chat_id"]);
    putStr("notify_tg_proxy", tg["proxy"]);
    if (tg["token"]) updates["notify_tg_token"] = String(tg["token"]);
  }

  const mail = rowOf(payload["email"]);
  if (Object.keys(mail).length) {
    putBool("notify_mail_enabled", mail["enabled"]);
    putStr("notify_mail_host", mail["host"]);
    putStr("notify_mail_port", mail["port"]);
    putStr("notify_mail_security", mail["security"]);
    putStr("notify_mail_username", mail["username"]);
    putStr("notify_mail_to", mail["to"]);
    if (mail["password"]) updates["notify_mail_password"] = String(mail["password"]);
  }

  const wh = rowOf(payload["webhook"]);
  if (Object.keys(wh).length) {
    putBool("notify_wh_enabled", wh["enabled"]);
    putStr("notify_wh_url", wh["url"]);
    putStr("notify_wh_method", wh["method"]);
    putStr("notify_wh_body", wh["body"]);
    if (wh["headers"]) updates["notify_wh_headers"] = String(wh["headers"]);
  }

  let bumpedEpoch: number | null = null;
  let newSessionUser: string | null = null;
  const newUsername = strOf(payload["new_username"]).trim();
  const newPassword = payload["new_password"];

  // Changing username/password invalidates every old session ticket.
  if (newUsername) {
    if (newUsername.length < 3) throw invalid("用户名至少 3 个字符");
    if (newUsername !== (await repo.getSetting(env, "admin_username"))) {
      updates["admin_username"] = newUsername;
      bumpedEpoch = Math.floor(Date.now() / 1000);
      updates["session_epoch"] = String(bumpedEpoch);
      newSessionUser = newUsername;
    }
  }
  if (newPassword !== null && newPassword !== undefined && newPassword !== "") {
    if (String(newPassword).length < 10) throw invalid("新密码至少 10 个字符");
    updates["admin_password"] = await security.hashPassword(String(newPassword));
    bumpedEpoch = Math.floor(Date.now() / 1000);
    updates["session_epoch"] = String(bumpedEpoch);
  }

  if (Object.keys(updates).length) {
    const before = await repo.getSettings(env);
    const changed = Object.entries(updates)
      .filter(([key, value]) => String(before[key] ?? "") !== String(value))
      .map(([key]) => key)
      .filter((key) => !SETTING_LABELS_SKIP.has(key));
    await repo.setSettings(env, updates);
    if ("ddns_records" in updates) {
      await dns.syncRegistry(env, await repo.getSettings(env));
    }
    if (changed.length) {
      await repo.addEvent(env, "system", messages.ev("配置已更新"), {
        detail: `已保存 / ${settingLabels(changed)}`,
      });
    }
  }

  if (bumpedEpoch !== null) {
    await attachSession(c, newSessionUser ?? user, bumpedEpoch);
    return c.json({ ok: true, username: newSessionUser ?? user });
  }
  return c.json({ ok: true });
});

// -- Channel test ---------------------------------------------------------------

app.post("/api/v1/settings/test/:channel", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const channel = c.req.param("channel");
  const payload = await jsonBody(c);
  // Test with the draft values from the form, not the saved config.
  const config = await configFromDraft(c.env, payload);
  if (channel === "ddns") {
    const result = rowOf(await ddns.test(c.env, config));
    return c.json({
      ok: strOf(result["status"]).startsWith("✅"),
      status: result["status"],
      detail: notify.safeError(strOf(result["detail"]), config),
    });
  }
  if (channel !== "telegram" && channel !== "email" && channel !== "webhook") {
    throw invalid("未知渠道");
  }
  const nowLabel = tzNow(config["timezone"] || "Asia/Shanghai").iso.replace("T", " ");
  const message: notify.Message = {
    kind: "test",
    title: "通知通道测试",
    titleHtml: `✅ <b>${BRAND} 通知测试</b>\n\n配置工作正常。\n⏰ ${nowLabel}`,
    body: `✅ <b>${BRAND} 通知测试</b><br><br>配置工作正常。<br>⏰ ${nowLabel}`,
    text: "通知通道测试：配置工作正常。",
  };
  try {
    await notify.send(
      c.env,
      config,
      channel,
      await notify.withTrafficFooter(c.env, config, message),
    );
  } catch (e) {
    return c.json({
      ok: false,
      detail: notify.safeError(e instanceof Error ? e.message : String(e), config),
    });
  }
  return c.json({ ok: true, detail: "已发送" });
});

// -- Events ---------------------------------------------------------------------

app.get("/api/v1/events", async (c) => {
  await requireAdmin(c);
  const limitRaw = Number(c.req.query("limit") ?? 100);
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 100, 500));
  return c.json({
    items: await repo.listEvents(
      c.env,
      limit,
      c.req.query("kind") ?? "",
      c.req.query("level") ?? "",
    ),
  });
});

export default app;
