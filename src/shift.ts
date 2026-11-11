/**
 * Shift engine — faithful port of `app/shift.py` (BeacherZ/cdt-management).
 *
 * Covers: single-instance keepalive (windowed, start-if-stopped), joint
 * shift rotation (day cycle by hours and by fixed timetable; month cycle by
 * days from the 1st), handover order (start duty first, confirm Running,
 * only then stop standby), traffic thresholds with failover
 * (DUTY_START_TRIES failed starts -> failover) and global circuit-break
 * (all members over threshold -> stop all), spot-preemption recovery, and
 * the `shift_runs` phase/stage state machine persisted in D1.
 *
 * One reconcile step per call, idempotent: the same start/stop is never
 * issued twice without re-reading instance state first (every reconcile
 * re-reads all members via `refreshServerState` before deciding).
 *
 * All timestamps are Unix seconds. Display timezone is Asia/Shanghai by
 * default (from settings `timezone`); stored values are UTC epoch seconds.
 *
 * NOTE on async shape: the Python source is synchronous (SQLite + SDK).
 * Every repo / aliyun / notify / dns call here is async (D1 + fetch), so
 * all engine functions are `async` and every such call is awaited — except
 * the pure rotation helpers (`dutyAt`, `nextSwitchAt`, `memberSpanLabel`,
 * `activeMembers`, `keepaliveWindow`), which are synchronous by design:
 * the API layer calls them inline while rendering, without D1 access.
 * `actualDuty` is async because, like Python's `actual_duty`, it applies
 * the run-row override (failover / manual switch) read from D1 on top of
 * the clock; the sync clock-only answer is `dutyAt`.
 *
 * SIMPLIFIED notes are inline where a branch could not be ported 1:1.
 */
import type { Env } from "./env";
import * as repo from "./repo";
import * as aliyun from "./aliyun";
import * as messages from "./messages";
import * as notify from "./notify";
import * as dns from "./dns";
import { execute } from "./db";
import { resolveSettings } from "./settings";
import type {
  DnsRecord,
  EventRecord,
  KeepaliveView,
  Row,
  ServerView,
  ShiftGroup,
  ShiftMember,
  ShiftRun,
} from "./repo";
import type { Message } from "./notify";
import type { ServerInfo } from "./messages";
import type { DDNSReport } from "./dns";

// Row types re-exported for the API layer (it imports these from here).
export type { ServerView as Server };
export type { ShiftGroup, ShiftMember as Member, ShiftRun };
export type { KeepaliveView as Keepalive };

/** Inputs accepted by the pure helpers: a typed repo row or a plain row. */
export type GroupLike = ShiftGroup | Row;
export type MemberLike = ShiftMember | Row;

export type Config = Record<string, string>;

export interface ReconcileResult {
  group_id?: number;
  keepalive?: number;
  idle?: number;
  slot?: string;
  duty?: string;
  mode?: string;
  ready?: boolean;
  stage?: string;
  breaker?: boolean;
  limit_stop?: boolean;
  over_limit?: boolean;
  resting?: boolean;
  skipped?: string;
  state_unreadable?: string;
  error?: string;
  label?: string;
  status?: string;
  traffic?: number | null;
  ddns?: string;
  event_id?: number;
  ok?: boolean;
  servers?: number;
  duplicate?: boolean;
  target_status?: string;
  managed_note?: string;
  instance_status?: string;
  stopped_mode?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Phases / constants (mirrors app/shift.py)
// ---------------------------------------------------------------------------

export const PHASE_PENDING = "pending";
export const PHASE_SWITCHING = "switching";
export const PHASE_SETTLED = "settled";
export const PHASE_FAILOVER = "failover";
export const PHASE_MANUAL = "manual";
export const PHASE_BREAKER = "breaker";
export const PHASE_ERROR = "error";

const SETTLED_LIKE_PHASES = new Set([
  PHASE_SETTLED,
  PHASE_FAILOVER,
  PHASE_MANUAL,
  PHASE_BREAKER,
]);

export const ORIGIN_NEW_GROUP = "new_group";

export const TRANSIENT_STATUS: ReadonlySet<string> = new Set([
  "Starting",
  "Pending",
  "Stopping",
]);

const GROUP_EVENT_KINDS = [
  "shift_done",
  "manual",
  "group_new",
  "failover",
  "shift_failover",
  "recovery",
];

// Same-instance re-issue cooldown for breaker / limit-stop commands (seconds).
const BREAKER_STOP_COOLDOWN = 120;
// Give up waiting on DDNS after this long and settle the shift anyway (seconds).
const DDNS_WAIT_SECONDS = 180;

const KEEPALIVE_RETRY_MARK = "仍未运行（";
const KEEPALIVE_MILESTONES = new Set([3, 10, 30, 100, 300, 1000, 3000]);

const READ_ERROR_ESCALATE = 3;
const READ_ERROR_MILESTONES = new Set([2, 5, 10, 30, 60]);

// Physical StoppedMode values that count as "stopped, do not re-issue stop".
const STOPPED_MODES = new Set([
  "StopCharging",
  "KeepCharging",
  "Stop",
  "Not-applicable",
]);

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

function s(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0";
  return Boolean(v);
}

/** Members of a group, typed or plain row alike. */
function membersOf(group: GroupLike): MemberLike[] {
  const m = (group as unknown as { members?: unknown }).members;
  return Array.isArray(m) ? (m as MemberLike[]) : [];
}

/** messages.ServerInfo view of a server row (structural cast). */
function info(server: ServerView): ServerInfo {
  return server as unknown as ServerInfo;
}

function infos(servers: ServerView[]): ServerInfo[] {
  return servers.map((server) => info(server));
}

/** Aliyun account view of a server row (secret decrypted by getServer). */
function account(server: ServerView): aliyun.AliyunAccount {
  return server as unknown as aliyun.AliyunAccount;
}

function emptyRun(): ShiftRun {
  return {
    group_id: 0,
    slot: "",
    phase: PHASE_PENDING,
    stage: "",
    event_id: 0,
    duty_server_id: 0,
    standby_server_ids: "",
    failover: 0,
    failover_reason: "",
    failover_from: 0,
    duty_day: "",
    manual: 0,
    origin: "",
    dns_before: "",
    attempts: 0,
    started_at: 0,
    updated_at: 0,
    note: "",
  };
}

// ---------------------------------------------------------------------------
// Timezone helpers (Intl-based; Workers has no zoneinfo/tzdata)
// ---------------------------------------------------------------------------

export interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function tzParts(tz: string, ts: number): TzParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const out: TzParts = {
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  };
  for (const part of fmt.formatToParts(new Date(ts * 1000))) {
    if (part.type === "year") out.year = Number(part.value);
    else if (part.type === "month") out.month = Number(part.value);
    else if (part.type === "day") out.day = Number(part.value);
    else if (part.type === "hour") out.hour = Number(part.value) % 24;
    else if (part.type === "minute") out.minute = Number(part.value);
    else if (part.type === "second") out.second = Number(part.value);
  }
  return out;
}

/** Offset of `tz` from UTC at `ts`, in milliseconds. */
function tzOffsetMs(tz: string, ts: number): number {
  const p = tzParts(tz, ts);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    ts * 1000
  );
}

/** Wall-clock time in `tz` -> UTC epoch seconds. */
function zonedToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = base;
  for (let i = 0; i < 3; i++) {
    guess = base - tzOffsetMs(tz, guess / 1000);
  }
  return Math.floor(guess / 1000);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function dayKey(tz: string, ts: number): string {
  const p = tzParts(tz, ts);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function monthDays(year: number, month: number): number {
  // month is 1-based; day 0 of the next month = last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function hms(ts: number, tz: string): string {
  const p = tzParts(tz, ts);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

function ymdHm(ts: number, tz: string): string {
  const p = tzParts(tz, ts);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

// ---------------------------------------------------------------------------
// Rotation math (pure; no D1 access)
// ---------------------------------------------------------------------------

function hhmmToMinutes(value: unknown): number {
  const parts = s(value).trim().split(":");
  if (parts.length !== 2) return -1;
  const hour = parseInt(parts[0] ?? "", 10);
  const minute = parseInt(parts[1] ?? "", 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return -1;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return -1;
  return hour * 60 + minute;
}

/**
 * Single-instance keepalive run window: (in window?, human summary).
 * Time-of-day and day-of-month intersect; both empty = unlimited.
 * end 00:00 means 24:00; day range is clamped to the month's length.
 * Unreadable config is treated as "unlimited" so a bad row never pins a
 * machine in the stopped state.
 */
export function keepaliveWindowDetail(
  item: KeepaliveView | Row,
  nowTs: number,
  tz: string,
): [boolean, string] {
  const startRaw = s(item.start_time).trim();
  const endRaw = s(item.end_time).trim();
  const start = startRaw ? hhmmToMinutes(startRaw) : -1;
  let end = endRaw ? hhmmToMinutes(endRaw) : -1;
  if (end === 0 && start > 0) end = 24 * 60;
  const timed = start >= 0 && end > start;

  let dayStart = parseInt(s(item.start_day ?? 0), 10) || 0;
  let dayEnd = parseInt(s(item.end_day ?? 0), 10) || 0;
  if (!Number.isInteger(dayStart) || !Number.isInteger(dayEnd)) {
    dayStart = 0;
    dayEnd = 0;
  }
  const dated = dayStart >= 1 && dayStart <= dayEnd && dayEnd <= 31;

  const parts: string[] = [];
  if (timed) {
    const endLabel = end === 24 * 60 ? "24:00" : endRaw;
    parts.push(`每天 ${startRaw}–${endLabel}`);
  }
  if (dated) parts.push(`${dayStart}–${dayEnd} 日`);
  const summary = parts.join(" · ");

  const now = tzParts(tz, nowTs);
  if (timed) {
    const minute = now.hour * 60 + now.minute;
    if (!(start <= minute && minute < end)) return [false, summary];
  }
  if (dated) {
    const days = monthDays(now.year, now.month);
    if (
      !(Math.min(dayStart, days) <= now.day && now.day <= Math.min(dayEnd, days))
    ) {
      return [false, summary];
    }
  }
  return [true, summary];
}

/** Exported by the contract: is this keepalive allowed to run right now? */
export function keepaliveWindow(
  keepalive: KeepaliveView | Row,
  now: number | Date,
  tz = "Asia/Shanghai",
): boolean {
  const nowTs =
    now instanceof Date ? Math.floor(now.getTime() / 1000) : Math.floor(now);
  return keepaliveWindowDetail(keepalive, nowTs, tz)[0];
}

function windowBracket(windowText: string): string {
  return windowText ? `（${windowText}）` : "";
}

function isTimetableGroup(group: GroupLike): boolean {
  const members = membersOf(group).filter((m) => truthy(m.enabled));
  if (members.length < 2) return false;
  return members.every(
    (m) => hhmmToMinutes(m.start_time) >= 0 && hhmmToMinutes(m.end_time) >= 0,
  );
}

function shiftStartTs(nowTs: number, tz: string, startMinutes: number): number {
  const p = tzParts(tz, nowTs);
  const start = Math.max(0, startMinutes);
  let candidate = zonedToUtc(tz, p.year, p.month, p.day, 0, 0) + start * 60;
  if (candidate > nowTs) candidate -= 86400;
  return candidate;
}

export function isMonthCycle(group: GroupLike): boolean {
  return s(group.cycle || "day") === "month";
}

export function activeMembers(group: ShiftGroup): ShiftMember[];
export function activeMembers(group: Row): Row[];
export function activeMembers(group: GroupLike): MemberLike[];
export function activeMembers(group: GroupLike): MemberLike[] {
  const month = isMonthCycle(group);
  const members = membersOf(group).filter(
    (m) =>
      truthy(m.enabled) &&
      (month ? num(m.days) > 0 : num(m.hours) > 0),
  );
  return [...members].sort((a, b) => num(a.position) - num(b.position));
}

type MonthLayoutRow = [MemberLike, number, number];

function monthLayout(
  group: GroupLike,
  year: number,
  month: number,
): MonthLayoutRow[] {
  const members = activeMembers(group);
  const daysInMonth = monthDays(year, month);
  const layout: MonthLayoutRow[] = [];
  let cursor = 1;
  for (let index = 0; index < members.length; index++) {
    const member = members[index] as MemberLike;
    const remaining = daysInMonth - cursor + 1;
    if (remaining <= 0) break;
    const span =
      index === members.length - 1
        ? remaining
        : Math.min(Math.max(Math.trunc(num(member.days)), 0), remaining);
    if (span <= 0) continue;
    layout.push([member, cursor, cursor + span - 1]);
    cursor += span;
  }
  return layout;
}

function dutyAtMonth(
  group: GroupLike,
  nowTs: number,
  tz: string,
): [MemberLike, number] | null {
  const members = activeMembers(group);
  if (members.length === 0) return null;
  const now = tzParts(tz, nowTs);
  const layout = monthLayout(group, now.year, now.month);
  const monthStart = zonedToUtc(tz, now.year, now.month, 1, 0, 0);
  for (const [member, startDay, endDay] of layout) {
    if (startDay <= now.day && now.day <= endDay) {
      return [member, monthStart + (startDay - 1) * 86400];
    }
  }
  if (layout.length === 0) return null;
  const [member, startDay] = layout[0] as MonthLayoutRow;
  return [member, monthStart + (startDay - 1) * 86400];
}

function dutyAtTimetable(
  group: GroupLike,
  nowTs: number,
  tz: string,
): [MemberLike, number] {
  const members = activeMembers(group);
  const now = tzParts(tz, nowTs);
  const minuteOfDay = now.hour * 60 + now.minute;
  for (const member of members) {
    const start = hhmmToMinutes(member.start_time);
    const end = hhmmToMinutes(member.end_time);
    if (start < 0 || end < 0) continue;
    if (end > start) {
      if (start <= minuteOfDay && minuteOfDay < end) {
        return [member, shiftStartTs(nowTs, tz, start)];
      }
    } else if (minuteOfDay >= start || minuteOfDay < end) {
      // Legacy overnight slot [start, 1440) U [0, end).
      return [member, shiftStartTs(nowTs, tz, start)];
    }
  }
  const first = members[0] as MemberLike;
  return [first, shiftStartTs(nowTs, tz, hhmmToMinutes(first.start_time))];
}

/** (duty member, this slot's start timestamp) for the clock alone. */
export function dutyAt(
  group: GroupLike,
  nowTs: number,
  tz = "Asia/Shanghai",
): [MemberLike, number] | null {
  const members = activeMembers(group);
  if (members.length < 2) return null;
  if (isMonthCycle(group)) return dutyAtMonth(group, nowTs, tz);
  if (isTimetableGroup(group)) return dutyAtTimetable(group, nowTs, tz);

  const total = members.reduce((acc, m) => acc + num(m.hours) * 3600, 0);
  const anchor = num(
    (group as ShiftGroup).anchor_at ?? (group as ShiftGroup).created_at ?? nowTs,
  );
  const elapsed = Math.max(0, nowTs - anchor);
  const cycleIndex = Math.floor(elapsed / total);
  const offset = elapsed - cycleIndex * total;

  let accumulated = 0;
  for (const member of members) {
    const span = num(member.hours) * 3600;
    if (offset < accumulated + span) {
      return [member, Math.floor(anchor + cycleIndex * total + accumulated)];
    }
    accumulated += span;
  }
  const last = members[members.length - 1] as MemberLike;
  return [
    last,
    Math.floor(anchor + cycleIndex * total + accumulated - num(last.hours) * 3600),
  ];
}

/**
 * Who is *actually* on duty right now: the clock's answer, overridden by
 * this slot's run row when a failover or manual switch is in effect.
 * Async — the override lives in D1. The sync clock-only answer is `dutyAt`.
 */
export async function actualDuty(
  env: Env,
  group: ShiftGroup,
  nowTs: number,
  tz = "Asia/Shanghai",
): Promise<[ShiftMember, number] | null> {
  const picked = dutyAt(group, nowTs, tz);
  if (picked === null) return null;
  const [member, shiftStart] = picked;
  const run = await repo.getRun(env, group.id, String(shiftStart));
  if (!run || !(run.failover || run.manual)) {
    return [member as ShiftMember, shiftStart];
  }
  const override = num(run.duty_server_id);
  if (!override) return [member as ShiftMember, shiftStart];
  for (const candidate of activeMembers(group)) {
    if (num(candidate.server_id) === override) {
      return [candidate as ShiftMember, shiftStart];
    }
  }
  return [member as ShiftMember, shiftStart];
}

export async function groupsOfServer(
  env: Env,
  serverId: number,
): Promise<number[]> {
  const groups: number[] = [];
  for (const group of await repo.listGroups(env)) {
    if (!truthy(group.enabled)) continue;
    for (const member of group.members ?? []) {
      if (truthy(member.enabled) && num(member.server_id) === serverId) {
        groups.push(group.id);
        break;
      }
    }
  }
  return groups;
}

export function nextSwitchAt(
  group: GroupLike,
  nowTs: number,
  tz = "Asia/Shanghai",
): number | null {
  const members = activeMembers(group);
  if (members.length < 2) return null;
  if (isMonthCycle(group)) return nextSwitchMonth(group, nowTs, tz);
  if (isTimetableGroup(group)) return nextSwitchTimetable(group, nowTs, tz);

  const total = members.reduce((acc, m) => acc + num(m.hours) * 3600, 0);
  const anchor = num(
    (group as ShiftGroup).anchor_at ?? (group as ShiftGroup).created_at ?? nowTs,
  );
  const elapsed = Math.max(0, nowTs - anchor);
  const cycleIndex = Math.floor(elapsed / total);
  const offset = elapsed - cycleIndex * total;
  let accumulated = 0;
  for (const member of members) {
    accumulated += num(member.hours) * 3600;
    if (offset < accumulated) {
      return anchor + cycleIndex * total + accumulated;
    }
  }
  return anchor + (cycleIndex + 1) * total;
}

function nextSwitchMonth(
  group: GroupLike,
  nowTs: number,
  tz: string,
): number {
  const now = tzParts(tz, nowTs);
  const layout = monthLayout(group, now.year, now.month);
  const monthStart = zonedToUtc(tz, now.year, now.month, 1, 0, 0);
  for (const [, startDay, endDay] of layout) {
    if (startDay <= now.day && now.day <= endDay) {
      return monthStart + endDay * 86400;
    }
  }
  return monthStart + monthDays(now.year, now.month) * 86400;
}

function nextSwitchTimetable(
  group: GroupLike,
  nowTs: number,
  tz: string,
): number {
  const members = activeMembers(group);
  const now = tzParts(tz, nowTs);
  const minuteOfDay = now.hour * 60 + now.minute;
  for (const member of members) {
    const start = hhmmToMinutes(member.start_time);
    const end = hhmmToMinutes(member.end_time);
    if (start < 0 || end < 0) continue;
    if (end > start) {
      if (start <= minuteOfDay && minuteOfDay < end) {
        return zonedToUtc(tz, now.year, now.month, now.day, 0, 0) + end * 60;
      }
    } else if (minuteOfDay >= start || minuteOfDay < end) {
      const todayStart = zonedToUtc(tz, now.year, now.month, now.day, 0, 0);
      let candidate = todayStart + end * 60;
      if (candidate <= nowTs) candidate += 86400;
      return candidate;
    }
  }
  return nowTs + 3600;
}

export async function currentMemberIndex(
  env: Env,
  group: ShiftGroup,
  nowTs: number,
  tz = "Asia/Shanghai",
): Promise<number> {
  const members = activeMembers(group);
  const picked = await actualDuty(env, group, nowTs, tz);
  if (picked === null) return -1;
  const target = num(picked[0].server_id);
  for (let i = 0; i < members.length; i++) {
    if (num((members[i] as MemberLike).server_id) === target) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Threshold / stop helpers
// ---------------------------------------------------------------------------

function overThreshold(server: ServerView): boolean {
  if (server.traffic_used === null || server.traffic_used === undefined) {
    return false;
  }
  const threshold = num(server.threshold_gb);
  return threshold > 0 && num(server.traffic_used) >= threshold;
}

function usedGb(server: ServerView): number {
  return num(server.traffic_used);
}

function isStoppedAnyMode(server: ServerView): boolean {
  if (s(server.instance_status) !== "Stopped") return false;
  return STOPPED_MODES.has(s(server.stopped_mode));
}

function allStoppedAnyMode(servers: ServerView[]): boolean {
  return servers.every((server) => isStoppedAnyMode(server));
}

export function stopModeOf(server: ServerView): string {
  return repo.normalizeStopMode(server.stop_mode);
}

/**
 * Stop by the instance's configured mode; returns the mode that actually
 * took effect (StopCharging may fall back to Stop for unsupported specs).
 */
export async function stopServerByPref(
  env: Env,
  server: ServerView,
): Promise<string> {
  if (stopModeOf(server) === "Stop") {
    return aliyun.stopInstance(env, account(server), "Stop", false);
  }
  return aliyun.stopInstance(env, account(server), "StopCharging", true);
}

function encodeIds(servers: ServerView[]): string {
  return JSON.stringify(servers.map((server) => server.id));
}

function hoursOf(group: GroupLike, server: ServerView): number {
  for (const member of membersOf(group)) {
    if (num(member.server_id) === server.id) return num(member.hours) || 12;
  }
  return 12;
}

function memberOf(group: GroupLike, serverId: number): MemberLike | null {
  for (const member of membersOf(group)) {
    if (num(member.server_id) === serverId) return member;
  }
  return null;
}

function shiftSpan(
  group: GroupLike,
  duty: ServerView,
  nowTs: number,
  tz: string,
): string {
  const member = memberOf(group, duty.id);
  const slotName = s(member?.slot_name ?? "").trim();
  if (isMonthCycle(group)) {
    const now = tzParts(tz, nowTs);
    for (const [item, startDay, endDay] of monthLayout(group, now.year, now.month)) {
      if (startDay <= now.day && now.day <= endDay) {
        const name = s(item.slot_name).trim();
        const span = `${now.month} 月 ${startDay}–${endDay} 日`;
        return name ? `${name}（${span}）` : span;
      }
    }
    return slotName;
  }
  const start = s(member?.start_time ?? "");
  const end = s(member?.end_time ?? "");
  if (slotName || start || end) {
    return messages.shiftPeriod(slotName, start, end);
  }
  const hours = num(member?.hours) || hoursOf(group, duty);
  return `${duty.label}（${hours} 小时）`;
}

export function memberSpanLabel(
  group: GroupLike,
  member: MemberLike,
  nowTs: number,
  tz = "Asia/Shanghai",
): string {
  if (isMonthCycle(group)) {
    const now = tzParts(tz, nowTs);
    const target = num(member.server_id);
    for (const [item, startDay, endDay] of monthLayout(group, now.year, now.month)) {
      if (num(item.server_id) === target) return `${startDay}–${endDay} 日`;
    }
    return "";
  }
  const start = s(member.start_time);
  const end = s(member.end_time);
  if (start && end) return messages.shiftPeriod("", start, end);
  return "";
}

// ---------------------------------------------------------------------------
// Error text / retry interval
// ---------------------------------------------------------------------------

function briefExc(exc: unknown): string {
  const text =
    exc instanceof Error
      ? aliyun.briefError(exc)
      : s(exc).trim().slice(0, 140);
  for (const sep of ["失败：", "失败:", "异常：", "异常:"]) {
    const idx = text.indexOf(sep);
    if (idx >= 0 && idx <= 12) {
      return text.slice(idx + sep.length).trim() || text;
    }
  }
  return text;
}

async function retryInterval(env: Env): Promise<number> {
  try {
    const raw = await repo.getSetting(env, "reconcile_interval", "60");
    return Math.max(30, parseInt(raw, 10) || 60);
  } catch {
    return 60;
  }
}

// ---------------------------------------------------------------------------
// Live refresh (traffic + instance state -> D1 + local row)
// ---------------------------------------------------------------------------

const BILL_TZ = "Asia/Shanghai";

function monthKey(ts: number): string {
  const p = tzParts(BILL_TZ, ts);
  return `${p.year}-${pad2(p.month)}`;
}

async function resolveEmptyTraffic(
  env: Env,
  server: ServerView,
  nowTs: number,
): Promise<number> {
  const known = num(server.traffic_used);
  const lastTs = await repo.lastSampleTs(env, server.id);
  if (known > 0 && lastTs && monthKey(lastTs) === monthKey(nowTs)) {
    const flag = `traffic_empty:${server.id}`;
    if (!(await repo.getFlag(env, flag))) {
      await repo.setFlag(env, flag);
      await repo.addEvent(env, "warning", messages.ev("流量读数异常", messages.objServer(server.label)), {
        detail: `CDT 未返回流量明细，沿用上次读数 ${known.toFixed(2)} GB 判定，不按 0 处理`,
        level: "warning",
        serverId: server.id,
      });
    }
    return known;
  }
  return 0;
}

async function refreshServerState(env: Env, server: ServerView): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const realTraffic = await aliyun.getTrafficGb(env, account(server));
  const emptyReading = realTraffic === null;
  const traffic = emptyReading
    ? await resolveEmptyTraffic(env, server, nowTs)
    : realTraffic;
  const info = await aliyun.getInstance(env, account(server));
  await repo.updateServerRuntime(env, server.id, {
    traffic,
    status: info.status,
    stoppedMode: info.stoppedMode,
    publicIp: info.publicIp,
    regionId: info.regionId,
  });
  if (!emptyReading) {
    await repo.addSample(env, server.id, traffic, info.status);
  }
  if (
    (await repo.getFlag(env, `traffic_empty:${server.id}`)) &&
    !emptyReading
  ) {
    await repo.clearFlag(env, `traffic_empty:${server.id}`);
  }
  server.traffic_used = traffic;
  server.instance_status = info.status;
  server.stopped_mode = info.stoppedMode;
  server.public_ip = info.publicIp;
  if (info.regionId) server.region_id = info.regionId;
}

// ---------------------------------------------------------------------------
// Read-error tracking (one running event per server, escalates at 3 fails)
// ---------------------------------------------------------------------------

async function readError(
  env: Env,
  opts: {
    serverId: number;
    title: string;
    exc: unknown;
    groupId?: number;
    tzName?: string;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const tzName = opts.tzName ?? "Asia/Shanghai";
  const brief = briefExc(opts.exc);
  const count = await repo.bumpFlag(env, `read_err:${opts.serverId}`);
  const interval = await retryInterval(env);
  const event = await repo.pendingEvent(env, opts.serverId, "read_error");
  if (event === null) {
    const eid = await repo.addEvent(env, "warning", opts.title, {
      detail:
        `${hms(now, tzName)} 读取失败：${brief}；` +
        `每 ${interval} 秒重试，恢复后自动更新`,
      level: "warning",
      groupId: opts.groupId ?? 0,
      serverId: opts.serverId,
      status: "running",
      pendingKind: "read_error",
    });
    await repo.addEventProgress(env, eid, `${hms(now, tzName)} 第 1 次失败：${brief}`);
    return;
  }
  const eid = event.id;
  await repo.updateEvent(env, eid, {
    detail: `${hms(now, tzName)} 仍失败（连续 ${count} 次）：${brief}；每 ${interval} 秒重试`,
  });
  if (READ_ERROR_MILESTONES.has(count) || count === READ_ERROR_ESCALATE) {
    await repo.addEventProgress(
      env,
      eid,
      `${hms(now, tzName)} 第 ${count} 次失败：${brief}`,
    );
  }
  if (count >= READ_ERROR_ESCALATE) {
    await repo.updateEvent(env, eid, { level: "error" });
  }
}

async function readRecovered(
  env: Env,
  opts: { serverId: number; title: string; tzName?: string },
): Promise<void> {
  const key = `read_err:${opts.serverId}`;
  const age = await repo.flagAge(env, key);
  if (age < 0) return;
  const count = await repo.flagValue(env, key);
  await repo.clearFlag(env, key);
  const event = await repo.pendingEvent(env, opts.serverId, "read_error");
  if (event === null) return;
  const eid = event.id;
  const now = Math.floor(Date.now() / 1000);
  const tzName = opts.tzName ?? "Asia/Shanghai";
  const minutes = Math.max(1, Math.round(age / 60));
  await repo.addEventProgress(env, eid, `${hms(now, tzName)} 已恢复`);
  await repo.updateEvent(env, eid, {
    title: opts.title,
    detail: `${hms(now, tzName)} 恢复正常（此前连续失败 ${count} 次，持续约 ${minutes} 分钟）`,
    level: "info",
  });
  await repo.finishEvent(env, eid, "done");
}

async function closeOrphanReadErrors(
  env: Env,
  monitored: Set<number>,
): Promise<void> {
  for (const event of await repo.runningPendingEvents(env, "read_error")) {
    const serverId = num(event.server_id);
    if (serverId && monitored.has(serverId)) continue;
    const eid = event.id;
    if (serverId) await repo.clearFlag(env, `read_err:${serverId}`);
    await repo.updateEvent(env, eid, { level: "info" });
    await repo.finishEvent(env, eid, "done", "对象已不在监控中，读取告警自动收尾");
  }
}

// ---------------------------------------------------------------------------
// Event close-out helpers
// ---------------------------------------------------------------------------

async function closeGroupEvents(
  env: Env,
  groupId: number,
  note: string,
): Promise<void> {
  for (const event of await repo.runningEvents(env, groupId, GROUP_EVENT_KINDS)) {
    await repo.addEventProgress(env, event.id, note);
    await repo.finishEvent(env, event.id, "error", note);
  }
}

async function closeRunningEvent(
  env: Env,
  eventId: number,
  note: string,
): Promise<boolean> {
  if (!eventId) return false;
  const event = await repo.getEvent(env, eventId);
  if (!event || s(event.status) !== "running") return false;
  await repo.addEventProgress(env, eventId, note);
  await repo.finishEvent(env, eventId, "error", note);
  return true;
}

// ---------------------------------------------------------------------------
// DNS snapshot / state (read-only; no Cloudflare calls)
// ---------------------------------------------------------------------------

export async function dnsSnapshot(
  env: Env,
  groupId: number,
  dutyId: number,
): Promise<string> {
  const names = [...(await repo.dnsRecordsOf(env, dns.TARGET_GROUP, groupId))];
  for (const name of await repo.dnsRecordsOf(env, dns.TARGET_SERVER, dutyId)) {
    if (!names.includes(name)) names.push(name);
  }
  const snapshot: Record<string, string> = {};
  for (const name of names) {
    const row: DnsRecord | null = await repo.getDnsRecord(env, name);
    snapshot[name] = s(row?.last_ip ?? "");
  }
  return JSON.stringify(snapshot);
}

async function ddnsStateOf(
  env: Env,
  groupId: number,
  dutyId: number,
): Promise<string> {
  const names = [...(await repo.dnsRecordsOf(env, dns.TARGET_GROUP, groupId))];
  for (const name of await repo.dnsRecordsOf(env, dns.TARGET_SERVER, dutyId)) {
    if (!names.includes(name)) names.push(name);
  }
  const statuses: string[] = [];
  for (const name of names) {
    const row: DnsRecord | null = await repo.getDnsRecord(env, name);
    const status = s(row?.last_status ?? "").trim();
    statuses.push(status || "⏸ 待同步");
  }
  return dns.combineStatus(statuses);
}

// ---------------------------------------------------------------------------
// Month-cycle daily failover reset
// ---------------------------------------------------------------------------

async function resetMonthDayFailover(
  env: Env,
  group: ShiftGroup,
  groupId: number,
  nowTs: number,
  tz: string,
): Promise<ShiftRun | null> {
  if (!isMonthCycle(group)) return null;
  const scheduled = dutyAt(group, nowTs, tz);
  if (scheduled === null) return null;
  const slotKey = String(scheduled[1]);
  const run = await repo.getRun(env, groupId, slotKey);
  if (!run) return null;
  if (!run.failover || s(run.failover_reason) !== "stall") return null;
  if (run.manual) return null;

  const today = dayKey(tz, nowTs);
  const doneDay = s(run.duty_day);
  if (doneDay === today) return null;
  if (!doneDay) {
    return repo.upsertRun(env, groupId, slotKey, { duty_day: today });
  }

  const oldEventId = num(run.event_id);
  const oldEvent = oldEventId ? await repo.getEvent(env, oldEventId) : null;
  if (oldEvent && s(oldEvent.status) === "running") {
    await repo.addEventProgress(env, oldEventId, "跨日复位，本节重新尝试原当班");
    await repo.finishEvent(env, oldEventId, "done", "跨日复位，本节重新尝试原当班");
  }
  for (const prefix of [
    `duty_stall:${groupId}:${slotKey}`,
    `duty_tries:${groupId}:${slotKey}`,
    `stall_nocand:${groupId}:${slotKey}`,
    `stall_disabled:${groupId}:${slotKey}`,
    `failover_tried:${groupId}:${slotKey}:`,
    `recovery:${groupId}:${slotKey}`,
    `start_err:${groupId}:${slotKey}`,
  ]) {
    await repo.clearFlagsLike(env, prefix);
  }
  return repo.upsertRun(env, groupId, slotKey, {
    failover: 0,
    failover_from: 0,
    failover_reason: "",
    duty_day: "",
    duty_server_id: 0,
    phase: PHASE_SWITCHING,
    stage: "",
    event_id: 0,
    started_at: Math.floor(nowTs),
  });
}

// ---------------------------------------------------------------------------
// Single-instance keepalive: retry notes / pause / resume
// ---------------------------------------------------------------------------

async function keepaliveRetryNote(
  env: Env,
  opts: {
    serverId: number;
    label: string;
    stateLabel: string;
    pending: EventRecord | null;
    error?: string;
    quiet?: boolean;
  },
): Promise<number> {
  const triesKey = `keepalive_tries:${opts.serverId}`;
  let eventId: number;
  if (opts.pending) {
    eventId = opts.pending.id;
    const tries = await repo.bumpFlag(env, triesKey);
    let detail = `等待开机到位（已尝试 ${tries} 次）`;
    if (opts.error) detail += `；启动指令失败：${opts.error}`;
    await repo.updateEvent(env, eventId, { detail });
    if (KEEPALIVE_MILESTONES.has(tries)) {
      await repo.addEventProgress(
        env,
        eventId,
        `${KEEPALIVE_RETRY_MARK}${opts.stateLabel}），已尝试拉起 ${tries} 次`,
      );
    }
    return eventId;
  }
  await repo.clearFlag(env, triesKey);
  const tries = await repo.bumpFlag(env, triesKey);
  let detail = `等待开机到位（已尝试 ${tries} 次）`;
  if (opts.error) detail += `；启动指令失败：${opts.error}`;
  eventId = await repo.addEvent(
    env,
    opts.quiet ? "keepalive_quiet" : "start",
    messages.ev(
      opts.quiet ? "单机保活窗口恢复中" : "单机保活抢占恢复中",
      messages.objServer(opts.label),
    ),
    {
      detail,
      level: "warning",
      serverId: opts.serverId,
      status: "running",
      pendingStatus: "Running",
      pendingKind: "keepalive",
    },
  );
  await repo.addEventProgress(
    env,
    eventId,
    opts.error
      ? `启动指令失败：${opts.error}`
      : `已下发开机指令（原状态 ${opts.stateLabel}）`,
  );
  if (KEEPALIVE_MILESTONES.has(tries)) {
    await repo.addEventProgress(
      env,
      eventId,
      `${KEEPALIVE_RETRY_MARK}${opts.stateLabel}），已尝试拉起 ${tries} 次`,
    );
  }
  return eventId;
}

async function closeKeepaliveEvent(
  env: Env,
  serverId: number,
  label: string,
  note: string,
): Promise<void> {
  const event = await repo.pendingEvent(env, serverId, "keepalive");
  await repo.clearFlag(env, `keepalive_tries:${serverId}`);
  if (event === null) return;
  const eid = event.id;
  await repo.addEventProgress(env, eid, note);
  await repo.updateEvent(env, eid, {
    title: messages.ev("单机保活暂停", messages.objServer(label)),
    level: "info",
    kind: "keepalive_pause",
  });
  await repo.finishEvent(env, eid, "done", note);
}

async function keepaliveOneShot(
  env: Env,
  opts: {
    serverId: number;
    kind: string;
    title: string;
    summary: string;
    steps: string[];
    level?: string;
  },
): Promise<number> {
  const eventId = await repo.addEvent(env, opts.kind, opts.title, {
    level: opts.level ?? "info",
    serverId: opts.serverId,
    status: "running",
  });
  for (const text of opts.steps) {
    await repo.addEventProgress(env, eventId, text);
  }
  await repo.finishEvent(env, eventId, "done", opts.summary);
  return eventId;
}

async function keepalivePauseNote(
  env: Env,
  opts: {
    serverId: number;
    label: string;
    windowText: string;
    summary: string;
    steps: string[];
    awaitStop?: boolean;
  },
): Promise<void> {
  await repo.clearFlag(env, `keepalive_tries:${opts.serverId}`);
  const paused = await repo.pendingEvent(env, opts.serverId, "keepalive_stop");
  if (paused !== null) {
    for (const text of opts.steps) {
      await repo.addEventProgress(env, paused.id, text);
    }
    return;
  }
  const event = await repo.pendingEvent(env, opts.serverId, "keepalive");
  const head = `已离开运行窗口${windowBracket(opts.windowText)}，窗口外不再自动拉起`;
  if (event !== null) {
    const eid = event.id;
    await repo.updateEvent(env, eid, {
      title: messages.ev("单机保活窗口暂停", messages.objServer(opts.label)),
      level: "info",
    });
    if (opts.awaitStop) {
      await repo.updateEvent(env, eid, {
        kind: "keepalive_pause",
        detail: "等待停机到位",
      });
    }
    await repo.addEventProgress(env, eid, head);
    for (const text of opts.steps) {
      await repo.addEventProgress(env, eid, text);
    }
    if (opts.awaitStop) {
      await repo.retargetEvent(env, eid, "Stopped", "keepalive_stop");
      return;
    }
    await repo.finishEvent(env, eid, "done", opts.summary);
    return;
  }
  const title = messages.ev("单机保活窗口暂停", messages.objServer(opts.label));
  if (opts.awaitStop) {
    const eid = await repo.addEvent(env, "keepalive_pause", title, {
      detail: "等待停机到位",
      serverId: opts.serverId,
      status: "running",
      pendingStatus: "Stopped",
      pendingKind: "keepalive_stop",
    });
    await repo.addEventProgress(env, eid, head);
    for (const text of opts.steps) {
      await repo.addEventProgress(env, eid, text);
    }
    return;
  }
  await keepaliveOneShot(env, {
    serverId: opts.serverId,
    kind: "keepalive_pause",
    title,
    summary: opts.summary,
    steps: [head, ...opts.steps],
  });
}

async function keepalivePauseProgress(
  env: Env,
  serverId: number,
  mode: string,
  issued = true,
): Promise<void> {
  const event = await repo.latestServerEvent(env, serverId, ["keepalive_pause"], 600);
  if (event === null) return;
  const label = messages.modeLabel(mode) || "停机";
  const doneText = `已暂停（${label}）`;
  if (s(event.detail) === doneText && s(event.status) === "done") return;
  const stepText = issued
    ? `已下发停机指令（${label}）`
    : `实例已是停机状态（${label}），未重复下发指令`;
  await repo.addEventProgress(env, event.id, stepText);
  if (s(event.status) === "running") {
    await repo.updateEvent(env, event.id, {
      detail: `等待停机到位（${label}）`,
    });
    return;
  }
  await repo.finishEvent(env, event.id, "done", doneText);
}

async function keepaliveRestRecovered(
  env: Env,
  serverId: number,
  mode: string,
): Promise<void> {
  const event = await repo.latestServerEvent(
    env,
    serverId,
    ["keepalive_rest_error"],
    3600,
  );
  if (event === null) return;
  const label = messages.modeLabel(mode) || "停机";
  const doneText = `重试成功，已停机（${label}）`;
  if (s(event.detail) === doneText) return;
  await repo.addEventProgress(env, event.id, doneText);
  await repo.updateEvent(env, event.id, { detail: doneText });
}

async function keepaliveRestFailNote(
  env: Env,
  serverId: number,
  label: string,
  error: string,
): Promise<number> {
  return repo.addEvent(env, "keepalive_rest_error", messages.ev("单机保活停机失败", messages.objServer(label)), {
    detail: `停机指令失败：${error}`,
    level: "warning",
    serverId,
  });
}

async function keepaliveResumeNote(
  env: Env,
  server: ServerView,
  windowText: string,
  status: string,
): Promise<number> {
  const serverId = server.id;
  const label = server.label || `#${serverId}`;
  const title = messages.ev("单机保活窗口恢复中", messages.objServer(label));
  const doneTitle = messages.ev("单机保活窗口恢复", messages.objServer(label));
  const head = `已进入运行窗口${windowBracket(windowText)}，恢复自动拉起`;
  const resumeFlag = `keepalive_resume_pending:${serverId}`;
  if (status === "Stopped") {
    try {
      await aliyun.startInstance(env, account(server));
    } catch (exc) {
      await repo.setFlag(env, resumeFlag);
      return keepaliveOneShot(env, {
        serverId,
        kind: "keepalive_resume",
        title: messages.ev("单机保活窗口恢复失败", messages.objServer(label)),
        summary: "启动指令失败，下一轮重试",
        steps: [head, `启动指令失败：${briefExc(exc)}`],
        level: "warning",
      });
    }
    await repo.clearFlag(env, resumeFlag);
    const eventId = await repo.addEvent(env, "keepalive_quiet", title, {
      detail: "等待开机到位",
      serverId,
      status: "running",
      pendingStatus: "Running",
      pendingKind: "keepalive",
    });
    await repo.addEventProgress(env, eventId, head);
    await repo.addEventProgress(env, eventId, "已下发开机指令（原状态 已停机）");
    await repo.clearFlag(env, `keepalive_tries:${serverId}`);
    await repo.bumpFlag(env, `keepalive_tries:${serverId}`);
    return eventId;
  }
  if (status === "Running") {
    await repo.clearFlag(env, resumeFlag);
    return keepaliveOneShot(env, {
      serverId,
      kind: "keepalive_resume",
      title: doneTitle,
      summary: "运行中",
      steps: [head, "实例已在运行，无需指令"],
    });
  }
  await repo.setFlag(env, resumeFlag);
  return 0;
}

/** Outside the run window: actively stop, event only, never a notification. */
async function keepaliveRest(
  env: Env,
  server: ServerView,
  windowText: string,
): Promise<void> {
  const serverId = server.id;
  const label = server.label || `#${serverId}`;
  const restFlag = `keepalive_rest:${serverId}`;
  const failFlag = `keepalive_rest_fail:${serverId}`;
  const logged = await repo.getFlag(env, restFlag);
  const wasFailed = await repo.getFlag(env, failFlag);

  if (isStoppedAnyMode(server)) {
    if (logged) {
      await keepalivePauseProgress(env, serverId, s(server.stopped_mode), false);
      return;
    }
    await repo.setFlag(env, restFlag);
    await repo.clearFlag(env, failFlag);
    const mode = s(server.stopped_mode);
    if (wasFailed) await keepaliveRestRecovered(env, serverId, mode);
    await keepalivePauseNote(env, {
      serverId,
      label,
      windowText,
      summary: `已暂停（${messages.modeLabel(mode) || "停机"}）`,
      steps: [
        `实例已是停机状态（${messages.modeLabel(mode) || "已停机"}），未重复下发指令`,
      ],
    });
    return;
  }

  if (s(server.instance_status) === "Stopping") return;

  let mode: string;
  try {
    mode = await stopServerByPref(env, server);
  } catch (exc) {
    const error = briefExc(exc);
    if (!logged && !(await repo.getFlag(env, failFlag))) {
      await repo.setFlag(env, failFlag);
      await keepaliveRestFailNote(env, serverId, label, error);
    }
    return;
  }

  await repo.clearFlag(env, failFlag);
  if (wasFailed) await keepaliveRestRecovered(env, serverId, mode);
  if (logged) {
    await keepalivePauseProgress(env, serverId, mode);
    return;
  }
  await repo.setFlag(env, restFlag);
  await keepalivePauseNote(env, {
    serverId,
    label,
    windowText,
    summary: "等待停机到位",
    steps: [`已下发停机指令（${messages.modeLabel(mode)}）`],
    awaitStop: true,
  });
}

// ---------------------------------------------------------------------------
// Over-limit stop (shared by keepalive + idle)
// ---------------------------------------------------------------------------

async function limitStopServer(
  env: Env,
  serverId: number,
  server: ServerView,
  config: Config,
  scope: string,
): Promise<boolean> {
  const flag = `limit_stop:${scope}:${serverId}`;
  if (await repo.getFlag(env, flag)) return false;

  const mode = s(server.stopped_mode);
  let effectiveMode = mode;
  if (!isStoppedAnyMode(server)) {
    try {
      effectiveMode = await stopServerByPref(env, server);
    } catch (exc) {
      const err = `limit_stop_err:${scope}:${serverId}`;
      if (!(await repo.getFlag(env, err))) {
        await repo.setFlag(env, err);
        await repo.addEvent(env, "error", messages.ev("流量超限停机失败", messages.objServer(server.label)), {
          detail: aliyun.briefError(exc),
          level: "error",
          serverId,
        });
      }
      return false;
    }
    await repo.clearFlag(env, `limit_stop_err:${scope}:${serverId}`);
  }

  await repo.setFlag(env, flag);
  const tail =
    scope === messages.SCOPE_KEEPALIVE
      ? "保活已暂停"
      : messages.stopPhrase(effectiveMode);
  const reason = `已用 ${usedGb(server).toFixed(2)} GB（阈值 ${num(server.threshold_gb)} GB）`;
  const stoppedAlready = isStoppedAnyMode(server);
  const eventId = await repo.addEvent(
    env,
    "limit_stop",
    messages.ev(`流量超限，${tail}`, messages.objServer(server.label)),
    {
      detail: `等待停机到位 / ${reason}`,
      level: "warning",
      serverId,
      status: "running",
      pendingStatus: "Stopped",
      pendingKind: "limit_stop",
    },
  );
  await repo.addEventProgress(
    env,
    eventId,
    `已用 ${usedGb(server).toFixed(2)} GB，超过阈值 ${num(server.threshold_gb)} GB`,
  );
  await repo.addEventProgress(
    env,
    eventId,
    stoppedAlready
      ? `实例已是停机状态（${messages.modeLabel(effectiveMode) || "已停机"}），未重复下发指令`
      : `已下发停机指令（${messages.modeLabel(effectiveMode)}）`,
  );
  if (config.notify_on_limit_stop === "1") {
    const results = await notify.sendAll(
      env,
      config,
      messages.overLimit(info(server), scope, effectiveMode),
    );
    await notify.noteNotify(env, eventId, results);
  }
  return true;
}

// ---------------------------------------------------------------------------
// reconcile_keepalives / reconcile_idle_limits
// ---------------------------------------------------------------------------

async function groupedServerIds(env: Env): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const group of await repo.listGroups(env)) {
    if (!truthy(group.enabled)) continue;
    const members = activeMembers(group);
    if (members.length < 2) continue;
    for (const member of members) ids.add(num(member.server_id));
  }
  return ids;
}

async function reconcileKeepalives(
  env: Env,
  config: Config,
  nowTs: number,
  tz: string,
  grouped: Set<number>,
): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const item of await repo.listKeepalives(env)) {
    const serverId = num(item.server_id);
    if (!truthy(item.enabled)) continue;
    if (grouped.has(serverId)) {
      await closeKeepaliveEvent(
        env,
        serverId,
        s(item.label) || `#${serverId}`,
        "已由换班组接管，停止保活拉起",
      );
      await repo.clearFlag(env, `keepalive_resume_pending:${serverId}`);
      const flag = `keepalive_conflict:${serverId}`;
      if (!(await repo.getFlag(env, flag))) {
        await repo.setFlag(env, flag);
        await repo.addEvent(
          env,
          "warning",
          messages.ev("单机保活已停用", messages.objServer(s(item.label) || "")),
          {
            detail: "已停用 / 由换班组接管，避免两边互相拉扯",
            level: "warning",
            serverId,
          },
        );
      }
      continue;
    }

    await repo.clearFlag(env, `keepalive_conflict:${serverId}`);

    const server = await repo.getServer(env, serverId, true);
    if (server === null) continue;
    const label = server.label || `#${serverId}`;
    try {
      await refreshServerState(env, server);
    } catch (exc) {
      await readError(env, {
        serverId,
        title: messages.ev("状态读取异常", messages.objServer(label)),
        exc,
        tzName: tz,
      });
      results.push({ keepalive: serverId, error: String(exc) });
      continue;
    }
    await readRecovered(env, {
      serverId,
      title: messages.ev("状态读取已恢复", messages.objServer(label)),
      tzName: tz,
    });

    const [inWindow, windowText] = keepaliveWindowDetail(item, nowTs, tz);
    const restFlag = `keepalive_rest:${serverId}`;
    if (!inWindow) {
      await keepaliveRest(env, server, windowText);
      results.push({
        keepalive: serverId,
        label: server.label,
        status: server.instance_status,
        resting: true,
      });
      continue;
    }

    if (overThreshold(server)) {
      if (
        await limitStopServer(env, serverId, server, config, messages.SCOPE_KEEPALIVE)
      ) {
        results.push({ keepalive: serverId, over_limit: true });
      }
      await closeKeepaliveEvent(env, serverId, label, "流量超限，已停机并暂停保活");
      continue;
    }
    if (await repo.getFlag(env, `limit_stop:${messages.SCOPE_KEEPALIVE}:${serverId}`)) {
      await repo.clearFlag(env, `limit_stop:${messages.SCOPE_KEEPALIVE}:${serverId}`);
    }

    const status = s(server.instance_status);
    let planned = false;
    if (await repo.getFlag(env, restFlag)) {
      await repo.clearFlag(env, restFlag);
      await repo.clearFlag(env, `keepalive_rest_fail:${serverId}`);
      await keepaliveResumeNote(env, server, windowText, status);
      planned = true;
    }

    if (status === "Stopped" && !planned) {
      const resumePending = await repo.getFlag(
        env,
        `keepalive_resume_pending:${serverId}`,
      );
      await repo.clearFlag(env, `keepalive_resume_pending:${serverId}`);
      const stateLabel =
        messages.STATUS_LABELS[status] ?? status ?? "未知";
      const pending = await repo.pendingEvent(env, serverId, "keepalive");
      try {
        await aliyun.startInstance(env, account(server));
        await keepaliveRetryNote(env, {
          serverId,
          label,
          stateLabel,
          pending,
          quiet: resumePending,
        });
        if (await repo.getFlag(env, `keepalive_fail:${serverId}`)) {
          await repo.clearFlag(env, `keepalive_fail:${serverId}`);
        }
      } catch (exc) {
        await keepaliveRetryNote(env, {
          serverId,
          label,
          stateLabel,
          pending,
          error: briefExc(exc),
          quiet: resumePending,
        });
      }
    } else if (status === "Running") {
      await repo.clearFlag(env, `keepalive_tries:${serverId}`);
      await repo.clearFlag(env, `keepalive_resume_pending:${serverId}`);
    }
    results.push({
      keepalive: serverId,
      label: server.label,
      status: server.instance_status,
      traffic: server.traffic_used,
    });
  }
  return results;
}

async function reconcileIdleLimits(
  env: Env,
  config: Config,
  grouped: Set<number>,
  keepaliveIds: Set<number>,
  tz: string,
): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const server of await repo.listServers(env, true)) {
    const serverId = server.id;
    if (grouped.has(serverId) || keepaliveIds.has(serverId)) continue;
    const label = server.label || `#${serverId}`;
    try {
      await refreshServerState(env, server);
    } catch (exc) {
      await readError(env, {
        serverId,
        title: messages.ev("状态读取异常", messages.objServer(label)),
        exc,
        tzName: tz,
      });
      continue;
    }
    await readRecovered(env, {
      serverId,
      title: messages.ev("状态读取已恢复", messages.objServer(label)),
      tzName: tz,
    });
    if (overThreshold(server)) {
      if (
        await limitStopServer(env, serverId, server, config, messages.SCOPE_IDLE)
      ) {
        results.push({ idle: serverId, over_limit: true });
      }
    } else if (
      await repo.getFlag(env, `limit_stop:${messages.SCOPE_IDLE}:${serverId}`)
    ) {
      await repo.clearFlag(env, `limit_stop:${messages.SCOPE_IDLE}:${serverId}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Joint shift rotation — helpers
// ---------------------------------------------------------------------------

async function syncDdns(
  env: Env,
  server: ServerView,
  config: Config,
  kind: string,
  targetId: number,
  opts: { ip?: string; verify?: boolean } = {},
): Promise<DDNSReport> {
  const ip = s(opts.ip ?? server.public_ip ?? "");
  if (config.ddns_enabled !== "1") {
    return dns.noSyncReport(config);
  }
  const [names, results] = await dns.syncTargetFull(env, kind, targetId, config, {
    ip,
    verify: opts.verify ?? false,
  });
  let allNames = [...names];
  let allResults = [...results];
  if (kind === dns.TARGET_GROUP) {
    const [ownNames, ownResults] = await dns.syncTargetFull(
      env,
      dns.TARGET_SERVER,
      server.id,
      config,
      { ip, verify: opts.verify ?? false },
    );
    allNames = allNames.concat(ownNames);
    allResults = allResults.concat(ownResults);
  }
  return dns.report(allNames, allResults);
}

async function shiftEvent(
  env: Env,
  groupId: number,
  slotKey: string,
  name: string,
  dutyLabel: string,
  dutyId = 0,
): Promise<number> {
  const run = await repo.getRun(env, groupId, slotKey);
  const eventId = num(run?.event_id);
  if (eventId) {
    const current = await repo.getEvent(env, eventId);
    if (current && s(current.status) === "running") return eventId;
  }
  const newEventId = await repo.addEvent(
    env,
    "shift_done",
    messages.ev("换班进行中", messages.objGroup(name)),
    {
      detail: `等待当班 ${dutyLabel} 到位`,
      level: "info",
      groupId,
      status: "running",
    },
  );
  await repo.upsertRun(env, groupId, slotKey, {
    event_id: newEventId,
    dns_before: await dnsSnapshot(env, groupId, dutyId),
  });
  await repo.addEventProgress(env, newEventId, `换班开始：当班 ${dutyLabel}`);
  return newEventId;
}

async function maybeReportTimeout(
  env: Env,
  group: ShiftGroup,
  config: Config,
  nowTs: number,
  slotKey: string,
  shiftStart: number,
  duty: ServerView,
  others: ServerView[],
  notifyEnabled: boolean,
): Promise<void> {
  if (!notifyEnabled || config.notify_on_error !== "1") return;
  const settings = resolveSettings(env);
  const run = await repo.getRun(env, group.id, slotKey);
  const startedAt = num(run?.started_at) || shiftStart;
  const elapsed = (nowTs - startedAt) / 60;
  if (elapsed < settings.shiftTimeoutMinutes) return;
  const flag = `timeout:${group.id}:${slotKey}`;
  if (await repo.getFlag(env, flag)) return;

  const results = await notify.sendAll(
    env,
    config,
    messages.shiftError(
      info(duty),
      infos(others),
      settings.shiftTimeoutMinutes,
      s(group.name),
      await ddnsStateOf(env, group.id, duty.id),
    ),
  );
  await repo.setFlag(env, flag);
  const eventId = await repo.addEvent(
    env,
    "error",
    messages.ev("换班超时", messages.objGroup(s(group.name))),
    {
      detail: `已等待 ${elapsed.toFixed(0)} 分钟仍未就绪`,
      level: "error",
      groupId: group.id,
    },
  );
  await notify.noteNotify(env, eventId, results);
}

async function recordSettled(
  env: Env,
  opts: {
    groupId: number;
    slotKey: string;
    kind: string;
    name: string;
    duty: ServerView;
    others: ServerView[];
    ddnsBrief: string;
    isFailover: boolean;
    isManual: boolean;
    results?: Record<string, string> | null;
  },
): Promise<number | null> {
  const detail = `当班 ${opts.duty.label} / 待机 ${opts.others.length} 台 / ${opts.ddnsBrief}`;
  const run = await repo.getRun(env, opts.groupId, opts.slotKey);
  const runEventId = num(run?.event_id);
  if (runEventId) {
    await repo.updateEvent(env, runEventId, { detail });
    if (opts.results !== null && opts.results !== undefined) {
      await notify.noteNotify(env, runEventId, opts.results);
    }
    return null;
  }
  const eventId = await repo.addEvent(
    env,
    opts.kind,
    messages.ev(
      opts.isFailover
        ? "故障转移"
        : opts.isManual
          ? "手动换班完成"
          : "换班完成",
      messages.objGroup(opts.name),
    ),
    { detail, groupId: opts.groupId, serverId: opts.duty.id },
  );
  if (opts.results !== null && opts.results !== undefined) {
    await notify.noteNotify(env, eventId, opts.results);
  }
  return eventId;
}

async function notifySettled(
  env: Env,
  opts: {
    group: ShiftGroup;
    config: Config;
    duty: ServerView;
    others: ServerView[];
    ddnsStatus: string;
    failover: number;
    slotKey: string;
    manual?: boolean;
    shiftEventId?: number;
    nowTs?: number;
    ddnsBrief?: string;
  },
): Promise<void> {
  const ddnsBrief = opts.ddnsBrief || opts.ddnsStatus;
  const group = opts.group;
  const groupId = group.id;
  const name = s(group.name);
  const tz = opts.config.timezone ?? "Asia/Shanghai";
  const isFailover = Boolean(opts.failover);
  const isManual = Boolean(opts.manual) && !isFailover;
  const kind = isFailover ? "shift_failover" : "shift_done";
  const scope = isFailover ? "failover" : isManual ? "manual" : "settled";
  let flag: string;
  if (isManual && opts.shiftEventId) {
    flag = `notify:${groupId}:manual:${opts.shiftEventId}`;
  } else if (isFailover && isMonthCycle(group)) {
    const day = dayKey(tz, opts.nowTs ?? Math.floor(Date.now() / 1000));
    flag = `notify:${groupId}:${opts.slotKey}:failover:${day}`;
  } else {
    flag = `notify:${groupId}:${opts.slotKey}:${scope}`;
  }
  if (await repo.getFlag(env, flag)) {
    await recordSettled(env, {
      groupId,
      slotKey: opts.slotKey,
      kind,
      name,
      duty: opts.duty,
      others: opts.others,
      ddnsBrief,
      isFailover,
      isManual,
    });
    return;
  }

  const enabledKey = isFailover ? "notify_on_failover" : "notify_on_shift";
  if (opts.config[enabledKey] !== "1") {
    await repo.setFlag(env, flag);
    await repo.clearFlag(env, `timeout:${groupId}:${opts.slotKey}`);
    await recordSettled(env, {
      groupId,
      slotKey: opts.slotKey,
      kind,
      name,
      duty: opts.duty,
      others: opts.others,
      ddnsBrief,
      isFailover,
      isManual,
    });
    return;
  }

  let message: Message;
  if (isFailover) {
    const run = await repo.getRun(env, groupId, opts.slotKey);
    const fromId = num(run?.failover_from);
    const reason = s(run?.failover_reason);
    let over = fromId
      ? opts.others.filter((server) => server.id === fromId)
      : [];
    if (over.length === 0) {
      over = opts.others.filter((server) => overThreshold(server));
    }
    if (over.length === 0 && opts.others.length > 0) {
      over = [opts.others[0] as ServerView];
    }
    const overIds = new Set(over.map((server) => server.id));
    const standby = opts.others.filter((server) => !overIds.has(server.id));
    message = messages.shiftFailover(
      info(opts.duty),
      infos(over),
      infos(standby),
      opts.ddnsStatus,
      name,
      reason,
    );
  } else {
    const delayed = await repo.getFlag(env, `timeout:${groupId}:${opts.slotKey}`);
    const period = shiftSpan(
      group,
      opts.duty,
      opts.nowTs ?? Math.floor(Date.now() / 1000),
      tz,
    );
    message = messages.shiftDone(
      info(opts.duty),
      infos(opts.others),
      period,
      opts.ddnsStatus,
      name,
      delayed,
      isManual,
    );
    if (delayed) {
      await repo.clearFlag(env, `timeout:${groupId}:${opts.slotKey}`);
    }
  }

  const results = await notify.sendAll(env, opts.config, message);
  await repo.setFlag(env, flag);
  await recordSettled(env, {
    groupId,
    slotKey: opts.slotKey,
    kind,
    name,
    duty: opts.duty,
    others: opts.others,
    ddnsBrief,
    isFailover,
    isManual,
    results,
  });
}

async function handleBreaker(
  env: Env,
  group: ShiftGroup,
  config: Config,
  slotKey: string,
  duty: ServerView,
  others: ServerView[],
  notifyEnabled: boolean,
  reason = "",
): Promise<ReconcileResult> {
  const groupId = group.id;
  const name = s(group.name);
  const everyone = [duty, ...others];
  const why = reason || "全部成员流量超限";

  const run = await repo.getRun(env, groupId, slotKey);
  await closeRunningEvent(env, num(run?.event_id), `${why}，触发全局熔断`);

  for (const server of everyone) {
    if (isStoppedAnyMode(server)) continue;
    const serverId = server.id;
    const stamp = `breaker_stop:${groupId}:${slotKey}:${serverId}`;
    const age = await repo.flagAge(env, stamp);
    if (age >= 0 && age < BREAKER_STOP_COOLDOWN) continue;
    try {
      await stopServerByPref(env, server);
      await repo.clearFlag(env, `breaker_stop_err:${groupId}:${slotKey}:${serverId}`);
    } catch (exc) {
      const flag = `breaker_stop_err:${groupId}:${slotKey}:${serverId}`;
      if (!(await repo.getFlag(env, flag))) {
        await repo.setFlag(env, flag);
        await repo.addEvent(
          env,
          "error",
          messages.ev("熔断停机失败", messages.objMember(name, server.label)),
          {
            detail: aliyun.briefError(exc),
            level: "error",
            groupId,
            serverId,
          },
        );
      }
    } finally {
      await repo.clearFlag(env, stamp);
      await repo.setFlag(env, stamp);
    }
  }

  await repo.upsertRun(env, groupId, slotKey, {
    phase: PHASE_BREAKER,
    event_id: 0,
    duty_server_id: duty.id,
    standby_server_ids: encodeIds(others),
    note: why,
  });

  const flag = `breaker:${groupId}:${slotKey}`;
  if (
    notifyEnabled &&
    config.notify_on_breaker === "1" &&
    !(await repo.getFlag(env, flag))
  ) {
    if (allStoppedAnyMode(everyone)) {
      const results = await notify.sendAll(
        env,
        config,
        messages.breaker(infos(everyone), name, reason),
      );
      await repo.setFlag(env, flag);
      const eventId = await repo.addEvent(
        env,
        "breaker",
        messages.ev("全局熔断", messages.objGroup(name)),
        {
          detail: `${messages.stopTail(infos(everyone))} / ${why}`,
          level: "error",
          groupId,
        },
      );
      for (const member of everyone) {
        const memberLabel = member.label || `#${member.id}`;
        await repo.addEventProgress(
          env,
          eventId,
          `${memberLabel}：${messages.stopPhrase(s(member.stopped_mode))}`,
        );
      }
      await repo.addEventProgress(env, eventId, "已确认全部停机，本轮未再下发指令");
      await notify.noteNotify(env, eventId, results);
    }
  }

  return { group_id: groupId, breaker: true };
}

async function handleLimitStop(
  env: Env,
  group: ShiftGroup,
  config: Config,
  slotKey: string,
  duty: ServerView,
  others: ServerView[],
  notifyEnabled: boolean,
): Promise<ReconcileResult> {
  const groupId = group.id;
  const name = s(group.name);
  const dutyStatus = s(duty.instance_status);

  const run = await repo.getRun(env, groupId, slotKey);
  await closeRunningEvent(env, num(run?.event_id), "当班流量超限，触发超限停机");

  if (!isStoppedAnyMode(duty)) {
    if (!TRANSIENT_STATUS.has(dutyStatus)) {
      const stamp = `limit_stop_cmd:${groupId}:${slotKey}`;
      const age = await repo.flagAge(env, stamp);
      if (!(age >= 0 && age < BREAKER_STOP_COOLDOWN)) {
        try {
          const mode = await stopServerByPref(env, duty);
          await repo.clearFlag(env, `limit_stop_err:${groupId}:${slotKey}`);
          const eventFlag = `limit_stop_evt:${groupId}:${slotKey}`;
          if (!(await repo.getFlag(env, eventFlag))) {
            await repo.setFlag(env, eventFlag);
            const used = usedGb(duty);
            const thr = num(duty.threshold_gb);
            const eventId = await repo.addEvent(
              env,
              "limit_stop",
              messages.ev(
                `当班流量超限，${messages.stopPhrase(mode)}`,
                messages.objDuty(name, duty.label),
              ),
              {
                detail: `等待停机到位 / 已用 ${used.toFixed(2)} GB（阈值 ${thr} GB）`,
                level: "warning",
                groupId,
                serverId: duty.id,
                status: "running",
                pendingStatus: "Stopped",
                pendingKind: "limit_stop",
              },
            );
            await repo.addEventProgress(
              env,
              eventId,
              `已用 ${used.toFixed(2)} GB，超过阈值 ${thr} GB`,
            );
            await repo.addEventProgress(
              env,
              eventId,
              `已下发停机指令（${messages.modeLabel(mode)}）`,
            );
          }
        } catch (exc) {
          const errFlag = `limit_stop_err:${groupId}:${slotKey}`;
          if (!(await repo.getFlag(env, errFlag))) {
            await repo.setFlag(env, errFlag);
            await repo.addEvent(
              env,
              "error",
              messages.ev("当班流量超限停机失败", messages.objDuty(name, duty.label)),
              {
                detail: aliyun.briefError(exc),
                level: "error",
                groupId,
                serverId: duty.id,
              },
            );
          }
        } finally {
          await repo.clearFlag(env, stamp);
          await repo.setFlag(env, stamp);
        }
      }
    }
  } else {
    for (const prefix of ["limit_stop_evt", "limit_stop_err", "limit_stop_cmd"]) {
      await repo.clearFlag(env, `${prefix}:${groupId}:${slotKey}`);
    }
    const flag = `limit_stop:${groupId}:${slotKey}`;
    if (
      notifyEnabled &&
      config.notify_on_limit_stop === "1" &&
      isStoppedAnyMode(duty) &&
      !(await repo.getFlag(env, flag))
    ) {
      const results = await notify.sendAll(
        env,
        config,
        messages.limitStop(info(duty), name),
      );
      await repo.setFlag(env, flag);
      await notify.noteNotify(
        env,
        await repo.latestEventId(env, "limit_stop", groupId),
        results,
      );
    }
  }

  await repo.upsertRun(env, groupId, slotKey, {
    phase: PHASE_BREAKER,
    event_id: 0,
    duty_server_id: duty.id,
    standby_server_ids: encodeIds(others),
    note: "当班流量超限且无法换班",
  });
  return { group_id: groupId, limit_stop: true };
}

// ---------------------------------------------------------------------------
// Joint shift rotation — reconcile_group
// ---------------------------------------------------------------------------

export async function reconcileGroup(
  env: Env,
  group: ShiftGroup,
  config: Config,
  nowTs: number,
  notifyEnabled = true,
): Promise<ReconcileResult> {
  const settings = resolveSettings(env);
  const groupId = group.id;
  const name = s(group.name) || `#${groupId}`;
  const tz = config.timezone ?? "Asia/Shanghai";

  if (!truthy(group.enabled)) {
    await closeGroupEvents(env, groupId, "换班组已停用，本节流程中止");
    return { group_id: groupId, skipped: "disabled" };
  }

  await resetMonthDayFailover(env, group, groupId, nowTs, tz);

  const picked = await actualDuty(env, group, nowTs, tz);
  if (picked === null) {
    await closeGroupEvents(env, groupId, "启用成员不足两台，排不出当班，流程中止");
    return { group_id: groupId, skipped: "成员不足两台" };
  }
  const [dutyMember, shiftStart] = picked;
  const slotKey = String(shiftStart);
  let run: ShiftRun =
    (await repo.getRun(env, groupId, slotKey)) ?? emptyRun();

  const manualSwitch = Boolean(run.manual);
  const failedOver = Boolean(run.failover);
  let failoverFrom = num(run.failover_from);
  let failoverReason = s(run.failover_reason);

  let duty = await repo.getServer(env, num(dutyMember.server_id), true);
  if (duty === null) {
    return { group_id: groupId, skipped: "当班服务器已被删除" };
  }

  let others: ServerView[] = [];
  for (const member of activeMembers(group)) {
    if (num(member.server_id) === num(dutyMember.server_id)) continue;
    const server = await repo.getServer(env, num(member.server_id), true);
    if (server !== null) others.push(server);
  }
  if (others.length === 0) {
    return { group_id: groupId, skipped: "没有其他成员" };
  }

  // 1) Read live state of every member.
  let dutyError = "";
  try {
    await refreshServerState(env, duty);
  } catch (exc) {
    dutyError = String(exc);
  }
  const healthyOthers: ServerView[] = [];
  const unreadable = new Set<number>();
  for (const server of others) {
    const memberId = server.id;
    const memberLabel = server.label || `#${memberId}`;
    try {
      await refreshServerState(env, server);
      healthyOthers.push(server);
      await readRecovered(env, {
        serverId: memberId,
        title: messages.ev(
          "状态读取已恢复",
          messages.objMember(name, memberLabel),
        ),
        tzName: tz,
      });
    } catch (exc) {
      unreadable.add(memberId);
      await readError(env, {
        serverId: memberId,
        title: messages.ev(
          "状态读取异常",
          messages.objMember(name, memberLabel),
        ),
        exc,
        groupId,
        tzName: tz,
      });
    }
  }

  // Duty state unreadable: never act on a stale snapshot.
  if (dutyError) {
    await readError(env, {
      serverId: duty.id,
      title: messages.ev("状态读取异常", messages.objDuty(name, duty.label)),
      exc: dutyError,
      groupId,
      tzName: tz,
    });
    return { group_id: groupId, state_unreadable: dutyError };
  }
  await readRecovered(env, {
    serverId: duty.id,
    title: messages.ev("状态读取已恢复", messages.objDuty(name, duty.label)),
    tzName: tz,
  });

  // 2) Duty over threshold -> find a replacement; none -> circuit-break.
  let failover = false;
  let breaker = false;
  let breakerReason = "";
  if (overThreshold(duty) && truthy(group.failover_enabled) && !dutyError) {
    const candidates = healthyOthers.filter((s2) => !overThreshold(s2));
    if (candidates.length > 0) {
      const replacement = candidates.reduce((a, b) =>
        num(a.traffic_used) <= num(b.traffic_used) ? a : b,
      );
      const decisionEvent = await repo.addEvent(
        env,
        "failover",
        messages.ev("当班超限，故障转移", messages.objDuty(name, duty.label)),
        {
          detail: `等待接管到位（${replacement.label}）`,
          level: "warning",
          groupId,
          serverId: replacement.id,
          status: "running",
        },
      );
      await repo.addEventProgress(
        env,
        decisionEvent,
        `当班 ${duty.label} 流量超限（${usedGb(duty).toFixed(2)} GB / 阈值 ${num(duty.threshold_gb)} GB），改由 ${replacement.label} 接班`,
      );
      others = others.filter((s2) => s2.id !== replacement.id);
      others.push(duty);
      failoverFrom = duty.id;
      failoverReason = "traffic";
      duty = replacement;
      failover = true;
      await repo.upsertRun(env, groupId, slotKey, {
        phase: PHASE_SWITCHING,
        stage: "",
        event_id: decisionEvent,
        started_at: Math.floor(Date.now() / 1000),
        failover_from: failoverFrom,
        failover_reason: failoverReason,
      });
      run = (await repo.getRun(env, groupId, slotKey)) ?? run;
    } else {
      breaker = true;
      if (healthyOthers.length === 0) {
        breakerReason = "其他成员状态读取失败，无法确认可接班的成员";
      } else if (healthyOthers.length < others.length) {
        breakerReason = "可读取的成员流量均已超限，其余成员状态读取失败";
      } else {
        breakerReason = "全部成员流量超限";
      }
    }
  }

  if (breaker) {
    return handleBreaker(env, group, config, slotKey, duty, others, notifyEnabled, breakerReason);
  }

  if (overThreshold(duty) && !failover) {
    return handleLimitStop(env, group, config, slotKey, duty, others, notifyEnabled);
  }

  const recoveryFlag = `recovery:${groupId}:${slotKey}`;
  let eventId = num(run.event_id);

  // 2.5) Duty won't come up -> same failover path as over-threshold.
  const stallFlag = `duty_stall:${groupId}:${slotKey}`;
  const triesFlag = `duty_tries:${groupId}:${slotKey}`;
  const dutyNow = s(duty.instance_status);
  const tries = await repo.flagValue(env, triesFlag);
  const stallLimit = TRANSIENT_STATUS.has(dutyNow)
    ? settings.dutyStartGraceSeconds
    : settings.dutyStallSeconds;
  let stall = false;
  let stallReason = "";
  if (!failover && !manualSwitch && dutyNow !== "Running") {
    if ((await repo.flagAge(env, stallFlag)) < 0) {
      await repo.setFlag(env, stallFlag);
    }
    if (TRANSIENT_STATUS.has(dutyNow)) {
      stall = (await repo.flagAge(env, stallFlag)) >= stallLimit;
    } else {
      stall = tries >= settings.dutyStartTries;
    }
    stallReason = TRANSIENT_STATUS.has(dutyNow)
      ? `已 ${stallLimit} 秒未就绪`
      : `已尝试 ${tries} 次仍未能拉起`;
  } else {
    await repo.clearFlag(env, stallFlag);
    await repo.clearFlag(env, triesFlag);
  }

  if (stall) {
    if (!truthy(group.failover_enabled)) {
      const flag = `stall_disabled:${groupId}:${slotKey}`;
      if (!(await repo.getFlag(env, flag))) {
        await repo.setFlag(env, flag);
        await repo.addEvent(
          env,
          "warning",
          messages.ev("当班未就绪", messages.objDuty(name, duty.label)),
          {
            detail: `保持等待（未启用故障转移） / ${stallReason}`,
            level: "warning",
            groupId,
            serverId: duty.id,
          },
        );
      }
    } else {
      const tried = new Set<number>();
      for (const s2 of healthyOthers) {
        if (
          await repo.getFlag(env, `failover_tried:${groupId}:${slotKey}:${s2.id}`)
        ) {
          tried.add(s2.id);
        }
      }
      const candidates = healthyOthers.filter(
        (s2) => !tried.has(s2.id) && !overThreshold(s2),
      );
      const statusText =
        messages.STATUS_LABELS[s(duty.instance_status)] ??
        s(duty.instance_status) ??
        "未知";
      if (candidates.length > 0) {
        const replacement = candidates.reduce((a, b) =>
          num(a.traffic_used) <= num(b.traffic_used) ? a : b,
        );
        await repo.setFlag(
          env,
          `failover_tried:${groupId}:${slotKey}:${duty.id}`,
        );
        const title = messages.ev(
          "当班未就绪，故障转移",
          messages.objDuty(name, duty.label),
        );
        const detail = `等待接管到位（${replacement.label}）`;
        if (eventId) {
          await repo.updateEvent(env, eventId, {
            title,
            detail,
            kind: "shift_failover",
          });
          await repo.addEventProgress(
            env,
            eventId,
            `${duty.label}（${statusText}）${stallReason}，改由 ${replacement.label} 接班`,
          );
        } else {
          eventId = await repo.addEvent(env, "shift_failover", title, {
            detail,
            level: "warning",
            groupId,
            serverId: replacement.id,
            status: "running",
          });
        }
        await repo.clearFlag(env, recoveryFlag);
        others = others.filter((s2) => s2.id !== replacement.id);
        others.push(duty);
        failoverFrom = duty.id;
        failoverReason = "stall";
        duty = replacement;
        failover = true;
        await repo.clearFlag(env, stallFlag);
        await repo.clearFlag(env, triesFlag);
        const dayFields = isMonthCycle(group)
          ? { duty_day: dayKey(tz, nowTs) }
          : {};
        await repo.upsertRun(env, groupId, slotKey, {
          phase: PHASE_SWITCHING,
          stage: "",
          event_id: eventId,
          started_at: Math.floor(Date.now() / 1000),
          failover: 1,
          failover_from: failoverFrom,
          failover_reason: failoverReason,
          ...dayFields,
        });
        run = (await repo.getRun(env, groupId, slotKey)) ?? run;
        eventId = 0;
      } else {
        const flag = `stall_nocand:${groupId}:${slotKey}`;
        if (!(await repo.getFlag(env, flag))) {
          await repo.setFlag(env, flag);
          await repo.addEvent(
            env,
            "error",
            messages.ev("当班未就绪，无成员接替", messages.objGroup(name)),
            {
              detail:
                `${duty.label}（${statusText}）${stallReason}，` +
                "其余成员要么流量也已超限，要么状态读取失败",
              level: "error",
              groupId,
              serverId: duty.id,
            },
          );
        }
      }
    }
  }

  const failoverFlag = failover || failedOver ? 1 : 0;

  // 3) Guarantee the duty instance is running — start duty only.
  const previouslySettled = SETTLED_LIKE_PHASES.has(s(run.phase));
  const restartClock = previouslySettled
    ? { started_at: Math.floor(nowTs) }
    : {};
  let dutyStatus = s(duty.instance_status);
  const dutyNotRunning =
    dutyStatus !== "Running" && !TRANSIENT_STATUS.has(dutyStatus);

  if (dutyNotRunning) {
    if (previouslySettled) {
      await repo.setFlag(env, recoveryFlag);
      eventId = await repo.addEvent(
        env,
        "recovery",
        messages.ev("当班自动拉起中", messages.objDuty(name, duty.label)),
        {
          detail: "等待运行到位",
          level: "warning",
          groupId,
          serverId: duty.id,
          status: "running",
        },
      );
      await repo.addEventProgress(
        env,
        eventId,
        `检测到当班 ${duty.label} 未运行（${dutyStatus || "未知"}）`,
      );
      await repo.upsertRun(env, groupId, slotKey, {
        event_id: eventId,
        started_at: Math.floor(Date.now() / 1000),
      });
    } else {
      eventId = await shiftEvent(
        env,
        groupId,
        slotKey,
        name,
        duty.label,
        duty.id,
      );
    }

    await repo.bumpFlag(env, triesFlag);
    try {
      await aliyun.startInstance(env, account(duty));
      await repo.clearFlag(env, `start_err:${groupId}:${slotKey}`);
      await repo.addEventProgress(
        env,
        eventId,
        `已下发开机指令（当班 ${duty.label}）`,
      );
      await repo.updateEvent(env, eventId, { detail: "等待开机到位" });
      dutyStatus = "Starting";
    } catch (exc) {
      const flag = `start_err:${groupId}:${slotKey}`;
      if (!(await repo.getFlag(env, flag))) {
        await repo.setFlag(env, flag);
        await repo.addEvent(
          env,
          "error",
          messages.ev("当班启动失败", messages.objDuty(name, duty.label)),
          {
            detail: aliyun.briefError(exc),
            level: "error",
            groupId,
            serverId: duty.id,
          },
        );
      }
      await repo.updateEvent(env, eventId, {
        detail: `当班启动失败，等待重试：${briefExc(exc)}`,
      });
      await repo.addEventProgress(
        env,
        eventId,
        `当班启动失败：${briefExc(exc)}`,
        { once: true },
      );
      await repo.upsertRun(env, groupId, slotKey, {
        phase: PHASE_ERROR,
        stage: "",
        event_id: eventId,
        duty_server_id: duty.id,
        standby_server_ids: encodeIds(others),
        failover: failoverFlag,
        note: String(exc).slice(0, 200),
      });
      await maybeReportTimeout(
        env,
        group,
        config,
        nowTs,
        slotKey,
        shiftStart,
        duty,
        others,
        notifyEnabled,
      );
      return { group_id: groupId, error: String(exc) };
    }
  } else if (!previouslySettled) {
    eventId = await shiftEvent(
      env,
      groupId,
      slotKey,
      name,
      duty.label,
      duty.id,
    );
  }

  // Duty still starting: wait, do not touch standby this round.
  if (TRANSIENT_STATUS.has(dutyStatus)) {
    await repo.upsertRun(env, groupId, slotKey, {
      phase: PHASE_SWITCHING,
      stage: "starting_duty",
      event_id: eventId,
      duty_server_id: duty.id,
      standby_server_ids: encodeIds(others),
      failover: failoverFlag,
      attempts: num(run.attempts) + 1,
      ...restartClock,
    });
    await maybeReportTimeout(
      env,
      group,
      config,
      nowTs,
      slotKey,
      shiftStart,
      duty,
      others,
      notifyEnabled,
    );
    return {
      group_id: groupId,
      slot: slotKey,
      ready: false,
      stage: "starting_duty",
    };
  }

  // 4) Duty is Running: wait for a public IP first when DDNS is on.
  const ddnsEnabled = config.ddns_enabled === "1";
  const hasIp = Boolean(s(duty.public_ip).trim());
  if (ddnsEnabled && !hasIp) {
    await repo.upsertRun(env, groupId, slotKey, {
      phase: PHASE_SWITCHING,
      stage: "starting_duty",
      event_id: eventId,
      duty_server_id: duty.id,
      standby_server_ids: encodeIds(others),
      failover: failoverFlag,
      attempts: num(run.attempts) + 1,
      ...restartClock,
    });
    await maybeReportTimeout(
      env,
      group,
      config,
      nowTs,
      slotKey,
      shiftStart,
      duty,
      others,
      notifyEnabled,
    );
    return {
      group_id: groupId,
      slot: slotKey,
      ready: false,
      stage: "waiting_ip",
    };
  }

  if (!previouslySettled) {
    await repo.addEventProgress(
      env,
      eventId,
      `当班 ${duty.label} 已开机`,
      { once: true },
    );
  }

  // 5) Stop standby — only now that duty is confirmed Running.
  let allStopped = true;
  for (const server of others) {
    if (unreadable.has(server.id)) {
      allStopped = false;
      continue;
    }
    if (isStoppedAnyMode(server)) continue;
    if (TRANSIENT_STATUS.has(s(server.instance_status))) {
      const stalledOut =
        failoverReason === "stall" && server.id === failoverFrom;
      if (!stalledOut) {
        allStopped = false;
        continue;
      }
    }
    try {
      const stopMode = await stopServerByPref(env, server);
      await repo.clearFlag(env, `stop_err:${server.id}`);
      await repo.addEventProgress(
        env,
        eventId,
        `已下发停机指令（${server.label}，${messages.modeLabel(stopMode)}）`,
      );
    } catch (exc) {
      const flag = `stop_err:${server.id}`;
      if (!(await repo.getFlag(env, flag))) {
        await repo.setFlag(env, flag);
        await repo.addEvent(
          env,
          "error",
          messages.ev("非当班停机失败", messages.objMember(name, server.label)),
          {
            detail: aliyun.briefError(exc),
            level: "error",
            groupId,
            serverId: server.id,
          },
        );
      }
    }
    allStopped = false;
  }

  if (allStopped && !previouslySettled) {
    await repo.addEventProgress(
      env,
      eventId,
      `非当班${messages.stopTail(infos(others))}`,
      { once: true },
    );
  }

  // 6) DDNS only after all instance states are confirmed.
  let ddnsText = "";
  let ddnsBrief = "";
  let ddnsReport: DDNSReport | null = null;
  let ddnsOk = true;
  if (allStopped) {
    ddnsReport = await syncDdns(env, duty, config, dns.TARGET_GROUP, groupId, {
      verify: !previouslySettled,
    });
    ddnsText = ddnsReport.status;
    ddnsBrief = ddnsReport.brief;
    const ddnsBound =
      (await repo.dnsRecordsOf(env, dns.TARGET_GROUP, groupId)).length > 0 ||
      (await repo.dnsRecordsOf(env, dns.TARGET_SERVER, duty.id)).length > 0;
    ddnsOk =
      !ddnsEnabled || !ddnsBound || dns.isSuccess(ddnsText);
    if (previouslySettled && !ddnsOk) ddnsOk = true;

    const waitKey = `ddns_wait:${groupId}:${slotKey}`;
    if (ddnsOk) {
      await repo.clearFlag(env, waitKey);
    } else {
      const waited = await repo.flagAge(env, waitKey);
      if (waited < 0) {
        await repo.setFlag(env, waitKey);
      } else if (waited >= DDNS_WAIT_SECONDS) {
        ddnsOk = true;
        await repo.clearFlag(env, waitKey);
        await repo.addEvent(
          env,
          "error",
          messages.ev("DDNS 未同步，换班照常结算", messages.objGroup(name)),
          {
            detail:
              `已放行结算 / 等待 ${Math.floor(DDNS_WAIT_SECONDS / 60)} 分钟仍未同步（${ddnsText}），` +
              "请检查记录名、Token 与 Zone",
            level: "warning",
            groupId,
          },
        );
      }
    }
    if (!previouslySettled && ddnsReport !== null) {
      const text = `DDNS：${ddnsReport.detail}`;
      const existing = await repo.getEvent(env, eventId);
      const logged = (existing?.progress ?? []).some((step) =>
        s(step.text).includes("DDNS："),
      );
      if (!logged || ddnsReport.results.some((r) => r.changed)) {
        await repo.addEventProgress(env, eventId, text);
      }
    }
  }

  const ready =
    dutyStatus === "Running" &&
    allStopped &&
    (hasIp || !ddnsEnabled) &&
    ddnsOk;

  const recovered =
    ready &&
    (await repo.getFlag(env, recoveryFlag)) &&
    !failoverFlag &&
    !manualSwitch;
  const firstSettle = ready && !previouslySettled && !recovered;
  let phase: string;
  if (!ready) {
    phase = PHASE_SWITCHING;
  } else if (failoverFlag) {
    phase = PHASE_FAILOVER;
  } else {
    phase = PHASE_SETTLED;
  }
  const stage = ready ? "" : "stopping_standby";

  await repo.upsertRun(env, groupId, slotKey, {
    phase,
    stage,
    event_id: eventId,
    duty_server_id: duty.id,
    standby_server_ids: encodeIds(others),
    failover: failoverFlag,
    attempts: num(run.attempts) + 1,
    ...(ready ? {} : restartClock),
  });

  const summary: ReconcileResult = {
    group_id: groupId,
    slot: slotKey,
    duty: duty.label,
    mode: manualSwitch ? "manual" : failoverFlag ? "failover" : "normal",
    ready,
    ddns: ddnsText,
  };

  if (!ready) {
    await maybeReportTimeout(
      env,
      group,
      config,
      nowTs,
      slotKey,
      shiftStart,
      duty,
      others,
      notifyEnabled,
    );
    return summary;
  }

  // Settle: rewrite the same running event as the final result (first time only).
  let kind = failoverFlag
    ? "shift_failover"
    : manualSwitch
      ? "manual"
      : "shift_done";
  if (firstSettle && eventId) {
    await repo.addEventProgress(env, eventId, "全部状态确认完毕", {
      once: true,
    });
    let label: string;
    if (failoverFlag) {
      if (failoverReason === "stall") {
        label = "当班未就绪，故障转移";
      } else if (failoverReason === "traffic") {
        label = "当班超限，故障转移";
      } else {
        label = "故障转移";
      }
      kind = "shift_failover";
    } else if (manualSwitch) {
      label = "手动换班完成";
      kind = "manual";
    } else if (s(run.origin) === ORIGIN_NEW_GROUP) {
      label = "新建换班组";
      kind = "group_new";
    } else {
      label = "换班完成";
      kind = "shift_done";
    }
    await repo.updateEvent(env, eventId, {
      title: messages.ev(label, messages.objGroup(name)),
      kind,
    });
    await repo.finishEvent(env, eventId, "done");
    for (const prefix of [
      `duty_stall:${groupId}:${slotKey}`,
      `duty_tries:${groupId}:${slotKey}`,
      `stall_nocand:${groupId}:${slotKey}`,
      `stall_disabled:${groupId}:${slotKey}`,
      `failover_tried:${groupId}:${slotKey}:`,
    ]) {
      await repo.clearFlagsLike(env, prefix);
    }
  }

  if (recovered) {
    await repo.clearFlag(env, recoveryFlag);
    if (eventId) {
      await repo.addEventProgress(env, eventId, "当班已恢复运行", {
        once: true,
      });
      await repo.updateEvent(env, eventId, {
        title: messages.ev(
          "当班已恢复运行",
          messages.objDuty(name, duty.label),
        ),
        detail: ddnsBrief ? `运行中 / ${ddnsBrief}` : "运行中",
        kind: "recovery",
      });
      await repo.finishEvent(env, eventId, "done");
    }
  }

  if (!notifyEnabled) {
    if (firstSettle && eventId) {
      await recordSettled(env, {
        groupId,
        slotKey,
        kind,
        name,
        duty,
        others,
        ddnsBrief,
        isFailover: Boolean(failoverFlag),
        isManual: manualSwitch,
      });
    }
    return summary;
  }

  if (firstSettle || failover) {
    await notifySettled(env, {
      group,
      config,
      duty,
      others,
      ddnsStatus: ddnsText,
      failover: failoverFlag,
      slotKey,
      manual: manualSwitch,
      shiftEventId: eventId,
      nowTs,
      ddnsBrief,
    });
  } else if (recovered && config.notify_on_recovery === "1") {
    const results = await notify.sendAll(
      env,
      config,
      messages.recovery(info(duty), ddnsText, undefined, "recovery", name),
    );
    await notify.noteNotify(env, eventId, results);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Group lifecycle: bootstrap / dissolve
// ---------------------------------------------------------------------------

// SIMPLIFIED: the Python engine holds a threading.Lock so reconcile and
// manual operations never overlap. Workers has no cross-isolate lock; the
// module-level `reconciling` flag in reconcileAll only guards within one
// isolate. D1-backed idempotency (run.event_id reuse, dedupe flags, "only
// issue start/stop after a fresh read") keeps a rare overlap safe, but it
// is not a hard exclusion.
let reconciling = false;

export async function bootstrapGroup(
  env: Env,
  groupId: number,
): Promise<ReconcileResult> {
  const group = await repo.getGroup(env, groupId);
  if (group === null) throw new Error("换班组不存在");
  const name = s(group.name) || `#${groupId}`;
  const config = await repo.getSettings(env);
  const tz = config.timezone ?? "Asia/Shanghai";
  const nowTs = Math.floor(Date.now() / 1000);

  if (!truthy(group.enabled)) {
    await repo.addEvent(
      env,
      "group_new",
      messages.ev("新建换班组", messages.objGroup(name)),
      {
        detail: "换班组未启用，没有对组员下发任何启停指令",
        groupId,
      },
    );
    return { group_id: groupId, skipped: "disabled" };
  }

  const picked = await actualDuty(env, group, nowTs, tz);
  if (picked === null) {
    await repo.addEvent(
      env,
      "group_new",
      messages.ev("新建换班组", messages.objGroup(name)),
      {
        detail: "启用成员不足两台，排不出当班，未下发任何启停指令",
        groupId,
      },
    );
    return { group_id: groupId, skipped: "成员不足两台" };
  }

  const [dutyMember, shiftStart] = picked;
  const slotKey = String(shiftStart);
  const duty = await repo.getServer(env, num(dutyMember.server_id), true);
  if (duty === null) {
    await repo.addEvent(
      env,
      "group_new",
      messages.ev("新建换班组", messages.objGroup(name)),
      {
        detail: "排班表指定的当班服务器已被删除，未下发任何启停指令",
        groupId,
      },
    );
    return { group_id: groupId, skipped: "当班服务器已被删除" };
  }

  const others: ServerView[] = [];
  for (const member of activeMembers(group)) {
    if (num(member.server_id) === num(dutyMember.server_id)) continue;
    const server = await repo.getServer(env, num(member.server_id), true);
    if (server !== null) others.push(server);
  }

  const slotName = s(dutyMember.slot_name).trim();
  const when = slotName || "当前时刻";
  const eventId = await repo.addEvent(
    env,
    "group_new",
    messages.ev("新建换班组", messages.objGroup(name)),
    {
      detail: `等待当班 ${duty.label} 到位 / 其余 ${others.length} 台待停机`,
      groupId,
      serverId: duty.id,
      status: "running",
    },
  );
  await repo.addEventProgress(
    env,
    eventId,
    `按排班表核对组员状态：${when} / 当班 ${duty.label}`,
  );
  await repo.upsertRun(env, groupId, slotKey, {
    event_id: eventId,
    origin: ORIGIN_NEW_GROUP,
    phase: PHASE_SWITCHING,
    duty_server_id: duty.id,
    standby_server_ids: encodeIds(others),
  });
  // This slot's settle notification is claimed: bootstrapping only aligns
  // state, it does not push a report.
  await repo.setFlag(env, `notify:${groupId}:${slotKey}:settled`);

  let mismatched = 0;
  const targets: Array<[ServerView, boolean]> = [
    [duty, true],
    ...others.map((server) => [server, false] as [ServerView, boolean]),
  ];
  for (const [server, shouldRun] of targets) {
    const label = server.label || `#${server.id}`;
    try {
      await refreshServerState(env, server);
    } catch (exc) {
      mismatched += 1;
      await repo.addEventProgress(
        env,
        eventId,
        `${label}：状态读取失败（${briefExc(exc)}），交给下一轮同步重试`,
      );
      continue;
    }
    const status = s(server.instance_status);
    const suffix = messages.statusSuffix(status, server.stopped_mode);
    if (shouldRun) {
      if (status === "Running") {
        await repo.addEventProgress(
          env,
          eventId,
          `当班 ${label}：${status}${suffix}，符合排班表`,
          { once: true },
        );
      } else {
        mismatched += 1;
        await repo.addEventProgress(
          env,
          eventId,
          `当班 ${label}：${status}${suffix}，需要开机`,
          { once: true },
        );
      }
    } else if (isStoppedAnyMode(server)) {
      await repo.addEventProgress(
        env,
        eventId,
        `${label}：${status}${suffix}，符合排班表`,
        { once: true },
      );
    } else {
      mismatched += 1;
      await repo.addEventProgress(
        env,
        eventId,
        `${label}：${status}${suffix}，需要节省停机`,
        { once: true },
      );
    }
  }

  if (!mismatched) {
    await repo.addEventProgress(
      env,
      eventId,
      "组员状态已符合排班表，无需下发启停指令",
      { once: true },
    );
  }

  const result = await reconcileGroup(env, group, config, nowTs, false);
  // SIMPLIFIED: Python asks the scheduler for a fast-reconcile window
  // (10s interval) so the user does not wait a full minute. Workers has no
  // fast-reconcile window (CONTRACT: scheduler); the next cron tick (<=60s)
  // continues the in-progress run.
  return { group_id: groupId, event_id: eventId, ...result };
}

export async function dissolveGroup(
  env: Env,
  groupId: number,
): Promise<ReconcileResult> {
  const group = await repo.getGroup(env, groupId);
  if (group === null) throw new Error("换班组不存在");
  const name = s(group.name) || `#${groupId}`;
  const memberIds = (group.members ?? []).map((m) => num(m.server_id));
  const bound = await repo.dnsRecordsOf(env, dns.TARGET_GROUP, groupId);
  const keepalives = new Map<number, KeepaliveView>();
  for (const item of await repo.listKeepalives(env)) {
    keepalives.set(num(item.server_id), item);
  }

  let detail = `已解散 / ${memberIds.length} 台保持原状，未下发指令`;
  if (bound.length > 0) detail += " / DDNS 绑定已解除";
  const eventId = await repo.addEvent(
    env,
    "group_dissolve",
    messages.ev("解散换班组", messages.objGroup(name)),
    { detail, groupId: 0, status: "running" },
  );

  for (const serverId of memberIds) {
    const server = await repo.getServer(env, serverId, true);
    if (server === null) {
      await repo.addEventProgress(env, eventId, `#${serverId}：服务器已被删除，跳过`);
      continue;
    }
    const label = server.label || `#${serverId}`;
    try {
      await refreshServerState(env, server);
      const status = s(server.instance_status);
      const suffix = messages.statusSuffix(status, server.stopped_mode);
      await repo.addEventProgress(
        env,
        eventId,
        `${label}：${status}${suffix}，保持不动`,
      );
    } catch (exc) {
      await repo.addEventProgress(
        env,
        eventId,
        `${label}：状态读取失败（${briefExc(exc)}），保持不动`,
      );
    }

    const item = keepalives.get(serverId);
    if (item !== undefined && truthy(item.enabled)) {
      await repo.setKeepaliveEnabled(env, item.id, false);
      await repo.addEventProgress(
        env,
        eventId,
        `${label}：单机保活已暂停，不会被自动拉起`,
      );
    }
  }

  // Close any running events of this group so none spins forever.
  // SIMPLIFIED: Python queries events directly by group_id regardless of
  // kind; repo has no such call, so the known shift kinds are closed here.
  for (const row of await repo.runningEvents(env, groupId, [
    ...GROUP_EVENT_KINDS,
    "limit_stop",
    "breaker",
    "group_dissolve",
  ])) {
    await repo.addEventProgress(
      env,
      row.id,
      "换班组已解散，本次换班流程中止",
    );
    await repo.finishEvent(env, row.id, "done", "换班组已解散，流程未走完");
  }

  await repo.deleteGroup(env, groupId);
  if (bound.length > 0) {
    await repo.addEventProgress(env, eventId, `DDNS 绑定已解除：${bound.join("、")}`);
  }
  await repo.addEventProgress(env, eventId, "组员均已回到闲散手动，可随时手动开关机");
  await repo.finishEvent(env, eventId, "done");
  return { ok: true, event_id: eventId, servers: memberIds.length };
}

// ---------------------------------------------------------------------------
// Manual operations
// ---------------------------------------------------------------------------

async function manualEvent(
  env: Env,
  groupId: number,
  slotKey: string,
  name: string,
  current: MemberLike,
  target: MemberLike,
): Promise<number> {
  const fromLabel = s(current.label) || s(current.server_id);
  const toLabel = s(target.label) || s(target.server_id);
  for (const stale of await repo.runningEvents(env, groupId, GROUP_EVENT_KINDS)) {
    await repo.addEventProgress(
      env,
      stale.id,
      `已被新的手动换班取代（改为 ${toLabel}）`,
    );
    if (["manual", "shift_done"].includes(s(stale.kind))) {
      await repo.updateEvent(env, stale.id, {
        title: messages.ev("手动换班已取消", messages.objGroup(name)),
        detail: `已取消 / 改为 ${toLabel}`,
      });
    }
    await repo.finishEvent(env, stale.id, "done");
  }
  const eventId = await repo.addEvent(
    env,
    "manual",
    messages.ev("手动换班进行中", messages.objGroup(name)),
    {
      detail: `等待接管到位（${toLabel}，原当班 ${fromLabel}）`,
      level: "info",
      groupId,
      status: "running",
    },
  );
  await repo.addEventProgress(env, eventId, `手动换班：${fromLabel} → ${toLabel}`);
  await repo.upsertRun(env, groupId, slotKey, {
    event_id: eventId,
    dns_before: await dnsSnapshot(env, groupId, num(target.server_id)),
  });
  return eventId;
}

async function manualSwitchTimetable(
  env: Env,
  group: ShiftGroup,
  config: Config,
  nowTs: number,
  tz: string,
): Promise<ReconcileResult> {
  const groupId = group.id;
  const members = activeMembers(group);
  const picked = await actualDuty(env, group, nowTs, tz);
  if (picked === null) throw new Error("组内启用的成员不足两台");
  const [currentMember, shiftStart] = picked;
  const slotKey = String(shiftStart);

  const currentIndex = members.findIndex(
    (m) => num(m.server_id) === num(currentMember.server_id),
  );
  const nextMember =
    currentIndex >= 0
      ? (members[(currentIndex + 1) % members.length] as MemberLike)
      : (members[0] as MemberLike);

  await repo.upsertRun(env, groupId, slotKey, {
    phase: PHASE_SWITCHING,
    stage: "",
    duty_server_id: num(nextMember.server_id),
    failover: 0,
    manual: 1,
    started_at: Math.floor(nowTs),
  });
  await manualEvent(env, groupId, slotKey, s(group.name), currentMember, nextMember);
  const fresh = (await repo.getGroup(env, groupId)) ?? group;
  return reconcileGroup(env, fresh, config, nowTs);
}

export async function manualSwitch(
  env: Env,
  groupId: number,
): Promise<ReconcileResult> {
  const group = await repo.getGroup(env, groupId);
  if (group === null) throw new Error("换班组不存在");
  const config = await repo.getSettings(env);
  const tz = config.timezone ?? "Asia/Shanghai";
  const nowTs = Math.floor(Date.now() / 1000);

  const members = activeMembers(group);
  if (members.length < 2) throw new Error("组内启用的成员不足两台");

  if (isMonthCycle(group) || isTimetableGroup(group)) {
    const result = await manualSwitchTimetable(env, group, config, nowTs, tz);
    // SIMPLIFIED: no fast-reconcile window in Workers; next cron tick continues.
    return result;
  }

  const pickedNow = await actualDuty(env, group, nowTs, tz);
  const currentMember = pickedNow ? pickedNow[0] : (members[0] as MemberLike);

  const size = members.length;
  const currentIndex = members.findIndex(
    (m) => num(m.server_id) === num(currentMember.server_id),
  );
  const nextIndex = (currentIndex + 1) % size;
  const cumBeforeNext =
    members.slice(0, nextIndex).reduce((acc, m) => acc + num(m.hours), 0) * 3600;

  const newAnchor = Math.floor(nowTs - cumBeforeNext);
  // Direct anchor move, mirroring Python's UPDATE shift_groups SET anchor_at
  // (repo has no set-anchor call; resetGroupAnchor only resets to now).
  await execute(env.DB, "UPDATE shift_groups SET anchor_at=? WHERE id=?", [
    newAnchor,
    groupId,
  ]);
  const fresh = (await repo.getGroup(env, groupId)) ?? group;
  const picked = dutyAt(fresh, nowTs, tz);
  if (picked !== null) {
    const slotKey = String(picked[1]);
    await repo.upsertRun(env, groupId, slotKey, {
      manual: 1,
      failover: 0,
      duty_server_id: num(picked[0].server_id),
      started_at: Math.floor(nowTs),
    });
    await manualEvent(env, groupId, slotKey, s(group.name), currentMember, picked[0]);
  }
  const result = await reconcileGroup(env, fresh, config, nowTs);
  // SIMPLIFIED: no fast-reconcile window in Workers; next cron tick continues.
  return result;
}

async function managedNote(env: Env, serverId: number): Promise<string> {
  for (const group of await repo.listGroups(env)) {
    if (!truthy(group.enabled)) continue;
    for (const member of group.members ?? []) {
      if (truthy(member.enabled) && num(member.server_id) === serverId) {
        return `换班组「${s(group.name)}」`;
      }
    }
  }
  for (const item of await repo.listKeepalives(env)) {
    if (num(item.server_id) === serverId && truthy(item.enabled)) {
      return "单机保活";
    }
  }
  return "";
}

export async function manualAction(
  env: Env,
  serverId: number,
  action: string,
): Promise<ReconcileResult> {
  if (action !== "start" && action !== "stop") {
    throw new Error("只支持 start / stop");
  }
  const server = await repo.getServer(env, serverId, true);
  if (server === null) throw new Error("服务器不存在");
  if (!s(server.instance_id).trim()) {
    throw new Error("这台服务器还没填实例 ID，无法启停");
  }

  const label = action === "start" ? "开机" : "停机";
  const targetStatus = action === "start" ? "Running" : "Stopped";
  const note = await managedNote(env, serverId);

  if (await repo.pendingManualExists(env, serverId, targetStatus)) {
    return {
      status: "pending",
      duplicate: true,
      target_status: targetStatus,
      managed_note: note,
      instance_status: server.instance_status || "Unknown",
      stopped_mode: server.stopped_mode || "",
    };
  }

  let stopMode = "";
  if (action === "start") {
    try {
      await refreshServerState(env, server);
    } catch {
      // Unreadable: judge on the stored snapshot rather than blocking.
    }
    if (overThreshold(server)) {
      throw new Error(
        `已用 ${usedGb(server).toFixed(2)} GB，已达阈值 ${num(server.threshold_gb)} GB，不能开机；请先调高阈值，或等流量包重置后再试`,
      );
    }
    await aliyun.startInstance(env, account(server));
  } else {
    stopMode = await stopServerByPref(env, server);
  }

  let detail = `等待${label}到位`;
  if (action === "stop" && stopMode) {
    detail += `（${messages.modeLabel(stopMode)}）`;
  }
  if (note) detail += ` / 由${note}托管，下一轮同步会按流程纠正`;

  const eventId = await repo.addEvent(
    env,
    "manual",
    messages.ev(`手动${label}`, messages.objServer(server.label)),
    {
      detail,
      level: "info",
      serverId,
      status: "running",
      pendingStatus: targetStatus,
      pendingKind: "manual",
    },
  );
  await repo.addEventProgress(env, eventId, `已下发${label}指令`);

  return {
    status: "pending",
    event_id: eventId,
    target_status: targetStatus,
    managed_note: note,
    instance_status: server.instance_status || "Unknown",
    stopped_mode: server.stopped_mode || "",
  };
}

export async function refreshServer(
  env: Env,
  serverId: number,
): Promise<{
  traffic_used: number | null;
  instance_status: string;
  stopped_mode: string;
  public_ip: string;
}> {
  const server = await repo.getServer(env, serverId, true);
  if (server === null) throw new Error("服务器不存在");
  await refreshServerState(env, server);
  const fresh = (await repo.getServer(env, serverId)) ?? server;
  return {
    traffic_used: fresh.traffic_used,
    instance_status: fresh.instance_status,
    stopped_mode: fresh.stopped_mode,
    public_ip: fresh.public_ip,
  };
}

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------

export async function dailyReport(env: Env): Promise<boolean> {
  const config = await repo.getSettings(env);
  const tz = config.timezone ?? "Asia/Shanghai";
  const today = dayKey(tz, Math.floor(Date.now() / 1000));
  const flag = `daily_report:${today}`;
  if (await repo.getFlag(env, flag)) return false;

  const servers: ServerView[] = [];
  for (const server of await repo.listServers(env, true)) {
    try {
      await refreshServerState(env, server);
    } catch {
      // A single unreadable server must not block the daily report.
    }
    servers.push((await repo.getServer(env, server.id)) ?? server);
  }
  if (servers.length === 0) return false;

  const message = messages.dailyReport(
    infos(servers),
    ymdHm(Math.floor(Date.now() / 1000), tz),
  );
  const results = await notify.sendAll(env, config, message);
  await repo.setFlag(env, flag);
  const eventId = await repo.addEvent(
    env,
    "daily_report",
    messages.ev("每日报告已推送"),
    { detail: `已推送 / ${servers.length} 台服务器` },
  );
  await notify.noteNotify(env, eventId, results);
  return true;
}

// ---------------------------------------------------------------------------
// Confirm pending manual events (port of Python `_confirm_pending_events`)
// ---------------------------------------------------------------------------

/**
 * The Python original ran a 5-second confirm thread: after a manual
 * start/stop it polled DescribeInstances until the instance reached the
 * target state, then finished the "running" event. That thread was never
 * ported — nothing in the Workers reconcile round finished manual events,
 * so the first manual start left a forever-"running" event behind and
 * `manualAction`'s duplicate guard (`pendingManualExists`) then swallowed
 * every later start for the same target state with a silent 200 (no API
 * call, no error). This step runs once per reconcile round (1-minute cron
 * / on-demand reconcile): it re-reads each waiting manual event's
 * instance and finishes the event once the target state is reached, or
 * after a 10-minute timeout so a stuck wait can never block manual
 * control again.
 */
const MANUAL_CONFIRM_TIMEOUT_SECONDS = 600;

async function confirmPendingManualEvents(env: Env): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  for (const event of await repo.runningPendingEvents(env, "manual")) {
    const server = await repo.getServer(env, num(event.server_id), true);
    if (server === null) {
      await repo.finishEvent(env, event.id, "error", "服务器已删除，等待收尾");
      continue;
    }
    try {
      await refreshServerState(env, server);
    } catch {
      // Unreadable this round: keep waiting; the timeout below still applies.
    }
    const fresh = (await repo.getServer(env, server.id)) ?? server;
    const status = s(fresh.instance_status);
    const target = s(event.pending_status);
    if (target && status === target) {
      await repo.addEventProgress(env, event.id, `已确认到位：${status}`);
      await repo.finishEvent(env, event.id, "done", `已确认${status}`);
      continue;
    }
    const waited = nowTs - num(event.pending_ts || event.ts);
    if (waited > MANUAL_CONFIRM_TIMEOUT_SECONDS) {
      const waitedMin = Math.max(1, Math.floor(waited / 60));
      await repo.addEventProgress(
        env,
        event.id,
        `等待超时（${waitedMin} 分钟），实例状态仍为 ${status || "未知"}`,
      );
      await repo.finishEvent(
        env,
        event.id,
        "error",
        `等待${target || "目标状态"}超时，实例状态仍为 ${status || "未知"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level entry: reconcile_all
// ---------------------------------------------------------------------------

export async function reconcileAll(env: Env): Promise<void> {
  // SIMPLIFIED: in-process guard only (see note above bootstrapGroup).
  // A second call in the same isolate is skipped; overlapping calls in
  // another isolate are made safe by the D1-backed idempotency below.
  if (reconciling) return;
  reconciling = true;
  try {
    const config = await repo.getSettings(env);
    const tz = config.timezone ?? "Asia/Shanghai";
    const nowTs = Math.floor(Date.now() / 1000);

    const grouped = await groupedServerIds(env);
    const keepaliveIds = await repo.keepaliveServerIds(env);

    try {
      await reconcileKeepalives(env, config, nowTs, tz, grouped);
    } catch (exc) {
      await repo.addEvent(
        env,
        "error",
        messages.ev("单机保活同步异常"),
        { detail: aliyun.briefError(exc), level: "error" },
      );
    }

    try {
      await reconcileIdleLimits(env, config, grouped, keepaliveIds, tz);
    } catch (exc) {
      await repo.addEvent(
        env,
        "error",
        messages.ev("闲散超限检查异常"),
        { detail: aliyun.briefError(exc), level: "error" },
      );
    }

    try {
      await confirmPendingManualEvents(env);
    } catch {
      // A failed confirm round must never fail the whole round; the
      // next tick retries, and the timeout still bounds the wait.
    }

    for (const group of await repo.listGroups(env)) {
      try {
        await reconcileGroup(env, group, config, nowTs);
      } catch (exc) {
        await repo.addEvent(
          env,
          "error",
          messages.ev("换班组同步异常", messages.objGroup(s(group.name))),
          {
            detail: aliyun.briefError(exc),
            level: "error",
            groupId: group.id,
          },
        );
      }
    }

    try {
      const monitored = new Set(
        (await repo.listServers(env)).map((server) => server.id),
      );
      await closeOrphanReadErrors(env, monitored);
    } catch {
      // Orphan cleanup must never fail the round.
    }
  } finally {
    reconciling = false;
  }
}

// ---------------------------------------------------------------------------
// Engine object (mirrors Python's `engine = Engine()`; the API layer calls
// these as `engine.*`, and also imports the named functions directly).
// ---------------------------------------------------------------------------

export const engine = {
  reconcileAll,
  dailyReport,
  refresh: refreshServer,
  manualAction,
  bootstrapGroup,
  dissolveGroup,
  manualSwitch,
  reconcileGroup,
};
