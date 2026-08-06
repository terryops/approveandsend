import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import { isSentiment, isTaskStatus, type Analysis, type NewTask, type Task, type TaskStatus } from './types';

interface TaskRow {
  id: string;
  status: string;
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
  final_reply: string | null;
  reviewer_notes: string | null;
  sent_at: string | null;
  sent_by: string | null;
  error: string | null;
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
    };
  } catch {
    // Same reasoning as the queue's payload: reading a row must not throw.
    return null;
  }
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    status: isTaskStatus(row.status) ? row.status : 'failed',
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
    finalReply: row.final_reply,
    reviewerNotes: row.reviewer_notes,
    sentAt: row.sent_at,
    sentBy: row.sent_by,
    error: row.error,
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
      `INSERT INTO tasks (id, status, priority, message_id, thread_id, message_id_header,
                          subject, from_address, from_name, received_at, body,
                          created_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      randomUUID(),
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

  return { task: mapTask(row), existed: false };
}

export function getTask(id: string, db: Db = getDb()): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? mapTask(row) : null;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  scope?: string;
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

  const rows = db
    .prepare(
      `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
        ORDER BY priority ASC, COALESCE(received_at, created_at) DESC
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

export interface TaskUpdate {
  status?: TaskStatus;
  scope?: string | null;
  priority?: number;
  /** Ingestion writes the summary first and fills the real body in after the
   * detail fetch, so this is updatable even though nothing else rewrites it. */
  body?: string;
  analysis?: Analysis | null;
  draft?: string | null;
  finalReply?: string | null;
  reviewerNotes?: string | null;
  sentAt?: string | null;
  sentBy?: string | null;
  error?: string | null;
}

const COLUMNS: Record<keyof TaskUpdate, string> = {
  status: 'status',
  scope: 'scope',
  priority: 'priority',
  body: 'body',
  analysis: 'analysis',
  draft: 'draft',
  finalReply: 'final_reply',
  reviewerNotes: 'reviewer_notes',
  sentAt: 'sent_at',
  sentBy: 'sent_by',
  error: 'error',
};

export function updateTask(id: string, changes: TaskUpdate, db: Db = getDb()): Task | null {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, column] of Object.entries(COLUMNS) as [keyof TaskUpdate, string][]) {
    if (!(key in changes)) continue;
    const value = changes[key];
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

export function deleteTask(id: string, db: Db = getDb()): boolean {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}
