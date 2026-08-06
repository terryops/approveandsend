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

/**
 * Whether the cookie should be marked `Secure`, from the scheme in use.
 *
 * This used to key off `NODE_ENV`, which meant every production install got
 * `Secure: true` — including the many that sit on a Tailscale address or a LAN
 * IP with no certificate, where the browser silently refuses to store the
 * cookie and the login page just reloads forever. The escape hatch existed but
 * you could only find it after being locked out by it, which is not an escape
 * hatch. The scheme is a fact about the request and answers the question
 * exactly: mark it `Secure` when the browser is actually on HTTPS.
 *
 * `COOKIE_SECURE` forces either answer, for a proxy that terminates TLS
 * without saying so in `X-Forwarded-Proto`.
 */
export function cookieSecure(proto: string | null | undefined): boolean {
  const override = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (override === 'true' || override === '1') return true;
  if (override === 'false' || override === '0') return false;

  // A proxy chain appends, so the client-facing scheme is the first entry.
  return (proto ?? '').split(',')[0]!.trim().toLowerCase() === 'https';
}

export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(DEFAULT_TTL_MS / 1000),
    secure,
  } as const;
}
