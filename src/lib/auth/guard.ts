import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { resolveRequestLocale } from '../i18n';
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
 *
 * Memoised per request, so that a page checking on top of its layout costs one
 * signature check and one row read rather than two.
 */
export const currentIdentity = cache(async function currentIdentity(): Promise<Identity | null> {
  if (!isProtected()) return { operatorId: null };

  const jar = await cookies();
  const identity = verifyToken(jar.get(COOKIE_NAME)?.value);
  if (!identity?.operatorId) return identity;

  // A cookie stays cryptographically valid for a week, so disabling someone
  // would otherwise not take effect until it expired. Reading the row on every
  // request is what makes the button on the operators page mean anything.
  const operator = getOperator(identity.operatorId);
  return operator && !operator.disabledAt ? identity : null;
});

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

/**
 * Whether this request may reach the four screens that are not work.
 *
 * Three cases, and the middle one is the one worth spelling out:
 *
 * - No session at all: no. The page guards redirect before this matters, but
 *   an answer of "yes, because nobody is nobody in particular" is exactly the
 *   bug `requireMachine` had.
 * - A session with no operator id: yes. That is `ADMIN_PASSWORD`, the shared
 *   key to the whole install — and on an install with no password at all it is
 *   everyone, which is correct, because a desk with no door has no roles to
 *   enforce and the wizard behind `/setup` is the thing that gives it one.
 * - A named operator: whatever their row says.
 */
export async function isAdmin(): Promise<boolean> {
  const identity = await currentIdentity();
  if (!identity) return false;
  if (!identity.operatorId) return true;
  return getOperator(identity.operatorId)?.admin === true;
}

/**
 * For the pages behind the flag: the queue, the archive, the people list and
 * setup.
 *
 * A reviewer who types one of those addresses lands on the inbox rather than
 * on a refusal. There is nothing for them to do about being told no — the fix
 * is a colleague pressing a button on a screen they cannot see — so a wall
 * would only be a worse way of saying "not here". The nav does not offer these
 * links to them either; this is the half that a typed URL cannot get past.
 */
export async function requireAdminPage(): Promise<void> {
  await requirePage();
  if (!(await isAdmin())) redirect('/');
}

/**
 * The same line for the actions those pages post to.
 *
 * Every one of them keeps its `requireApi()` — this calls it — because hiding a
 * link is not a permission check and a form post does not come from a link. A
 * retired reviewer's browser still has the queue page in its history, and the
 * buttons on it still post.
 */
export async function requireAdminApi(): Promise<void> {
  await requireApi();
  if (!(await isAdmin())) throw new Error('Not permitted');
}

/**
 * For server components. Sends the browser to the login page.
 *
 * Also settles what language the page is in, which is not this function's
 * business but is the only place guaranteed to run before one. The App Router
 * renders a layout and the page inside it as separate tasks, so resolving the
 * language in the root layout leaves a race the page sometimes wins: the nav
 * came back in Chinese and the form under it in English. Every page starts with
 * this await, so hanging it here is the one hook that cannot be forgotten on a
 * page added later — the same argument that keeps the session check out of
 * middleware.
 */
export async function requirePage(): Promise<void> {
  await resolveRequestLocale();
  if (!(await hasSession())) redirect('/login');
}

/**
 * For route handlers and server actions. Throws rather than redirecting.
 *
 * The same await as `requirePage`, and it is not decoration here either. A
 * server action is its own request: nothing has read `Accept-Language` for it,
 * and on an install that has not picked an interface language the workspace
 * answer is `''` — so every `t()` thrown out of an action fell through to
 * English while the page the operator was looking at was in their own language.
 * A French wizard rejecting a short password in English is the shape of it, and
 * the same went for every failure `sendReply` renders into `?error=`.
 */
export async function requireApi(): Promise<void> {
  await resolveRequestLocale();
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
