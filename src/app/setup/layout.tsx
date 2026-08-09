import type { ReactNode } from 'react';

import { requireAdminPage } from '@/lib/auth/guard';

/**
 * The shell around the wizard's steps and around the settings screen they
 * become.
 *
 * Nothing but the guard now: the step strip moved into the pages themselves,
 * because a layout is not told which of its children is being rendered and a
 * progress indicator that cannot say which step you are on is a list of links.
 * That it cannot tell them apart is also why the choice between the two shapes
 * is made in `page.tsx` rather than here. See `steps.tsx` and `settingsMode`.
 *
 * Note what guards this: `requireAdminPage`, one call covering the wizard, the
 * settings screen and every step page under them — a layout is the one place a
 * check cannot be forgotten by whoever adds the fifth step.
 *
 * On a fresh install there is no password, so `isProtected()` is false, nobody
 * is anybody in particular, and `isAdmin()` is true for the visitor — which is
 * the only way this could work, since setting the password is step one and the
 * first operator is created on it. The moment that step completes the wizard is
 * behind the login wall along with everything else, and behind the flag: the
 * operator it just created is an admin, and the colleagues they add afterwards
 * are not. No special case, no bypass to forget about later.
 */
export default async function SetupLayout({ children }: { children: ReactNode }) {
  await requireAdminPage();
  return <div className="stack">{children}</div>;
}
