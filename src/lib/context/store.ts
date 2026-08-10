import { getDb, type Db } from '../db';
import { coerceBlock, type ContextBlock, type StoredContext } from './types';

/**
 * Looked-up context, kept per task and per source.
 *
 * Kept, not recomputed: the reviewer needs to see what the model saw. If the
 * sidebar re-queried Stripe on every page load, a subscription cancelled after
 * the draft was written would make the draft look like a mistake nobody made.
 * This row is the evidence.
 */

interface Row {
  task_id: string;
  source_id: string;
  label: string;
  title: string;
  href: string | null;
  fields: string;
  prompt: string;
  created_at: string;
}

function map(row: Row): StoredContext {
  const block = coerceBlock({
    title: row.title,
    prompt: row.prompt,
    href: row.href,
    fields: safeFields(row.fields),
  });

  return {
    taskId: row.task_id,
    sourceId: row.source_id,
    label: row.label,
    createdAt: row.created_at,
    title: block?.title ?? row.title,
    fields: block?.fields ?? [],
    prompt: block?.prompt ?? '',
    ...(block?.href ? { href: block.href } : {}),
  };
}

function safeFields(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Same rule as everywhere else that reads a JSON column: reading a row
    // must not throw. A garbled field list costs the reviewer a card, not the
    // page.
    return [];
  }
}

export function saveContext(
  taskId: string,
  sourceId: string,
  label: string,
  block: ContextBlock,
  db: Db = getDb(),
): void {
  db.prepare(
    `INSERT INTO task_context (task_id, source_id, label, title, href, fields, prompt, created_at)
     VALUES (@task_id, @source_id, @label, @title, @href, @fields, @prompt, @created_at)
     ON CONFLICT(task_id, source_id) DO UPDATE SET
       label = excluded.label,
       title = excluded.title,
       href = excluded.href,
       fields = excluded.fields,
       prompt = excluded.prompt,
       created_at = excluded.created_at`,
  ).run({
    task_id: taskId,
    source_id: sourceId,
    label,
    title: block.title,
    href: block.href ?? null,
    fields: JSON.stringify(block.fields),
    prompt: block.prompt,
    created_at: new Date().toISOString(),
  });
}

export function listContext(taskId: string, db: Db = getDb()): StoredContext[] {
  const rows = db
    .prepare('SELECT * FROM task_context WHERE task_id = ? ORDER BY source_id')
    .all(taskId) as Row[];
  return rows.map(map);
}

/**
 * Whether this task has any cards at all.
 *
 * Asked before queuing a translation job: a desk that reads its own mail
 * perfectly well still wants its context cards in its own language, so
 * "translation is off" cannot be decided by `reviewLanguage` alone any more.
 * One indexed row rather than `listContext(...).length`, because the answer is
 * needed on a path that is otherwise doing nothing.
 */
export function hasContext(taskId: string, db: Db = getDb()): boolean {
  return db.prepare('SELECT 1 FROM task_context WHERE task_id = ? LIMIT 1').get(taskId) !== undefined;
}

export function clearContext(taskId: string, db: Db = getDb()): number {
  return db.prepare('DELETE FROM task_context WHERE task_id = ?').run(taskId).changes;
}
