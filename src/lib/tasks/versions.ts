import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import { newlines } from '../text';

/**
 * Every text that has ever been in the draft box.
 *
 * The current one lives on the task, because that is what gets sent and it
 * must be one field with one writer. This is everything it used to be.
 *
 * The button that made this necessary is Redraft. A reviewer who has spent ten
 * minutes rewriting a reply and then presses it to see what else the model
 * might say has, until now, destroyed their own work with a button that does
 * not look destructive. Keeping the old text costs a row.
 */

/**
 * Where a text came from, as far as the person choosing between them cares.
 *
 * `critic` is a narrower `model` — the drafter wrote it too, and the second
 * opinion then threw it out. It is kept apart because "the assistant wrote this
 * earlier" and "a second model refused to let this go out" are different
 * answers to the only question this panel is ever asked, which is whether to
 * press Put this back.
 */
export const DRAFT_SOURCES = ['model', 'human', 'critic'] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];

export function isDraftSource(value: unknown): value is DraftSource {
  return typeof value === 'string' && (DRAFT_SOURCES as readonly string[]).includes(value);
}

export interface DraftVersion {
  id: string;
  taskId: string;
  body: string;
  /** Where it came from. Not who asked for it — a redraft a human requested is still 'model'. */
  source: DraftSource;
  /** What the reviewer asked for, on the versions that came from a redraft. */
  notes: string | null;
  createdAt: string;
}

interface VersionRow {
  id: string;
  task_id: string;
  body: string;
  source: string;
  notes: string | null;
  created_at: string;
}

/**
 * How many texts are kept per task before the oldest is dropped.
 *
 * Twenty is generous for a review queue where three is a lot, and it is a
 * ceiling rather than a target: it exists so a task caught in a redraft loop
 * cannot grow without bound, not because the twenty-first version is
 * uninteresting.
 */
const MAX_VERSIONS = 20;

function mapVersion(row: VersionRow): DraftVersion {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    // Anything unrecognised reads as the model's, which is what every row
    // written before a value existed actually was.
    source: isDraftSource(row.source) ? row.source : 'model',
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/**
 * Keep this text. Returns null when there was nothing worth keeping.
 *
 * Identical consecutive texts are not recorded: saving a task without touching
 * the draft is the most common thing anybody does on this screen, and a
 * history of twenty identical entries hides the one edit that mattered.
 */
export function recordDraft(
  taskId: string,
  body: string,
  options: { source: DraftSource; notes?: string | null; db?: Db },
): DraftVersion | null {
  const db = options.db ?? getDb();
  // Settled here as well as at the form, because this is the guard that the two
  // spellings defeated: a save that changed nothing arrived as CRLF against the
  // model's LF, the comparison below saw an edit, and the panel filled with
  // copies of one reply. `field()` stops new ones; this stops any caller.
  const normalised = newlines(body);
  const text = normalised.trim();
  if (!text) return null;

  const latest = db
    .prepare(`SELECT body FROM draft_versions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(taskId) as { body: string } | undefined;
  // And the stored side of the comparison too, for the rows written before any
  // of this was normalised. They are the ones on real desks.
  if (latest !== undefined && newlines(latest.body).trim() === text) return null;

  try {
    const row: VersionRow = {
      id: randomUUID(),
      task_id: taskId,
      body: normalised,
      source: options.source,
      notes: options.notes?.trim() || null,
      created_at: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO draft_versions (id, task_id, body, source, notes, created_at)
       VALUES (@id, @task_id, @body, @source, @notes, @created_at)`,
    ).run(row);

    // Oldest first out. Done here rather than on a schedule because the only
    // moment a task can exceed the cap is the moment something was added.
    db.prepare(
      `DELETE FROM draft_versions
        WHERE task_id = @task
          AND id NOT IN (
            SELECT id FROM draft_versions
             WHERE task_id = @task
             ORDER BY created_at DESC, rowid DESC
             LIMIT @keep
          )`,
    ).run({ task: taskId, keep: MAX_VERSIONS });

    return mapVersion(row);
  } catch (error) {
    // Same contract as the event log: losing the copy must not lose the draft.
    console.warn('[tasks] could not keep the previous draft:', error);
    return null;
  }
}

/** Newest first: on this list the thing you want is almost always the last one. */
export function listVersions(taskId: string, db: Db = getDb()): DraftVersion[] {
  const rows = db
    .prepare(`SELECT * FROM draft_versions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(taskId) as VersionRow[];
  return rows.map(mapVersion);
}

export function getVersion(id: string, db: Db = getDb()): DraftVersion | null {
  const row = db.prepare(`SELECT * FROM draft_versions WHERE id = ?`).get(id) as
    | VersionRow
    | undefined;
  return row ? mapVersion(row) : null;
}
