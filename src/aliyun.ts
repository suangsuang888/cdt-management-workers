/**
 * Aliyun ECS / CDT / BSS client for Cloudflare Workers.
 *
 * Port of `app/aliyun.py` (BeacherZ/cdt-management, commit 3ccf6a7).
 *
 * The Python code uses the official Aliyun SDK (`AcsClient` /
 * `CommonRequest`), which is not available in Workers. The RPC signature is
 * therefore implemented from scratch here with WebCrypto:
 *   - percent-encoding per RFC 3986
 *   - SignatureMethod=HMAC-SHA1, SignatureVersion=1.0
 *   - SignatureNonce (random), Timestamp (UTC ISO-8601)
 *   - HMAC-SHA1 over `GET&%2F&<canonical query>` with key
 *     `accessKeySecret + "&"`, base64-encoded
 * All RPC calls are plain GET requests with the signed query string; the
 * Aliyun RPC APIs accept GET for every action used here.
 *
 * NEVER log or return secrets: error messages are redacted/classified by
 * `briefError` (mirrors the Python `_redact` / `brief_error`).
 *
 * Dry-run: when `env.CDT_DRY_RUN === "1"`, no live call is made; per-instance
 * state lives in a module-level `Map` (persists across calls within one
 * isolate) and mirrors `app/aliyun.py` `_mock` / `_mock_advance`, with the
 * async start/stop delay from `CDT_MOCK_OP_DELAY` (seconds, default 3).
 */

import type { Env } from "./env";
import { listServers } from "./repo";

export class AliyunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliyunError";
  }
}

/** Account record, snake_case as stored in D1 (see `repo.getServer`). */
export interface AliyunAccount {
  access_key_id: string;
  access_key_secret: string;
  region_id: string;
  site: string;
  instance_id: string;
  stop_mode?: string;
  /** Only used by the dry-run mock to derive demo traffic/cost. */
  quota_gb?: number;
}

export interface InstanceInfo {
  status: string;
  stoppedMode: string;
  publicIp: string;
  regionId: string;
}

export interface AccountBalance {
  amount: number;
  currency: string;
  site: string;
}

export interface InstanceBill {
  total: number;
  site: string;
}

// ---------------------------------------------------------------------------
// Endpoints (aliyun.py: _endpoints / bss_endpoint, lines ~150-175)
// ---------------------------------------------------------------------------

export const CDT_DOMAIN = "cdt.aliyuncs.com";
// CDT is a centralised API, region-independent; upstream fixes it to Hong Kong.
export const CDT_REGION = "cn-hongkong";

export const BSS_VERSION = "2017-12-14";
export const ECS_VERSION = "2014-05-26";
export const CDT_VERSION = "2021-08-13";

const BSS_ENDPOINTS: Record<string, { region: string; domain: string }> = {
  china: { region: "cn-hangzhou", domain: "business.aliyuncs.com" },
  international: { region: "ap-southeast-1", domain: "business.ap-southeast-1.aliyuncs.com" },
};

export function ecsDomain(region: string): string {
  return `ecs.${region}.aliyuncs.com`;
}

/** Returns `{region, domain}` for BSS (balance/bill) by site; unknown site -> china. */
export function bssEndpoint(site: string): { region: string; domain: string } {
  return BSS_ENDPOINTS[site] ?? BSS_ENDPOINTS["china"]!;
}

/**
 * Whether the Aliyun client is usable. There is no vendor SDK in Workers —
 * the RPC signature is implemented from scratch — so "ready" means at least
 * one registered server has its AccessKey secret configured. (Previously
 * this was hardcoded to `false`, which made the panel permanently show
 * "阿里云 SDK 未就绪" even with a working account.)
 */
export async function sdkReady(env: Env): Promise<boolean> {
  const servers = await listServers(env);
  return servers.some((s) => s.secret_configured);
}

// ---------------------------------------------------------------------------
// Error redaction / classification (aliyun.py: brief_error, lines ~80-135)
// ---------------------------------------------------------------------------

const NET_ERROR_HINTS = [
  "network is unreachable",
  "max retries exceeded",
  "newconnectionerror",
  "failed to establish a new connection",
  "connection refused",
  "connection reset",
  "connection aborted",
  "temporary failure in name resolution",
  "name or service not known",
];
const TIMEOUT_HINTS = ["timed out", "timeout", "readtimeout"];
const AUTH_ERROR_HINTS = [
  "signaturedoesnotmatch",
  "invalidaccesskeyid",
  "invalidaccesskeysecret",
  "authfailure",
  "authsitefail",
  "forbidden",
  "unauthorized",
  "accessdenied",
];
const THROTTLE_HINTS = ["throttling", "requestlimitexceeded", "serviceunavailable"];

const SECRET_PARAM_RE =
  /\b(Signature|AccessKeyId|AccessKeySecret|SecurityToken|SignatureNonce)=([^&\s'"]+)/gi;

function redact(text: string): string {
  return text
    .replace(SECRET_PARAM_RE, "$1=***")
    .replace(/<[^>]*object at 0x[0-9a-fA-F]+>/g, "<sdk-error>")
    .replace(/\b0x[0-9a-fA-F]{4,}\b/g, "0x***")
    .trim();
}

function errorHost(text: string): string {
  const m = /host=(?:'|")?([^'",\s)]+)/.exec(text);
  return m?.[1] ?? "";
}

/**
 * Compress a raw error into one human-readable, redacted line for events /
 * notifications. Mirrors Python `brief_error` (without SDK exception types).
 */
export function briefError(exc: unknown): string {
  const text = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
  const low = text.toLowerCase();
  const host = errorHost(text);
  if (NET_ERROR_HINTS.some((h) => low.includes(h))) {
    return host ? `网络不可达（${host}）` : "网络不可达";
  }
  if (TIMEOUT_HINTS.some((h) => low.includes(h))) {
    return host ? `连接超时（${host}）` : "连接超时";
  }
  if (AUTH_ERROR_HINTS.some((h) => low.includes(h))) {
    return "鉴权失败（AccessKey 无效或无权限）";
  }
  if (THROTTLE_HINTS.some((h) => low.includes(h))) {
    return "接口限流，稍后重试";
  }
  // Prefer an Aliyun error code + message when the body carried one.
  const code = (exc as { code?: unknown } | null)?.code;
  const message = (exc as { message?: unknown } | null)?.message;
  if (typeof code === "string" && code && !["sdk.httperror", "sdk.servererror", "sdk.clienterror"].includes(code.toLowerCase())) {
    return redact(typeof message === "string" && message ? `${code}：${message}` : code).slice(0, 140);
  }
  return redact(text).slice(0, 140);
}

// ---------------------------------------------------------------------------
// RPC signing (from scratch, WebCrypto)
// ---------------------------------------------------------------------------

/** RFC 3986 percent-encoding: encodeURIComponent plus ! ' ( ) * . */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function utcTimestamp(date = new Date()): string {
  // e.g. 2026-11-12T01:15:52Z
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Sign an Aliyun RPC request and return the full HTTPS URL (GET).
 * `params` are the action parameters (Action/Version/RegionId/...); the
 * common signing parameters are added here.
 */
export async function signRpcUrl(
  domain: string,
  account: AliyunAccount,
  params: Record<string, string>,
): Promise<string> {
  const all: Record<string, string> = {
    ...params,
    Format: "JSON",
    AccessKeyId: account.access_key_id,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: randomNonce(),
    Timestamp: utcTimestamp(),
  };
  const canonical = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k]!)}`)
    .join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(`${account.access_key_secret}&`, stringToSign);
  return `https://${domain}/?${canonical}&Signature=${percentEncode(signature)}`;
}

// ---------------------------------------------------------------------------
// RPC transport
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT_MS = 12_000; // settings.HTTP_TIMEOUT default 12s

interface RpcErrorBody {
  Code?: unknown;
  Message?: unknown;
  RequestId?: unknown;
}

async function rpcCall<T>(
  domain: string,
  account: AliyunAccount,
  params: Record<string, string>,
): Promise<T> {
  const url = await signRpcUrl(domain, account, params);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new AliyunError(briefError(err));
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AliyunError(`接口返回非 JSON（HTTP ${res.status}）`);
  }
  // NOTE: Aliyun RPC success responses may still carry a `Code` field —
  // BSS returns Code "200" (QueryAccountBalance) or "Success"
  // (DescribeInstanceBill) on success, while ECS responses carry no Code
  // at all. Treating any present Code as an error made every BSS query
  // fail with e.g. "Success：Successful!" / "200：success" even though the
  // call had succeeded. Only a non-2xx HTTP status or a non-success Code
  // is an error.
  const body = (data !== null && typeof data === "object" ? data : {}) as RpcErrorBody;
  const code = typeof body.Code === "string" ? body.Code : "";
  const message = typeof body.Message === "string" ? body.Message : "";
  const isSuccessCode = code === "" || code === "200" || code === "Success";
  if (!res.ok || !isSuccessCode) {
    const errCode = code || `HTTP_${res.status}`;
    const err = new AliyunError(message || errCode);
    // Attach the code so callers (site fallback, no-stock detection) can read it.
    (err as AliyunError & { code?: string }).code = errCode;
    throw err;
  }
  return data as T;
}

function errorCode(exc: unknown): string {
  if (exc instanceof AliyunError) {
    return (exc as AliyunError & { code?: string }).code ?? "";
  }
  return "";
}

// Site-selection errors (aliyun.py: _SITE_ERROR_HINTS, lines ~243-246).
const SITE_ERROR_HINTS = ["AuthSiteFail", "NotApplicable", "site matches", "AuthPrincipal"];

function looksLikeSiteError(exc: unknown): boolean {
  const text = `${errorCode(exc)} ${exc instanceof Error ? exc.message : String(exc)}`;
  return SITE_ERROR_HINTS.some((h) => text.includes(h));
}

// ---------------------------------------------------------------------------
// BSS (balance / bill) with site fallback (aliyun.py: _bss_request /
// _bss_with_site_fallback, lines ~217-282)
// ---------------------------------------------------------------------------

async function bssRequest(
  account: AliyunAccount,
  action: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const { region, domain } = bssEndpoint(account.site || "china");
  return rpcCall<Record<string, unknown>>(domain, account, {
    Action: action,
    Version: BSS_VERSION,
    RegionId: region,
    ...params,
  });
}

async function bssWithSiteFallback(
  account: AliyunAccount,
  action: string,
  params: Record<string, string> = {},
): Promise<{ data: Record<string, unknown>; site: string }> {
  const site = account.site || "china";
  try {
    return { data: await bssRequest(account, action, params), site };
  } catch (exc) {
    if (!looksLikeSiteError(exc)) throw exc;
    const other = site === "china" ? "international" : "china";
    try {
      const data = await bssRequest({ ...account, site: other }, action, params);
      return { data, site: other };
    } catch {
      // Fallback also failed: the original error is more informative.
      throw exc;
    }
  }
}

// Balance: 6h in-process TTL cache (aliyun.py: BALANCE_TTL / _balance_cache).
const BALANCE_TTL_MS = 6 * 3600 * 1000;
const balanceCache = new Map<string, { at: number; value: AccountBalance }>();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getAccountBalance(
  env: Env,
  account: AliyunAccount,
  force = false,
): Promise<AccountBalance> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    return {
      amount: parseFloat(state.balance),
      currency: state.currency,
      site: account.site || "china",
    };
  }
  const key = (await sha256Hex(`${account.access_key_id}:${account.site || "china"}`)).slice(0, 20);
  const now = Date.now();
  const cached = balanceCache.get(key);
  if (cached && !force && now - cached.at < BALANCE_TTL_MS) {
    return { ...cached.value };
  }
  let data: Record<string, unknown>;
  let site: string;
  try {
    ({ data, site } = await bssWithSiteFallback(account, "QueryAccountBalance"));
  } catch (exc) {
    throw new AliyunError(`账户余额查询失败：${briefError(exc)}`);
  }
  const payload = (data["Data"] as Record<string, unknown> | undefined) ?? {};
  const amountRaw = payload["AvailableAmount"];
  const amount = typeof amountRaw === "number" ? amountRaw : parseFloat(String(amountRaw ?? "0")) || 0;
  const currencyRaw = payload["Currency"];
  const currency = (typeof currencyRaw === "string" && currencyRaw.trim()) || "CNY";
  const value: AccountBalance = { amount, currency, site };
  balanceCache.set(key, { at: now, value });
  return { ...value };
}

export async function getInstanceBill(
  env: Env,
  account: AliyunAccount,
  cycle: string,
): Promise<InstanceBill> {
  if (isDryRun(env)) {
    return {
      total: Math.round(parseFloat(mockState(env, account).cost) * 100) / 100,
      site: account.site || "china",
    };
  }
  let data: Record<string, unknown>;
  let site: string;
  try {
    ({ data, site } = await bssWithSiteFallback(account, "DescribeInstanceBill", {
      BillingCycle: cycle,
      InstanceID: account.instance_id,
      Granularity: "MONTHLY",
      MaxResults: "300",
    }));
  } catch (exc) {
    throw new AliyunError(`实例账单查询失败：${briefError(exc)}`);
  }
  const dataObj = (data["Data"] as Record<string, unknown> | undefined) ?? {};
  let items: unknown = dataObj["Items"] ?? [];
  // Some responses wrap the array as {"Item": [...]}.
  if (items !== null && typeof items === "object" && !Array.isArray(items)) {
    items = (items as Record<string, unknown>)["Item"] ?? [];
  }
  let total = 0;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const v = (item as Record<string, unknown>)["PretaxAmount"];
      const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
      if (Number.isFinite(n)) total += n;
    }
  }
  return { total: Math.round(total * 100) / 100, site };
}

// ---------------------------------------------------------------------------
// CDT traffic (aliyun.py: get_traffic_gb, lines ~447-476)
// Action: ListCdtInternetTraffic, version 2021-08-13, domain cdt.aliyuncs.com,
// region cn-hongkong. Sums all TrafficDetails[].Traffic (bytes) -> GB.
// Returns null when the call succeeds but no detail rows are returned.
// ---------------------------------------------------------------------------

interface TrafficDetail {
  Traffic?: unknown;
}

export async function getTrafficGb(env: Env, account: AliyunAccount): Promise<number | null> {
  if (isDryRun(env)) {
    return parseFloat(mockState(env, account).traffic);
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(CDT_DOMAIN, account, {
      Action: "ListCdtInternetTraffic",
      Version: CDT_VERSION,
      RegionId: CDT_REGION,
    });
  } catch (exc) {
    throw new AliyunError(`CDT 流量查询失败：${briefError(exc)}`);
  }
  const details = (data["TrafficDetails"] as TrafficDetail[] | undefined) ?? [];
  if (!Array.isArray(details) || details.length === 0) return null;
  let totalBytes = 0;
  for (const item of details) {
    const v = item?.Traffic;
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
    if (Number.isFinite(n)) totalBytes += n;
  }
  return totalBytes / 1024 ** 3;
}

// ---------------------------------------------------------------------------
// ECS instances (aliyun.py: get_instance / start_instance / stop_instance,
// lines ~478-577). Actions: DescribeInstances / StartInstances /
// StopInstances, version 2014-05-26, domain ecs.<region>.aliyuncs.com.
// ---------------------------------------------------------------------------

interface EcsInstance {
  Status?: unknown;
  StoppedMode?: unknown;
  RegionId?: unknown;
  ZoneId?: unknown;
  EipAddress?: { IpAddress?: unknown };
  PublicIpAddress?: { IpAddress?: unknown };
}

export async function getInstance(env: Env, account: AliyunAccount): Promise<InstanceInfo> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    mockAdvance(state);
    return {
      status: state.status,
      stoppedMode: state.stopped_mode,
      publicIp: state.public_ip,
      regionId: account.region_id || "",
    };
  }
  let data: Record<string, unknown>;
  try {
    // DescribeInstancesRequest.set_InstanceIds takes a JSON array string.
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeInstances",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      InstanceIds: JSON.stringify([account.instance_id]),
    });
  } catch (exc) {
    if (exc instanceof AliyunError && exc.message.startsWith("实例状态查询失败")) throw exc;
    throw new AliyunError(`实例状态查询失败：${briefError(exc)}`);
  }
  const instances = ((data["Instances"] as Record<string, unknown> | undefined)?.["Instance"] as EcsInstance[] | undefined) ?? [];
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new AliyunError("实例状态查询失败：实例不存在或已释放，请检查实例 ID 与地域");
  }
  const inst = instances[0]!;
  const eip = inst.EipAddress?.IpAddress;
  let publicIp: string;
  if (eip) {
    publicIp = String(eip);
  } else {
    const addresses = inst.PublicIpAddress?.IpAddress;
    publicIp = Array.isArray(addresses) && addresses.length > 0 ? String(addresses[0]) : "";
  }
  const region = String(inst.RegionId ?? inst.ZoneId ?? "").trim();
  return {
    status: String(inst.Status ?? ""),
    stoppedMode: String(inst.StoppedMode ?? ""),
    publicIp,
    regionId: region,
  };
}

// Stock-out error codes on start (aliyun.py: _NO_STOCK_HINTS, lines ~520-524).
const NO_STOCK_HINTS = ["InsufficientInventory", "NoStock"];

export async function startInstance(env: Env, account: AliyunAccount): Promise<void> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    const delay = mockOpDelay(env);
    if (delay <= 0) {
      state.status = "Running";
      state.stopped_mode = "";
      state.pending_until = 0;
      state.target_status = "";
    } else {
      state.status = "Starting";
      state.stopped_mode = "";
      state.target_status = "Running";
      state.pending_until = Date.now() / 1000 + delay;
    }
    return;
  }
  try {
    // NOTE: the official SDK's StartInstancesRequest.set_InstanceIds
    // serialises the list as `InstanceId.1`, `InstanceId.2`, ... — note the
    // SINGULAR `InstanceId`, not `InstanceIds`. Both `InstanceIds.1` and
    // a JSON-array `InstanceIds` are rejected with MissingParameter
    // "InstanceId ... is not supplied" (verified live 2026-11-12).
    await rpcCall(ecsDomain(account.region_id), account, {
      Action: "StartInstances",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      "InstanceId.1": account.instance_id,
    });
  } catch (exc) {
    const raw = `${errorCode(exc)} ${exc instanceof Error ? exc.message : String(exc)}`;
    if (NO_STOCK_HINTS.some((h) => raw.includes(h))) {
      const code = errorCode(exc) || "InsufficientInventory";
      throw new AliyunError(`库存不足（${code}），${account.region_id || "该地域"} 暂无可用实例库存`);
    }
    throw new AliyunError(`启动实例失败：${briefError(exc)}`);
  }
}

/**
 * Stop the instance. `mode` defaults to "StopCharging" (saves instance fees).
 * With `fallback=true`, an unsupported StopCharging falls back to plain "Stop".
 * Returns the **actually applied** stopped mode ("Stop" when it fell back).
 */
export async function stopInstance(
  env: Env,
  account: AliyunAccount,
  mode = "StopCharging",
  fallback = false,
): Promise<string> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    const delay = mockOpDelay(env);
    if (delay <= 0) {
      state.status = "Stopped";
      state.stopped_mode = mode;
      state.pending_until = 0;
      state.target_status = "";
    } else {
      state.status = "Stopping";
      state.stopped_mode = mode;
      state.target_status = "Stopped";
      state.pending_until = Date.now() / 1000 + delay;
    }
    return mode;
  }
  const params: Record<string, string> = {
    Action: "StopInstances",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    // Same as StartInstances: the SDK uses singular `InstanceId.N`
    // (see above); `InstanceIds.1` / JSON array are rejected.
    "InstanceId.1": account.instance_id,
    StoppedMode: mode,
  };
  try {
    await rpcCall(ecsDomain(account.region_id), account, params);
    return mode;
  } catch (exc) {
    if (fallback && mode !== "Stop") {
      try {
        await rpcCall(ecsDomain(account.region_id), account, { ...params, StoppedMode: "Stop" });
        return "Stop";
      } catch (retryExc) {
        throw new AliyunError(`停止实例失败：${briefError(retryExc)}`);
      }
    }
    throw new AliyunError(`停止实例失败：${briefError(exc)}`);
  }
}

// ---------------------------------------------------------------------------
// Dry-run mock (aliyun.py: _mock / _mock_set / _mock_advance, lines ~330-420)
// Module-level Map: state persists across calls within one isolate, as the
// Python process-level `_MOCK` dict does. Workers isolates may be recycled,
// so mock state is not durable — that matches dry-run intent.
// ---------------------------------------------------------------------------

export function isDryRun(env: Env): boolean {
  return env.CDT_DRY_RUN === "1";
}

export function mockOpDelay(env: Env): number {
  const raw = parseFloat(env.CDT_MOCK_OP_DELAY ?? "3");
  return Number.isFinite(raw) ? Math.max(0, raw) : 3;
}

interface MockState {
  status: string;
  stopped_mode: string;
  public_ip: string;
  traffic: string;
  cost: string;
  balance: string;
  currency: string;
  pending_until: number; // epoch seconds, 0 = no operation in flight
  target_status: string;
}

const mockStates = new Map<string, MockState>();

function mockKey(account: AliyunAccount): string {
  return account.instance_id || account.access_key_id || "mock";
}

function mockState(env: Env, account: AliyunAccount): MockState {
  const key = mockKey(account);
  let state = mockStates.get(key);
  if (state === undefined) {
    const index = mockStates.size + 10;
    // Stable per-instance offset from the instance id hash, so demo figures
    // differ per server but do not jump between rounds (mirrors Python).
    const seed = Array.from(key).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const quota = account.quota_gb ?? 200;
    state = {
      status: "Stopped",
      stopped_mode: "StopCharging",
      // 47.243.x is an Aliyun Hong Kong public range; mock only, never written to DNS.
      public_ip: `47.243.${index}.${20 + index}`,
      traffic: (quota * 0.42).toFixed(2),
      cost: (quota * 0.072 + 9 + (seed % 420) / 100).toFixed(2),
      balance: `${800 + (seed % 1600)}.${((seed * 7) % 100).toString().padStart(2, "0")}`,
      currency: "CNY",
      pending_until: 0,
      target_status: "",
    };
    mockStates.set(key, state);
  }
  return state;
}

function mockAdvance(state: MockState): void {
  if (state.pending_until && state.target_status && Date.now() / 1000 >= state.pending_until) {
    state.pending_until = 0;
    const target = state.target_status;
    state.target_status = "";
    state.status = target;
    if (target === "Stopped") {
      state.stopped_mode = state.stopped_mode || "StopCharging";
    } else {
      state.stopped_mode = "";
    }
  }
}
