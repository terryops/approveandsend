'use client';

import { useEffect } from 'react';

import { noteOpened } from '../../actions';

/**
 * Somebody actually looked at this one.
 *
 * This used to be `after(() => markOpened(id))` in the page itself, which was
 * the right shape for a screen that is only ever rendered because somebody
 * asked for it — and stopped being true the moment the inbox started
 * prefetching. A prefetch renders this page in full on the server without
 * anybody seeing it, so the read-marker fired on rows the reviewer had merely
 * pointed at on the way past, and the unread dot cleared itself off mail nobody
 * had opened. That is the exact hazard Next's prefetching guide warns about
 * under "triggering unwanted side-effects during prefetching", and its answer is
 * this one: a side effect belongs in an effect, where it happens because a
 * browser mounted the page rather than because a server rendered it.
 *
 * There is no prefetch of a *document*, though, so the page keeps a server-side
 * marker for the one case an effect cannot reach: a browser with no JavaScript,
 * which has no soft navigations and therefore no prefetching either. See the
 * `sec-fetch-dest` check on the task page. With scripts on, both fire on a hard
 * load and the second is a no-op — `markOpened` only writes a column that is
 * still null.
 *
 * Keyed on the task rather than on the mount, because the router keeps this
 * component alive across a `router.refresh()` and across a move from one task to
 * the next. Refreshes must not repost; a new task must.
 */
export function MarkOpened({ taskId }: { taskId: string }) {
  useEffect(() => {
    // Nothing waits for this and nothing renders from it: the action revalidates
    // nothing, so the answer is an empty response the router throws away. The
    // dot it clears is on the inbox, which is rendered afresh on the way back.
    void noteOpened(taskId);
  }, [taskId]);

  return null;
}
