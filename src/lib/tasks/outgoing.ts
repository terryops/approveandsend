import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import type { OutgoingAttachment } from '../mail/types';
import { MAX_UPLOAD_BYTES, UploadTooLarge } from '../mail/uploads';

/**
 * What the reviewer is sending along with the reply, before it goes.
 *
 * The mirror image of `attachments.ts`, which holds metadata for files that
 * stay in the mailbox. These are files that are not anywhere yet: a browser
 * will not let a page fill a file input, so between the moment somebody picks
 * an invoice on the review screen and the moment the mail leaves, this table is
 * the only place those bytes exist. See migration 29.
 *
 * They are deleted by the send — `sendReply` clears them inside the transaction
 * that marks the task sent — so nothing here outlives the reply it was picked
 * for, and the copy that matters ends up where every other record of what went
 * out already lives: the Sent folder.
 */

export interface PendingAttachment {
  id: string;
  taskId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

interface Row {
  id: string;
  task_id: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

function map(row: Row): PendingAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

/**
 * What is riding along, in the order it was picked.
 *
 * Names and sizes, never the bytes. Every caller of this is drawing a list on a
 * screen, and reading a 15 MB blob out of SQLite to print "invoice.pdf" would
 * do it on every render of every task that has one.
 */
export function listPending(taskId: string, db: Db = getDb()): PendingAttachment[] {
  const rows = db
    .prepare(
      `SELECT id, task_id, filename, content_type, size, created_at
         FROM outgoing_attachments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(taskId) as Row[];
  return rows.map(map);
}

/** How much this reply is already carrying. */
export function pendingBytes(taskId: string, db: Db = getDb()): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM outgoing_attachments WHERE task_id = ?')
    .get(taskId) as { total: number };
  return row.total;
}

/**
 * Put files on a reply.
 *
 * The ceiling is checked against everything the task is already carrying, not
 * just against this batch — otherwise three 8 MB picks in a row build a reply no
 * gateway will accept, and the reviewer finds out from a bounce. Files that
 * replace one of the same name do not count twice; that is the point of the
 * unique index, and of measuring rather than adding here.
 *
 * All or nothing: a batch that would go over the line stores none of it, so
 * "attach these four" never half-happens.
 */
export function attachToTask(
  taskId: string,
  files: OutgoingAttachment[],
  db: Db = getDb(),
): PendingAttachment[] {
  if (files.length === 0) return [];

  const replacing = new Set(files.map(file => file.filename));
  const kept = listPending(taskId, db)
    .filter(file => !replacing.has(file.filename))
    .reduce((sum, file) => sum + file.size, 0);
  const incoming = files.reduce((sum, file) => sum + file.content.length, 0);
  if (kept + incoming > MAX_UPLOAD_BYTES) throw new UploadTooLarge(kept + incoming);

  const insert = db.prepare(
    `INSERT INTO outgoing_attachments (id, task_id, filename, content_type, size, content, created_at)
     VALUES (:id, :task, :filename, :contentType, :size, :content, :createdAt)
     ON CONFLICT (task_id, filename) DO UPDATE
        SET content_type = excluded.content_type,
            size         = excluded.size,
            content      = excluded.content,
            created_at   = excluded.created_at`,
  );

  const store = db.transaction(() => {
    for (const file of files) {
      insert.run({
        id: randomUUID(),
        task: taskId,
        filename: file.filename,
        contentType: file.contentType || 'application/octet-stream',
        size: file.content.length,
        content: file.content,
        createdAt: new Date().toISOString(),
      });
    }
  });
  store();

  return listPending(taskId, db);
}

/**
 * Take one back off.
 *
 * The task id is part of the delete rather than checked afterwards, for the
 * reason `getAttachment` puts it in the lookup: an id in a form is a value
 * somebody can edit.
 */
export function detachFromTask(taskId: string, id: string, db: Db = getDb()): boolean {
  return (
    db
      .prepare('DELETE FROM outgoing_attachments WHERE id = ? AND task_id = ?')
      .run(id, taskId).changes > 0
  );
}

/**
 * One of them, bytes and all, for the reviewer looking at what they attached.
 *
 * The task id is part of the lookup rather than checked afterwards, for the
 * reason `getAttachment` puts it in there: a download link is a URL, and a URL
 * is a thing people edit.
 */
export function getPending(
  taskId: string,
  id: string,
  db: Db = getDb(),
): { filename: string; contentType: string; content: Buffer } | null {
  const row = db
    .prepare(
      'SELECT filename, content_type, content FROM outgoing_attachments WHERE id = ? AND task_id = ?',
    )
    .get(id, taskId) as { filename: string; content_type: string; content: Buffer } | undefined;

  return row ? { filename: row.filename, contentType: row.content_type, content: row.content } : null;
}

/** The files themselves, read for the one call that needs them: the send. */
export function pendingAttachments(taskId: string, db: Db = getDb()): OutgoingAttachment[] {
  const rows = db
    .prepare(
      `SELECT filename, content_type, content FROM outgoing_attachments
        WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(taskId) as { filename: string; content_type: string; content: Buffer }[];

  return rows.map(row => ({
    filename: row.filename,
    content: row.content,
    ...(row.content_type ? { contentType: row.content_type } : {}),
  }));
}

/** Once the reply has gone, these are bytes we have no reason to be holding. */
export function clearPending(taskId: string, db: Db = getDb()): void {
  db.prepare('DELETE FROM outgoing_attachments WHERE task_id = ?').run(taskId);
}
