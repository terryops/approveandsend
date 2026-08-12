import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';

/**
 * The other ways a reply could have gone, waiting to be picked from.
 *
 * Kept in the database rather than held on the page because generating them
 * takes a model call and a reviewer who navigates away, or comes back after
 * lunch, should not pay for it twice.
 *
 * They are labelled A, B, C by position. The letters carry no ranking — they
 * exist so a reviewer can say "go with B" to a colleague, which is a thing
 * people actually do and is impossible when the only handle is a paragraph of
 * text.
 */

export interface Alternative {
  id: string;
  taskId: string;
  /** A, B, C — by position, not by merit. */
  label: string;
  /** A few words on what this approach commits the desk to. May be ''. */
  strategy: string;
  body: string;
  createdAt: string;
}

interface AlternativeRow {
  id: string;
  task_id: string;
  label: string;
  strategy: string;
  body: string;
  created_at: string;
}

const LABELS = ['A', 'B', 'C', 'D', 'E'] as const;

function mapAlternative(row: AlternativeRow): Alternative {
  return {
    id: row.id,
    taskId: row.task_id,
    label: row.label,
    strategy: row.strategy,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * Replace whatever was on offer with this set.
 *
 * Wholesale, because a second ask is a reviewer saying the first set missed
 * the point, and leaving the old ones alongside would make the choice harder
 * rather than wider. What the reviewer picked is not in here anyway — picking
 * one puts it in the draft box, where the version history keeps it.
 */
export function replaceAlternatives(
  taskId: string,
  options: { strategy: string; body: string }[],
  db: Db = getDb(),
): Alternative[] {
  const now = new Date().toISOString();
  // Labelled after the empties are dropped, not before: a set that reads A, C,
  // D looks like something went missing, and something did — but it was never
  // an option, so there is nothing for the reviewer to go looking for.
  const rows: AlternativeRow[] = options
    .map(option => ({ strategy: option.strategy.trim(), body: option.body.trim() }))
    .filter(option => option.body !== '')
    .flatMap((option, index) => {
      const label = LABELS[index];
      if (!label) return [];
      return [
        {
          id: randomUUID(),
          task_id: taskId,
          label,
          strategy: option.strategy,
          body: option.body,
          created_at: now,
        },
      ];
    });

  const write = db.transaction(() => {
    db.prepare(`DELETE FROM draft_alternatives WHERE task_id = ?`).run(taskId);
    const insert = db.prepare(
      `INSERT INTO draft_alternatives (id, task_id, label, strategy, body, created_at)
       VALUES (@id, @task_id, @label, @strategy, @body, @created_at)`,
    );
    for (const row of rows) insert.run(row);
  });
  write();

  return rows.map(mapAlternative);
}

/** In label order, which is the order they were generated in. */
export function listAlternatives(taskId: string, db: Db = getDb()): Alternative[] {
  const rows = db
    .prepare(`SELECT * FROM draft_alternatives WHERE task_id = ? ORDER BY label`)
    .all(taskId) as AlternativeRow[];
  return rows.map(mapAlternative);
}

export function getAlternative(id: string, db: Db = getDb()): Alternative | null {
  const row = db.prepare(`SELECT * FROM draft_alternatives WHERE id = ?`).get(id) as
    | AlternativeRow
    | undefined;
  return row ? mapAlternative(row) : null;
}

/**
 * Rewrite one option in place, keeping its letter.
 *
 * For a redraft, which is a rewrite of the option in the box and not a request
 * for a different set: the reviewer sitting on B who asks for it shorter wants
 * B shorter, and expects to find it under B afterwards — with A and C where
 * they left them.
 */
export function updateAlternativeBody(
  id: string,
  body: string,
  db: Db = getDb(),
): Alternative | null {
  const row = db
    .prepare(`UPDATE draft_alternatives SET body = ? WHERE id = ? RETURNING *`)
    .get(body.trim(), id) as AlternativeRow | undefined;
  return row ? mapAlternative(row) : null;
}

/**
 * Add one more, under the next free letter.
 *
 * The case is a redraft of something that is not on the strip — the reviewer
 * edited by hand, or asked for a rewrite of a reply that predates the set. The
 * result is a genuine fourth approach, and dropping it would leave the strip
 * claiming to hold every version of this reply while the one in the box is
 * missing. Null when the letters run out; five is already more than anybody
 * chooses between.
 */
export function addAlternative(
  taskId: string,
  option: { strategy: string; body: string },
  db: Db = getDb(),
): Alternative | null {
  const body = option.body.trim();
  if (!body) return null;

  const taken = new Set(listAlternatives(taskId, db).map(existing => existing.label));
  const label = LABELS.find(candidate => !taken.has(candidate));
  if (!label) return null;

  const row: AlternativeRow = {
    id: randomUUID(),
    task_id: taskId,
    label,
    strategy: option.strategy.trim(),
    body,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO draft_alternatives (id, task_id, label, strategy, body, created_at)
     VALUES (@id, @task_id, @label, @strategy, @body, @created_at)`,
  ).run(row);

  return mapAlternative(row);
}

/** Used when the reply goes out: nobody needs the roads not taken after that. */
export function clearAlternatives(taskId: string, db: Db = getDb()): void {
  db.prepare(`DELETE FROM draft_alternatives WHERE task_id = ?`).run(taskId);
}
