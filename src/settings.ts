// Process-level constants ported from app/settings.py (Python).
// In Workers there is no process env at import time: values that were read
// from CDT_* environment variables are resolved from the Worker `Env`
// (wrangler [vars] / secrets) via `resolveSettings()` below. The D1
// `settings` table (see repo.getSettings) still holds the user-facing
// settings with the same keys as the Python app.

import type { Env } from "./env";

export const APP_NAME = "cdt-management";
export const VERSION = "1.3.11-workers";
export const BRAND = "CDT-Management";
// 实际部署的仓库（Workers 移植版）：「关于」页显示的仓库链接。
export const REPO = "suangsuang888/cdt-management-workers";
// 上游 Docker 版仓库：仅用于「关于」页检查上游最新 release；
// 本移植版的版本号带 -workers 后缀，比较时要去掉后缀再比基础版本。
export const UPSTREAM_REPO = "BeacherZ/cdt-management";

// Reconcile interval (seconds). Below 30s would exhaust the Aliyun API quota.
export const RECONCILE_INTERVAL_MIN_SECONDS = 30;
export const RECONCILE_INTERVAL_DEFAULT_SECONDS = 60;

// Single Aliyun / HTTP call timeout (seconds).
export const HTTP_TIMEOUT_SECONDS = 12;

// Events are retained this many days (pruneEvents).
export const EVENT_RETAIN_DAYS_MIN = 1;
export const EVENT_RETAIN_DAYS_DEFAULT = 14;

// Shift timeout (minutes): a handover not ready by then is a shift failure.
export const SHIFT_TIMEOUT_MINUTES_MIN = 2;
export const SHIFT_TIMEOUT_MINUTES_DEFAULT = 10;

// How many failed duty-start attempts trigger a failover to another member.
// Counted in *attempts that actually issued start_instance*, not wall-clock.
export const DUTY_START_TRIES_MIN = 2;
export const DUTY_START_TRIES_DEFAULT = 3;

// Stall tolerance (seconds) for a duty instance stuck in Starting/Pending
// before it is treated as dead. Only used as a middle-state fallback.
export const DUTY_STALL_SECONDS_MIN = 60;
export const DUTY_STALL_SECONDS_DEFAULT = 180;

// Extra grace (seconds) once a duty instance has entered Starting/Pending
// (start issued, Aliyun is bringing the machine up). Windows instances take
// 2–3 minutes to boot normally, so this must be well above DUTY_STALL_SECONDS.
// Default 480 (8 min) so failover fires ~2 min before the 10-min shift
// timeout; it tightens automatically when SHIFT_TIMEOUT_MINUTES is lowered.
export const DUTY_START_GRACE_CONFIGURED_DEFAULT = 480;
export const DUTY_START_GRACE_MIN_SECONDS = 60;

export function dutyStartGrace(
  shiftTimeoutMinutes: number = SHIFT_TIMEOUT_MINUTES_DEFAULT,
  dutyStallSeconds: number = DUTY_STALL_SECONDS_DEFAULT,
  configuredGrace: number = DUTY_START_GRACE_CONFIGURED_DEFAULT,
): number {
  return Math.max(
    dutyStallSeconds,
    Math.min(configuredGrace, shiftTimeoutMinutes * 60 - 60),
  );
}

/** True when the timeout is so short the grace can no longer precede it. */
export function graceOrderBroken(
  shiftTimeoutMinutes: number,
  dutyStartGraceSeconds: number,
): boolean {
  return dutyStartGraceSeconds >= shiftTimeoutMinutes * 60;
}

// Dry-run: no live Aliyun calls (in-memory mocks in aliyun.ts).
export const DRY_RUN_DEFAULT = false;
// Dry-run mock async op (start/stop) delay in seconds; 3 by default so the
// "spinning confirmation" flow is observable, 0 in smoke tests.
export const MOCK_OP_DELAY_DEFAULT_SECONDS = 3;

export const SESSION_COOKIE = "cdt_mgmt_session";
export const CSRF_COOKIE = "cdt_mgmt_csrf";
export const SESSION_TTL_SECONDS = 14 * 24 * 3600;

/**
 * Default rows for the D1 `settings` table, mirroring db.py DEFAULTS.
 * The migration seeds these; `reconcile_interval` defaults to the
 * RECONCILE_INTERVAL default (60). Values are strings, as in Python.
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  admin_username: "",
  admin_password: "",
  initialized: "0",
  // Incremented on password change to invalidate all issued session tokens.
  session_epoch: "0",
  timezone: "Asia/Shanghai",
  traffic_threshold_pct: "90",
  reconcile_interval: String(RECONCILE_INTERVAL_DEFAULT_SECONDS),
  // Which second of each N-second grid a reconcile round fires on (0–59).
  reconcile_offset: "0",
  billing_enabled: "1",
  billing_interval: "600",
  daily_report_enabled: "1",
  daily_report_time: "23:58",
  notify_on_shift: "1",
  notify_on_failover: "1",
  notify_on_recovery: "1",
  notify_on_breaker: "1",
  notify_on_limit_stop: "1",
  notify_on_error: "1",
  notify_on_keepalive: "1",
  notify_on_power: "1",
  // DDNS
  ddns_enabled: "0",
  ddns_provider: "cloudflare",
  ddns_cf_auth_mode: "token",
  ddns_cf_token: "",
  ddns_cf_email: "",
  ddns_cf_key: "",
  ddns_zone_id: "",
  ddns_records: "[]",
  ddns_record: "",
  ddns_ttl: "60",
  ddns_proxied: "0",
  ddns_last_ip: "",
  ddns_last_status: "",
  ddns_last_at: "0",
  // Telegram
  notify_tg_enabled: "0",
  notify_tg_token: "",
  notify_tg_chat_id: "",
  notify_tg_proxy: "",
  // Mail
  notify_mail_enabled: "0",
  notify_mail_host: "",
  notify_mail_port: "465",
  notify_mail_security: "ssl",
  notify_mail_username: "",
  notify_mail_password: "",
  notify_mail_to: "",
  // Webhook
  notify_wh_enabled: "0",
  notify_wh_url: "",
  notify_wh_method: "POST",
  notify_wh_headers: "",
  notify_wh_body: "",
};

export interface ResolvedSettings {
  reconcileIntervalSeconds: number;
  shiftTimeoutMinutes: number;
  dutyStartTries: number;
  dutyStallSeconds: number;
  dutyStartGraceSeconds: number;
  graceOrderBroken: boolean;
  eventRetainDays: number;
}

function envInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = value === undefined ? NaN : parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

/**
 * Resolve the process-level tunables from Worker Env, applying the same
 * floors/defaults as settings.py (CDT_RECONCILE_INTERVAL etc.).
 */
export function resolveSettings(env: Env): ResolvedSettings {
  const shiftTimeoutMinutes = envInt(
    env.CDT_SHIFT_TIMEOUT_MINUTES,
    SHIFT_TIMEOUT_MINUTES_DEFAULT,
    SHIFT_TIMEOUT_MINUTES_MIN,
  );
  const dutyStallSeconds = envInt(
    env.CDT_DUTY_STALL_SECONDS,
    DUTY_STALL_SECONDS_DEFAULT,
    DUTY_STALL_SECONDS_MIN,
  );
  const grace = dutyStartGrace(shiftTimeoutMinutes, dutyStallSeconds);
  return {
    reconcileIntervalSeconds: envInt(
      env.CDT_RECONCILE_INTERVAL,
      RECONCILE_INTERVAL_DEFAULT_SECONDS,
      RECONCILE_INTERVAL_MIN_SECONDS,
    ),
    shiftTimeoutMinutes,
    dutyStartTries: envInt(
      env.CDT_DUTY_START_TRIES,
      DUTY_START_TRIES_DEFAULT,
      DUTY_START_TRIES_MIN,
    ),
    dutyStallSeconds,
    dutyStartGraceSeconds: grace,
    graceOrderBroken: graceOrderBroken(shiftTimeoutMinutes, grace),
    eventRetainDays: envInt(
      undefined,
      EVENT_RETAIN_DAYS_DEFAULT,
      EVENT_RETAIN_DAYS_MIN,
    ),
  };
}
