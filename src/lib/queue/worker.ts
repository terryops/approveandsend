import { getDb, type Db } from '../db';
import { backoffMs, claimNext, completeJob, failJob, DEFAULT_LEASE_MS } from './store';
import { PermanentJobError, type Job, type JobHandler } from './types';

/**
 * The worker: claim a job, run its handler, record what happened.
 *
 * Handlers are registered rather than switched on. The predecessor had one
 * 700-line route with a `switch` over six job types, half of them specific to
 * one company's internal tooling, which is exactly the kind of thing that
 * cannot be extracted into a public project. A registry means a deployment can
 * add a job type without touching this file.
 */

export interface WorkerOptions {
  handlers: Record<string, JobHandler>;
  /** Restrict this worker to one job type. */
  type?: string;
  leaseMs?: number;
  db?: Db;
  /** Override the retry delay. Tests pass `() => 0`. */
  backoff?: (attempts: number) => number;
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | { kind: 'completed'; job: Job; result: unknown }
  | { kind: 'retrying'; job: Job; error: string; delayMs: number }
  | { kind: 'failed'; job: Job; error: string };

export interface JobOutcome {
  job: Job;
  status: 'completed' | 'retrying' | 'failed';
  result?: unknown;
  error?: string;
}

export interface Worker {
  /** Runs at most one job. Null when there was nothing to run. */
  runOnce(): Promise<JobOutcome | null>;
  /** Runs until the queue is empty or `max` jobs have been run. */
  drain(max?: number): Promise<JobOutcome[]>;
}

export function createWorker(options: WorkerOptions): Worker {
  const db = options.db ?? getDb();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const backoff = options.backoff ?? (attempts => backoffMs(attempts));

  async function runOnce(): Promise<JobOutcome | null> {
    const job = claimNext({ type: options.type, leaseMs }, db);
    if (!job) return null;

    const handler = options.handlers[job.type];
    if (!handler) {
      // Not a transient condition: no number of retries will register a
      // handler. Retrying would also hold the job at the head of the queue.
      return record({ job, permanent: true, error: `No handler registered for job type "${job.type}"` });
    }

    try {
      const result = await handler(job.payload, { job, db });
      if (!completeJob(job.id, result, db, job.leaseToken)) {
        // The lease ran out while the handler was working and somebody else
        // has the job now. Their answer is the live one; ours is thrown away
        // rather than written over the top of it.
        console.warn(`[queue] discarding a result for ${job.id}: the lease was reassigned`);
        return null;
      }
      const outcome: JobOutcome = { job, status: 'completed', result };
      options.onEvent?.({ kind: 'completed', job, result });
      return outcome;
    } catch (error) {
      return record({
        job,
        permanent: error instanceof PermanentJobError,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function record({ job, permanent, error }: { job: Job; permanent: boolean; error: string }): JobOutcome | null {
    const delayMs = permanent ? 0 : backoff(job.attempts);
    const updated = failJob(job.id, error, { permanent, retryDelayMs: delayMs, leaseToken: job.leaseToken }, db);
    // Same fence as the success path, and it matters more here: a preempted
    // worker reporting a failure would put a job somebody else has already
    // completed back on the queue.
    if (!updated) return null;
    const status = updated.status === 'failed' ? 'failed' : 'retrying';

    options.onEvent?.(
      status === 'failed' ? { kind: 'failed', job: updated, error } : { kind: 'retrying', job: updated, error, delayMs },
    );

    return { job: updated, status, error };
  }

  async function drain(max = 100): Promise<JobOutcome[]> {
    const outcomes: JobOutcome[] = [];
    for (let i = 0; i < max; i += 1) {
      const outcome = await runOnce();
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  return { runOnce, drain };
}
