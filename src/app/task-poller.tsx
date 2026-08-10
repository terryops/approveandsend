'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Watching a job that is already running.
 *
 * The review screen is a server component reading the row straight out of
 * SQLite, so there is nothing to subscribe to and nothing to invent an API for:
 * `router.refresh()` re-runs the page on the server and patches in whatever it
 * finds. When the drafting job writes the new reply and moves the task off
 * `pending`, the next refresh renders it and the panel this sits inside stops
 * being rendered at all — which is how the waiting state ends, without anything
 * here having to know what it was waiting for.
 *
 * Two seconds because that is the scale of the thing being watched: a model
 * call is tens of seconds, and a refresh costs one cheap read of a local file.
 * Polling only exists while this component is mounted, and it is only mounted
 * while a job is actually in flight — nothing here runs on an idle screen.
 */
export function TaskPoller({
  intervalMs = 2000,
  slowTo,
}: {
  intervalMs?: number;
  /**
   * How far apart the refreshes are allowed to drift, for a wait that may not
   * end.
   *
   * "A job is in flight" is a claim about the row, not about anything actually
   * turning: a task sits at `pending` for as long as it takes the queue to reach
   * it, and on an install whose crontab was never set up, or whose model is
   * misconfigured, that is forever. A fixed tick then means re-rendering this
   * whole screen — the letter, the thread, the rulebook, the history — every few
   * seconds for the rest of the afternoon, on a page that is never going to say
   * anything different. It is not free: it is a full server render competing with
   * the next thing the reviewer clicks.
   *
   * So the interval grows while nothing happens. Left unset it does not, and that
   * is the right answer for the redraft panel: a worker has just been kicked, the
   * answer is seconds away, and every one of those refreshes turns the queue
   * again — see the `nudgeQueue` in the task page, which is hung off exactly this
   * cadence and would slow down with it.
   */
  slowTo?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    // A chain of timeouts rather than an interval, because the gap changes.
    let wait = intervalMs;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      router.refresh();
      // Half again each time: from five seconds that is a minute's ceiling
      // after about a hundred seconds of nothing happening. A wait that was
      // going to end usually ends inside the first few refreshes, where this is
      // still as quick as it ever was.
      if (slowTo) wait = Math.min(Math.round(wait * 1.5), slowTo);
      timer = setTimeout(tick, wait);
    };

    timer = setTimeout(tick, wait);
    return () => clearTimeout(timer);
  }, [router, intervalMs, slowTo]);

  return null;
}
