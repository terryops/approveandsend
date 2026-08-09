import { getDb, type Db } from '../db';
import { listRules } from '../rules/store';
import { listTasks } from '../tasks/store';

/**
 * Whether anything has ever happened on this desk.
 *
 * One question asked in three places — the wizard's last screen, the inbox's
 * empty state, and `seedDemoData` itself — and it was written out three times,
 * which is two more than a predicate this load-bearing can survive. The one in
 * `seed.ts` is the only thing standing between a working desk and a queue full
 * of fictional mail from Acme Cloud; the other two decide whether the button
 * that calls it is on screen at all. Drift between them does not fail loudly.
 * It shows somebody a button that silently does nothing.
 *
 * Proposals count, and that is the load-bearing part rather than a detail: a
 * rulebook of nothing but pending suggestions reads as empty to a query that
 * hides them, and a desk that has learned enough to suggest something has
 * plainly been used.
 *
 * Two indexed lookups with `LIMIT 1`, so it is cheap enough to ask on a page
 * render — but ask it where the answer matters. The inbox only needs it once it
 * already knows the list came back empty.
 */
export function deskUntouched(db: Db = getDb()): boolean {
  return (
    listTasks({ limit: 1 }, db).length === 0 &&
    listRules({ proposed: 'include' }, db).length === 0
  );
}
