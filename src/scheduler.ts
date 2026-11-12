/**
 * Scheduler — TypeScript port of `app/scheduler.py` `_loop` body.
 *
 * One `runReconcile(env)` call is one reconcile round; it is invoked by
 * the Workers Cron Trigger (every minute, see wrangler.toml) and by
 * `scheduled()` in `index.ts`.
 *
 * DEGRADATIONS vs the Python original (deliberate — Workers has no
 * long-lived threads):
 * - No 5-second event-confirm thread (`_confirm_loop` /
 *   `_confirm_pending_events`). A manual start/stop (or any event waiting
 *   for an instance state) is only confirmed on the next reconcile step,
 *   i.e. on the next 1-minute cron tick, instead of within ~5 seconds.
 *   Confirmation logic lives in `shift.ts` (`confirmPendingEvents`,
 *   called from `reconcileAll`): it covers manual, keepalive,
 *   keepalive_stop and limit_stop events, sends the keepalive
 *   "抢占恢复" notification (gated by `notify_on_keepalive`, silent for
 *   window-resume events), and times out non-keepalive waits after
 *   10 minutes so a stuck event can never block later manual control.
 * - No fast-reconcile window (`request_fast_reconcile`, 10 s interval for
 *   90 s after a group is created). The cron interval is fixed at 1
 *   minute; the API's group-save handler still bootstraps a new group
 *   synchronously, so the "save and see members settle" behaviour is
 *   preserved for that path. Use POST /api/v1/reconcile for an on-demand
 *   round instead of waiting for the next tick.
 * - No grid alignment to `reconcile_offset`: Workers Cron Triggers fire
 *   at minute boundaries, so the configured "巡检起始秒" offset is
 *   effectively ignored. The `reconcile_interval` setting is likewise
 *   not honoured by the trigger (minimum cron cadence is 1 minute);
 *   `CDT_RECONCILE_INTERVAL` only matters if a future driver re-implements
 *   the wait loop.
 * - No wake-up signal (`_wake`): on-demand rounds go through the API.
 * - Daily-report dedup and the hourly prune timestamp are kept in D1
 *   flags (`daily_report:<date>` is checked inside `engine.dailyReport`;
 *   `scheduler_last_prune` here) instead of module globals, because a
 *   Workers isolate may be recycled between ticks and globals do not
 *   survive across isolates.
 */

import type { Env } from "./env";
import * as repo from "./repo";
import * as dns from "./dns";
import * as billing from "./billing";
import { dailyReport, reconcileAll } from "./shift";
import { resolveSettings } from "./settings";

const PRUNE_INTERVAL_SECONDS = 3600;
const LAST_PRUNE_FLAG = "scheduler_last_prune";

function tzParts(tzName: string, at: Date): { hour: number; minute: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  let hour = Number(parts["hour"]);
  if (hour === 24) hour = 0;
  return {
    hour,
    minute: Number(parts["minute"]),
    dateStr: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
  };
}

async function maybeDailyReport(env: Env): Promise<void> {
  const config = await repo.getSettings(env);
  if (config["daily_report_enabled"] !== "1") return;
  if ((await repo.getSetting(env, "initialized")) !== "1") return;

  const tzName = config["timezone"] || "Asia/Shanghai";
  const now = new Date();
  const { hour, minute } = tzParts(tzName, now);
  const target = config["daily_report_time"] || "23:58";
  const [targetHour, targetMinute] = target.split(":").map((v) => Number(v) || 0);
  // "Has the target time passed today?" — not "is it exactly this minute",
  // so a restart at 23:59 still delivers the report (same as Python).
  if (hour * 60 + minute < (targetHour ?? 23) * 60 + (targetMinute ?? 58)) return;
  // dailyReport() itself dedupes via the `daily_report:<date>` flag in D1,
  // so calling it every minute after the target time is a cheap no-op.
  await dailyReport(env);
}

export async function runReconcile(env: Env): Promise<void> {
  try {
    await reconcileAll(env);
  } catch (e) {
    console.error("reconcile round failed", e);
  }

  try {
    await maybeDailyReport(env);
  } catch (e) {
    console.error("daily report check failed", e);
  }

  // DNS: only issues real requests when a target is running but its
  // resolution disagrees; steady state costs nothing.
  try {
    await dns.reconcile(env, await repo.getSettings(env));
  } catch (e) {
    console.error("DNS reconcile failed", e);
  }

  // Billing is slow data; refreshDue() applies its own ~30 min TTL and
  // only calls out when a snapshot is actually due.
  try {
    await billing.refreshDue(env);
  } catch (e) {
    console.error("billing refresh failed", e);
  }

  // Hourly prune of old events. The timestamp is a D1 flag (see header):
  // flags are presence-only, so `flagAge` reads the `created_at` of the
  // last prune and clear+set refreshes it.
  try {
    const age = await repo.flagAge(env, LAST_PRUNE_FLAG);
    if (age < 0 || age > PRUNE_INTERVAL_SECONDS) {
      await repo.pruneEvents(env, resolveSettings(env).eventRetainDays);
      await repo.clearFlag(env, LAST_PRUNE_FLAG);
      await repo.setFlag(env, LAST_PRUNE_FLAG);
    }
  } catch (e) {
    console.error("prune events failed", e);
  }
}
