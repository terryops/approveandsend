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
  // The lighter half of the same button: the reviewer kept the reply and asked
  // for changes to it. Its own line rather than a qualifier on `redraft`,
  // because "asked for it again from scratch, twice" and "asked for two small
  // fixes" are the difference between a draft that missed and one that nearly
  // landed, and that is the question anybody reads this history to answer.
  'revise',
  // A human overruling the classifier. Worth its own line in the history: it
  // changes which rules the next draft is written against, so a draft that
  // reads differently before and after has a reason on the record.
  'recategorised',
  'dismissed',
  'reopened',
  'sent',
  'failed',
  'superseded',
] as const;

export type TaskAction = (typeof TASK_ACTIONS)[number];

/**
 * The detail on a `sent` event that came out of an archive rather than out of
 * an actual send.
 *
 * A string two modules agree on, because the difference matters downstream: an
 * imported row says the old desk approved an answer, and approved is not
 * delivered. Anything that tells the model what this customer has already
 * heard from us has to be able to tell the two apart.
 */
export const IMPORTED_SEND = 'imported from the previous system';

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
