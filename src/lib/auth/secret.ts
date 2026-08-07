import { randomBytes } from 'node:crypto';

import { getMeta, setMeta } from '../db/meta';

/**
 * The key the session cookie is signed with.
 *
 * Two sources: `SESSION_SECRET` when someone has set one deliberately, else a
 * random 32 bytes generated once and kept in `meta`.
 *
 * There used to be a third, between them: `aas:<ADMIN_PASSWORD>`. It bought one
 * real thing — changing the password signed everyone out, which in a system
 * with no session store is the only revocation there is — and it cost far more.
 * A cookie is a payload and its HMAC, handed to the browser and therefore to
 * anyone who gets a copy of it, and with a password-derived key that pair is an
 * offline oracle: one unsalted SHA-256 per guess, no rate limit, no lockout, no
 * log line. A support desk password does not survive that for an afternoon.
 *
 * So the trade is stated plainly: **changing `ADMIN_PASSWORD` no longer signs
 * anyone out.** Existing cookies stay valid until they expire, up to a week.
 * That is worth it, because the revocation it replaces was never the property
 * being defended — an attacker who already has the cookie does not need the
 * password, and the person who has the password can disable the operator or set
 * `SESSION_SECRET` to something new and cut every session at once. Losing a
 * weak eviction is cheaper than shipping a crackable one.
 */

const META_KEY = 'auth.session_secret';

let cached: string | null = null;

function installSecret(): string {
  if (cached) return cached;

  const existing = getMeta(META_KEY);
  if (existing) {
    cached = existing;
    return existing;
  }

  // Written on first use rather than in the migration: an install that pins
  // SESSION_SECRET never needs one, and a secret that exists in every backup
  // is a secret in more places than it has to be.
  const fresh = randomBytes(32).toString('base64url');
  setMeta(META_KEY, fresh);
  cached = fresh;
  return fresh;
}

export function sessionSecret(): string {
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit) return explicit;
  return installSecret();
}

/** For tests, and for anything that swaps the database underneath a process. */
export function resetSessionSecret(): void {
  cached = null;
}
