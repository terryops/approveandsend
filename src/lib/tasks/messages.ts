import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import { buildThreadContext, type ThreadContextOptions } from '../thread-context';

/**
 * The conversation a task belongs to.
 *
 * Kept separately from `tasks.body`, which holds only the message being
 * replied to. Two readers need the rest of it: the drafter, which will
 * otherwise answer a follow-up as if it were a first contact, and the reviewer,
 * who cannot judge a reply without seeing what it is replying to.
 */

export type MessageDirection = 'inbound' | 'outbound';

export interface TaskMessage {
  id: string;
  taskId: string;
  direction: MessageDirection;
  messageId: string | null;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  body: string;
  receivedAt: string;
  createdAt: string;
}

export interface NewTaskMessage {
  direction: MessageDirection;
  messageId?: string | null;
  fromAddress?: string;
  fromName?: string | null;
  subject?: string;
  body?: string;
  receivedAt: string;
}

interface Row {
  id: string;
  task_id: string;
  direction: string;
  message_id: string | null;
  from_address: string;
  from_name: string | null;
  subject: string;
  body: string;
  received_at: string;
  created_at: string;
}

function map(row: Row): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    messageId: row.message_id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    body: row.body,
    receivedAt: row.received_at,
    createdAt: row.created_at,
  };
}

/**
 * Record one message of the conversation.
 *
 * Re-recording the same provider id updates the row rather than adding a
 * second: a thread is re-read on every sync that touches it, and an append-only
 * write here would grow the prompt by one copy of the thread per sync.
 */
export function addMessage(taskId: string, input: NewTaskMessage, db: Db = getDb()): TaskMessage {
  const now = new Date().toISOString();

  if (input.messageId) {
    const existing = db
      .prepare('SELECT * FROM task_messages WHERE task_id = ? AND message_id = ?')
      .get(taskId, input.messageId) as Row | undefined;

    if (existing) {
      const updated = db
        .prepare(
          `UPDATE task_messages SET direction = ?, from_address = ?, from_name = ?,
                                    subject = ?, body = ?, received_at = ?
             WHERE id = ? RETURNING *`,
        )
        .get(
          input.direction,
          input.fromAddress ?? '',
          input.fromName ?? null,
          input.subject ?? '',
          input.body ?? '',
          input.receivedAt,
          existing.id,
        ) as Row;
      return map(updated);
    }
  }

  const row = db
    .prepare(
      `INSERT INTO task_messages (id, task_id, direction, message_id, from_address,
                                  from_name, subject, body, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      randomUUID(),
      taskId,
      input.direction,
      input.messageId ?? null,
      input.fromAddress ?? '',
      input.fromName ?? null,
      input.subject ?? '',
      input.body ?? '',
      input.receivedAt,
      now,
    ) as Row;

  return map(row);
}

/** The conversation, oldest first. */
export function listMessages(taskId: string, db: Db = getDb()): TaskMessage[] {
  const rows = db
    .prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY received_at ASC, created_at ASC')
    .all(taskId) as Row[];
  return rows.map(map);
}

export function countMessages(taskId: string, db: Db = getDb()): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ?')
    .get(taskId) as { n: number };
  return row.n;
}

/** True when we have already replied in this thread. */
export function hasOutboundMessage(taskId: string, db: Db = getDb()): boolean {
  const row = db
    .prepare("SELECT 1 FROM task_messages WHERE task_id = ? AND direction = 'outbound' LIMIT 1")
    .get(taskId);
  return row !== undefined;
}

/**
 * The conversation rendered for a prompt, or '' when this is a first contact.
 *
 * The trimming lives in `buildThreadContext` and is not optional: one
 * production thread reached 1.4 MB and every generation on it timed out.
 */
export function threadContextFor(
  taskId: string,
  options: ThreadContextOptions = {},
  db: Db = getDb(),
): string {
  const messages = listMessages(taskId, db);
  if (messages.length === 0) return '';

  const inbound = messages
    .filter(m => m.direction === 'inbound')
    .map(m => ({ from: m.fromAddress, body: m.body, receivedAt: m.receivedAt }));
  const outbound = messages
    .filter(m => m.direction === 'outbound')
    .map(m => ({ from: m.fromAddress, body: m.body, receivedAt: m.receivedAt }));

  return buildThreadContext(inbound, outbound, options);
}
