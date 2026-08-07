import type { Db } from '../db';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: string;
  type: string;
  /** Already parsed. `{}` when the stored JSON is unreadable. */
  payload: unknown;
  dedupeKey: string | null;
  status: JobStatus;
  /** Lower runs first. */
  priority: number;
  attempts: number;
  maxAttempts: number;
  /** Not claimable before this. Also carries the retry backoff. */
  runAfter: string;
  leaseExpiresAt: string | null;
  /**
   * Issued by the claim that produced this job, and required to write its
   * outcome. A worker preempted by lease expiry still holds the old one.
   */
  leaseToken: string | null;
  /** The handler's return value, JSON-encoded. */
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobContext {
  job: Job;
  db: Db;
}

/** Whatever it returns is JSON-encoded into `result`, for debugging. */
export type JobHandler = (payload: unknown, context: JobContext) => Promise<unknown>;

/**
 * A failure that retrying cannot fix — a malformed payload, a deleted record.
 * The predecessor retried everything three times, so a job enqueued with a
 * typo'd id burned three LLM calls to reach the same conclusion.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}
