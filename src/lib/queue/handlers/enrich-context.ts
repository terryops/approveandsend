import { gatherContext } from '../../context/gather';
import { hasContextSources } from '../../context/registry';
import { getDb, type Db } from '../../db';
import type { RedraftMode } from '../../drafting/draft';
import { getTask } from '../../tasks/store';
import type { TaskOrigin } from '../../tasks/types';
import { enqueue, type EnqueueResult } from '../store';
import { recordEvent } from '../../tasks/events';
import { t } from '../../i18n';
import { PermanentJobError, type JobHandler } from '../types';
import { enqueueCompose } from './compose-message';
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

/**
 * What runs once the lookups are in.
 *
 * A composed task has no letter to answer, so sending it down the reply path
 * would produce a reply to mail nobody sent. Carried on the payload rather
 * than read off the task's origin, because the job is what knows why it was
 * queued and a task's origin is not always the same question.
 */
export type ContextThen = 'draft' | 'compose';

/**
 * Whether the second opinion runs, carried the length of the chain.
 *
 * The decision is made by whoever pressed the button — a redraft turns the
 * critic off — and the job that acts on it is two hops away, so it travels on
 * the payload rather than being read off the task. Absent means on, which is
 * every other caller.
 */
type ChainOptions = { db?: Db; critic?: boolean; mode?: RedraftMode };

/** `{ critic: false }` and nothing at all, since the default is on. */
function criticFlag(critic: boolean | undefined): { critic?: false } {
  return critic === false ? { critic: false } : {};
}

/**
 * The reviewer's choice between amending the draft and replacing it, travelling
 * the same two hops as the critic flag and for the same reason: the button is
 * pressed here and acted on in the drafter.
 *
 * Absent on every caller that is not a redraft, which is what the drafter's own
 * fallback is written for.
 */
function modeFlag(mode: RedraftMode | undefined): { mode?: RedraftMode } {
  return mode ? { mode } : {};
}

export function enqueueEnrichContext(
  taskId: string,
  options: {
    priority?: number;
    db?: Db;
    then?: ContextThen;
    critic?: boolean;
    mode?: RedraftMode;
  } = {},
): EnqueueResult {
  const then: ContextThen = options.then ?? 'draft';
  return enqueue(
    ENRICH_CONTEXT,
    {
      payload: { taskId, then, ...criticFlag(options.critic), ...modeFlag(options.mode) },
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
  options: ChainOptions = {},
): Promise<EnqueueResult> {
  const db = options.db ?? getDb();
  return (await hasContextSources())
    ? enqueueEnrichContext(taskId, { db, ...criticFlag(options.critic), ...modeFlag(options.mode) })
    : enqueueDraftReply(taskId, { db, ...criticFlag(options.critic), ...modeFlag(options.mode) });
}

/**
 * The same, for mail the desk is starting rather than answering.
 *
 * A composed task was skipping the lookups entirely: whoever handed the brief
 * in got a draft written with nothing but the brief, and the reviewer opened a
 * screen with no card on it — while the identical address arriving as an email
 * got both. Nothing about a source cares which door the address came through,
 * so neither does this.
 */
export async function enqueueContextThenCompose(
  taskId: string,
  options: { db?: Db } = {},
): Promise<EnqueueResult> {
  const db = options.db ?? getDb();
  return (await hasContextSources())
    ? enqueueEnrichContext(taskId, { db, then: 'compose' })
    : enqueueCompose(taskId, { db });
}

/**
 * Whichever of the two a task is for.
 *
 * The two pipelines are picked apart in three places — reopen, redraft and the
 * sweep — and each of them got it wrong on its own at least once: a composed
 * task sent down the reply path produces a reply to the brief, addressed to
 * the customer, as though the desk's own instructions had arrived as mail.
 */
export async function enqueueContextThenWrite(
  task: { id: string; origin: TaskOrigin },
  options: ChainOptions = {},
): Promise<EnqueueResult> {
  // The composer has no critic pass to skip and no draft to amend, so both
  // flags are dropped rather than passed to something that would ignore them.
  return task.origin === 'composed'
    ? enqueueContextThenCompose(task.id, { db: options.db })
    : enqueueContextThenDraft(task.id, options);
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

  const then: ContextThen = value.then === 'compose' ? 'compose' : 'draft';

  /**
   * Hand off to whichever writer this chain was started for.
   *
   * The result is read rather than discarded. One draft in flight per task is
   * the right rule, but it made the second Redraft on a task already drafting
   * disappear: the enqueue was deduped onto the running job, this function
   * threw the answer away, and the reviewer was shown the *first* request's
   * reply as though it were the answer to their second. Now the drop is
   * recorded where it happened, on the task's own timeline, so a reply that
   * ignored the note has a reason next to it instead of looking like the model
   * refusing to listen.
   */
  const write = () => {
    if (then === 'compose') return enqueueCompose(taskId, { db: context.db });
    const queued = enqueueDraftReply(taskId, {
      db: context.db,
      critic: value.critic !== false,
      ...(value.mode === 'revise' || value.mode === 'rewrite'
        ? { mode: value.mode as RedraftMode }
        : {}),
    });
    // `updated` means the waiting job took this request's note and mode, which
    // is the same thing as having been queued. Only an in-flight holder drops
    // it.
    if (queued.deduped && !queued.updated) {
      recordEvent(taskId, 'redraft_dropped', {
        detail: t('task.redraftDropped'),
        db: context.db,
      });
    }
    return queued;
  };

  let result;
  try {
    result = await gatherContext(task, { db: context.db });
  } catch (error) {
    // gatherContext already swallows per-source failures, so reaching here
    // means the registry itself is broken. Draft anyway and say so.
    write();
    throw error;
  }

  write();

  return {
    found: result.found,
    empty: result.empty.length,
    // Named, because "which lookup is broken" is the only question anyone asks
    // of this job.
    ...(result.failed.length > 0 ? { failed: result.failed } : {}),
  };
};
