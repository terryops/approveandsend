'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The things in the header that have to know where you are.
 *
 * Same defect as the nav pill, same cause, and all of them found by clicking
 * rather than by reading: the root layout is not re-rendered on navigation, so
 * `headers()` up there reports the URL of whichever page loaded the *document*
 * and keeps reporting it for the rest of the session. Anything decided from it
 * is decided once and then quietly stops being true.
 *
 * See `nav.tsx` for the long version. These sit in their own file because they
 * are not navigation — all they share is the reason they cannot be server-side.
 *
 * Deliberately as small as the question each one answers. The forms, their
 * actions and their words all stay in the layout: `actions.fields.test.ts`
 * reads this codebase statically to check that every field a form posts is a
 * field its action reads, and it can only do that while the form and the name
 * of its action are in the same place. Passing the bound action down as a prop
 * compiles and works and puts that check out of a job — which is worth more
 * than the tidier component would have been.
 */

/**
 * Where the language and theme switches come back to.
 *
 * Both post a server action and redirect, and this field is how they know where
 * to land. Stale, it lands you somewhere else: open the inbox, click through to
 * the rulebook, switch to dark, and you are back on the inbox with your place
 * lost. The query comes too — a filtered or searched inbox is a different
 * screen from the bare one, and changing the theme should not clear it.
 */
export function ReturnTo() {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  return <input type="hidden" name="returnTo" value={query ? `${pathname}?${query}` : pathname} />;
}

/** The task being reviewed, or nothing. One regex, shared by both below. */
function reviewing(pathname: string): string | undefined {
  return /^\/tasks\/([^/]+)\/?$/.exec(pathname)?.[1];
}

/**
 * Shows its children on the review screen and nowhere else.
 *
 * The switch used to be conditioned on the layout's own pathname, so it
 * appeared when a task was loaded directly and never when one was clicked into
 * — and clicking into one from the queue is how a reviewer actually opens one.
 * On the ordinary path the control was simply missing; on the way back out it
 * stayed behind, offering to relayout a screen that had gone.
 *
 * Children arrive already rendered, forms and actions and all. What is decided
 * here is only whether they are on screen.
 */
export function WhileReviewing({ children }: { children: ReactNode }) {
  return reviewing(usePathname()) ? <>{children}</> : null;
}

/*
 * `OnInbox` was here, showing the desk's state and the two buttons that drive
 * it on the inbox and nowhere else. It has gone, and so has the group: the
 * markup is on the inbox page now — see `page.tsx`.
 *
 * Worth saying why, because the component was not wrong. It hid the group
 * correctly on six screens out of seven. What it could not do is stop the work:
 * children arrive here already rendered, so the four counts behind those two
 * numbers ran in the layout on every screen and were discarded on all but one —
 * and on that one they were whatever had been true when the document loaded,
 * because the layout that read them does not run again when you navigate. A
 * gate in the browser cannot fix either half. Reading them on the screen that
 * shows them fixes both.
 */

/** Which task the switch is about. Inside the form, so it posts with it. */
export function ReviewingTaskId() {
  return <input type="hidden" name="taskId" value={reviewing(usePathname()) ?? ''} />;
}
