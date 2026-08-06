import { getDb, type Db } from './index';

/**
 * Key/value facts about the installation. Deliberately tiny: this is for
 * things with exactly one value and no history, such as when the rulebook was
 * last consolidated. Anything worth querying gets its own table.
 */

export function getMeta(key: string, db: Db = getDb()): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string, db: Db = getDb()): void {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}
