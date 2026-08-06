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
 * compromise does not hand over the review UI, and both are compared with the
 * same constant-time helper the login path uses.
 */
export async function requireMachine(request: Request): Promise<boolean> {
  const token = process.env.CRON_TOKEN?.trim();
  if (token) {
    const header = request.headers.get('authorization') ?? '';
    const presented = header.replace(/^Bearer\s+/i, '');
    const { timingSafeEqual } = await import('node:crypto');
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(token, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return hasSession();
}
