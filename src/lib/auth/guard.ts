import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { COOKIE_NAME, isProtected, verifyToken } from './session';

/**
 * One check, called from every page and every route handler.
 *
 * Deliberately not middleware: middleware runs on the edge runtime, this needs
 * `node:crypto`, and a security check you have to remember to keep in the
 * matcher pattern is a security check that will eventually miss a route.
 */

export async function hasSession(): Promise<boolean> {
  if (!isProtected()) return true;
  const jar = await cookies();
  return verifyToken(jar.get(COOKIE_NAME)?.value);
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
