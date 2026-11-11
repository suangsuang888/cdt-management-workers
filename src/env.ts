// Env binding — created by agent 1 (aliyun/billing) because src/env.ts did
// not exist yet when this module was written. Interface copied verbatim from
// CONTRACT.md; agent 3 (env owner) owns this file afterwards — do not edit
// without coordinating with them.
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
