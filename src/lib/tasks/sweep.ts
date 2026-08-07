import { getDb, type Db } from '../db';
import { COMPOSE_MESSAGE, enqueueCompose } from '../queue/handlers/compose-message';
import { ENRICH_CONTEXT, enqueueForDrafting } from '../queue/handlers/enrich-context';
import { DRAFT_REPLY } from '../queue/handlers/draft-reply';
import { getTask, updateTask } from './store';

/**
 * Finding the tasks nothing is going to finish.
 *
 * Every path from "email arrives" to "draft awaiting review" runs through a
 * queued job, and a job can stop existing without the task ever hearing about
 * it. The worker's own error handling covers the case where a handler throws —
 * the task is marked `failed` and someone sees it. It does not cover:
 *
 *   - a lease that expired for the last time, which `claimNext` fails directly
 *     without running the handler, so nothing writes the task's status;
 *   - a worker killed mid-job, leaving the task in `drafting` and the job in
 *     `processing` until the lease runs out;
 *   - `cleanupJobs` deleting a finished job whose task never advanced;
 *   - an enrich-context job that died before it enqueued the draft.
 *
 * In all of them the task sits in `pending` or `drafting` and is invisible: no
 * error, no red row, no reply. The customer is waiting and the desk looks idle.
 * This finds them.
 */

/** Statuses that mean "the machine still owes this one something". */
const IN_FLIGHT = ['pending', 'drafting'] as const;

export interface SweepOptions {
  /**
   * How long a task may sit in an in-flight status before it counts as stuck.
   *
   * Longer than the queue's 15-minute lease by default. A job that is genuinely
   * running is excluded anyway, by the live-job check below; the grace is for
   * the gap between `createTask` and `enqueue`, which are not one transaction.
   */
  graceMs?: number;
  /** Cap on tasks touched per run, so one bad night cannot fan out unboundedly. */
  limit?: number;
  db?: Db;
}

export interface SweepResult {
  /** Stuck tasks found. The other three numbers sum to this. */
  found: number;
  /** Put back in the queue: there was no job left to finish them. */
  requeued: number;
  /** Marked failed: their job gave up, and retrying it is a human's call. */
  failed: number;
  /** Neither: enqueueing threw. Left alone for the next sweep. */
  errors: { taskId: string; error: string }[];
}

interface StuckRow {
  id: string;
  status: string;
  /** The most recent job for this task, if any survives. */
  job_status: string | null;
  job_error: string | null;
}

/**
 * Repair whatever fell through.
 *
 * A task with no job at all is requeued — the work was never done and nothing
 * is going to do it. A task whose last job *failed* is marked failed instead,
 * carrying the job's error: re-running a job that already exhausted its
 * attempts would either loop forever (a malformed payload never becomes valid)
 * or quietly re-spend three LLM calls per sweep on an outage that has not
 * ended. Marking it failed puts it in front of a human with a redraft button,
 * which is where that decision belongs.
 */
export async function sweepStuckTasks(options: SweepOptions = {}): Promise<SweepResult> {
  const db = options.db ?? getDb();
  const cutoff = new Date(Date.now() - (options.graceMs ?? 20 * 60 * 1000)).toISOString();

  // Jobs are matched on dedupe_key rather than by digging the task id out of
  // the JSON payload: the key is `type:taskId` by construction, and it is the
  // column the queue already has an index on.
  //
  // All three job types, because a composed message reaches `awaiting_review`
  // by a different route than an inbound one. Leaving `compose-message` out
  // made every stuck composition look like a task with no job at all, and the
  // repair below then enqueued a *drafting* job for it — which has no customer
  // email to work from.
  const keys = `(:draft || t.id, :enrich || t.id, :compose || t.id)`;
  const rows = db
    .prepare(
      `SELECT t.id, t.status,
              (SELECT j.status FROM jobs j
                WHERE j.dedupe_key IN ${keys}
                ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS job_status,
              (SELECT j.error FROM jobs j
                WHERE j.dedupe_key IN ${keys}
                ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS job_error
         FROM tasks t
        WHERE t.status IN (${IN_FLIGHT.map(s => `'${s}'`).join(', ')})
          AND t.updated_at < :cutoff
          -- Anything still claimable, or still running, is not stuck.
          AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.dedupe_key IN ${keys}
                   AND j.status IN ('pending', 'processing')
              )
        ORDER BY t.updated_at ASC
        LIMIT :limit`,
    )
    .all({
      draft: `${DRAFT_REPLY}:`,
      enrich: `${ENRICH_CONTEXT}:`,
      compose: `${COMPOSE_MESSAGE}:`,
      cutoff,
      limit: options.limit ?? 50,
    }) as StuckRow[];

  const result: SweepResult = { found: rows.length, requeued: 0, failed: 0, errors: [] };

  for (const row of rows) {
    try {
      if (row.job_status === 'failed') {
        updateTask(
          row.id,
          {
            status: 'failed',
            error:
              row.job_error ??
              'The job that was going to draft this stopped without saying why.',
          },
          db,
        );
        result.failed += 1;
      } else if (getTask(row.id, db)?.origin === 'composed') {
        // Same repair, the other pipeline. Sending this one down the drafting
        // path would produce a reply to an email nobody sent.
        enqueueCompose(row.id, { db });
        result.requeued += 1;
      } else {
        await enqueueForDrafting(row.id, { db });
        result.requeued += 1;
      }
    } catch (error) {
      // One task that will not requeue must not stop the other forty-nine.
      result.errors.push({
        taskId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
