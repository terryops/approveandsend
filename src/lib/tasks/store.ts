import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import { recordEvent } from './events';
import { isRiskFactor, isRiskLevel, type Risk } from './risk';
import { isCause, isOrigin, isSentiment, isTaskStatus, type Analysis, type NewTask, type Task, type TaskStatus } from './types';

interface TaskRow {
  id: string;
  status: string;
  origin: string;
  scope: string | null;
  priority: number;
  message_id: string | null;
  thread_id: string | null;
  message_id_header: string | null;
  subject: string;
  from_address: string;
  from_name: string | null;
  received_at: string | null;
  body: string;
  analysis: string | null;
  draft: string | null;
  reply_subject: string | null;
  final_reply: string | null;
  reviewer_notes: string | null;
  sent_at: string | null;
  sent_by: string | null;
  error: string | null;
  superseded_by: string | null;
  opened_at: string | null;
  rejection_reason: string | null;
  risk_level: string | null;
  risk_factors: string | null;
  created_at: string;
  updated_at: string;
}

function parseAnalysis(raw: string | null): Analysis | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      intent: typeof value.intent === 'string' ? value.intent : '',
      language: typeof value.language === 'string' ? value.language : '',
      sentiment: isSentiment(value.sentiment) ? value.sentiment : 'neutral',
      keyPoints: Array.isArray(value.keyPoints) ? value.keyPoints.filter((p): p is string => typeof p === 'string') : [],
      suggestedActions: Array.isArray(value.suggestedActions)
        ? value.suggestedActions.filter((p): p is string => typeof p === 'string')
        : [],
      ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
      ...(isCause(value.cause) ? { cause: value.cause } : {}),
    };
  } catch {
    // Same reasoning as the queue's payload: reading a row must not throw.
    return null;
  }
}

/** Null level means never graded, which is not the same as graded low. */
function parseRisk(level: string | null, factors: string | null): Risk | null {
  if (!isRiskLevel(level)) return null;

  let parsed: unknown = [];
  try {
    parsed = factors ? JSON.parse(factors) : [];
  } catch {
    // Same as everywhere else here: reading a row must not throw. A grade with
    // no reasons attached is still a usable grade.
  }

  return {
    level,
    factors: Array.isArray(parsed) ? parsed.filter(isRiskFactor) : [],
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    status: isTaskStatus(row.status) ? row.status : 'failed',
    origin: isOrigin(row.origin) ? row.origin : 'inbound',
    scope: row.scope,
    priority: row.priority,
    messageId: row.message_id,
    threadId: row.thread_id,
    messageIdHeader: row.message_id_header,
    subject: row.subject,
    fromAddress: row.from_address,
    fromName: row.from_name,
    receivedAt: row.received_at,
    body: row.body,
    analysis: parseAnalysis(row.analysis),
    draft: row.draft,
    replySubject: row.reply_subject,
    finalReply: row.final_reply,
    reviewerNotes: row.reviewer_notes,
    sentAt: row.sent_at,
    sentBy: row.sent_by,
    error: row.error,
    supersededBy: row.superseded_by,
    openedAt: row.opened_at,
    rejectionReason: row.rejection_reason,
    risk: parseRisk(row.risk_level, row.risk_factors),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateTaskResult {
  task: Task;
  /** True when this message had already been ingested. */
  existed: boolean;
}

/**
 * Ingests one email. Calling it again with the same `messageId` returns the
 * task that already exists — including a dismissed one, which is how a
 * dismissed email stays dismissed across the next mailbox sync.
 */
export function createTask(input: NewTask, db: Db = getDb()): CreateTaskResult {
  const now = new Date().toISOString();

  if (input.messageId) {
    const existing = db.prepare('SELECT * FROM tasks WHERE message_id = ?').get(input.messageId) as
      | TaskRow
      | undefined;
    if (existing) return { task: mapTask(existing), existed: true };
  }

  const row = db
    .prepare(
      `INSERT INTO tasks (id, status, origin, priority, message_id, thread_id, message_id_header,
                          subject, from_address, from_name, received_at, body,
                          created_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      randomUUID(),
      input.origin ?? 'inbound',
      input.priority ?? 5,
      input.messageId ?? null,
      input.threadId ?? null,
      input.messageIdHeader ?? null,
      input.subject ?? '',
      input.fromAddress ?? '',
      input.fromName ?? null,
      input.receivedAt ?? null,
      input.body ?? '',
      now,
      now,
    ) as TaskRow;

  // Every task's history starts here, whatever created it — a sync, the demo
  // seed, an import from an older install.
  recordEvent(row.id, 'received', { db });

  return { task: mapTask(row), existed: false };
}

export function getTask(id: string, db: Db = getDb()): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? mapTask(row) : null;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  scope?: string;
  /** Everything to or from one correspondent, case-insensitively. */
  fromAddress?: string;
  /**
   * `queue` is the reviewer's order — urgent first, then newest. `newest` is
   * chronological, which is the only useful order for one person's history:
   * priority is a claim about what to do next, and nobody reading back through
   * a correspondence wants last March's urgent email at the top.
   */
  order?: 'queue' | 'newest';
  limit?: number;
  offset?: number;
}

export function listTasks(filter: ListTasksFilter = {}, db: Db = getDb()): Task[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.scope) {
    where.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.fromAddress) {
    // COLLATE NOCASE rather than LOWER() on both sides, for the same reason
    // the history lookup does it: same answer, and it can use the index.
    where.push('from_address = ? COLLATE NOCASE');
    params.push(filter.fromAddress.trim());
  }

  const order =
    filter.order === 'newest'
      ? 'COALESCE(received_at, created_at) DESC'
      : 'priority ASC, COALESCE(received_at, created_at) DESC';

  const rows = db
    .prepare(
      `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit ?? 50, filter.offset ?? 0) as TaskRow[];

  return rows.map(mapTask);
}

export function countTasksByStatus(db: Db = getDb()): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all() as {
    status: string;
    count: number;
  }[];
  return Object.fromEntries(rows.map(row => [row.status, row.count]));
}

/**
 * Note that somebody has now read this task.
 *
 * Deliberately not routed through `updateTask`: opening a task must not touch
 * `updated_at`. That column is how "changed since you last looked" is decided
 * everywhere else, and a read that counted as a change would mark every task
 * stale the moment it was read, which is the opposite of what it is for.
 */
export function markOpened(id: string, db: Db = getDb()): void {
  db.prepare('UPDATE tasks SET opened_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

/**
 * How many tasks are waiting for a reviewer who has not seen them yet.
 *
 * Only `awaiting_review`. A pending task has nothing to read, and a sent one
 * has already had its moment; counting either would put a number on the screen
 * that no amount of reading could clear.
 */
export function countUnopened(db: Db = getDb()): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE status = 'awaiting_review' AND opened_at IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

export interface TaskUpdate {
  status?: TaskStatus;
  scope?: string | null;
  priority?: number;
  /** Ingestion writes the summary first and fills the real body in after the
   * detail fetch, so this is updatable even though nothing else rewrites it. */
  body?: string;
  /** Only a composed mail rewrites this, and only where nobody typed one. */
  subject?: string;
  analysis?: Analysis | null;
  draft?: string | null;
  replySubject?: string | null;
  finalReply?: string | null;
  reviewerNotes?: string | null;
  sentAt?: string | null;
  sentBy?: string | null;
  error?: string | null;
  supersededBy?: string | null;
  openedAt?: string | null;
  rejectionReason?: string | null;
  risk?: Risk | null;
}

const COLUMNS: Record<keyof TaskUpdate, string> = {
  status: 'status',
  scope: 'scope',
  priority: 'priority',
  body: 'body',
  subject: 'subject',
  analysis: 'analysis',
  draft: 'draft',
  replySubject: 'reply_subject',
  finalReply: 'final_reply',
  reviewerNotes: 'reviewer_notes',
  sentAt: 'sent_at',
  sentBy: 'sent_by',
  error: 'error',
  supersededBy: 'superseded_by',
  openedAt: 'opened_at',
  rejectionReason: 'rejection_reason',
  // Two columns behind one field. `risk` is set as a unit or not at all, so
  // there is no update that writes a level without its reasons.
  risk: 'risk_level',
};

export function updateTask(id: string, changes: TaskUpdate, db: Db = getDb()): Task | null {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, column] of Object.entries(COLUMNS) as [keyof TaskUpdate, string][]) {
    if (!(key in changes)) continue;
    const value = changes[key];

    // The one field that is two columns. Writing the reasons in the same
    // statement as the grade is what stops a row claiming to be high risk for
    // reasons that belong to the draft before this one.
    if (key === 'risk') {
      const risk = value as Risk | null;
      sets.push('risk_level = ?', 'risk_factors = ?');
      params.push(risk?.level ?? null, risk ? JSON.stringify(risk.factors) : null);
      continue;
    }

    sets.push(`${column} = ?`);
    params.push(key === 'analysis' && value ? JSON.stringify(value) : (value ?? null));
  }

  if (sets.length === 0) return getTask(id, db);

  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), id);

  const row = db
    .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .get(...params) as TaskRow | undefined;

  return row ? mapTask(row) : null;
}

/** Everything on one conversation, oldest first. Empty for an untracked thread. */
export function listThread(threadId: string, db: Db = getDb()): Task[] {
  if (!threadId) return [];
  const rows = db
    .prepare('SELECT * FROM tasks WHERE thread_id = ? ORDER BY received_at ASC, created_at ASC')
    .all(threadId) as TaskRow[];
  return rows.map(mapTask);
}

/**
 * Retire the unanswered tasks a newer message on the same thread replaced.
 *
 * The case: a customer writes, gets no reply within the hour, and writes again
 * — often to say something the first message got wrong, or that they no longer
 * need help. Both messages become tasks, and the older draft is now an answer
 * to a question they have moved on from. Sending it reads as not having been
 * listened to, which is worse than a slow reply.
 *
 * Only unsent tasks are touched. A sent one is a record of a mail that exists
 * in somebody's inbox, and no later message unsends it.
 *
 * Returns the ids retired.
 */
export function supersedeThread(threadId: string, newerTaskId: string, db: Db = getDb()): string[] {
  if (!threadId) return [];

  const rows = db
    .prepare(
      `SELECT id FROM tasks
        WHERE thread_id = ? AND id != ?
          AND status IN ('pending', 'drafting', 'awaiting_review', 'failed')`,
    )
    .all(threadId, newerTaskId) as { id: string }[];

  // One transaction over the whole batch. A thread with three unanswered
  // messages that fails after the second leaves one task dismissed with no
  // event saying why and two still in the queue — three rows in three
  // different states, from one ingestion.
  const retire = db.transaction(() => {
    for (const row of rows) {
      // Dismissed, so it leaves the queue the way a human dismissal does, and
      // `superseded_by` so a month from now the row explains itself.
      updateTask(row.id, { status: 'dismissed', supersededBy: newerTaskId }, db);
      recordEvent(row.id, 'superseded', { detail: newerTaskId, db });
    }
  });
  retire();

  return rows.map(row => row.id);
}

export function deleteTask(id: string, db: Db = getDb()): boolean {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}
