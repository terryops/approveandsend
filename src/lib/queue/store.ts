import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import type { Job, JobStatus } from './types';

/**
 * Queue storage.
 *
 * The design constraint is that the only durable state is one SQLite file —
 * there is no Redis here and adding one to run a handful of background jobs
 * would be the largest operational cost in the project. Everything below is
 * therefore written so that a crashed worker, two workers, or a worker
 * restarted mid-job all end in a state the next claim can reason about.
 */

interface JobRow {
  id: string;
  type: string;
  payload: string;
  dedupe_key: string | null;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_expires_at: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function mapJob(row: JobRow): Job {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    // A payload we cannot read is a permanent failure, but that is the
    // handler's verdict to reach — reading a job must not throw.
  }

  return {
    id: row.id,
    type: row.type,
    payload,
    dedupeKey: row.dedupe_key,
    status: row.status as JobStatus,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface EnqueueOptions {
  payload?: unknown;
  /** While a job with this key is pending or processing, this is a no-op. */
  dedupeKey?: string;
  /** Lower runs first. Default 5. */
  priority?: number;
  maxAttempts?: number;
  /** Delay before the job becomes claimable. */
  delayMs?: number;
}

export interface EnqueueResult {
  job: Job;
  /** True when an unfinished job already held this dedupe key. */
  deduped: boolean;
}

export function enqueue(type: string, options: EnqueueOptions = {}, db: Db = getDb()): EnqueueResult {
  const now = Date.now();
  const runAfter = new Date(now + (options.delayMs ?? 0)).toISOString();
  const id = randomUUID();

  try {
    const row = db
      .prepare(
        `INSERT INTO jobs (id, type, payload, dedupe_key, status, priority, attempts,
                           max_attempts, run_after, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        id,
        type,
        JSON.stringify(options.payload ?? {}),
        options.dedupeKey ?? null,
        options.priority ?? 5,
        options.maxAttempts ?? 3,
        runAfter,
        new Date(now).toISOString(),
      ) as JobRow;

    return { job: mapJob(row), deduped: false };
  } catch (error) {
    // The unique index did its job. Return the job already holding the key
    // rather than an error: the caller asked for the work to happen, and it
    // is going to happen.
    const existing = options.dedupeKey
      ? (db
          .prepare(
            `SELECT * FROM jobs
              WHERE dedupe_key = ? AND (status = 'pending' OR status = 'processing')
              LIMIT 1`,
          )
          .get(options.dedupeKey) as JobRow | undefined)
      : undefined;

    if (existing) return { job: mapJob(existing), deduped: true };
    throw error;
  }
}

export interface ClaimOptions {
  /** Restrict to one job type. */
  type?: string;
  /** How long the claim is good for. Must exceed the slowest handler. */
  leaseMs?: number;
}

/** 15 minutes — an LLM call on a self-hosted model genuinely takes minutes. */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

/**
 * Takes the next runnable job and marks it processing, in one statement.
 *
 * The predecessor selected a job and then claimed it in a second query. That
 * is correct only because the second one re-checks the status — the losing
 * worker gets nothing back and concludes the queue is empty while work is
 * sitting in it.
 *
 * `attempts` increments here, at claim time, not on failure. A job that hangs
 * the worker hard has still consumed an attempt when its lease expires, so it
 * eventually fails instead of being retried forever. The original reset stuck
 * jobs to pending without touching the counter, which is an infinite loop with
 * an LLM call in it.
 */
export function claimNext(options: ClaimOptions = {}, db: Db = getDb()): Job | null {
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();

  // A job whose lease expired for the last time is dead, not retryable.
  db.prepare(
    `UPDATE jobs
        SET status = 'failed',
            finished_at = ?,
            error = COALESCE(error, 'Worker lease expired and no attempts remain')
      WHERE status = 'processing'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
        AND attempts >= max_attempts`,
  ).run(now, now);

  const row = db
    .prepare(
      `UPDATE jobs
          SET status = 'processing',
              attempts = attempts + 1,
              started_at = COALESCE(started_at, :now),
              lease_expires_at = :lease
        WHERE id = (
          SELECT id FROM jobs
           WHERE run_after <= :now
             AND attempts < max_attempts
             AND (status = 'pending'
                  OR (status = 'processing'
                      AND lease_expires_at IS NOT NULL
                      AND lease_expires_at <= :now))
             AND (:type IS NULL OR type = :type)
           ORDER BY priority ASC, run_after ASC, rowid ASC
           LIMIT 1
        )
        RETURNING *`,
    )
    .get({ now, lease, type: options.type ?? null }) as JobRow | undefined;

  return row ? mapJob(row) : null;
}

export function completeJob(id: string, result: unknown, db: Db = getDb()): void {
  db.prepare(
    `UPDATE jobs
        SET status = 'completed', finished_at = ?, result = ?, error = NULL,
            lease_expires_at = NULL
      WHERE id = ?`,
  ).run(new Date().toISOString(), result === undefined ? null : JSON.stringify(result), id);
}

export interface FailOptions {
  /** Skip the remaining attempts — the failure is not going to change. */
  permanent?: boolean;
  /** Delay before the retry becomes claimable. Ignored when permanent. */
  retryDelayMs?: number;
}

export function failJob(id: string, error: string, options: FailOptions = {}, db: Db = getDb()): Job | null {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const current = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!current) return null;

  const exhausted = options.permanent || current.attempts >= current.max_attempts;

  const row = exhausted
    ? (db
        .prepare(
          `UPDATE jobs
              SET status = 'failed', finished_at = ?, error = ?, lease_expires_at = NULL
            WHERE id = ? RETURNING *`,
        )
        .get(nowIso, error, id) as JobRow)
    : (db
        .prepare(
          `UPDATE jobs
              SET status = 'pending', error = ?, run_after = ?, lease_expires_at = NULL
            WHERE id = ? RETURNING *`,
        )
        .get(error, new Date(now + (options.retryDelayMs ?? 0)).toISOString(), id) as JobRow);

  return mapJob(row);
}

/**
 * 30s, 60s, 120s… capped at ten minutes, with jitter so that a batch of jobs
 * failing on the same outage does not retry in lockstep and reproduce it.
 */
export function backoffMs(attempts: number, jitter = true): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 600_000);
  return jitter ? Math.round(base * (0.8 + Math.random() * 0.4)) : base;
}

export function getJob(id: string, db: Db = getDb()): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export interface ListJobsFilter {
  type?: string;
  status?: JobStatus;
  limit?: number;
}

export function listJobs(filter: ListJobsFilter = {}, db: Db = getDb()): Job[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    where.push('type = ?');
    params.push(filter.type);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }

  const rows = db
    .prepare(
      `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...params, filter.limit ?? 100) as JobRow[];

  return rows.map(mapJob);
}

export type QueueStats = Record<JobStatus, number> & { total: number };

export function queueStats(type?: string, db: Db = getDb()): QueueStats {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM jobs${type ? ' WHERE type = ?' : ''} GROUP BY status`,
    )
    .all(...(type ? [type] : [])) as { status: string; count: number }[];

  const stats: QueueStats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
  for (const row of rows) {
    if (row.status in stats) stats[row.status as JobStatus] = row.count;
    stats.total += row.count;
  }
  return stats;
}

/** Deletes finished jobs older than `hours`. Returns how many went. */
export function cleanupJobs(hours = 168, db: Db = getDb()): number {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db
    .prepare(
      `DELETE FROM jobs
        WHERE (status = 'completed' OR status = 'failed') AND finished_at < ?`,
    )
    .run(cutoff).changes;
}

/** Puts a failed job back in the queue with its attempt counter reset. */
export function retryJob(id: string, db: Db = getDb()): Job | null {
  const row = db
    .prepare(
      `UPDATE jobs
          SET status = 'pending', attempts = 0, error = NULL, finished_at = NULL,
              lease_expires_at = NULL, run_after = ?
        WHERE id = ? AND status = 'failed'
        RETURNING *`,
    )
    .get(new Date().toISOString(), id) as JobRow | undefined;

  return row ? mapJob(row) : null;
}

/**
 * Takes a job away from whatever claimed it and puts it back on the queue.
 *
 * For the job that says `processing` and is not: the worker was killed, the
 * container was replaced, the machine went away. `claimNext` will pick it up
 * again on its own once the lease runs out, so this is not a repair so much as
 * an "I know it is dead, do not make me wait fifteen minutes for it".
 *
 * The attempt counter is left alone, unlike `retryJob`. This job may well have
 * been killed by the thing it was doing — a prompt that runs the machine out
 * of memory every time — and resetting the count would make that a loop with
 * nothing to stop it.
 */
export function releaseJob(id: string, db: Db = getDb()): Job | null {
  const row = db
    .prepare(
      `UPDATE jobs
          SET status = 'pending', lease_expires_at = NULL, run_after = ?
        WHERE id = ? AND status = 'processing'
        RETURNING *`,
    )
    .get(new Date().toISOString(), id) as JobRow | undefined;

  return row ? mapJob(row) : null;
}

export function deleteJob(id: string, db: Db = getDb()): boolean {
  return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
}
