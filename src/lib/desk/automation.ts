import { getDb, type Db } from '../db';
import { getMeta, setMeta } from '../db/meta';

/**
 * Whether anything outside this app is driving it.
 *
 * Four endpoints do everything that happens without a person: mail is fetched,
 * the queue is drained, killed jobs are released, the rulebook is tidied. None
 * of them run on their own — this app has no scheduler and deliberately does
 * not grow one, because a timer inside a web process is a timer that stops when
 * the process is recycled and says nothing about it.
 *
 * So the schedule lives outside, and the one thing this app can honestly report
 * is whether it is being called. That is the difference between a desk with
 * nothing to do and a desk nobody ever wired up — and until this existed the two
 * looked identical from every screen. `deskToday` makes the same distinction for
 * the worker by watching the jobs table; this watches the door.
 */

/** In the order the card lists them, which is the order the crontab has. */
export const SCHEDULED = ['sync', 'worker', 'sweep', 'consolidate'] as const;
export type Scheduled = (typeof SCHEDULED)[number];

/**
 * How often each is meant to be called, in minutes.
 *
 * The same cadence `docker/ticker.sh` runs and the same one the settings screen
 * hands out, because a desk told to expect a five-minute sync and then given a
 * fifteen-minute crontab would report itself late for ever.
 */
const EVERY: Record<Scheduled, number> = {
  sync: 5,
  worker: 2,
  sweep: 60,
  consolidate: 7 * 24 * 60,
};

/**
 * The two a desk stops working without.
 *
 * A sweep that has never run means nothing was ever left stuck, and a rulebook
 * that has never been consolidated is the normal state of a desk in its first
 * week. Letting either of those turn the verdict amber would make the verdict
 * useless in exactly the fortnight somebody is reading it most closely.
 */
const ESSENTIAL: readonly Scheduled[] = ['sync', 'worker'];

export interface ScheduledJob {
  job: Scheduled;
  /** Minutes between calls, as this app asks for it to be scheduled. */
  every: number;
  lastRun: string | null;
  /** Whole minutes since `lastRun`; null when it has never been called. */
  agoMinutes: number | null;
  state: 'onTime' | 'late' | 'never';
}

export interface Automation {
  jobs: ScheduledJob[];
  /** Nothing has ever called any of them: there is no scheduler at all. */
  silent: boolean;
  /** Something is calling them and one of the two that matter is overdue. */
  late: boolean;
  /** Without this there is nothing to authenticate a scheduler as. */
  tokenSet: boolean;
}

function key(job: Scheduled): string {
  return `automation.lastRun.${job}`;
}

/**
 * Recorded when the call arrives, not when the work succeeds.
 *
 * The question this answers is "is anything out there calling me", and a sync
 * that reached the mailbox and got a wrong password still answers it yes. The
 * failure has its own report — the sync result, the mailbox test — and folding
 * the two together would point somebody at their crontab over a password.
 *
 * A 401 is not recorded, which is the half that matters: a scheduler holding
 * the wrong token must not be able to light this green.
 *
 * Best-effort. A bookkeeping write that fails must not turn a working sync into
 * a 500 — the endpoint's job is the mail, and this is a note in the margin.
 */
export function noteRun(job: Scheduled, db?: Db): void {
  try {
    setMeta(key(job), new Date().toISOString(), db ?? getDb());
  } catch (error) {
    console.warn(`[automation] could not record the ${job} call:`, error);
  }
}

/**
 * How overdue a call has to be before it is worth saying so.
 *
 * Twice the interval, and never less than a quarter of an hour — the same floor
 * `deskToday` puts under the queue light and for the same reason. A two-minute
 * worker that goes amber at four minutes would be amber every time a host was
 * briefly busy, and a light that cries wolf between ticks is a light nobody
 * reads by the second week.
 */
function grace(every: number): number {
  return Math.max(every * 2, 15);
}

export function automation(db: Db = getDb()): Automation {
  const now = Date.now();

  const jobs = SCHEDULED.map<ScheduledJob>(job => {
    const every = EVERY[job];
    const lastRun = getMeta(key(job), db);
    const at = lastRun ? new Date(lastRun).getTime() : Number.NaN;

    if (!Number.isFinite(at)) {
      return { job, every, lastRun: null, agoMinutes: null, state: 'never' };
    }

    // Clamped at zero: a clock that moved backwards between the write and this
    // read would otherwise print a call that has not happened yet.
    const agoMinutes = Math.max(0, Math.floor((now - at) / 60_000));
    return {
      job,
      every,
      lastRun,
      agoMinutes,
      state: agoMinutes > grace(every) ? 'late' : 'onTime',
    };
  });

  const silent = jobs.every(job => job.state === 'never');

  return {
    jobs,
    silent,
    late:
      !silent &&
      jobs.some(job => ESSENTIAL.includes(job.job) && job.state !== 'onTime'),
    tokenSet: (process.env.CRON_TOKEN?.trim() ?? '') !== '',
  };
}
