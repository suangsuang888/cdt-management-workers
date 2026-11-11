/**
 * DNS 记录与绑定。
 *
 * 对应 Python `app/dns.py`。这里是「域名 → 机器」的唯一出入口。
 * 规则只有一条：**绑定必须是显式的**。
 *
 * 三层分工：
 *   ddns.ts   只跟 Cloudflare 说话（查 Zone、找 Record ID、PUT A 记录）
 *   dns.ts    管绑定关系、谁该指向哪个 IP、什么时候需要更新（本文件）
 *   shift.ts  换班/保活跑到该同步的时机时调 syncRecord()，拿回状态塞进通知
 *
 * Workers 差异（相对 Python）：
 * - 所有碰库的函数都是 async，且第一个参数是 `env`（`repo.*` 同样以 `env`
 *   开头，见 `src/repo.ts`）。Python 的 repo 是模块级单例，Workers 里 D1
 *   绑定必须显式传。
 * - `targetInfo` / `groupRunner` 是 async：`shift.actualDuty` 需读库，且要
 *   传时区（设置里的 `timezone`，默认 Asia/Shanghai）。
 *   与 shift 的循环依赖沿用 Python 的做法——函数内动态 import。
 * - 时间统一用 Unix 秒（number），`Date.now() / 1000`。
 * - `syncRecord` 的第 4 个参数除对象外也接受布尔值（`true` = force），
 *   兼容 `api.ts` 手动同步入口的调用方式。
 */

import type { Env } from "./env";
import * as ddns from "./ddns";
import { DDNSResult } from "./ddns";
import * as messages from "./messages";
import * as repo from "./repo";
import type { DnsRecord, ServerView, ShiftGroup } from "./repo";

export const TARGET_SERVER = "server";
export const TARGET_GROUP = "group";
export const TARGET_NONE = "";

export const STATUS_UNBOUND = "⏸ 未绑定";
// 概览摘要里统一带「DDNS」前缀（`✅ DDNS已同步（…）` / `⏸ DDNS未绑定`），
// 事件列表收起时那一行能直接看出是哪一项没绑；详情和通知仍用短句。
export const STATUS_UNBOUND_BRIEF = "⏸ DDNS未绑定";
export const STATUS_DISABLED_BRIEF = "⏸ DDNS未启用";
export const STATUS_IDLE = "⏸ 目标未运行";
export const STATUS_NO_IP = "⚠️ 目标没有公网 IP";

export const STATE_UNBOUND = "unbound";
export const STATE_IDLE = "idle";
export const STATE_PENDING = "pending";
export const STATE_SYNCED = "synced";
export const STATE_ERROR = "error";

// 一条记录同步失败后，这么多秒内不再重试。
const RETRY_COOLDOWN = 120;

// 中间态：机器在动（正在起来/正在停），别急着判「没在跑」
const TRANSIENT_STATUS = new Set(["Starting", "Pending", "Stopping"]);

// 换班进行中，巡检让位多久（秒）。换班本身最多 10 分钟就该结算完，这里给到 15 分钟。
const SHIFT_DNS_HOLD = 15 * 60;

function tzOf(config?: Record<string, string> | null): string {
  return (config?.["timezone"] ?? "").trim() || "Asia/Shanghai";
}

/** 一次同步的三个说法，各用各的场合。 */
export interface DDNSReport {
  /** 事件详情里的一行：带前后 IP，能看出到底改没改 */
  detail: string;
  /** 事件概览/收尾摘要：一句话结论 */
  brief: string;
  /** 原来的汇总状态（✅ 已同步 / ❌ 更新失败…），通知里用它 */
  status: string;
  results: DDNSResult[];
}

/** 绑定目标的当前快照。 */
export interface DnsTarget {
  kind: string;
  id: number;
  label: string;
  status: string;
  running: boolean;
  ip: string;
  duty?: string;
}

export function normalize(name: string | null | undefined): string {
  return (name ?? "").trim();
}

// --------------------------------------------------------------------------
// 登记：设置里的记录名 ⇄ dns_records 表
// --------------------------------------------------------------------------

export async function syncRegistry(env: Env, config: Record<string, string>): Promise<void> {
  // 配置读不懂（不是列表、或混了非域名）时绝不能往下走：下面那段会把
  // 「不在名单里」的行连同 target 一起删光，用户从此不再有 DDNS。
  // 注意区分「读不懂」(null) 和「用户清空」(空列表)：后者该删就删。
  if (ddns.parseRecords(config) === null) {
    console.warn(
      `DDNS 记录名配置无法解析，保留现有绑定不动：${(config["ddns_records"] ?? "").slice(0, 80)}`,
    );
    return;
  }
  const names = ddns.records(config);
  const keep = new Set(names);
  for (const name of names) {
    await repo.ensureDnsRecord(env, name);
  }
  for (const row of await repo.listDnsRecords(env)) {
    if (!keep.has(row.record)) {
      await repo.deleteDnsRecord(env, row.record);
    }
  }
}

export async function adoptLegacy(env: Env, config: Record<string, string>): Promise<void> {
  const names = new Set(ddns.records(config).map((n) => n.toLowerCase()));
  for (const group of await repo.listGroups(env)) {
    const legacy = normalize(group.ddns_record || undefined);
    if (!legacy) {
      continue;
    }
    if (!names.has(legacy.toLowerCase())) {
      // 设置里已经没有这个名字了，说明是升级前删掉的残留
      continue;
    }
    const row = await repo.getDnsRecord(env, legacy);
    if (row !== null && row.target_kind) {
      continue;
    }
    if (await repo.dnsRecordOf(env, TARGET_GROUP, group.id)) {
      continue;
    }
    await repo.bindDnsRecord(env, legacy, TARGET_GROUP, group.id);
    console.info(`接手换班组「${group.name}」的域名 ${legacy}`);
  }
}

async function editableRecords(config: Record<string, string>): Promise<string[]> {
  if (ddns.parseRecords(config) === null) {
    throw new Error("记录名配置读不懂（ddns_records 不是合法列表），请先修好再改");
  }
  return ddns.records(config);
}

export async function addRecord(
  env: Env,
  name: string,
  config: Record<string, string>,
): Promise<string> {
  const n = normalize(name);
  if (!n) {
    throw new Error("域名不能为空");
  }
  if ([...n].some((ch) => /\s/.test(ch))) {
    throw new Error("域名不能带空格");
  }
  if (!n.includes(".")) {
    throw new Error("域名至少要有一层，形如 cdt.example.com");
  }

  const names = await editableRecords(config);
  if (!names.some((item) => item.toLowerCase() === n.toLowerCase())) {
    names.push(n);
  }
  await repo.setSettings(env, {
    ddns_records: JSON.stringify(names),
    // 老字段留个镜像，仅为了降级回旧版本时还能读
    ddns_record: names.length > 0 ? (names[0] as string) : "",
  });
  await repo.ensureDnsRecord(env, n);
  return n;
}

export async function removeRecord(
  env: Env,
  name: string,
  config: Record<string, string>,
): Promise<void> {
  const n = normalize(name);
  const names = (await editableRecords(config)).filter(
    (item) => item.toLowerCase() !== n.toLowerCase(),
  );
  await repo.setSettings(env, {
    ddns_records: JSON.stringify(names),
    ddns_record: names.length > 0 ? (names[0] as string) : "",
  });
  await repo.deleteDnsRecord(env, n);
}

// --------------------------------------------------------------------------
// 目标解析
// --------------------------------------------------------------------------

async function serversById(env: Env): Promise<Map<number, ServerView>> {
  const map = new Map<number, ServerView>();
  for (const server of await repo.listServers(env)) {
    map.set(server.id, server);
  }
  return map;
}

/** 换班组此刻真正在跑的那台（归一化视图：serverId 一律是服务器 ID）。 */
export interface GroupRunner {
  serverId: number;
  label: string;
  instance_status: string;
  public_ip: string;
}

async function groupRunner(
  env: Env,
  group: ShiftGroup,
  nowTs: number,
  servers: Map<number, ServerView>,
  tz: string,
): Promise<GroupRunner | null> {
  // 延迟导入：shift 反过来要用本模块，顶层导入会成环（与 Python 做法一致）。
  const shift = await import("./shift");
  // shift 自己定义了一份 ShiftGroup 类型（带 AnyRow 索引签名），与 repo 的
  // 不完全相同，这里按结构转一次。
  const picked = await shift.actualDuty(
    env,
    group as unknown as Parameters<typeof shift.actualDuty>[1],
    nowTs,
    tz,
  );
  if (!picked) {
    return null;
  }
  const member = picked[0];
  const server = servers.get(member.server_id);
  if (server) {
    return {
      serverId: server.id,
      label: server.label,
      instance_status: server.instance_status,
      public_ip: server.public_ip ?? "",
    };
  }
  return {
    serverId: Number(member.server_id) || 0,
    label: String(member.label ?? ""),
    instance_status: String(member.instance_status ?? ""),
    public_ip: String(member.public_ip ?? ""),
  };
}

export async function targetInfo(
  env: Env,
  kind: string,
  targetId: number,
  config?: Record<string, string> | null,
  servers?: Map<number, ServerView>,
  nowTs?: number,
): Promise<DnsTarget | null> {
  if (!kind || !targetId) {
    return null;
  }
  const serverMap = servers ?? (await serversById(env));
  const now = nowTs ?? Date.now() / 1000;
  const tz = tzOf(config);

  if (kind === TARGET_SERVER) {
    const server = serverMap.get(targetId);
    if (!server) {
      return null;
    }
    return {
      kind: TARGET_SERVER,
      id: targetId,
      label: server.label || `#${targetId}`,
      status: server.instance_status || "Unknown",
      running: server.instance_status === "Running",
      ip: (server.public_ip ?? "").trim(),
    };
  }

  if (kind === TARGET_GROUP) {
    const group = await repo.getGroup(env, targetId);
    if (!group) {
      return null;
    }
    const runner = await groupRunner(env, group, now, serverMap, tz);
    return {
      kind: TARGET_GROUP,
      id: targetId,
      label: group.name || `#${targetId}`,
      status: (runner ? runner.instance_status : "") || "Unknown",
      running: runner !== null && runner.instance_status === "Running",
      ip: runner ? (runner.public_ip ?? "").trim() : "",
      duty: runner ? runner.label : "",
    };
  }

  return null;
}

export function desiredIp(target: DnsTarget | null | undefined): string {
  if (!target || !target.running) {
    return "";
  }
  const ip = (target.ip ?? "").trim();
  return ddns.isPublicIpv4(ip) ? ip : "";
}

export function isFailure(status: string): boolean {
  const text = String(status ?? "");
  return text.startsWith("❌") || text.startsWith("⚠️");
}

export function isSuccess(text: string): boolean {
  const t = String(text ?? "");
  return t.startsWith("✅") && !t.includes("❌") && !t.includes("⚠️");
}

export function stateOf(row: DnsRecord, target: DnsTarget | null | undefined): string {
  if (!target) {
    return STATE_UNBOUND;
  }
  const live = desiredIp(target);
  if (!live) {
    // 「在跑但公网 IP 还没拿到」跟「没在跑」是两件事：以前都判成 idle，
    // 界面写「目标未运行」，人看着像机器挂了，实际马上就绪。
    if (target.running || TRANSIENT_STATUS.has(target.status)) {
      return STATE_PENDING;
    }
    return STATE_IDLE;
  }
  const last = row.last_ip;
  const status = row.last_status;
  // 失败优先判：失败路径故意保留上次成功的 IP，于是 last 永远不等于 live ——
  // 先比 IP 就会把失败降级成「待同步」，错误详情看不见。
  if (isFailure(status)) {
    return STATE_ERROR;
  }
  if (last === live && status.startsWith("✅")) {
    return STATE_SYNCED;
  }
  return STATE_PENDING;
}

// --------------------------------------------------------------------------
// 同步
// --------------------------------------------------------------------------

export interface SyncRecordOptions {
  ip?: string | null;
  force?: boolean;
  verify?: boolean;
}

export async function syncRecord(
  env: Env,
  record: string,
  config: Record<string, string>,
  options: SyncRecordOptions | boolean = {},
): Promise<DDNSResult> {
  const opts: SyncRecordOptions = typeof options === "boolean" ? { force: options } : options;
  const { ip = null, force = false, verify = false } = opts;
  const name = normalize(record);
  if (!name) {
    return new DDNSResult(STATUS_UNBOUND);
  }
  const row = await repo.getDnsRecord(env, name);
  if (!row) {
    return new DDNSResult(STATUS_UNBOUND, `${name} 不在记录名列表里`);
  }

  if (ip !== null && !ip) {
    // 调用方明确给了空 IP（实例刚起、EIP 还没分配）：这一轮不同步，也**不要**
    // 按失败把 last_status 覆盖成「IP 无效」——上次的「✅ 已同步」还要留着，
    // 下一轮拿到真实 IP 再改。
    return new DDNSResult(STATUS_NO_IP, "实例还没有可用的公网 IP", false, "");
  }

  let resolvedIp = ip;
  if (resolvedIp === null) {
    const target = await targetInfo(env, row.target_kind, row.target_id, config);
    if (!target) {
      await repo.setDnsState(env, name, row.last_ip, STATUS_UNBOUND);
      return new DDNSResult(STATUS_UNBOUND, `${name} 还没绑定`, false, "");
    }
    resolvedIp = desiredIp(target);
    if (!resolvedIp) {
      const status = target.running ? STATUS_NO_IP : STATUS_IDLE;
      await repo.setDnsState(env, name, row.last_ip, status);
      return new DDNSResult(status, `${target.label} 没有可用的公网 IP`, false, "");
    }
  }

  // 每条记录自己的「上次同步到哪」，不能借用全局那一个，否则会互相覆盖
  const scoped: Record<string, string> = {
    ...config,
    ddns_last_ip: row.last_ip,
    ddns_last_status: row.last_status,
  };
  const result = await ddns.syncFull(env, scoped, {
    ip: resolvedIp,
    force,
    record: name,
    verify,
  });
  if (result.status === ddns.STATUS_SYNCED || result.status === ddns.STATUS_UNCHANGED) {
    // IP 和状态都没变就别写库。last_at 的语义是「上次真正同步的时间」，
    // 不是「上次检查的时间」。
    const unchanged = row.last_ip === resolvedIp && row.last_status === result.status;
    if (force || !unchanged) {
      // verify 查完发现 CF 上本来就对：这是「纠正本地缓存」，不是真的写过
      // Cloudflare，时间戳得留着，否则界面又会跳到「刚刚」。
      const keepAt = verify && !force && !result.changed ? row.last_at || null : null;
      await repo.setDnsState(env, name, resolvedIp, result.status, keepAt ?? undefined);
    }
    // 成功后清掉失败去重标记（含手动「立即同步」这条路径）
    await repo.clearFlagsLike(env, `dns_fail:${name}:`);
  } else {
    // 失败时保留上次成功的 IP **与时间**。
    await repo.setDnsState(env, name, row.last_ip, result.status, row.last_at);
  }
  return result;
}

export function combineStatus(statuses: string[]): string {
  if (statuses.length === 0) {
    return STATUS_UNBOUND;
  }
  const unique = [...new Set(statuses)];
  if (unique.length === 1) {
    return statuses.length === 1
      ? (unique[0] as string)
      : `${unique[0]}（${statuses.length} 条）`;
  }
  // 结果不一致时逐条列出来，别用一个「已同步」盖掉某条的失败
  return unique.join(" / ");
}

export async function syncTargetFull(
  env: Env,
  kind: string,
  targetId: number,
  config: Record<string, string>,
  options: SyncRecordOptions | boolean = {},
): Promise<[string[], DDNSResult[]]> {
  const names = await repo.dnsRecordsOf(env, kind, targetId || 0);
  if (names.length === 0) {
    return [[], []];
  }
  const results: DDNSResult[] = [];
  for (const name of names) {
    results.push(await syncRecord(env, name, config, options));
  }
  return [names, results];
}

export async function syncTarget(
  env: Env,
  kind: string,
  targetId: number,
  config: Record<string, string>,
  options: SyncRecordOptions | boolean = {},
): Promise<[string[], string[]]> {
  const [names, results] = await syncTargetFull(env, kind, targetId, config, options);
  return [names, results.map((r) => r.status)];
}

export function report(names: string[], results: DDNSResult[]): DDNSReport {
  if (results.length === 0) {
    return { detail: STATUS_UNBOUND, brief: STATUS_UNBOUND_BRIEF, status: STATUS_UNBOUND, results: [] };
  }

  const status = combineStatus(results.map((r) => r.status));
  // 有失败就照旧把原因摆出来，不包装成「已同步（…）」
  if (!isSuccess(status)) {
    return { detail: status, brief: status, status, results };
  }

  const changed = results.filter((r) => r.changed);
  let brief: string;
  if (changed.length === results.length) {
    brief = "✅ DDNS已同步（已更新）";
  } else if (changed.length === 0) {
    brief = "✅ DDNS已同步（IP 未变化）";
  } else {
    brief = `✅ DDNS已同步（已更新 ${changed.length} 条 / 未变化 ${results.length - changed.length} 条）`;
  }

  const multi = names.length > 1;
  const parts: string[] = [];
  results.forEach((result, index) => {
    const name = index < names.length ? (names[index] as string) : "";
    const prefix = multi && name ? `${name} ` : "";
    if (result.changed) {
      // 第一次指向没有「旧值」，写成「首次指向」比留一个空箭头清楚
      parts.push(
        result.previous
          ? `${prefix}${result.previous} → ${result.ip}`
          : `${prefix}${result.ip}（首次指向）`,
      );
    } else {
      parts.push(`${prefix}${result.ip}（IP 未变化）`);
    }
  });

  const detail = `${ddns.STATUS_SYNCED} ` + parts.join("、");
  return { detail, brief, status, results };
}

export function noSyncReport(config: Record<string, string>): DDNSReport {
  if (config["ddns_enabled"] !== "1") {
    return {
      detail: ddns.STATUS_DISABLED,
      brief: STATUS_DISABLED_BRIEF,
      status: ddns.STATUS_DISABLED,
      results: [],
    };
  }
  return {
    detail: STATUS_UNBOUND,
    brief: STATUS_UNBOUND_BRIEF,
    status: STATUS_UNBOUND,
    results: [],
  };
}

async function shiftEvents(env: Env, kind: string, targetId: number): Promise<repo.EventRecord[]> {
  if (!targetId) {
    return [];
  }
  // 延迟导入：shift 反过来要用本模块，顶层导入会成环。
  const shift = await import("./shift");

  let groupIds: number[];
  if (kind === TARGET_GROUP) {
    groupIds = [targetId];
  } else if (kind === TARGET_SERVER) {
    // 这台机器自己绑的域名，换班时也会被一起指过去
    groupIds = await shift.groupsOfServer(env, targetId);
  } else {
    return [];
  }
  // failover / shift_failover：当班超限或起不来时，事件 kind 会在转移过程中
  // 被改写成这两个。漏掉它们，转移期间巡检会以为「没在换班」。
  const kinds = ["shift_done", "manual", "group_new", "failover", "shift_failover"];
  const events: repo.EventRecord[] = [];
  for (const groupId of groupIds) {
    events.push(...(await repo.runningEvents(env, groupId, kinds)));
  }
  return events;
}

async function shiftBusy(env: Env, kind: string, targetId: number): Promise<boolean> {
  return (await shiftEvents(env, kind, targetId)).length > 0;
}

async function shiftHold(
  env: Env,
  kind: string,
  targetId: number,
  nowTs?: number,
): Promise<boolean> {
  const events = await shiftEvents(env, kind, targetId);
  if (events.length === 0) {
    return false;
  }
  const now = nowTs ?? Date.now() / 1000;
  return events.some((event) => now - event.ts < SHIFT_DNS_HOLD);
}

export interface ReconcileEntry {
  record: string;
  target: string;
  ip: string;
  status: string;
}

/** 巡检所有绑定：目标在跑、但 IP 跟上次不一样时才真打接口。 */
export async function reconcile(
  env: Env,
  config: Record<string, string>,
  force = false,
): Promise<ReconcileEntry[]> {
  if (config["ddns_enabled"] !== "1") {
    return [];
  }

  await syncRegistry(env, config);
  const servers = await serversById(env);
  const nowTs = Date.now() / 1000;
  const results: ReconcileEntry[] = [];

  for (const row of await repo.listDnsRecords(env)) {
    const kind = row.target_kind;
    if (!kind) {
      continue;
    }
    const record = row.record;
    const target = await targetInfo(env, kind, row.target_id, config, servers, nowTs);
    if (!target) {
      continue;
    }
    const live = desiredIp(target);
    if (!live) {
      continue;
    }
    if (!force && live === row.last_ip && row.last_status.startsWith("✅")) {
      continue;
    }
    // 刚失败过的记录先冷静一会儿：坏记录每轮都重试只会把 60 秒的巡检拖长。
    // 手动「立即同步」force=True，不受此限。
    if (!force) {
      const cooled = await repo.flagAge(env, `dns_retry:${record}`);
      if (cooled >= 0 && cooled < RETRY_COOLDOWN) {
        continue;
      }
      // 换班进行中（且没卡死）：解析交给换班结算统一改。
      if (await shiftHold(env, kind, row.target_id, nowTs)) {
        continue;
      }
    }

    const previous = row.last_ip;
    const result = await syncRecord(env, record, config, { ip: live, force });
    results.push({ record, target: target.label, ip: live, status: result.status });
    if (result.status === ddns.STATUS_SYNCED || result.status === ddns.STATUS_UNCHANGED) {
      await repo.clearFlag(env, `dns_retry:${record}`);
      await repo.clearFlagsLike(env, `dns_fail:${record}:`);
      if (previous !== live && !(await shiftBusy(env, kind, row.target_id))) {
        await repo.addEvent(env, "dns", messages.ev("DNS 记录已更新", messages.objServer(record)), {
          detail: `${previous || "—"} → ${live}（${target.label}）`,
        });
      }
    } else {
      // 同一类失败不要每分钟刷一条
      const flag = `dns_fail:${record}:${result.status}`;
      if (!(await repo.getFlag(env, flag))) {
        await repo.setFlag(env, flag);
        await repo.addEvent(env, "error", messages.ev(result.status, messages.objServer(record)), {
          detail: result.detail || target.label || "",
          level: "warning",
        });
      }
      // 冷却计时从现在开始：set_flag 是 ON CONFLICT DO NOTHING，必须先清再置。
      await repo.clearFlag(env, `dns_retry:${record}`);
      await repo.setFlag(env, `dns_retry:${record}`);
    }
  }
  return results;
}

// --------------------------------------------------------------------------
// 绑定
// --------------------------------------------------------------------------

export interface BindResult {
  record: string;
  target: DnsTarget | null;
  records: string[];
  sync?: { status: string; detail: string; ip: string };
}

export async function bind(
  env: Env,
  record: string,
  kind: string,
  targetId: number,
  config?: Record<string, string> | null,
): Promise<BindResult> {
  const name = normalize(record);
  if (name === "") {
    throw new Error("域名不能为空");
  }
  if ((await repo.getDnsRecord(env, name)) === null) {
    throw new Error(`${name} 不在记录名列表里，请先在设置里添加`);
  }
  if (!kind) {
    await repo.bindDnsRecord(env, name, TARGET_NONE, 0);
    // 解绑后清掉残留的解析状态，界面别再把旧 IP 显示成「当前解析」
    await repo.setDnsState(env, name, "", "");
    return { record: name, target: null, records: [] };
  }

  if (kind !== TARGET_SERVER && kind !== TARGET_GROUP) {
    throw new Error("只能绑定到服务器或换班组");
  }
  if (kind === TARGET_SERVER && (await repo.getServer(env, targetId)) === null) {
    throw new Error("服务器不存在");
  }
  if (kind === TARGET_GROUP && (await repo.getGroup(env, targetId)) === null) {
    throw new Error("换班组不存在");
  }

  // 一条记录只属于一个目标；但一个目标可以挂多条记录。
  await repo.bindDnsRecord(env, name, kind, targetId);
  const target = await targetInfo(env, kind, targetId, config);
  const label = (target && target.label) || `#${targetId}`;
  const records = await repo.dnsRecordsOf(env, kind, targetId);
  const result: BindResult = { record: name, target, records };

  // 绑完立刻同步一次：用户刚把域名指到这台机器/这个换班组，不该等到下一轮
  // 巡检（最长一分钟）才生效。目标没在跑就只写状态，不硬塞 IP。
  let synced: DDNSResult | null = null;
  if (config !== null && config !== undefined && config["ddns_enabled"] === "1") {
    synced = await syncRecord(env, name, config);
    result.sync = { status: synced.status, detail: synced.detail, ip: synced.ip };
  }

  let summary = `已指向 ${label}`;
  if (records.length > 1) {
    summary += `（该目标现有 ${records.length} 条记录）`;
  }
  const syncedReport = synced !== null ? report([name], [synced]) : null;
  if (syncedReport !== null) {
    summary += ` / ${syncedReport.brief}`;
  }
  // detail 留空：一次性事件会把 detail 按行拆成过程条目，这里概览和过程要分开写。
  const eventId = await repo.addEvent(env, "dns", messages.ev("DNS 绑定已更新", name), {
    detail: "",
  });
  await repo.addEventProgress(env, eventId, `已指向 ${label}`);
  if (syncedReport !== null) {
    await repo.addEventProgress(env, eventId, `DDNS：${syncedReport.detail}`);
  }
  await repo.updateEvent(env, eventId, { detail: summary });
  return result;
}

// --------------------------------------------------------------------------
// 界面快照
// --------------------------------------------------------------------------

export interface DnsSnapshotRecord {
  record: string;
  target: DnsTarget | null;
  last_ip: string;
  last_status: string;
  last_at: number;
  desired_ip: string;
  state: string;
}

export interface DnsSnapshot {
  enabled: boolean;
  provider: string;
  configured: boolean;
  ttl: string;
  proxied: boolean;
  records: DnsSnapshotRecord[];
}

export async function snapshot(
  env: Env,
  config: Record<string, string>,
  nowTs?: number,
): Promise<DnsSnapshot> {
  // 只读：记录名与表的同步在启动（main）和保存设置时做，
  // 否则每次打开 DNS 页（GET）都会写一次库。
  const servers = await serversById(env);
  const now = nowTs ?? Date.now() / 1000;

  const records: DnsSnapshotRecord[] = [];
  for (const row of await repo.listDnsRecords(env)) {
    const record = row.record;
    const target = await targetInfo(env, row.target_kind, row.target_id, config, servers, now);
    records.push({
      record,
      target,
      last_ip: row.last_ip,
      last_status: row.last_status,
      last_at: row.last_at,
      desired_ip: desiredIp(target),
      state: stateOf(row, target),
    });
  }

  return {
    enabled: config["ddns_enabled"] === "1",
    provider: config["ddns_provider"] || "cloudflare",
    configured: Boolean(config["ddns_cf_token"]) || Boolean(config["ddns_cf_email"] && config["ddns_cf_key"]),
    ttl: config["ddns_ttl"] || "60",
    proxied: config["ddns_proxied"] === "1",
    records,
  };
}

export interface RecordBooks {
  servers: Record<number, string[]>;
  groups: Record<number, string[]>;
}

/** 每台服务器 / 每个换班组当前占着哪些记录，界面用来显示「已绑定 xxx」。 */
export async function recordBooks(env: Env): Promise<RecordBooks> {
  const serverMap: Record<number, string[]> = {};
  const groupMap: Record<number, string[]> = {};
  for (const row of await repo.listDnsRecords(env)) {
    const kind = row.target_kind;
    if (!kind) {
      continue;
    }
    if (kind === TARGET_SERVER) {
      const bucket = serverMap[row.target_id] ?? [];
      bucket.push(row.record);
      serverMap[row.target_id] = bucket;
    } else if (kind === TARGET_GROUP) {
      const bucket = groupMap[row.target_id] ?? [];
      bucket.push(row.record);
      groupMap[row.target_id] = bucket;
    }
  }
  return { servers: serverMap, groups: groupMap };
}

/** `booksForCards` 的输入：`recordBooks()` 的返回值，或等价的裸对象。 */
export type BooksInput =
  | RecordBooks
  | Record<string, Record<number, string[]>>
  | null
  | undefined;

/** 服务器卡片用：把换班组绑定的域名挂到「此刻当班」那台机器上。 */
export async function booksForCards(
  env: Env,
  nowTs?: number,
  books?: BooksInput,
): Promise<Record<number, string[]>> {
  const raw = books as unknown as Record<string, unknown> | null | undefined;
  const serverBooks = (raw?.["servers"] as Record<number, string[]> | undefined) ?? {};
  const groupBooks = (raw?.["groups"] as Record<number, string[]> | undefined) ?? {};
  let resolved: RecordBooks;
  if (raw && (raw["servers"] !== undefined || raw["groups"] !== undefined)) {
    resolved = { servers: serverBooks, groups: groupBooks };
  } else if (raw) {
    // 裸的 {serverId: [...]} 形状：当作 servers 处理
    resolved = { servers: raw as Record<number, string[]>, groups: {} };
  } else {
    resolved = await recordBooks(env);
  }
  const merged: Record<number, string[]> = {};
  for (const [serverId, names] of Object.entries(resolved.servers)) {
    merged[Number(serverId)] = [...names];
  }
  const groupMap = resolved.groups ?? {};
  if (Object.keys(groupMap).length === 0) {
    return merged;
  }

  const now = nowTs ?? Date.now() / 1000;
  const servers = await serversById(env);
  for (const [groupId, names] of Object.entries(groupMap)) {
    const group = await repo.getGroup(env, Number(groupId));
    if (!group) {
      continue;
    }
    const runner = await groupRunner(env, group, now, servers, "Asia/Shanghai");
    if (!runner) {
      continue;
    }
    const bucket = merged[runner.serverId] ?? [];
    for (const name of names) {
      if (!bucket.includes(name)) {
        bucket.push(name);
      }
    }
    merged[runner.serverId] = bucket;
  }
  return merged;
}
