/**
 * Billing snapshot: this month's instance bill (DescribeInstanceBill) +
 * account balance (QueryAccountBalance), persisted to D1.
 *
 * Port of `app/billing.py` (BeacherZ/cdt-management, commit 3ccf6a7).
 *
 * Cache strategy (same three layers as Python):
 *   1. `aliyun.getAccountBalance` in-memory 6h TTL (balance);
 *   2. D1 (`servers.monthly_cost` etc.) so a restart does not re-query;
 *   3. `billing_cycle` remembers which month the figures belong to.
 *
 * Event titles use the real `messages.ev` / `messages.objServer`.
 *
 * NOTE: Python billing.py never calls `updateServerRuntime` — shift.ts does
 * — so it is not imported here even though the task listed it.
 */

import type { Env } from "./env";
import {
  getAccountBalance,
  getInstanceBill,
  type AliyunAccount,
} from "./aliyun";
import {
  addEvent,
  getServer,
  getSettings,
  listServers,
  normalizeSite,
  updateServerBilling,
  updateServerSite,
  type ServerView,
} from "./repo";
import { ev, objServer } from "./messages";

// Billing refresh interval default (seconds); the real value comes from the
// `billing_interval` setting. Python: DEFAULT_BILL_TTL = 10 * 60.
export const DEFAULT_BILL_TTL = 10 * 60;

export interface BillingSnapshot {
  monthly_cost: number | null;
  balance: number | null;
  currency: string;
  cycle: string;
  error: string;
}

export interface BillingSummary {
  monthly_cost: number | null;
  balance: number | null;
  currency: string;
  cycle: string;
  stale: boolean;
  updated_at: number;
  error: string;
}

function billTtl(config: Record<string, string>): number {
  const raw = parseInt(config["billing_interval"] ?? "", 10);
  if (Number.isFinite(raw)) return Math.max(60, raw);
  return DEFAULT_BILL_TTL;
}

/** Current billing cycle (YYYY-MM) in the configured timezone (default Asia/Shanghai). */
export function currentCycle(config?: Record<string, string> | null): string {
  const tz = (config ?? {})["timezone"] || "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    const year = parts.find((p) => p.type === "year")?.value ?? "1970";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    return `${year}-${month}`;
  } catch {
    // Unknown/invalid timezone: fall back to UTC+8 (Asia/Shanghai offset).
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}

/**
 * Whether billing lookup is enabled. Sync by design (no env param): pass the
 * settings dict from `repo.getSettings(env)`; with no config it defaults to
 * enabled, matching Python's `billing_enabled` default of "1".
 */
export function enabled(config?: Record<string, string> | null): boolean {
  return ((config ?? {})["billing_enabled"] ?? "1") === "1";
}

function toAccount(server: ServerView): AliyunAccount {
  return {
    access_key_id: server.access_key_id,
    access_key_secret: server.access_key_secret ?? "",
    region_id: server.region_id,
    site: server.site || "china",
    instance_id: server.instance_id,
    stop_mode: server.stop_mode || undefined,
    quota_gb: server.quota_gb,
  };
}

/**
 * Fetch one server's bill + balance and persist the snapshot.
 * Returns the snapshot, or null when billing is disabled or the server
 * does not exist. The two APIs fail independently: a balance permission
 * error must not discard the bill figure (and vice versa).
 */
export async function refreshServer(
  env: Env,
  serverId: number,
  options?: { force?: boolean },
): Promise<BillingSnapshot | null> {
  const force = options?.force ?? false;
  const config = await getSettings(env);
  if (!enabled(config)) return null;

  const server = await getServer(env, serverId, true);
  if (server === null) return null;

  const cycle = currentCycle(config);
  const account = toAccount(server);
  let cost: number | null = null;
  let balance: number | null = null;
  let currency = "";
  let detectedSite = "";
  const errors: string[] = [];

  try {
    const bill = await getInstanceBill(env, account, cycle);
    cost = bill.total;
    detectedSite = bill.site;
  } catch (exc) {
    errors.push(exc instanceof Error ? exc.message : String(exc));
  }

  try {
    const wallet = await getAccountBalance(env, account, force);
    currency = wallet.currency;
    detectedSite = detectedSite || wallet.site;
    balance = wallet.amount;
  } catch (exc) {
    errors.push(exc instanceof Error ? exc.message : String(exc));
  }

  // BSS tells us which site the account really belongs to; correct the
  // stored site instead of making the user guess from AuthSiteFail.
  const configuredSite = normalizeSite(server.site);
  if (detectedSite && detectedSite !== configuredSite) {
    await updateServerSite(env, serverId, detectedSite);
    await addEvent(
      env,
      "billing",
      ev("站点已自动纠正", objServer(server.label)),
      `已纠正 / ${configuredSite} → ${detectedSite}（阿里云返回的站点与配置不一致，费用接口按实际站点走）`,
      { serverId },
    );
  }

  const errorText = errors.join("；");
  await updateServerBilling(env, serverId, {
    monthlyCost: cost,
    balance,
    currency,
    cycle: cost !== null ? cycle : "",
    error: errorText,
  });
  await markTransition(env, server, errorText);
  return { monthly_cost: cost, balance, currency, cycle, error: errorText };
}

/**
 * Refresh only the servers whose snapshot is stale. Returns how many were
 * actually refreshed. Never throws — a billing failure must not kill the
 * scheduler loop.
 */
export async function refreshDue(env: Env, nowTs?: number): Promise<number> {
  const config = await getSettings(env);
  if (!enabled(config)) return 0;

  const now = nowTs ?? Date.now() / 1000;
  const ttl = billTtl(config);
  const currentCycleName = currentCycle(config);
  let refreshed = 0;
  for (const server of await listServers(env)) {
    if (!server.secret_configured) continue;
    const last = server.billing_updated_at;
    const cycle = server.billing_cycle;
    // Cross-month refreshes immediately; an empty cycle means the last
    // attempt failed, which is still throttled by TTL so a BSS-permission-less
    // account is not hammered every 60s.
    if (last && now - last < ttl && (cycle === "" || cycle === currentCycleName)) continue;
    try {
      if ((await refreshServer(env, server.id)) !== null) refreshed += 1;
    } catch {
      // Swallowed on purpose (mirrors Python's log.exception + continue).
    }
  }
  return refreshed;
}

/**
 * Only record an event on a success<->failure transition, so a permanently
 * permission-less account does not flood the event stream every round.
 */
async function markTransition(env: Env, server: ServerView, errorText: string): Promise<void> {
  const wasError = server.billing_error.trim() !== "";
  const nowError = errorText !== "";
  if (wasError === nowError) return;
  if (nowError) {
    await addEvent(
      env,
      "error",
      ev("费用查询失败", objServer(server.label)),
      `${errorText}（缺 BSS 权限时可在设置里关闭费用查询）`,
      { level: "warning", serverId: server.id },
    );
  } else {
    await addEvent(
      env,
      "billing",
      ev("费用已恢复", objServer(server.label)),
      "已恢复 / 账单与余额查询正常",
      { serverId: server.id },
    );
  }
}

/**
 * Turn the stored snapshot into a frontend-friendly structure.
 * `stale=true` means the figures are from a previous month — the UI should
 * show "待更新" instead of presenting them as this month's cost.
 */
export function summaryOf(
  server: ServerView,
  config?: Record<string, string> | null,
): BillingSummary {
  const cycle = server.billing_cycle;
  const nowCycle = currentCycle(config);
  return {
    monthly_cost: server.monthly_cost,
    balance: server.balance_amount,
    currency: server.billing_currency || "CNY",
    cycle,
    stale: Boolean(cycle) && cycle !== nowCycle,
    updated_at: Math.trunc(server.billing_updated_at),
    error: server.billing_error,
  };
}

/**
 * CONTRACT: `sdkOk() => false`. There is no Aliyun SDK in Workers (the RPC
 * signature is implemented from scratch in aliyun.ts), so this is always
 * false — unlike Python's `aliyun.sdk_ready() or settings.DRY_RUN`, which
 * returns True in dry-run. Dry-run capability is detected via
 * `env.CDT_DRY_RUN === "1"` instead; do not gate live behaviour on this.
 */
export function sdkOk(): boolean {
  return false;
}
