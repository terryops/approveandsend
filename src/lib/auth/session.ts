import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Single-tenant auth: one password, one signed cookie.
 *
 * The system this was extracted from shipped a plaintext user table and a
 * session token of the form `user:timestamp:random` that nothing verified —
 * so anyone could mint one by typing it into the cookie jar. Both mistakes are
 * fixed here by having neither a user table nor an unsigned token: the cookie
 * is an expiry plus an HMAC over it, and the key is derived from the password,
 * so changing the password logs everyone out for free.
 */

const COOKIE_NAME = 'aas_session';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export { COOKIE_NAME };

/**
 * The password, or null when none is configured.
 *
 * An unset password disables auth rather than bricking the app: the common
 * first run is `npm run dev` behind a loopback interface, and a login wall
 * with no credentials to type is worse than useless. Every page renders a
 * warning banner in that state — see `isProtected()`.
 */
export function adminPassword(): string | null {
  const value = process.env.ADMIN_PASSWORD?.trim();
  return value ? value : null;
}

export function isProtected(): boolean {
  return adminPassword() !== null;
}

function signingKey(): Buffer {
  const password = adminPassword() ?? '';
  const secret = process.env.SESSION_SECRET?.trim() || `aas:${password}`;
  return Buffer.from(secret, 'utf8');
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** Constant-time, and false rather than throwing when the lengths differ. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function checkPassword(input: string): boolean {
  const password = adminPassword();
  if (password === null) return true;
  return safeEqual(input, password);
}

export function issueToken(ttlMs = DEFAULT_TTL_MS): string {
  // The nonce makes two tokens issued in the same millisecond distinguishable,
  // which matters only for debugging — it is not a session id, because there
  // is no session store to look it up in.
  const payload = `${Date.now() + ttlMs}.${randomBytes(9).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false;

  const cut = token.lastIndexOf('.');
  if (cut <= 0) return false;

  const payload = token.slice(0, cut);
  if (!safeEqual(token.slice(cut + 1), sign(payload))) return false;

  const expiry = Number(payload.split('.')[0]);
  return Number.isFinite(expiry) && expiry > Date.now();
}

export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: Math.floor(DEFAULT_TTL_MS / 1000),
  // Not `secure: true` unconditionally: plenty of self-hosted installs sit on
  // a Tailscale address with no certificate, and a cookie the browser refuses
  // to store is an unfixable login loop.
  secure: process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_COOKIE !== 'true',
} as const;
