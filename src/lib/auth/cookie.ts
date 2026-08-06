import { cookies, headers } from 'next/headers';

import { COOKIE_NAME, cookieOptions, cookieSecure, issueToken } from './session';

/**
 * Sets the session cookie with the right flags for however this install is
 * being reached.
 *
 * Next fills in `x-forwarded-proto` itself when nothing else has — `http` for
 * a request that arrived directly, the proxy's value when there is one — so
 * there is no ambiguous "header is missing" case to guess at.
 */
export async function setSessionCookie(operatorId: string | null = null): Promise<void> {
  const proto = (await headers()).get('x-forwarded-proto');
  const jar = await cookies();
  jar.set(COOKIE_NAME, issueToken(operatorId), cookieOptions(cookieSecure(proto)));
}
