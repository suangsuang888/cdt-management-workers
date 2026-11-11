/**
 * Cloudflare DDNS。
 *
 * 对应 Python `app/ddns.py`。行为对齐用户脚本：先取 Record ID，再 PUT 更新
 * A 记录，失败重试 3 次，并把「已同步 / IP 无效跳过 / 获取 ID 失败 / 更新失败」
 * 这几种结果回传给通知文案。
 *
 * Workers 差异：
 * - 用全局 `fetch` 代替 requests；认证优先用 Worker Secret
 *   `CLOUDFLARE_API_TOKEN`（`Authorization: Bearer`），未设置时退回设置里的
 *   `ddns_cf_token`；Global Key 模式（`ddns_cf_auth_mode=global_key`）仍支持。
 * - 没有 `time.sleep`：重试间隔用 `setTimeout` 的 Promise 实现。
 * - 没有 IPv4 强制解析（原 `_force_ipv4` 改 urllib3 的 gai family），Workers
 *   的 fetch 由运行时解析，见 SIMPLIFIED 注释。
 * - `sync()` 的参数顺序按 CONTRACT：`sync(env, config, record?, ip?)`；
 *   Python 是 `sync(ip, config, force, record, verify)`，调用方注意区分。
 *   另有 `syncFull(env, config, {ip, force, record, verify})` 保留完整参数。
 */

import type { Env } from "./env";

export const API = "https://api.cloudflare.com/client/v4";
/** 与 Python `settings.HTTP_TIMEOUT`（12 秒）一致。 */
export const HTTP_TIMEOUT_MS = 12_000;

export const STATUS_SYNCED = "✅ 已同步";
// IP 没变、不需要动记录：对外文案和「已同步」统一，通知和事件进度里出现「无变化」
// 反而让用户以为没查。内部靠 DDNSResult.changed 区分，不靠文案。
export const STATUS_UNCHANGED = "✅ 已同步";
export const STATUS_INVALID_IP = "⚠️ IP 无效跳过";
export const STATUS_NO_RECORD_ID = "❌ 获取 ID 失败";
export const STATUS_UPDATE_FAILED = "❌ 更新失败";
export const STATUS_DISABLED = "⏸ 未启用";
export const STATUS_ERROR = "❌ 同步异常";
export const STATUS_OK = "✅ 连接正常";

/** 一次 DDNS 同步的结果。`toString()` 即 Python `DDNSResult.__str__`（直接塞进通知文案）。 */
export class DDNSResult {
  status: string;
  detail: string;
  changed: boolean;
  ip: string;
  // 更新前记录里的值：事件详情要写「旧 → 新」，通知里也能看出改了什么。
  // verify=True 时取自 Cloudflare 的实时内容；其余情况取本地缓存的上次 IP。
  previous: string;

  constructor(
    status: string,
    detail = "",
    changed = false,
    ip = "",
    previous = "",
  ) {
    this.status = status;
    this.detail = detail;
    this.changed = changed;
    this.ip = ip;
    this.previous = previous;
  }

  /** Python `__str__`：直接返回状态短句。 */
  toString(): string {
    return this.status;
  }

  /** 与 `toString()` 相同，供调用方在模板里显式使用。 */
  get brief(): string {
    return this.status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------
// 记录名
// --------------------------------------------------------------------------

export function isValidRecord(name: string): boolean {
  const n = (name ?? "").trim();
  return Boolean(n) && n.includes(".") && ![...n].some((ch) => /\s/.test(ch));
}

export function parseRecords(config: Record<string, string>): string[] | null {
  const raw = (config["ddns_records"] ?? "").trim();
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 手改过配置文件、写成一行一条的也认
    parsed = raw.split("\n");
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const items = parsed.map((item) => String(item).trim()).filter(Boolean);
  if (items.some((item) => !isValidRecord(item))) {
    return null;
  }
  return items;
}

export function records(config: Record<string, string>): string[] {
  let items = parseRecords(config);
  if (items === null) {
    // 读不懂就当没有：展示层退回「未配置」，不把垃圾值当域名去解析
    items = [];
  }
  if (items.length === 0) {
    const single = (config["ddns_record"] ?? "").trim();
    if (isValidRecord(single)) {
      items = [single];
    }
  }
  // 去重但保留顺序
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    if (!seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      unique.push(item);
    }
  }
  return unique;
}

export function defaultRecord(config: Record<string, string>): string {
  const items = records(config);
  return items.length > 0 ? (items[0] as string) : "";
}

function recordOf(config: Record<string, string>, record?: string | null): string {
  return (record ?? "").trim() || defaultRecord(config);
}

function headersFor(env: Env, config: Record<string, string>): Record<string, string> {
  const mode = (config["ddns_cf_auth_mode"] ?? "token").toLowerCase();
  if (mode === "global_key") {
    const email = config["ddns_cf_email"] ?? "";
    const key = config["ddns_cf_key"] ?? "";
    if (!email || !key) {
      throw new Error("Cloudflare Global API Key 模式需要同时填写邮箱和 Key");
    }
    return { "X-Auth-Email": email, "X-Auth-Key": key, "Content-Type": "application/json" };
  }
  // 优先用 Worker Secret，其次用设置里保存的 token。
  const token = (env.CLOUDFLARE_API_TOKEN ?? "").trim() || (config["ddns_cf_token"] ?? "");
  if (!token) {
    throw new Error("Cloudflare API Token 未配置");
  }
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// SIMPLIFIED: 原 `_force_ipv4` 改写 urllib3 的 DNS 解析族，Workers 运行时
// 没有这个钩子，fetch 的解析由 Cloudflare 运行时决定。
export function isPublicIpv4(value: string): boolean {
  const text = (value ?? "").trim();
  const parts = text.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || (part.length > 1 && part.startsWith("0"))) {
      return false;
    }
    octets.push(n);
  }
  const [a, b] = octets as [number, number];
  const ip = (((octets[0] as number) << 24) | ((octets[1] as number) << 16) | ((octets[2] as number) << 8) | (octets[3] as number)) >>> 0;
  // 私有：10/8、172.16/12、192.168/16、100.64/10（CGNAT）
  if (a === 10 || a === 127) return false; // 10/8 私有；127/8 回环
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false; // 链路本地
  if (a === 0) return false; // 0/8（本网络）
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 IETF 协议分配（含 192.0.0.0/29、192.0.2.0/24 文档段）
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 基准测试
  if (a === 198 && b === 51) return false; // 198.51.100/24 文档段
  if (a === 203 && b === 0 && octets[2] === 113) return false; // 203.0.113/24 文档段
  if (a >= 224 && a <= 239) return false; // 组播（Python is_reserved 不含它，但 DDNS 目标不可能是组播地址）
  if (a >= 240) return false; // 240/4 保留
  if (ip === 0xffffffff) return false; // 255.255.255.255
  return true;
}

function rootDomain(record: string): string {
  const parts = record.trim().split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : record;
}

async function resolveZoneId(
  headers: Record<string, string>,
  config: Record<string, string>,
  record: string,
): Promise<string> {
  const zoneId = (config["ddns_zone_id"] ?? "").trim();
  if (zoneId) {
    return zoneId;
  }
  if (!record) {
    throw new Error("DDNS 记录名未配置");
  }
  const root = rootDomain(record);
  const url = `${API}/zones?name=${encodeURIComponent(root)}&status=active`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    result?: Array<{ id: string }>;
  };
  const zones = payload.result ?? [];
  if (response.status !== 200 || zones.length === 0) {
    throw new Error(`无法自动识别 ${root} 的 Zone ID，请手动填写`);
  }
  return String((zones[0] as { id: string }).id);
}

/** 查询记录，返回 [记录 ID, 当前指向的 IP]。 */
async function findRecord(
  headers: Record<string, string>,
  zoneId: string,
  record: string,
): Promise<[string, string] | null> {
  const url =
    `${API}/zones/${zoneId}/dns_records` +
    `?name=${encodeURIComponent(record)}&type=A`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    console.warn(`查询 DNS 记录失败 HTTP ${response.status}`);
    return null;
  }
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    result?: Array<{ id: string; content?: string }>;
  };
  if (payload.success && payload.result && payload.result.length > 0) {
    const item = payload.result[0] as { id: string; content?: string };
    return [String(item.id), String(item.content ?? "")];
  }
  return null;
}

export interface SyncOptions {
  ip: string;
  force?: boolean;
  record?: string | null;
  verify?: boolean;
}

/**
 * 把 ip 同步到 Cloudflare A 记录。
 * record 为空时用默认记录（第一条）；换班组可以指定自己那一条。
 * verify=True 用于「实例刚开机 / 刚换班」这类关键时刻：不信本地缓存，先查一次
 * Cloudflare 上记录的真实值，一致就不 PUT、直接算「未变化」。
 */
export async function syncFull(
  env: Env,
  config: Record<string, string>,
  options: SyncOptions,
): Promise<DDNSResult> {
  const { ip, force = false, record = null, verify = false } = options;
  if (config["ddns_enabled"] !== "1") {
    return new DDNSResult(STATUS_DISABLED, "", false, ip);
  }

  const name = recordOf(config, record);
  if (!name) {
    return new DDNSResult(STATUS_ERROR, "记录名未配置", false, ip);
  }
  if (!isPublicIpv4(ip)) {
    console.warn(`DDNS 跳过：IP 不可用 (${ip})`);
    return new DDNSResult(STATUS_INVALID_IP, `IP=${ip || "空"}`, false, ip);
  }

  if (env.CDT_DRY_RUN === "1") {
    // 演示/截图模式：照常走完上面的校验，但不碰真实的 Cloudflare
    const previous = String(config["ddns_last_ip"] ?? "");
    console.info(`DRY RUN：假装已把 ${name} 同步到 ${ip}`);
    const same = verify && !force && previous === ip;
    return new DDNSResult(
      same ? STATUS_UNCHANGED : STATUS_SYNCED,
      same ? "IP 未变化" : `${name} → ${ip}`,
      !same,
      ip,
      previous,
    );
  }

  // 记录名与 IP 都没变就免掉一次 API 调用。verify 时不走这条：用户要的就是
  // 「去 Cloudflare 看一眼真实值」，本地缓存算出来的结论不作数。
  if (
    !force &&
    !verify &&
    config["ddns_last_ip"] === ip &&
    (config["ddns_last_status"] ?? "").startsWith("✅")
  ) {
    return new DDNSResult(
      STATUS_UNCHANGED,
      "IP 未变化",
      false,
      ip,
      String(config["ddns_last_ip"] ?? ""),
    );
  }

  // 认证/Zone 这类配置问题重试也没用，先一次性判掉，别白等 6 秒
  let headers: Record<string, string>;
  let zoneId: string;
  try {
    headers = headersFor(env, config);
    zoneId = await resolveZoneId(headers, config, name);
  } catch (exc) {
    if (exc instanceof Error && /未配置|需要同时填写/.test(exc.message)) {
      return new DDNSResult(STATUS_ERROR, exc.message, false, ip);
    }
    console.warn(`DDNS 初始化失败: ${exc}`);
    return new DDNSResult(STATUS_ERROR, `无法连接 Cloudflare：${exc}`, false, ip);
  }

  let lastError = "";
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const found = await findRecord(headers, zoneId, name);
      if (!found) {
        lastError = "记录不存在或查询失败";
        if (attempt < attempts) {
          await sleep(1000);
        }
        continue;
      }
      const [recordId, current] = found;

      // 关键时刻已核对过真实值：CF 上就是这台机器的 IP，再 PUT 一遍只会
      // 白白刷新记录的修改时间，事件里还得写「已更新」，属于谎报。
      if (verify && !force && current === ip) {
        console.info(`DDNS 已是最新 ${name} -> ${ip}，跳过更新`);
        return new DDNSResult(STATUS_UNCHANGED, "IP 未变化", false, ip, current);
      }

      const response = await fetch(`${API}/zones/${zoneId}/dns_records/${recordId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          type: "A",
          name,
          content: ip,
          ttl: Number(config["ddns_ttl"] ?? 60) || 60,
          proxied: config["ddns_proxied"] === "1",
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
      };
      if (response.status === 200 && payload.success) {
        console.info(`DDNS 更新成功 ${name} -> ${ip}`);
        return new DDNSResult(STATUS_SYNCED, `${name} → ${ip}`, true, ip, current);
      }
      lastError = `HTTP ${response.status}`;
      console.warn(`DDNS 第 ${attempt} 次更新失败: ${lastError}`);
    } catch (exc) {
      lastError = String(exc);
      console.warn(`DDNS 第 ${attempt} 次更新异常: ${lastError}`);
    }
    if (attempt < attempts) {
      await sleep(1000);
    }
  }

  if (lastError.includes("Zone ID")) {
    return new DDNSResult(STATUS_ERROR, lastError, false, ip);
  }
  if (lastError.includes("记录")) {
    return new DDNSResult(STATUS_NO_RECORD_ID, lastError, false, ip);
  }
  return new DDNSResult(STATUS_UPDATE_FAILED, lastError, false, ip);
}

/**
 * CONTRACT 入口：`sync(env, config, record?, ip?)`。
 * record 为空用默认记录；ip 为空时无法同步，返回「IP 无效跳过」。
 */
export async function sync(
  env: Env,
  config: Record<string, string>,
  record?: string | null,
  ip?: string,
): Promise<DDNSResult> {
  return syncFull(env, config, { ip: ip ?? "", record: record ?? null });
}

/** 连通性自检：只读，不改记录。多条记录逐条查一遍。 */
export async function test(env: Env, config: Record<string, string>): Promise<DDNSResult> {
  const names = records(config);
  if (names.length === 0) {
    return new DDNSResult(STATUS_ERROR, "记录名未配置");
  }
  if (env.CDT_DRY_RUN === "1") {
    return new DDNSResult(
      STATUS_OK,
      `${names.length} 条记录（DRY RUN，未真的访问 Cloudflare）`,
    );
  }
  try {
    const headers = headersFor(env, config);
    // 每条记录各自解析 Zone：多条域名可能落在不同 Zone。
    const zones: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const zoneId = await resolveZoneId(headers, config, name);
      zones.push(zoneId);
      if (!(await findRecord(headers, zoneId, name))) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      return new DDNSResult(STATUS_NO_RECORD_ID, `${missing.join("、")} 未找到 A 记录`);
    }
    const detail =
      names.length === 1
        ? `Zone ${(zones[0] as string).slice(0, 8)}… / ${names[0]} 已就绪`
        : `${names.length} 条记录均就绪`;
    return new DDNSResult(STATUS_OK, detail);
  } catch (exc) {
    return new DDNSResult(STATUS_ERROR, exc instanceof Error ? exc.message : String(exc));
  }
}
