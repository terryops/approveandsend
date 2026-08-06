import { runBackfillItem } from '../../backfill/learn';
import { scanSentMail, type ScanResult } from '../../backfill/scan';
import { countBackfillByStatus, listBackfillItems } from '../../backfill/store';
import { getDb, type Db } from '../../db';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';
import { enqueueConsolidateRules } from './consolidate-rules';

/**
 * The backfill runs as two job types rather than one long one.
 *
 * `backfill-scan` makes a single provider call and writes a row per archived
 * reply. `backfill-learn` does everything expensive, once per row. Splitting
 * them is what makes the run interruptible: a worker that dies takes one
 * item's generation with it, not the whole pass, and the item is claimable
 * again the moment its lease expires. A single job looping over four hundred
 * emails would have to start from the beginning every time, which on a
 * self-hosted model means it would never finish at all.
 */

export const BACKFILL_SCAN = 'backfill-scan';
export const BACKFILL_LEARN = 'backfill-learn';

/**
 * Priority 9: behind drafting, behind learning from live mail, behind the
 * weekly tidy. Teaching the rulebook from two-year-old mail is never the thing
 * a person is waiting for, and a backfill that delayed today's drafts would be
 * a bad trade however good the rules were.
 */
const BACKFILL_PRIORITY = 9;

/** Tidy the rulebook every this many items, so a long run cannot silently bloat it. */
const CONSOLIDATE_EVERY = 25;

export interface BackfillScanPayload {
  limit?: number;
  since?: string;
}

export function enqueueBackfillScan(
  payload: BackfillScanPayload = {},
  options: { db?: Db } = {},
): EnqueueResult {
  return enqueue(
    BACKFILL_SCAN,
    {
      payload,
      // One scan at a time. Two overlapping scans would produce no duplicate
      // items — the unique index sees to that — but they would both walk the
      // mailbox to discover it.
      dedupeKey: BACKFILL_SCAN,
      priority: BACKFILL_PRIORITY,
      maxAttempts: 3,
    },
    options.db ?? getDb(),
  );
}

export function enqueueBackfillLearn(itemId: string, options: { db?: Db } = {}): EnqueueResult {
  return enqueue(
    BACKFILL_LEARN,
    {
      payload: { itemId },
      dedupeKey: `${BACKFILL_LEARN}:${itemId}`,
      priority: BACKFILL_PRIORITY,
      // Two attempts, not three. Each one is a full generation plus an
      // extraction against a mailbox that has already been read once; an
      // archived email is not worth three of those to fail on.
      maxAttempts: 2,
    },
    options.db ?? getDb(),
  );
}

function itemIdOf(payload: unknown): string {
  const value = payload as Record<string, unknown> | null;
  const itemId = value && typeof value.itemId === 'string' ? value.itemId.trim() : '';
  if (!itemId) throw new PermanentJobError('Payload is missing itemId');
  return itemId;
}

export interface ScanHandlerResult extends ScanResult {
  /** Items handed to `backfill-learn`. */
  queued: number;
}

/**
 * Hand every pending item to the queue.
 *
 * Every pending item, not only the ones the scan just created: a previous run
 * that was cancelled half way leaves rows nobody is going to enqueue otherwise,
 * and a second scan is exactly when a person expects them to start moving
 * again. Deduping means the ones already queued cost nothing.
 */
export function enqueuePendingBackfill(db: Db): number {
  let queued = 0;
  for (const item of listBackfillItems({ status: 'pending', limit: 5000 }, db)) {
    if (!enqueueBackfillLearn(item.id, { db }).deduped) queued += 1;
  }
  return queued;
}

export const backfillScanHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const scan = await scanSentMail({
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
    ...(typeof value.since === 'string' && value.since ? { since: value.since } : {}),
    db: context.db,
  });

  const result: ScanHandlerResult = { ...scan, queued: enqueuePendingBackfill(context.db) };
  return result;
};

/**
 * Tidy the rulebook every `CONSOLIDATE_EVERY` items.
 *
 * Triggered from the run rather than scheduled up front, because how many items
 * produce rules is not knowable when it starts. The dedupe key means a burst of
 * items crossing the threshold together queues one tidy, not twenty.
 */
export function maybeConsolidate(db: Db): boolean {
  const done = countBackfillByStatus(db);
  const finished = (done.learned ?? 0) + (done.failed ?? 0);
  if (finished === 0 || finished % CONSOLIDATE_EVERY !== 0) return false;
  enqueueConsolidateRules({ force: true, db });
  return true;
}

export const backfillLearnHandler: JobHandler = async (payload, context) => {
  const itemId = itemIdOf(payload);
  const result = await runBackfillItem(itemId, { db: context.db });
  maybeConsolidate(context.db);
  return result;
};
