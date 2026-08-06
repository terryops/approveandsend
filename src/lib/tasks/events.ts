import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';

/**
 * What happened to a task, in order.
 *
 * The status column says where a task ended up. This says how it got there —
 * drafted twice, rejected with a reason, reopened the next morning, sent by
 * somebody other than the person who wrote it. When a customer asks why they
 * were told something, that sequence is the answer, and no amount of columns
 * on `tasks` reconstructs it after the fact.
 *
 * Recording is best-effort by design. Every call site is doing something that
 * matters more than the note about it — sending mail, saving an edit — and a
 * failure to write history must never fail the thing being recorded.
 */

export const TASK_ACTIONS = [
  'received',
  'drafted',
  'edited',
  'redraft',
  'dismissed',
  'reopened',
  'sent',
  'failed',
  'superseded',
] as const;

export type TaskAction = (typeof TASK_ACTIONS)[number];

export interface TaskEvent {
  id: string;
  taskId: string;
  action: TaskAction;
  /** A short human-readable qualifier: a rejection reason, an error. */
  detail: string | null;
  /** Operator id. Null for the shared password, or for the machine. */
  actor: string | null;
  createdAt: string;
}

interface EventRow {
  id: string;
  task_id: string;
  action: string;
  detail: string | null;
  actor: string | null;
  created_at: string;
}

function isAction(value: string): value is TaskAction {
  return (TASK_ACTIONS as readonly string[]).includes(value);
}

function mapEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    // A row written by a newer version than the one reading it should not
    // crash the review screen over a label.
    action: isAction(row.action) ? row.action : 'edited',
    detail: row.detail,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

const MAX_DETAIL = 300;

export function recordEvent(
  taskId: string,
  action: TaskAction,
  options: { detail?: string | null; actor?: string | null; db?: Db } = {},
): TaskEvent | null {
  const db = options.db ?? getDb();
  const detail = options.detail?.trim().slice(0, MAX_DETAIL) || null;

  try {
    const row: EventRow = {
      id: randomUUID(),
      task_id: taskId,
      action,
      detail,
      actor: options.actor ?? null,
      created_at: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO task_events (id, task_id, action, detail, actor, created_at)
       VALUES (@id, @task_id, @action, @detail, @actor, @created_at)`,
    ).run(row);
    return mapEvent(row);
  } catch (error) {
    // Most likely a task that no longer exists. Worth a line in the log and
    // nothing more — see the note at the top about what this must not break.
    console.warn('[tasks] could not record history:', error);
    return null;
  }
}

/** Oldest first: this is read as a story, not as a feed. */
export function listEvents(taskId: string, db: Db = getDb()): TaskEvent[] {
  const rows = db
    .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, rowid`)
    .all(taskId) as EventRow[];
  return rows.map(mapEvent);
}
