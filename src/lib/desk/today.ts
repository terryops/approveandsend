/**
 * What this desk has done since midnight, what is still on it, and whether the
 * queue is moving.
 *
 * They are here for one reason: the review screen is a treadmill. A reviewer who
 * has answered thirty emails has no way to tell that from a reviewer who has
 * answered none — the queue only ever shows what is left, which by design never
 * looks finished. "Sent 7 today, learned 2 rules" is the only place the work
 * that is already done is visible at all.
 *
 * The same two numbers, read in two places and never both at once: the header
 * carries them on every screen, and the inbox opens with them at four times the
 * size — so the header stands down there.
 *
 * There used to be two more. `waiting` and `working` filled out a four-column
 * card at the top of the inbox, and they were the inbox's own first two tabs,
 * eighteen pixels below, in the same figures. Counting them here only ever
 * produced the same number in a louder typeface — and not always the same one,
 * since the tab counts `pending` alone while `working` added `drafting` to it,
 * which is the kind of near-agreement that reads as a bug. Both went with the
 * columns they were drawn for. What is left is what nothing else says.
 *
 * The queue light is the other half of the same honesty. A desk whose crontab
 * was never set up looks exactly like a desk with nothing to do, right up until
 * somebody notices the drafts stopped arriving three days ago. Which is why it
 * asks whether the worker is alive rather than whether the queue has anything in
 * it — see `queue` below for how badly those two come apart.
 *
 * Cheap enough for every page: four counts over indexed columns, no joins.
 */

import { getDb, type Db } from '../db';
import { queueStats } from '../queue/store';

export interface DeskToday {
  /** Replies that actually went out since midnight. */
  sent: number;
  /**
   * Rules the desk learned today — written from a conversation rather than
   * typed by hand, which is what `source_task_id` distinguishes. Proposals
   * count: the desk learned them, a person has yet to agree.
   */
  learned: number;
  /**
   * Whether the worker is alive, which is not the same question as whether the
   * queue has anything in it — and asking the second one gave the answer exactly
   * backwards. `pending + processing > 0` is *backlog*, and backlog is precisely
   * what a crontab that was never set up produces: jobs arrive, nothing claims
   * them, and the header lit up green and said "queue running" for three days.
   * A desk that was genuinely healthy and had just caught up said "idle".
   *
   * So it is liveness now, read from the jobs themselves:
   *
   * - `running` — something is being worked on, or something finished recently.
   * - `stalled` — there is work waiting and nothing has moved in a while. This
   *   is the state the light was added for and the one it could never show.
   * - `idle` — nothing waiting and nothing recent. A quiet desk, correctly quiet.
   */
  queue: 'running' | 'stalled' | 'idle';
}

/**
 * How long a queue may go without finishing anything before it is stalled.
 *
 * Fifteen minutes. Long enough that a five-minute crontab misses two runs before
 * anybody is told, which is the point — a light that cries wolf between ticks is
 * a light people stop reading.
 */
const QUIET_MINUTES = 15;

/** Local midnight as an ISO prefix, because every timestamp in this app is ISO-8601 UTC. */
function since(): string {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return midnight.toISOString();
}

const NOTHING: DeskToday = { sent: 0, learned: 0, queue: 'idle' };

/**
 * Never throws, because this is rendered by the root layout — on every screen,
 * including the login page and the first step of the wizard.
 *
 * A count in the header is decoration next to the page under it. On an install
 * whose database is not there yet, or is locked, or is mid-migration, three
 * quiet zeroes are the right answer; taking the whole app down to avoid printing
 * "Sent 0 today" is not.
 */
export function deskToday(db?: Db): DeskToday {
  try {
    const handle = db ?? getDb();
    const from = since();

    const sent = handle
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'sent' AND sent_at >= ?`)
      .get(from) as { n: number };

    const learned = handle
      .prepare(
        `SELECT COUNT(*) AS n FROM rules WHERE created_at >= ? AND source_task_id IS NOT NULL`,
      )
      .get(from) as { n: number };

    const stats = queueStats(undefined, handle);

    // The most recent thing the worker actually did. `finished_at` and not
    // `created_at`: enqueuing is this app's doing and proves nothing about
    // whether anything is on the other end of the queue.
    const quiet = new Date(Date.now() - QUIET_MINUTES * 60_000).toISOString();
    const recent = handle
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE finished_at >= ?`)
      .get(quiet) as { n: number };

    const alive = stats.processing > 0 || recent.n > 0;

    return {
      sent: sent.n,
      learned: learned.n,
      queue: alive ? 'running' : stats.pending > 0 ? 'stalled' : 'idle',
    };
  } catch {
    return NOTHING;
  }
}
