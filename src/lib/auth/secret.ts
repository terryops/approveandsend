import { randomBytes } from 'node:crypto';

import { getMeta, setMeta } from '../db/meta';

/**
 * The key the session cookie is signed with.
 *
 * Three sources, in order, and the order is the whole point:
 *
 * 1. `SESSION_SECRET`, when someone has set one deliberately.
 * 2. `aas:<ADMIN_PASSWORD>`, so changing the password signs everyone out. In a
 *    system with no session store that is the only revocation there is, and it
 *    is worth keeping.
 * 3. A random string generated once and kept in `meta`.
 *
 * The third exists because of operators. Before them, no password meant no
 * auth at all, so a predictable key signed tokens nobody was checking. Now an
 * install can have operators and no `ADMIN_PASSWORD` — a real login wall — and
 * deriving the key from an empty password would make every such install share
 * the constant `aas:`, which anyone who has read this file could forge against.
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

  // Written on first use rather than in the migration: a database that only
  // ever uses ADMIN_PASSWORD never needs one, and a secret that exists in
  // every backup is a secret in more places than it has to be.
  const fresh = randomBytes(32).toString('base64url');
  setMeta(META_KEY, fresh);
  cached = fresh;
  return fresh;
}

export function sessionSecret(password: string | null): string {
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit) return explicit;
  if (password) return `aas:${password}`;
  return installSecret();
}

/** For tests, and for anything that swaps the database underneath a process. */
export function resetSessionSecret(): void {
  cached = null;
}
