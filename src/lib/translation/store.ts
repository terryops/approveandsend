import { createHash } from 'node:crypto';

import { getDb, type Db } from '../db';

/**
 * Stored translations, keyed to the exact text they were made from.
 *
 * The hash is the point. A reviewer who cannot read French has no way of
 * noticing that the French draft was regenerated after its Chinese rendering
 * was written — so this never shows them a translation of anything but the
 * text currently on screen. A stale row reads as no translation, which is
 * honest, rather than as the previous draft, which is a trap.
 */

/**
 * The three things on the review screen that may arrive in a language the
 * person approving them does not read.
 *
 * Two of them are mail — theirs and ours — and are rendered into
 * `reviewLanguage`. The third is the row of context cards, rendered into the
 * interface language instead, because a card is furniture rather than mail;
 * see `cards.ts`. All three share this table because all three want the same
 * guarantee from it: a rendering is shown only for the exact text it was made
 * from.
 */
export type TranslationKind = 'body' | 'draft' | 'context';

export interface StoredTranslation {
  taskId: string;
  kind: TranslationKind;
  language: string;
  content: string;
  createdAt: string;
}

interface Row {
  task_id: string;
  kind: string;
  language: string;
  source_hash: string;
  content: string;
  created_at: string;
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

export function saveTranslation(
  taskId: string,
  kind: TranslationKind,
  language: string,
  source: string,
  content: string,
  db: Db = getDb(),
): void {
  db.prepare(
    `INSERT INTO task_translations (task_id, kind, language, source_hash, content, created_at)
     VALUES (@task_id, @kind, @language, @source_hash, @content, @created_at)
     ON CONFLICT(task_id, kind) DO UPDATE SET
       language = excluded.language,
       source_hash = excluded.source_hash,
       content = excluded.content,
       created_at = excluded.created_at`,
  ).run({
    task_id: taskId,
    kind,
    language,
    source_hash: fingerprint(source),
    content,
    created_at: new Date().toISOString(),
  });
}

/**
 * The translation of exactly this text, or null.
 *
 * `language` is checked too: changing `reviewLanguage` must not leave the old
 * language's translations on screen labelled as the new one.
 */
export function getTranslation(
  taskId: string,
  kind: TranslationKind,
  source: string,
  language: string,
  db: Db = getDb(),
): StoredTranslation | null {
  const row = db
    .prepare('SELECT * FROM task_translations WHERE task_id = ? AND kind = ?')
    .get(taskId, kind) as Row | undefined;

  if (!row) return null;
  if (row.language !== language) return null;
  if (row.source_hash !== fingerprint(source)) return null;

  return {
    taskId: row.task_id,
    kind: row.kind as TranslationKind,
    language: row.language,
    content: row.content,
    createdAt: row.created_at,
  };
}

/**
 * Whether the model has already said this text needs no rendering.
 *
 * An empty stored row is that answer, and it is stored so that the answer
 * exists at all. `translateForReview` returns null when the text is already in
 * the reviewer's language, and for a long time nothing was written for it — so
 * "no row" meant "nothing needed" exactly as often as it meant "not done yet",
 * and the screen could only say the pessimistic one. A desk answering Chinese
 * mail in Chinese to Chinese-reading reviewers therefore carried a line under
 * every reply announcing a missing translation that was never going to arrive,
 * and the queue re-asked for it on every edit forever.
 *
 * The cards have always done this — see `cardsAwaitingRendering`, which says
 * their no-op is a stored rendering identical to the card. The mail halves
 * store the empty string instead, because a copy of the reply filed as its own
 * translation is a thing a screen might one day render beside itself.
 */
export function isSameLanguage(row: StoredTranslation | null): boolean {
  return row !== null && row.content === '';
}

/** True when this exact text already has a current answer — skip the call. */
export function hasTranslation(
  taskId: string,
  kind: TranslationKind,
  source: string,
  language: string,
  db: Db = getDb(),
): boolean {
  return getTranslation(taskId, kind, source, language, db) !== null;
}

export function clearTranslations(taskId: string, db: Db = getDb()): number {
  return db.prepare('DELETE FROM task_translations WHERE task_id = ?').run(taskId).changes;
}
