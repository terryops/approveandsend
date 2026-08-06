import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { getDb, type Db } from './index';

/**
 * A copy of the database, taken before something rewrites a lot of it at once.
 *
 * Almost everything here is already reversible one item at a time —
 * `rule_revisions` keeps what a rule said before, `draft_versions` keeps the
 * text a redraft threw away. What none of that gives you is a way to undo a
 * *pass*: the weekly tidy can merge forty rules while nobody is awake, and
 * "put the rulebook back to Sunday" is not forty button presses, it is a file.
 *
 * So the tidy takes one first. It is the cheapest possible insurance against
 * the one operation in this product that changes a lot of human-written text
 * on a model's say-so.
 */

/** Enough to go back a couple of passes; not enough to fill a disk. */
const KEEP = 5;

const PREFIX = 'snapshot-';

function snapshotDir(db: Db): string | null {
  // `:memory:` has no file to copy and no directory to put one in, which is
  // every test and no deployment. Nothing to do rather than something to fail.
  const file = db.name;
  if (!file || file === ':memory:') return null;
  return resolve(dirname(file), 'snapshots');
}

/** ISO, minus the punctuation that makes a filename awkward to type. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Copies the database and prunes older copies of the same kind.
 *
 * Returns the path written, or null where there was nothing to copy. Never
 * throws: a snapshot that cannot be taken must not stop the work it was
 * guarding, or the insurance becomes the outage.
 */
export async function snapshot(reason: string, db: Db = getDb()): Promise<string | null> {
  const dir = snapshotDir(db);
  if (!dir) return null;

  const safe = reason.replace(/[^a-z0-9-]/gi, '-');

  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${PREFIX}${safe}-${stamp()}.db`);

    // better-sqlite3's own backup: a consistent copy taken while the worker
    // and the web process are both connected, which `cp` on a WAL database
    // is not.
    await db.backup(path);

    prune(dir, safe);
    return path;
  } catch (error) {
    console.error('[snapshot] could not write a copy:', error);
    return null;
  }
}

function prune(dir: string, reason: string): void {
  const mine = readdirSync(dir)
    .filter(name => name.startsWith(`${PREFIX}${reason}-`) && name.endsWith('.db'))
    // The stamp sorts lexicographically because it is ISO, which is the only
    // reason this does not need to stat every file.
    .sort();

  for (const name of mine.slice(0, Math.max(0, mine.length - KEEP))) {
    rmSync(join(dir, name), { force: true });
  }
}
