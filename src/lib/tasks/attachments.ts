import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';

/**
 * What the customer sent along with their email.
 *
 * Metadata only — the bytes stay in the mailbox until somebody asks for them.
 * See migration 14 for why.
 */

export interface TaskAttachment {
  id: string;
  taskId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  createdAt: string;
}

export interface NewTaskAttachment {
  messageId: string;
  attachmentId: string;
  filename?: string;
  contentType?: string;
  size?: number;
  inline?: boolean;
}

interface Row {
  id: string;
  task_id: string;
  message_id: string;
  attachment_id: string;
  filename: string;
  content_type: string;
  size: number;
  inline: number;
  created_at: string;
}

function map(row: Row): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    messageId: row.message_id,
    attachmentId: row.attachment_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    inline: row.inline === 1,
    createdAt: row.created_at,
  };
}

/**
 * Record one attachment.
 *
 * Re-reading a message updates its row rather than adding a second, for the
 * same reason `addMessage` does: a thread is re-read on every sync that
 * touches it.
 */
export function addAttachment(
  taskId: string,
  input: NewTaskAttachment,
  db: Db = getDb(),
): TaskAttachment {
  const values = {
    task: taskId,
    message: input.messageId,
    attachment: input.attachmentId,
    filename: input.filename ?? '',
    contentType: input.contentType || 'application/octet-stream',
    size: input.size ?? 0,
    inline: input.inline ? 1 : 0,
  };

  const existing = db
    .prepare(
      `SELECT * FROM task_attachments
        WHERE task_id = :task AND message_id = :message AND attachment_id = :attachment`,
    )
    .get(values) as Row | undefined;

  if (existing) {
    const updated = db
      .prepare(
        `UPDATE task_attachments
            SET filename = :filename, content_type = :contentType,
                size = :size, inline = :inline
          WHERE id = :id RETURNING *`,
      )
      .get({ ...values, id: existing.id }) as Row;
    return map(updated);
  }

  const row = db
    .prepare(
      `INSERT INTO task_attachments (id, task_id, message_id, attachment_id, filename,
                                     content_type, size, inline, created_at)
       VALUES (:id, :task, :message, :attachment, :filename, :contentType, :size,
               :inline, :createdAt) RETURNING *`,
    )
    .get({ ...values, id: randomUUID(), createdAt: new Date().toISOString() }) as Row;

  return map(row);
}

/** Everything attached to this task's conversation, oldest first. */
export function listAttachments(taskId: string, db: Db = getDb()): TaskAttachment[] {
  const rows = db
    .prepare('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(taskId) as Row[];
  return rows.map(map);
}

/**
 * One attachment, looked up by our id and the task it must belong to.
 *
 * The task id is part of the lookup rather than checked afterwards, so a
 * download link cannot be edited into one for somebody else's mailbox.
 */
export function getAttachment(
  taskId: string,
  id: string,
  db: Db = getDb(),
): TaskAttachment | null {
  const row = db
    .prepare('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?')
    .get(id, taskId) as Row | undefined;
  return row ? map(row) : null;
}

/**
 * The types safe to render in our own origin, and worth rendering.
 *
 * An allowlist of raster formats, and short on purpose. SVG is absent and
 * stays absent: it is a document that can carry script, so displaying one a
 * customer sent would hand them the reviewer's session on our own domain —
 * the exact trade the download route refuses to make. Everything here decodes
 * to pixels and nothing else.
 */
const RENDERABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isRenderableImage(contentType: string): boolean {
  return RENDERABLE.has(contentType.split(';')[0]!.trim().toLowerCase());
}

/**
 * The files worth telling the drafter about, as a prompt line.
 *
 * Inline images are left out: a signature logo is not something the customer
 * meant to send, and listing it invites a reply thanking them for it.
 */
export function attachmentSummary(attachments: TaskAttachment[]): string {
  const real = attachments.filter(a => !a.inline && a.filename);
  if (real.length === 0) return '';

  const names = [...new Set(real.map(a => a.filename))];
  return names.join(', ');
}
