import { gatherContext } from '../../context/gather';
import { hasContextSources } from '../../context/registry';
import { getDb, type Db } from '../../db';
import { getTask } from '../../tasks/store';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';
import { enqueueDraftReply } from './draft-reply';
import { enqueueTriage } from './triage';

/**
 * Looking the sender up before anything is written about them.
 *
 * Its own job rather than a step inside drafting, because the two fail in
 * different ways and want different retries. A model call fails slowly and
 * expensively; a billing API fails fast, and usually because someone's key
 * expired. Splitting them also means a source that has started timing out
 * shows up as its own red row in the queue instead of being reported as
 * "drafting failed", which is the wrong place to go looking.
 *
 * It always enqueues the draft afterwards, including when every source broke.
 * A reply written with less information is the product working slightly worse;
 * a support queue that stops because a CRM is down is the product not working.
 */

export const ENRICH_CONTEXT = 'enrich-context';

export function enqueueEnrichContext(
  taskId: string,
  options: { priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    ENRICH_CONTEXT,
    {
      payload: { taskId },
      dedupeKey: `${ENRICH_CONTEXT}:${taskId}`,
      // Ahead of drafting, which is priority 5: this is the thing drafting is
      // waiting for, and a queue drain that ran them the other way round would
      // draft blind and then look the customer up for nobody.
      priority: options.priority ?? 4,
      // External APIs fail fast and transiently. Two is enough; a third
      // attempt against a revoked key is just a slower way to give up.
      maxAttempts: 2,
    },
    options.db ?? getDb(),
  );
}

/**
 * Look the sender up, then draft — or just draft.
 *
 * Callers should not have to know whether this install has any context sources
 * — an extra no-op job per email would clutter the queue view of the many
 * installs that have none.
 */
export async function enqueueContextThenDraft(
  taskId: string,
  options: { db?: Db } = {},
): Promise<EnqueueResult> {
  const db = options.db ?? getDb();
  return (await hasContextSources())
    ? enqueueEnrichContext(taskId, { db })
    : enqueueDraftReply(taskId, { db });
}

/**
 * Get a freshly-ingested task moving.
 *
 * Triage first, which may end the task here — see `handlers/triage`. Reopening
 * skips it and calls `enqueueContextThenDraft` directly: a human who has just
 * undone a dismissal has answered the only question triage asks, and asking a
 * model to overrule them would make the reopen button do nothing.
 */
export async function enqueueForDrafting(
  taskId: string,
  options: { db?: Db } = {},
): Promise<EnqueueResult> {
  return enqueueTriage(taskId, { db: options.db ?? getDb() });
}

export const enrichContextHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);

  if (task.status === 'sent' || task.status === 'dismissed') {
    return { skipped: task.status };
  }

  let result;
  try {
    result = await gatherContext(task, { db: context.db });
  } catch (error) {
    // gatherContext already swallows per-source failures, so reaching here
    // means the registry itself is broken. Draft anyway and say so.
    enqueueDraftReply(taskId, { db: context.db });
    throw error;
  }

  enqueueDraftReply(taskId, { db: context.db });

  return {
    found: result.found,
    empty: result.empty.length,
    // Named, because "which lookup is broken" is the only question anyone asks
    // of this job.
    ...(result.failed.length > 0 ? { failed: result.failed } : {}),
  };
};
