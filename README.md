# CDT-Management Workers

**Cloudflare Workers + D1 版 CDT 管理面板：阿里云 CDT 抢占式实例的单机保活 + 多机联合换班 + DDNS + 通知。**

这是 [BeacherZ/cdt-management](https://github.com/BeacherZ/cdt-management)（Python + FastAPI + SQLite + Docker）的 TypeScript 移植版，跑在 Cloudflare Workers 上：后端是 Hono + D1，前端是原项目的 React + Vite（未改界面），定时巡检由 Workers Cron Triggers 驱动。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/suangsuang888/cdt-management-workers)

> 点上面的按钮可以直接部署到你的 Cloudflare 账号。部署时会问你要几个 Secrets（`ADMIN_PASSWORD`、`SESSION_SECRET`、`ENCRYPTION_KEY` 等），按 README 里的说明填就行。注意：按钮部署后还需要在 Cloudflare 控制台里手动创建一个同名 D1 数据库 `cdt-management` 并应用迁移，见下文「部署」一节。

> **版本**：`1.3.11-workers`（对应原项目 `1.3.11`）。验证状态（2026-11-11）：`npx tsc --noEmit` 通过（exit 0），`npx wrangler deploy --dry-run` 通过，D1 迁移本地应用通过（66 条命令），前端构建通过，`wrangler dev` 本地冒烟测试通过（`/api/health`、`/api/v1/system/init-status`、未登录访问 `/api/v1/overview` 返回 401、前端返回 200）。**未做真实部署，也未用真实阿里云账号验证过**——先在不重要的实例上测试。

## 架构

```
                          ┌─────────────────────────────┐
                          │        Cloudflare           │
                          │                             │
  浏览器 ──HTTPS──▶ Worker (Hono, src/index.ts)          │
                          │  ├─ /api/* → src/api.ts     │
                          │  ├─ 静态资源 → [assets]      │
                          │  │   web/dist (React+Vite)  │
                          │  └─ scheduled() 每分钟      │
                          │      └─ src/scheduler.ts    │
                          │          ├─ shift.reconcileAll()
                          │          ├─ 每日报告          │
                          │          ├─ dns.reconcile()  │
                          │          └─ 每小时 pruneEvents│
                          │                             │
                          │  D1 (cdt-management)        │
                          │  settings / servers /       │
                          │  keepalives / shift_groups… │
                          └──────┬───────────┬──────────┘
                                 │           │
                    阿里云 ECS/CDT/BSS   Cloudflare API
                    (RPC 签名, HMAC-SHA1)  (DDNS, Bearer Token)
                                 │
                          Telegram Bot API / Webhook
                          (通知；邮件见下)
```

### 模块对照（Python → TypeScript）

| 原项目 `app/*.py` | Workers `src/*.ts` | 说明 |
| --- | --- | --- |
| `api.py` | `api.ts` + `index.ts` | Hono 路由，`/api/*` 与原接口同形；`index.ts` 另管静态资源与 `scheduled()` |
| `scheduler.py` | `scheduler.ts` | 每轮 `runReconcile()`：换班引擎 → 每日报告 → DNS 对账 → 每小时清旧事件 |
| `shift.py` | `shift.ts` | 换班引擎（单机保活 / 联合换班 / 故障转移 / 熔断） |
| `aliyun.py` + `billing.py` | `aliyun.ts` + `billing.ts` | 阿里云 RPC 签名（HMAC-SHA1）手写实现；费用/余额 |
| `ddns.py` | `ddns.ts` | Cloudflare DDNS（查 Zone → 找 Record ID → PUT A 记录，重试 3 次） |
| `dns.py` | `dns.ts` | 绑定关系：谁该指向哪个 IP、什么时候需要更新、巡检对账 |
| `notify.py` | `notify.ts` | Telegram / 邮件（Webhook 转发）/ Webhook |
| `messages.py` | `messages.ts` | 通知文案（与原脚本逐字对齐，中文原文不动） |
| `db.py` + `repo.py` | `db.ts` + `repo.ts` + `migrations/0001_schema.sql` | D1，表名/列名与原 SQLite 一致 |
| `security.py` | `security.ts` | PBKDF2 密码、AES-GCM 字段加密、HMAC 会话 |
| `settings.py` | `settings.ts` | 常量与默认值 |
| `web/` | `web/` | 原 React + Vite 前端，界面未改 |

## 移植 vs 简化 / 降级

Workers 没有常驻进程、没有线程、没有 TCP 套接字，以下是**有意**的降级，代码里以 `// SIMPLIFIED:` 标记：

| 原行为 | Workers 版 | 原因 |
| --- | --- | --- |
| 5 秒事件确认线程（`_confirm_loop`）：手动启停后约 5 秒确认到位并补发通知 | 确认发生在下一轮巡检（下一分钟 cron tick），见 `scheduler.ts` | Workers 无后台线程；Cron 最小间隔 1 分钟 |
| 10 秒快速对账窗口（建组后 90 秒内每 10 秒一轮） | 无。Cron 固定每分钟；建组时 API 仍会同步引导一轮；想立即跑可调 `POST /api/v1/reconcile` | 同上 |
| 巡检间隔可自定义（默认 60 秒，最小 30 秒） | Cron 固定 `*/1 * * * *`（1 分钟）；`CDT_RECONCILE_INTERVAL` 仅作下限参考 | Cron Triggers 最小 1 分钟 |
| 邮件：SMTP 直发（SSL/TLS，`notify_mail_host` 等） | **不走 SMTP**：见下文「邮件（重要）」 | Workers 没有 SMTP 能力；不做「假装发出」的实现 |
| Telegram 代理（`notify_tg_proxy`） | 忽略该配置 | Workers `fetch` 不支持 HTTP 代理 |
| 登录限流：进程内内存计数 | 仍在内存里计数，但每个 isolate 重置（文档注明） | Workers 无共享内存 |
| DDNS 解析强制 IPv4（改 urllib3 的 gai family） | 无此钩子，由 Cloudflare 运行时解析 | Workers 无底层 DNS 控制 |
| AccessKey Secret 加密：Python Fernet | **格式不兼容**：AES-256-GCM，`aesgcm:v1:<base64(iv+ciphertext)>`（WebCrypto） | Workers 无 Fernet；**旧 Docker 的数据库不能直接迁移**，见下文 |

### 邮件（重要）

**Workers 里没有 SMTP，`notify.ts` 不会直发邮件，也不会假装发出。**

- 设置了 Secret `EMAIL_WEBHOOK_URL` 时：把消息以 JSON（`{to, subject, title, text, html, kind}`）POST 到该地址，返回 `"ok"`。该地址应指向 **Resend / MailChannels / 自建中继**等外部发信服务，由对方按 `to` / `subject` / `html` 发信；可选再设 `EMAIL_API_KEY`，会以 `Authorization: Bearer` 带上。
- 未设置时：`sendEmail()` 返回 `"email_not_configured"`，`sendAll()` 记为 `email: failed: email_not_configured`，事件里如实写「通知发送失败：email」，**不会谎称已发送**。
- 启用条件：`notify_mail_enabled=1` 且填了收件人（`notify_mail_to`）；原 `notify_mail_host` 不再是必需项（留着仅作兼容，不再使用）。

### 加密格式断裂（旧库不能直接迁移）

原 Docker 版用 Fernet 加密 `access_key_secret`，Workers 版用 WebCrypto AES-256-GCM（`ENCRYPTION_KEY`，base64 编码的 32 字节密钥，存储格式 `aesgcm:v1:<base64(iv+ciphertext)>`）。两种格式互不兼容：

- **旧 `cdt-management.db` 不能直接导入 D1**：`servers.access_key_secret` 解不出来。
- 迁移办法：部署后在面板里重新填写每台服务器的 AccessKey Secret（或重新添加服务器）。`master.key` 与新 `ENCRYPTION_KEY` 也**不是**同一个东西，不要混用。
- 登录密码格式未变：`pbkdf2_sha256$<rounds>$<b64salt>$<b64hash>`（PBKDF2-SHA256，100000 轮——Workers 的 WebCrypto 最多只支持 100000 轮，Python 原版的 260000 轮在这里会报错），密码哈希本身可以沿用。

## 部署

### 一键部署（推荐）

```bash
./scripts/deploy.sh
# 或者
npm run deploy:all
```

一条命令做完所有事：装依赖、构建前端、类型检查、创建 D1（自动把真实 `database_id` 写回 `wrangler.toml`）、应用迁移、设 Secrets、部署。中间只会问你几样东西：

- `ADMIN_PASSWORD`：面板登录密码，必填，你自己定
- `SESSION_SECRET`、`ENCRYPTION_KEY`：留空就自动生成随机值
- `CLOUDFLARE_API_TOKEN`、`TELEGRAM_BOT_TOKEN`：可选，留空跳过

第一次跑之前要先登录 Cloudflare（`npx wrangler login`）。想先演练一遍不真部署，可以跑 `./scripts/deploy.sh --dry-run`，只做到构建和类型检查那一步。

密钥只通过 `wrangler secret put` 进 Cloudflare，不会写进任何文件。`ENCRYPTION_KEY` 丢了库里的 AccessKey Secret 就解不出来，脚本最后会提醒你把它记到密码管理器里。

> 另一种“点按钮部署”（Cloudflare 的 Deploy 按钮）需要先把代码公开推到 GitHub 仓库上，如果你想要，我可以帮你把这个项目推到你的 GitHub 上再加按钮。

### 手动部署（分步）

- Node.js 18+、npm
- Cloudflare 账号，已装 `wrangler`（本仓库 `devDependencies` 已含）
- 阿里云账号（RAM 权限见下）、Cloudflare API Token（DDNS 用，可选）、Telegram Bot（通知用，可选）

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create cdt-management
```

把输出的 `database_id` 填进 `wrangler.toml` 的 `d1_databases` 一节（替换掉 `00000000-0000-0000-0000-000000000000` 这个占位符）。

### 2. 建表（本地 + 远端）

```bash
npx wrangler d1 migrations apply cdt-management --local
npx wrangler d1 migrations apply cdt-management --remote
```

### 3. 设置 Secrets（不要写进代码、不要提交）

```bash
npx wrangler secret put ADMIN_PASSWORD      # 面板登录密码（首次初始化用）
npx wrangler secret put SESSION_SECRET      # 会话签名密钥
npx wrangler secret put ENCRYPTION_KEY      # base64 编码的 32 字节密钥，加密 AccessKey Secret 用
npx wrangler secret put CLOUDFLARE_API_TOKEN  # DDNS 用；没有 DDNS 需求可不设
npx wrangler secret put TELEGRAM_BOT_TOKEN    # 通知用；不用 Telegram 可不设
# 可选：邮件转发（见上文「邮件（重要）」）
npx wrangler secret put EMAIL_WEBHOOK_URL
npx wrangler secret put EMAIL_API_KEY
```

生成 `ENCRYPTION_KEY`（32 字节随机，base64）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> **备份**：`ENCRYPTION_KEY` 丢了，库里存的 AccessKey Secret 就解不出来（要重新填）；`SESSION_SECRET` 换了，所有登录会话失效。

### 4. 构建前端并部署

```bash
npm install
npm run build:web   # web/ 里 npm install + npm run build，产物进 web/dist
npx wrangler deploy
```

`wrangler.toml` 已配好 `[assets] directory = "./web/dist"`，前端与 API 同源（前端调相对路径 `/api`，不需要改 `web/src/api.ts`）。

本地开发：

```bash
npx wrangler dev            # 后端 + 前端同源预览
cd web && npm run dev       # 仅前端 :5273，/api 代理到本地后端
CDT_DRY_RUN=1 npx wrangler dev   # 不调真实阿里云，走内存桩
```

## Cron（定时巡检）

`wrangler.toml` 已配：

```toml
[triggers]
crons = ["*/1 * * * *"]
```

每分钟一轮：换班引擎 → 每日报告（到点才发）→ DNS 对账 → 每小时清 14 天前的旧事件。Cron 最小间隔就是 1 分钟，**不要**指望改成 10 秒；想立即触发一轮，调 `POST /api/v1/reconcile`（需登录 + CSRF）。

## 配一遍的流程

1. **服务器** → 添加服务器：填别名、Region、AccessKey ID/Secret、实例 ID、配额与限流阈值，按需选停机模式（默认节省停机）。
2. 二选一（或都要，但**同一台不要同时挂两边**）：
   - **单机保活** → 添加保活，勾上这台；要限定运行时段/日期就在同一个设置页里填
   - **联合换班** → 新建换班组，选排班周期（一天一轮按工时，一月一轮按天数），按顺序添加成员
3. **设置 → DDNS**：填 Cloudflare Token（或 Global API Key）、TTL，开启
4. **DNS**：加域名记录，再把它绑到某台实例或某个换班组（不绑就谁也不会去动它）
5. **设置 → 通知**：填 Telegram Bot Token + Chat ID，点「发送测试」确认能收到；邮件走 Webhook 转发（见上文）
6. 回概览点「立即同步」，看第一轮结果

## 添加阿里云账号（RAM 权限）

完整功能需要给当前用户添加以下三种 RAM 权限（RAM 访问控制 → 身份管理 → 用户 → 权限管理）：

| RAM 权限 | 用在哪 |
| --- | --- |
| `AliyunECSFullAccess` | 查实例、开机、停机（含节省停机） |
| `AliyunCDTReadOnlyAccess` | 读当月 CDT 公网流量 |
| `AliyunBSSReadOnlyAccess` | 账户余额、实例账单 |

- 少了 CDT 这组，整轮对账都会失败，不是流量空着 —— 必须给
- 少了 BSS 这组，费用和余额显示不出来，启停照常
- 国内站和国际站的 AK 不通用，一台实例一套凭据
- RAM 控制台：[国内站](https://ram.console.aliyun.com/users) · [国际站](https://ram.console.alibabacloud.com/users)

AccessKey Secret 只存在 D1 里（AES-GCM 加密），绝不会出现在前端或日志里；面板的 API 响应里只会看到打码后的值。

## 数据放在哪

| 位置 | 内容 |
| --- | --- |
| D1 `cdt-management` | 实例、换班组、换班进度、事件、流量采样（表名/列名与原 SQLite 一致） |
| `ENCRYPTION_KEY`（Secret） | 加密主密钥，**必须与库一起备份**，丢了 AccessKey Secret 无法解密 |

## 常见问题

**换班了但没收到通知？** 先看「设置 → 通知」里渠道是否启用、点测试能不能发出去；再看概览的「最近事件」有没有对应记录。通知失败只记事件，不会阻塞换班。邮件没配 `EMAIL_WEBHOOK_URL` 时事件里会写 `email_not_configured`。

**DDNS 显示「IP 无效跳过」？** 实例还没拿到公网 IP，或者不是公网 IPv4。等下一轮同步，或手动刷新那台实例。

**所有成员都超限了怎么办？** 会全局熔断，全部节省停机，等下个月流量重置后手动开机，或调整阈值。

**忘了面板密码？** 用 `wrangler secret put ADMIN_PASSWORD` 重设后重新初始化（或直接改 D1 `settings` 表的 `admin_password`，需按 `pbkdf2_sha256$…` 格式）。

**事件确认变慢了？** 正常。Workers 版没有 5 秒确认线程，手动启停的「到位确认」要等下一分钟 cron tick。

## 已知问题与未验证项

- 类型检查与部署演练已通过（见上文版本说明），但**没有用真实阿里云账号验证过**：Aliyun RPC 签名只做了本地交叉验证（与 Node HMAC-SHA1 对照一致），ECS/CDT/BSS 的实际调用、换班全流程、DDNS 同步都需要在测试实例上跑一遍。
- 前端构建已验证通过（`cd web && npm install && npm run build`，exit 0）。注意 `web/vite.config.ts` 的 `outDir` 已由原项目的 `../app/static` 改为 `dist`，否则 `wrangler [assets]` 找不到产物。
- `wrangler.toml` 里的 `database_id` 仍是占位符 `00000000-0000-0000-0000-000000000000`，部署前必须先 `npx wrangler d1 create cdt-management` 并填入真实 ID。

## 致谢与许可

MIT 许可，见 `LICENSE` 与 `NOTICE.md`。

- 原项目：[**BeacherZ/cdt-management**](https://github.com/BeacherZ/cdt-management)（MIT）—— 后端逻辑、换班引擎、DDNS 与通知实现均移植自该项目；本移植版与原作者无关。
- 界面设计与安装体验参考了 [**wang4386/CDT-Monitor**](https://github.com/wang4386/CDT-Monitor)（作者青柠，MIT），详见 `NOTICE.md`。
