# CDT-Management Workers — shared contract for all porting agents

Target: `~/workspace/cdt-management-workers/`. Source: `/tmp/cdt-management`
(commit 3ccf6a7, MIT). Read the Python source you are porting before writing
TypeScript; do not invent behaviour. Never put a real credential anywhere.

## Env (src/env.ts — write this once, agent 3 owns it)

```ts
export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;          // base64, 32 bytes; encrypts AccessKey secrets in D1
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  EMAIL_WEBHOOK_URL?: string;       // optional external email provider hook (see notify)
  EMAIL_API_KEY?: string;
  CDT_DRY_RUN?: string;             // "1" = in-memory Aliyun mocks, no live calls
  CDT_MOCK_OP_DELAY?: string;       // seconds, default "3"
  CDT_RECONCILE_INTERVAL?: string;  // seconds, default "60", min 30
  CDT_SHIFT_TIMEOUT_MINUTES?: string;
  CDT_DUTY_START_TRIES?: string;
  CDT_DUTY_STALL_SECONDS?: string;
}
```

## Conventions

- TypeScript strict, no `any` leaks into exported APIs (use `unknown` + narrowing).
- All timestamps are Unix seconds (number), matching the Python code.
- Settings live in the D1 `settings` table (key/value strings), same keys as
  `repo.get_setting` in Python.
- Errors: throw `Error` with a clear message; API layer converts to
  `{ok:false, code, message}` JSON. Never log or return secrets.
- Dates/times: Asia/Shanghai is the display timezone; store UTC epoch seconds.
- Mark anything deliberately simplified with `// SIMPLIFIED:` in code and list
  it in README.md.
- Dry-run: when `CDT_DRY_RUN=1`, Aliyun calls use in-memory mock state
  (mirror `app/aliyun.py` `_mock`/`_mock_advance`, with configurable delay).

## Module contracts (function names are camelCase versions of the Python ones)

### src/db.ts + migrations/0001_schema.sql (agent 3)
- Tables (exact names/columns from `app/db.py` SCHEMA + ALTER migrations):
  `settings`, `servers`, `keepalives`, `shift_groups`, `shift_members`,
  `shift_runs`, `dns_records`, `events`, `flags`, `revoked_sessions`,
  `traffic_samples`. Keep the Python column names verbatim.
- `src/db.ts` exports: `query<T>(db, sql, params?)`, `queryOne<T>`,
  `execute(db, sql, params?)` returning `{changes, lastInsertRowId}`.
  D1 `bind()` with `?` placeholders; convert `null` rows to plain objects.

### src/repo.ts (agent 3)
Port `app/repo.py` 1:1 in camelCase, same semantics:
`getSettings/getSetting/setSettings`, `getFlag/setFlag/clearFlag/bumpFlag/flagAge/flagValue/clearFlagsLike`,
`revokeSession/isSessionRevoked`, `listServers(decrypt?)/getServer/upsertServer/reorderServers/deleteServer/updateServerSite/updateServerBilling/updateServerRuntime`,
`addSample/lastSampleTs/listSamples/latestSamples`,
`listKeepalives/getKeepalive/keepaliveServerIds/keepaliveSchedules/addKeepalive/setKeepaliveEnabled/updateKeepalive/deleteKeepalive`,
`listDnsRecords/reorderDnsRecords/getDnsRecord/ensureDnsRecord/deleteDnsRecord/bindDnsRecord/dnsRecordsOf/dnsRecordOf/setDnsState`,
`listGroups/getGroup/listMembers/upsertGroup/deleteGroup/resetGroupAnchor/getRun/upsertRun/recentRuns/standbyIds`,
`addEvent/listPendingEvents/pendingManualExists/pendingEvent/runningPendingEvents/addEventProgress/getEvent/finishEvent/updateEvent/retargetEvent/runningEvents/listEvents/latestEventId/latestServerEvent/pruneEvents`.
- `upsertServer` encrypts `access_key_secret` via `security.encrypt` before
  storing; `listServers(true)/getServer(..., true)` decrypt on read.
- `upsertGroup` includes the timetable-coverage validation from `api.py`
  helpers only if it lives in repo.py; otherwise the API layer does it.

### src/security.ts (agent 3)
Port `app/security.py`: `hashPassword/verifyPassword` in the exact format
`pbkdf2_sha256$<rounds>$<b64salt>$<b64hash>` (PBKDF2-SHA256 via WebCrypto,
rounds = 260000 as in Python — check the source), `encrypt/decrypt` for
AccessKey secrets (AES-256-GCM via WebCrypto, key derived from
`ENCRYPTION_KEY`; stored format `aesgcm:v1:<base64(iv+ciphertext)>`; if the
Python Fernet format cannot be reproduced, document the break in README —
old Docker DBs cannot be migrated as-is), `mask(secret)`,
`issueSession/readSession` (HMAC-SHA256 signed token, payload
`{u, exp, epoch, jti}`; cookie name `cdt_mgmt_session`; TTL 14 days),
`newCsrfToken`, `sessionId(token)` (sha256 of signature, first 32 hex chars).
Session revocation is checked against the D1 `revoked_sessions` table.

### src/settings.ts (agent 3)
Constants from `app/settings.py`: `VERSION = "1.3.11"` (bump to
`"1.3.11-workers"` in the UI only if trivial), reconcile interval min 30s,
`SHIFT_TIMEOUT_MINUTES` default 10, `DUTY_START_TRIES` default 3,
`DUTY_STALL_SECONDS` default 180, `DUTY_START_GRACE` derivation,
`EVENT_RETAIN_DAYS` default 14, `SESSION_TTL_SECONDS`, cookie names.

### src/aliyun.ts + src/billing.ts (agent 1)
Port `app/aliyun.py` + `app/billing.py`. Implement the Aliyun RPC signature
from scratch (percent-encode, `SignatureMethod=HMAC-SHA1`,
`SignatureVersion=1.0`, `SignatureNonce`, `Timestamp`, HMAC-SHA1 with
`accessKeySecret + "&"` via WebCrypto). Endpoints: ECS per region
(`ecs.<region>.aliyuncs.com`), CDT traffic via the ECS/CDT RPC actions used
in `get_traffic_gb` (read the source — it uses CommonRequest actions; mirror
them), BSS `business.ap-southeast-1.aliyuncs.com` / china
`business.aliyuncs.com` with site fallback (read `_endpoints`/`bss_endpoint`).
Exports: `AliyunError`, `getTrafficGb(env, account): Promise<number|null>`,
`getInstance(env, account): Promise<InstanceInfo>` (`{status, stoppedMode, publicIp, regionId}`),
`startInstance(env, account)`, `stopInstance(env, account, mode, fallback): Promise<string>` (returns actual stopped mode),
`getAccountBalance(env, account, force?)`, `getInstanceBill(env, account, cycle)`,
`ecsDomain(region)`, `bssEndpoint(site)`, `sdkReady() => false`.
Account type: `{access_key_id, access_key_secret, region_id, site, instance_id, stop_mode?}` (snake_case as stored).
`billing.ts` exports: `currentCycle(config?)`, `enabled(config?)`, `refreshServer(env, serverId, {force})`, `refreshDue(env, now?)`, `summaryOf(server, config?)`, `sdkOk() => false`.
Dry-run mock: in-memory per-instance state with `CDT_MOCK_OP_DELAY`
(simulates async start/stop reaching the target status after the delay).

### src/shift.ts (agent 2)
Faithful port of `app/shift.py` (3606 lines — the core). Exports:
`reconcileAll(env): Promise<void>`, `dailyReport(env): Promise<boolean>`,
`keepaliveWindow(keepalive, now): boolean`, plus internal helpers.
Cover: single keepalive (windowed, start-if-stopped), joint rotation
(day cycle: hours + fixed timetable `slot_name/start_time/end_time`;
month cycle: `days` from the 1st), handover order (start duty first,
confirm Running, then stop standby), traffic thresholds + failover
(`DUTY_START_TRIES` failed starts → failover) + global circuit-break
(all members over threshold → stop all), spot-preemption recovery,
`shift_runs` phase/stage state machine persisted in D1, idempotent
(one reconcile step per call; never issue the same start/stop twice in a row
without re-reading instance state). Events via `repo.addEvent` etc. and
notifications via `notify.sendAll` with `messages.*` builders.
If a branch cannot be faithfully ported, mark `// SIMPLIFIED:` and note it.

### src/scheduler.ts (agent 4)
Port `app/scheduler.py` `_loop` body as one function
`runReconcile(env): Promise<void>`: `shift.reconcileAll()`,
`_maybeDailyReport()`, `dns.reconcile(settings)`, hourly `pruneEvents`.
No threads, no 5s confirm loop, no fast-reconcile window — event
confirmation happens inside the reconcile step (next cron tick). Document this.

### src/ddns.ts + src/dns.ts (agent 5)
Port `app/ddns.py` + `app/dns.py`. Cloudflare API via fetch with
`Authorization: Bearer <CLOUDFLARE_API_TOKEN>`. Exports (ddns):
`parseRecords(config)/records(config)/defaultRecord(config)/isValidRecord/isPublicIpv4/sync(env, config, record?, ip?): Promise<DDNSResult>/test(env, config)`.
Exports (dns): `normalize/syncRegistry/adoptLegacy/addRecord/removeRecord/syncRecord/syncTarget/syncTargetFull/reconcile(env, config, force?)/snapshot/bind/recordBooks/booksForCards/report/noSyncReport/stateOf/desiredIp`.
`config` here is the settings dict from `repo.getSettings()`.

### src/notify.ts + src/messages.ts (agent 5)
Port `app/notify.py` + `app/messages.py`. `Message = {kind, title, titleHtml, body, bodyHtml?}` — match Python's `Message` fields.
`notify.ts` exports: `enabledChannels(config)`, `sendAll(env, config, message): Promise<Record<string,string>>`, `send(env, config, channel, message)`, `safeError`, `resultText`, `noteNotify`.
Telegram via `https://api.telegram.org/bot<token>/sendMessage` (HTML parse mode).
Webhook via plain POST JSON. **Email: SMTP is not available in Workers — do
NOT fake it. Implement `sendEmail` as a hook: if `EMAIL_WEBHOOK_URL` is set,
POST the message to it (document that it should point at Resend/MailChannels
or a relay); otherwise return an error string "email_not_configured" and
record it in the event. Document this in README.**

### src/api.ts + src/index.ts (agent 4)
Hono app mirroring `app/api.py` routes exactly (`/api/health`,
`/api/v1/system/init-status`, `/api/v1/setup`, `/api/v1/auth/login|logout|me`,
`/api/v1/overview`, `/api/v1/reconcile`, `/api/v1/servers...`,
`/api/v1/servers/{id}/refresh|billing|actions/{action}|samples`,
`/api/v1/keepalives...`, `/api/v1/groups...|switch`,
`/api/v1/dns...`, `/api/v1/settings...|test/{channel}`, `/api/v1/events`).
Same JSON shapes as the Python responses (read each handler). Session cookie
+ CSRF double-submit (read `_current_user/require_admin/require_csrf` and
the login/logout handlers in api.py), login rate-limiting in-memory per
`_rate_limited` (note: in-memory limits reset per isolate — document it).
`POST /api/v1/reconcile` runs one `runReconcile` round on demand.
`src/index.ts`: Hono fetch handler, `scheduled(event, env, ctx)` running
`runReconcile`, static assets served via `env.ASSETS` fallback for
non-`/api/*` paths (wrangler `[assets]`), `scheduled` must not run the
webhook path.

### Frontend (agent 5)
`web/` is already copied from the original (React+Vite). Verify it builds
(`npm install && npm run build` in `web/`). Adapt `web/src/api.ts` only if
the API base path needs it (original uses same-origin `/api` — keep it).
Do not redesign the UI.

### wrangler.toml / package.json / tsconfig (parent integrates)
- `wrangler.toml`: name `cdt-management-workers`, `compatibility_date = "2026-11-12"`,
  `main = "src/index.ts"`, `d1_databases = [{binding="DB", database_name="cdt-management", database_id="00000000-0000-0000-0000-000000000000"}]` (placeholder — user runs `wrangler d1 create`),
  `[triggers] crons = ["*/1 * * * *"]`, `[assets] directory = "./web/dist"`,
  `[vars]` for non-secret defaults.
- `package.json`: deps `hono`, devDeps `typescript`, `@cloudflare/workers-types`, `wrangler`.
- README.md (Chinese, agent 5 drafts, parent finalises): architecture, ported
  vs simplified, deploy steps, secrets list, D1 migration steps, cron, adding
  an Aliyun account, attribution (original repo + wang4386/CDT-Monitor).
