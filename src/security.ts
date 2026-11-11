// Password hashing, session signing and credential encryption.
// Port of app/security.py, re-implemented on WebCrypto (no Node APIs exist
// in Workers).
//
// *** ENCRYPTION INCOMPATIBILITY — READ BEFORE MIGRATING AN OLD DATABASE ***
// Python encrypted AccessKey secrets (and sensitive settings) with
// cryptography's AESGCM, keyed by a 32-byte master key stored in a
// `master.key` FILE on disk, in the format `v1:<base64(nonce+ciphertext)>`.
// Workers have no such file: the key comes from the `ENCRYPTION_KEY`
// environment secret (base64, 32 bytes) and ciphertexts are stored as
// `aesgcm:v1:<base64(iv+ciphertext)>` (WebCrypto AES-256-GCM; the 16-byte
// auth tag is appended to the ciphertext, as in the Python format).
// The two formats use different keys AND different prefixes, so a D1
// database copied from the Docker app CANNOT be migrated as-is: every
// stored AccessKey secret and sensitive setting (ddns_cf_token, Telegram
// token, mail password, webhook headers) must be re-entered after the move.
// `decrypt()` therefore throws on the Python `v1:` format instead of
// silently returning garbage. The one exception is the `pbkdf2_sha256$…`
// password hash stored under `admin_password`, which is not a ciphertext
// and is returned as-is so login keeps working.

import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./settings";

export { SESSION_COOKIE };

// NOTE: Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations
// (deriveBits throws NotSupportedError above that), so this must stay <=
// 100,000 even though the Python original used Django's 260,000 default.
// The round count is stored in the hash itself (`pbkdf2_sha256$<rounds>$…`),
// so verifyPassword keeps working for hashes made with any round count.
export const PBKDF2_ROUNDS = 100_000;

export interface SessionPayload {
  u: string;
  exp: number;
  epoch: number;
  jti: string;
}

// ---------------------------------------------------------------------------
// base64 helpers (standard + URL-safe, no padding where Python strips it)
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(padded + "=".repeat((-padded.length % 4 + 4) % 4));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// ---------------------------------------------------------------------------
// Passwords: pbkdf2_sha256$<rounds>$<b64salt>$<b64hash> (exact Python format)
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
      key,
      256,
    ),
  );
  return `pbkdf2_sha256$${PBKDF2_ROUNDS}$${bytesToBase64(salt)}$${bytesToBase64(digest)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
    const rounds = Number(parts[1]);
    const salt = base64ToBytes(parts[2] as string);
    const expected = base64ToBytes(parts[3] as string);
    if (!Number.isFinite(rounds) || rounds <= 0) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const actual = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt as BufferSource, iterations: rounds, hash: "SHA-256" },
        key,
        expected.length * 8,
      ),
    );
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Field encryption: AES-256-GCM, key = base64 ENCRYPTION_KEY (32 bytes)
// Stored format: `aesgcm:v1:<base64(iv+ciphertext)>` (iv = 12 random bytes).
// Empty plaintext stays empty, so "leave blank = don't change" keeps working.
// ---------------------------------------------------------------------------

const encryptionKeyCache = new Map<string, Promise<CryptoKey>>();

function getEncryptionKey(encryptionKeyB64: string | undefined): Promise<CryptoKey> {
  if (!encryptionKeyB64) {
    throw new Error(
      "ENCRYPTION_KEY is not configured: set it (base64, 32 bytes) via `wrangler secret put ENCRYPTION_KEY` before storing AccessKey secrets",
    );
  }
  const cached = encryptionKeyCache.get(encryptionKeyB64);
  if (cached) return cached;
  const promise = (async () => {
    const raw = base64ToBytes(encryptionKeyB64);
    if (raw.length !== 32) {
      throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  })();
  encryptionKeyCache.set(encryptionKeyB64, promise);
  return promise;
}

export async function encrypt(
  plain: string,
  encryptionKeyB64: string | undefined,
): Promise<string> {
  if (plain === null || plain === undefined || plain === "") return "";
  const key = await getEncryptionKey(encryptionKeyB64);
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);
  return `aesgcm:v1:${bytesToBase64(blob)}`;
}

export async function decrypt(
  stored: string,
  encryptionKeyB64: string | undefined,
): Promise<string> {
  if (!stored) return "";
  if (stored.startsWith("pbkdf2_sha256$")) {
    // Not a ciphertext: the admin password hash lives in the same
    // sensitive-settings path. Return it untouched so login still works.
    return stored;
  }
  if (!stored.startsWith("aesgcm:v1:")) {
    // Python `v1:` (Fernet/AESGCM, master.key) or legacy plaintext: not
    // decryptable here — see the incompatibility note at the top of file.
    throw new Error(
      "Stored secret uses the Python Docker format (v1:/master.key) and cannot be decrypted in Workers — re-enter the secret",
    );
  }
  const key = await getEncryptionKey(encryptionKeyB64);
  const raw = base64ToBytes(stored.slice("aesgcm:v1:".length));
  if (raw.length < 12 + 16) {
    throw new Error("Stored secret is too short to be a valid aesgcm:v1 value");
  }
  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** Render a credential safe for display / logs. */
export function mask(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(6)}${secret.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Session tokens: HMAC-SHA256 signed, stateless, 14-day TTL.
// Payload: {u, exp, epoch, jti} — `epoch` (not Python's `e`) and `jti` are
// the field names fixed by CONTRACT.md. Cookie name: cdt_mgmt_session.
// Revocation is checked by the API layer against D1 `revoked_sessions`
// via repo.isSessionRevoked(sessionId(token)).
// ---------------------------------------------------------------------------

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function getHmacKey(sessionSecret: string | undefined): Promise<CryptoKey> {
  if (!sessionSecret) {
    throw new Error(
      "SESSION_SECRET is not configured: set it via `wrangler secret put SESSION_SECRET`",
    );
  }
  const cached = hmacKeyCache.get(sessionSecret);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  hmacKeyCache.set(sessionSecret, promise);
  return promise;
}

async function sign(payload: Uint8Array, sessionSecret: string): Promise<string> {
  const key = await getHmacKey(sessionSecret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload as BufferSource),
  );
  return bytesToBase64Url(sig);
}

export async function issueSession(
  username: string,
  epoch: number,
  sessionSecret: string | undefined,
): Promise<string> {
  if (!sessionSecret) throw new Error("SESSION_SECRET is not configured");
  const payload: SessionPayload = {
    u: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    // epoch change invalidates all previously issued tokens (password change)
    epoch: Math.floor(epoch),
    jti: crypto.randomUUID(),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const body = bytesToBase64Url(payloadBytes);
  return `${body}.${await sign(payloadBytes, sessionSecret)}`;
}

/** Verify a token and return its payload, or null if invalid/expired/stale. */
export async function parseSession(
  token: string,
  epoch: number,
  sessionSecret: string | undefined,
): Promise<SessionPayload | null> {
  if (!token || !token.includes(".")) return null;
  if (!sessionSecret) return null;
  const dot = token.lastIndexOf(".");
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = base64UrlToBytes(body);
  } catch {
    return null;
  }
  const expectedSig = await sign(payloadBytes, sessionSecret);
  if (
    !timingSafeEqual(
      new TextEncoder().encode(expectedSig),
      new TextEncoder().encode(signature),
    )
  ) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const exp = Number(record["exp"] ?? 0);
  const payloadEpoch = Number(record["epoch"] ?? 0);
  const username = String(record["u"] ?? "");
  const jti = String(record["jti"] ?? "");
  if (!username || !jti) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  if (payloadEpoch !== Math.floor(epoch)) return null;
  return { u: username, exp, epoch: payloadEpoch, jti };
}

/** Verify a token and return the username, or null. */
export async function readSession(
  token: string,
  epoch: number,
  sessionSecret: string | undefined,
): Promise<string | null> {
  const payload = await parseSession(token, epoch, sessionSecret);
  return payload ? payload.u : null;
}

export function newCsrfToken(): string {
  // secrets.token_urlsafe(24) equivalent: 24 random bytes, base64url, 32 chars.
  return bytesToBase64Url(randomBytes(24));
}

/**
 * Stable short id for a token, for the revocation blacklist.
 * Only the signature is hashed (SHA-256, first 32 hex chars) — the table
 * never holds a usable token. Async because WebCrypto digest is async
 * (Python's hashlib.sha256 was synchronous).
 */
export async function sessionId(token: string): Promise<string> {
  if (!token || !token.includes(".")) return "";
  const signature = token.slice(token.lastIndexOf(".") + 1);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature)),
  );
  return Array.from(digest, (b) => (b as number).toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
