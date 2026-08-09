/**
 * One turn of the queue on behalf of somebody who is watching it.
 *
 * The redraft panel polls its own page every couple of seconds, and hanging a
 * short drain off each of those renders is what keeps a chained job moving while
 * a reviewer waits: `redraftTask` kicks a worker, that worker finishes
 * `enrich-context`, and the `draft-reply` it queued needs somebody to come back
 * for it. The cron would, in a minute or five. The person staring at a spinner
 * would rather it were now.
 *
 * The flag is the whole reason this is a module of its own rather than four
 * lines in the page. Every poll tick is a render, and every render was starting
 * another drain: a generation that takes forty seconds accumulated twenty of
 * them from one open tab, times however many tabs and reviewers are watching.
 * The job lease stops two workers running the same job; it has nothing to say
 * about twenty workers being constructed to ask whether there is one.
 *
 * Per process, which is the same scope as the worker it guards, and claimed
 * inside the call rather than at the call site — a page that reassigns a module
 * variable while rendering is a page with a side effect in it, which is both a
 * lint error and true.
 */

import { DEFAULT_HANDLERS } from './handlers';
import { createWorker } from './worker';

let turning = false;

/**
 * How long the flag may be held before it is given back regardless.
 *
 * `finally` covers a drain that throws. It does not cover one that never
 * returns, and every caller here is fire-and-forget — `after(() =>
 * nudgeQueue())`, with nobody waiting on the promise. A model call to a provider
 * that accepts the connection and then stalls has no timeout of its own, so the
 * drain never settles, `finally` never runs, and the flag stays true for the
 * life of the process: every poll tick and every open review screen from then on
 * returns at the guard, and the queue stops being nudged at all. That is the
 * "chained job with nothing coming back for it" this module was written to
 * prevent, made permanent and invisible by the function that prevents it.
 *
 * Two minutes, which is longer than any drain that is actually working. Letting
 * a second worker start after it is not the risk it sounds like: the job lease
 * is what stops two workers taking the same job, and a cron firing mid-drain
 * already makes exactly this happen.
 */
const PATIENCE_MS = 120_000;

/** Runs a few jobs if nothing else already is. Never throws. */
export async function nudgeQueue(jobs = 3): Promise<void> {
  if (turning) return;
  turning = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const drain = createWorker({ handlers: DEFAULT_HANDLERS })
      .drain(jobs)
      .catch(() => {
        // A job that throws records the failure on its own row, and the screen
        // that asked for this closes its panel as soon as the task leaves
        // `pending` — with the error on the task, which is the honest end to a
        // wait that is not going to succeed.
        //
        // Caught on the promise rather than around the await: once the deadline
        // below has won the race, nothing is waiting on this any more, and a
        // rejection with no handler on it takes the process down.
      });

    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, PATIENCE_MS);
      // Nothing here is worth keeping a process alive for. `unref` exists on
      // Node's timer and not on the number the edge runtime returns.
      (timer as unknown as { unref?: () => void }).unref?.();
    });

    await Promise.race([drain, deadline]);
  } finally {
    clearTimeout(timer);
    turning = false;
  }
}
