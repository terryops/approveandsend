import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { countActiveOperators } from '../operators/store';
import { sessionSecret } from './secret';

/**
 * One signed cookie, which may or may not have a name in it.
 *
 * The system this was extracted from shipped a plaintext user table and a
 * session token of the form `user:timestamp:random` that nothing verified — so
 * anyone could authenticate as anyone by typing a cookie. The fix is not to
 * drop the identity but to sign it: the payload is an operator id, an expiry
 * and a nonce, and the HMAC covers all three. Editing the id invalidates the
 * token exactly as editing the expiry does.
 *
 * An empty id is `ADMIN_PASSWORD`, logged in as nobody in particular. That
 * install has no operators and nothing to attribute, so the identity slot is
 * honestly empty rather than filled with a fictional "admin" who never
 * existed.
 */

const COOKIE_NAME = 'aas_session';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export { COOKIE_NAME };

/** Who a valid cookie says is holding it. `null` means the shared password. */
export interface Identity {
  operatorId: string | null;
}

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

/**
 * Whether anything is guarding this install.
 *
 * Operators count. A team that added four people and never set
 * `ADMIN_PASSWORD` has a login wall, and the red banner saying otherwise would
 * be a lie about the one thing the banner exists to tell the truth about.
 */
export function isProtected(): boolean {
  if (adminPassword() !== null) return true;
  try {
    return countActiveOperators() > 0;
  } catch {
    // No database yet — the first run, before any migration. Nothing is
    // guarding it, which is exactly what the banner should say.
    return false;
  }
}

function signingKey(): Buffer {
  return Buffer.from(sessionSecret(adminPassword()), 'utf8');
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

/**
 * The shared password.
 *
 * True when none is configured — but that no longer means the door is open,
 * because operators may be guarding it instead. `isProtected()` is the
 * question about the door; this one is only about this password.
 */
export function checkPassword(input: string): boolean {
  const password = adminPassword();
  if (password === null) return true;
  return safeEqual(input, password);
}

export function issueToken(operatorId: string | null = null, ttlMs = DEFAULT_TTL_MS): string {
  // The nonce makes two tokens issued in the same millisecond distinguishable,
  // which matters only for debugging — it is not a session id, because there
  // is no session store to look it up in.
  const payload = `${operatorId ?? ''}.${Date.now() + ttlMs}.${randomBytes(9).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * The identity a cookie proves, or null if it proves nothing.
 *
 * Null and `{ operatorId: null }` are different answers and the distinction is
 * load-bearing: the first is "not logged in", the second is "logged in with
 * the shared password". Returning a boolean here is what let the predecessor
 * treat every session as the same anonymous person.
 */
export function verifyToken(token: string | undefined | null): Identity | null {
  if (!token) return null;

  const cut = token.lastIndexOf('.');
  if (cut <= 0) return null;

  const payload = token.slice(0, cut);
  if (!safeEqual(token.slice(cut + 1), sign(payload))) return null;

  const parts = payload.split('.');
  if (parts.length !== 3) return null;

  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;

  return { operatorId: parts[0] || null };
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
