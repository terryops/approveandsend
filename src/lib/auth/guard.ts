import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getOperator, type Operator } from '../operators/store';
import { COOKIE_NAME, isProtected, verifyToken, type Identity } from './session';

/**
 * One check, called from every page and every route handler.
 *
 * Deliberately not middleware: middleware runs on the edge runtime, this needs
 * `node:crypto`, and a security check you have to remember to keep in the
 * matcher pattern is a security check that will eventually miss a route.
 */

/**
 * The identity in the cookie, or null.
 *
 * An unprotected install answers `{ operatorId: null }` — logged in as nobody,
 * which is true, rather than not logged in, which would send someone to a
 * login page that has no password to accept.
 */
export async function currentIdentity(): Promise<Identity | null> {
  if (!isProtected()) return { operatorId: null };

  const jar = await cookies();
  const identity = verifyToken(jar.get(COOKIE_NAME)?.value);
  if (!identity?.operatorId) return identity;

  // A cookie stays cryptographically valid for a week, so disabling someone
  // would otherwise not take effect until it expired. Reading the row on every
  // request is what makes the button on the operators page mean anything.
  const operator = getOperator(identity.operatorId);
  return operator && !operator.disabledAt ? identity : null;
}

export async function hasSession(): Promise<boolean> {
  return (await currentIdentity()) !== null;
}

/**
 * The operator behind this request, if there is a named one.
 *
 * Null means there is no name to write: either nobody is logged in, or the
 * shared password is, which is nobody in particular. A disabled operator never
 * reaches here — `currentIdentity` has already turned them away.
 */
export async function currentOperator(): Promise<Operator | null> {
  const identity = await currentIdentity();
  return identity?.operatorId ? getOperator(identity.operatorId) : null;
}

/** For server components. Sends the browser to the login page. */
export async function requirePage(): Promise<void> {
  if (!(await hasSession())) redirect('/login');
}

/** For route handlers and server actions. Throws rather than redirecting. */
export async function requireApi(): Promise<void> {
  if (!(await hasSession())) throw new Error('Not authenticated');
}

/**
 * Cron and other machine callers, which have no cookie jar.
 *
 * `CRON_TOKEN` is separate from the admin password so that a scheduler
 * compromise does not hand over the review UI, and it is compared with the same
 * constant-time helper the login path uses.
 *
 * Set the token and it is the whole answer: a wrong one is rejected outright
 * rather than falling through to the cookie. This used to end in
 * `return hasSession()`, which made six endpoints — sync, worker, sweep,
 * consolidate, context write, legacy import — reachable by any browser session,
 * and on an install with no `ADMIN_PASSWORD` and no operators reachable by
 * anyone at all, token or not.
 *
 * With no token there is nothing to authenticate a machine *as*, so the cookie
 * fallback is opt-in through `AAS_MACHINE_SESSION=1` — for the setup where
 * these are driven from a logged-in browser tab rather than a scheduler. Even
 * then the request must be same-origin: `/api` has no CSRF token and leans
 * entirely on `SameSite=Lax`, which is a default a browser may relax and not a
 * check this code performs. A cross-site POST that arrives with a valid cookie
 * is exactly the request that must not drain the queue.
 */
export async function requireMachine(request: Request): Promise<boolean> {
  const token = process.env.CRON_TOKEN?.trim();
  if (token) {
    const header = request.headers.get('authorization') ?? '';
    const presented = header.replace(/^Bearer\s+/i, '');
    const { timingSafeEqual } = await import('node:crypto');
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(token, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  if (process.env.AAS_MACHINE_SESSION?.trim() !== '1') return false;
  // On an install with no password and no operators there is no session to
  // check: `hasSession` is true for everyone, so the flag would open sync,
  // worker, sweep, consolidate and the legacy import to anyone who can reach
  // the port. The flag is meant to say "the browser session is enough", and on
  // an unprotected desk the browser session is not a statement about anybody.
  if (!isProtected()) return false;
  if (!sameOrigin(request)) return false;
  return hasSession();
}

/**
 * Whether the request came from the page it claims to have come from.
 *
 * No `origin` header means no cross-site form or fetch put it there — curl and
 * same-origin navigations both look like this — so absence is allowed. A header
 * that is present and names a different host is the case worth refusing.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  const host = request.headers.get('host');
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    // An unparseable Origin is not a same-origin one.
    return false;
  }
}
