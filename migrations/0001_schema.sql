-- CDT-Management Workers — consolidated D1 schema.
-- Port of app/db.py SCHEMA plus every column added by its _migrate()
-- ALTER TABLE steps, folded in so a fresh database has the final shape.
-- Table and column names are verbatim from the Python source.
-- Apply with: wrangler d1 migrations apply cdt-management --local / --remote

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- Server: one Aliyun account + one ECS instance.
CREATE TABLE IF NOT EXISTS servers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    label               TEXT    NOT NULL,
    access_key_id       TEXT    NOT NULL,
    access_key_secret   TEXT    NOT NULL,
    region_id           TEXT    NOT NULL,
    -- Site: china (aliyun.com) / international (alibabacloud.com).
    -- ECS and CDT endpoints are identical on both sites; only BSS differs.
    site                TEXT    NOT NULL DEFAULT 'china',
    instance_id         TEXT    NOT NULL,
    quota_gb            REAL    NOT NULL DEFAULT 200,
    threshold_gb        REAL    NOT NULL DEFAULT 188,
    remark              TEXT    NOT NULL DEFAULT '',
    traffic_used        REAL,
    instance_status     TEXT    NOT NULL DEFAULT '',
    -- Preferred stop mode: StopCharging (economy stop) / Stop (normal stop).
    stop_mode           TEXT    NOT NULL DEFAULT 'StopCharging',
    -- Last *actual* stopped mode returned by Aliyun (StopCharging /
    -- KeepCharging / Not-applicable). Kept apart from the preference above:
    -- an instance that does not support economy stop reports KeepCharging.
    stopped_mode        TEXT    NOT NULL DEFAULT '',
    public_ip           TEXT    NOT NULL DEFAULT '',
    traffic_checked_at  INTEGER NOT NULL DEFAULT 0,
    status_checked_at   INTEGER NOT NULL DEFAULT 0,
    -- Billing snapshot (BSS 2017-12-14): this month's bill / account balance.
    monthly_cost        REAL,
    balance_amount      REAL,
    billing_currency    TEXT    NOT NULL DEFAULT '',
    -- Billing cycle (YYYY-MM): stale numbers must not display as this month's.
    billing_cycle       TEXT    NOT NULL DEFAULT '',
    billing_updated_at  INTEGER NOT NULL DEFAULT 0,
    billing_error       TEXT    NOT NULL DEFAULT '',
    created_at          INTEGER NOT NULL DEFAULT 0,
    -- Manual sort weight on the Servers page; smaller sorts first, 0 = by id.
    sort_order          INTEGER NOT NULL DEFAULT 0
);

-- Single-instance keepalive: "if it stopped, pull it back up", with an
-- optional daily time window and monthly day window.
CREATE TABLE IF NOT EXISTS keepalives (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL UNIQUE,
    enabled    INTEGER NOT NULL DEFAULT 1,
    -- Daily allowed window: start_time <= now < end_time, same day (no
    -- midnight crossing). Both empty = all day.
    start_time TEXT    NOT NULL DEFAULT '',
    end_time   TEXT    NOT NULL DEFAULT '',
    -- Monthly allowed days: start_day <= day <= end_day, same month.
    -- 0 = unlimited (both 0 = all month; exactly one 0 = invalid config).
    start_day  INTEGER NOT NULL DEFAULT 0,
    end_day    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
);

-- Joint shift group.
CREATE TABLE IF NOT EXISTS shift_groups (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    failover_enabled  INTEGER NOT NULL DEFAULT 1,
    ddns_record       TEXT    NOT NULL DEFAULT '',
    anchor_at         INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL DEFAULT 0,
    -- Rotation cycle: day = one round per day (hours / fixed timetable),
    -- month = one round per month (by days).
    cycle             TEXT    NOT NULL DEFAULT 'day'
);

-- Group members, rotating in position order. Legacy `hours` is kept
-- (compatibility); the current scheme uses slot_name + fixed start/end
-- times per day. cycle=month groups use `days`: consecutive days per member
-- from the 1st of the month.
CREATE TABLE IF NOT EXISTS shift_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    server_id  INTEGER NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    hours      REAL    NOT NULL DEFAULT 12,
    enabled    INTEGER NOT NULL DEFAULT 1,
    slot_name  TEXT    NOT NULL DEFAULT '',
    start_time TEXT    NOT NULL DEFAULT '',
    end_time   TEXT    NOT NULL DEFAULT '',
    days       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(group_id, position)
);
CREATE INDEX IF NOT EXISTS idx_members_group ON shift_members(group_id, position);

-- Run state for one "someone is on duty" slot.
CREATE TABLE IF NOT EXISTS shift_runs (
    group_id            INTEGER NOT NULL,
    slot                TEXT    NOT NULL,
    phase               TEXT    NOT NULL DEFAULT 'pending',
    -- Fine-grained handover stage: '' / starting_duty (duty started, waiting
    -- Running) / stopping_standby (standby stopped, waiting Stopped); cleared
    -- once ready.
    stage               TEXT    NOT NULL DEFAULT '',
    -- In-progress handover event id, for appending progress across rounds.
    event_id            INTEGER NOT NULL DEFAULT 0,
    duty_server_id      INTEGER NOT NULL DEFAULT 0,
    standby_server_ids  TEXT    NOT NULL DEFAULT '',
    failover            INTEGER NOT NULL DEFAULT 0,
    -- Failover reason: 'traffic' (duty over traffic limit) / 'stall'
    -- (duty would not start, keepalive timed out).
    failover_reason     TEXT    NOT NULL DEFAULT '',
    -- The server that was replaced (the original duty). Settlement notices
    -- need it; it cannot be derived from "who was over limit" because a
    -- stalled original duty was never over limit.
    failover_from       INTEGER NOT NULL DEFAULT 0,
    -- Which day (group-timezone YYYY-MM-DD) this failover cover took effect.
    -- A month-cycle slot can last a whole month; the engine clears the
    -- cover at the next midnight so the original duty is re-invited.
    duty_day            TEXT    NOT NULL DEFAULT '',
    -- Manual handover flag: 1 = user-triggered, not a traffic failover.
    manual              INTEGER NOT NULL DEFAULT 0,
    -- Origin of this slot: '' normal timetable rotation / 'new_group' first
    -- alignment after the group was created.
    origin              TEXT    NOT NULL DEFAULT '',
    -- DNS IPs at handover start (JSON: {record: IP}), so the event can show
    -- "old IP -> new IP" after the records move.
    dns_before          TEXT    NOT NULL DEFAULT '',
    attempts            INTEGER NOT NULL DEFAULT 0,
    started_at          INTEGER NOT NULL DEFAULT 0,
    updated_at          INTEGER NOT NULL DEFAULT 0,
    note                TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, slot)
);

-- DNS record registry: one domain name = one explicit binding + sync state.
-- No "default record" fallback: anyone can be bound, so one domain must
-- never be silently claimed by two machines.
CREATE TABLE IF NOT EXISTS dns_records (
    record      TEXT    PRIMARY KEY,
    -- '' unbound / 'server' server (incl. single keepalive) / 'group' shift group
    target_kind TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    -- Last successfully synced IP, used to detect changes and shown in the UI.
    last_ip     TEXT    NOT NULL DEFAULT '',
    last_status TEXT    NOT NULL DEFAULT '',
    last_at     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    -- Manual sort: 0 = never dragged, sorts after dragged ones by registration.
    sort_order  INTEGER NOT NULL DEFAULT 0
);
-- One target may hold many records, so this is a lookup index only — NOT
-- unique. (The old unique idx_dns_target was dropped by _migrate().)
CREATE INDEX IF NOT EXISTS idx_dns_target_lookup
    ON dns_records(target_kind, target_id) WHERE target_kind <> '';

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL DEFAULT 0,
    level      TEXT    NOT NULL DEFAULT 'info',
    kind       TEXT    NOT NULL DEFAULT '',
    group_id   INTEGER NOT NULL DEFAULT 0,
    server_id  INTEGER NOT NULL DEFAULT 0,
    title      TEXT    NOT NULL DEFAULT '',
    detail     TEXT    NOT NULL DEFAULT '',
    -- Event lifecycle: running / done / error.
    status     TEXT    NOT NULL DEFAULT 'done',
    -- Completion log (JSON array: [{ts, text}]).
    progress   TEXT    NOT NULL DEFAULT '',
    -- Finish / failure timestamp, 0 while still open.
    finished_at INTEGER NOT NULL DEFAULT 0,
    -- Async target state to wait for, e.g. Stopped / Running; '' = no polling.
    pending_status TEXT    NOT NULL DEFAULT '',
    -- Async event type: manual (manual power op) / keepalive (keepalive pull-up).
    pending_kind   TEXT    NOT NULL DEFAULT '',
    -- When waiting for the *current* target started. Timeouts are measured
    -- from here, not from ts: a keepalive event may already be hours old
    -- when it is retargeted to a new goal.
    pending_ts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS flags (
    key        TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT 0,
    -- Attached counter. Currently used by keepalive retries ("attempt N").
    value      INTEGER NOT NULL DEFAULT 0
);

-- Revoked session tokens (only the first 16 bytes of the token signature's
-- SHA-256, never the token itself). Sessions are stateless, so deleting a
-- cookie alone does not revoke a token: it stays valid for 14 days.
CREATE TABLE IF NOT EXISTS revoked_sessions (
    token_id   TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_revoked_exp ON revoked_sessions(expires_at);

CREATE TABLE IF NOT EXISTS traffic_samples (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL,
    ts         INTEGER NOT NULL DEFAULT 0,
    used       REAL    NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_samples_server_ts ON traffic_samples(server_id, ts DESC);

-- Default settings rows (mirrors db.py DEFAULTS / settings.ts DEFAULT_SETTINGS).
INSERT INTO settings(key, value) VALUES('admin_username', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('admin_password', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('initialized', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('session_epoch', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('timezone', 'Asia/Shanghai') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('traffic_threshold_pct', '90') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('reconcile_interval', '60') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('reconcile_offset', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('billing_enabled', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('billing_interval', '600') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('daily_report_enabled', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('daily_report_time', '23:58') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_on_shift', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_on_failover', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_on_recovery', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_on_breaker', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_on_limit_stop', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_on_error', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_on_keepalive', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_enabled', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_provider', 'cloudflare') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_cf_auth_mode', 'token') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_cf_token', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_cf_email', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_cf_key', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_zone_id', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_records', '[]') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_record', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_ttl', '60') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_proxied', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_last_ip', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_last_status', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('ddns_last_at', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_tg_enabled', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_tg_token', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_tg_chat_id', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_tg_proxy', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_enabled', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_host', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_port', '465') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_security', 'ssl') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_username', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_password', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_to', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_wh_enabled', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_wh_url', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_wh_method', 'POST') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_wh_headers', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_wh_body', '') ON CONFLICT(key) DO NOTHING;
