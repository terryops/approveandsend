import { getDb, type Db } from '../../db';
import { draftReply } from '../../drafting/draft';
import { recordEvent } from '../../tasks/events';
import { getTask, updateTask } from '../../tasks/store';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';
import { enqueueForTranslation } from './translate-task';

/**
 * Turning an ingested email into a draft awaiting review.
 *
 * Unlike the learning job, this payload is only a task id. That is correct
 * here: the job's input is the customer's email, which does not change, and
 * re-reading the row means a retry picks up a scope the analysis has since
 * worked out.
 */

export const DRAFT_REPLY = 'draft-reply';

export interface DraftReplyPayload {
  taskId: string;
  /** Skip the critic pass. */
  critic?: boolean;
}

export function enqueueDraftReply(
  taskId: string,
  options: { critic?: boolean; priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    DRAFT_REPLY,
    {
      payload: { taskId, critic: options.critic ?? true } satisfies DraftReplyPayload,
      // One draft in flight per task. Two syncs noticing the same new mail
      // must not pay for two generations of the same reply.
      dedupeKey: `${DRAFT_REPLY}:${taskId}`,
      priority: options.priority ?? 5,
      maxAttempts: 3,
    },
    options.db ?? getDb(),
  );
}

export const draftReplyHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);

  // Somebody already dealt with this while it sat in the queue. Drafting over
  // a sent reply would replace what actually went out, which is the text the
  // learning loop needs.
  if (task.status === 'sent' || task.status === 'dismissed') {
    return { skipped: task.status };
  }

  updateTask(taskId, { status: 'drafting', error: null }, context.db);

  try {
    const result = await draftReply(task, { critic: value.critic !== false, db: context.db });

    updateTask(
      taskId,
      {
        status: 'awaiting_review',
        analysis: result.analysis,
        draft: result.draft,
        ...(result.analysis.scope ? { scope: result.analysis.scope } : {}),
        error: null,
        // Unread again. Whoever glanced at the previous draft — on a redraft,
        // probably the person who asked for this one — has not seen this text,
        // and a task that stayed "read" through a rewrite is one nobody is
        // told to go back to.
        openedAt: null,
      },
      context.db,
    );

    recordEvent(taskId, 'drafted', { db: context.db });

    // Now that both halves exist — their mail and our answer — one job can
    // render the pair for whoever has to read it.
    enqueueForTranslation(taskId, { db: context.db });

    return {
      appliedRules: result.appliedRuleIds.length,
      droppedRules: result.droppedRuleIds.length,
      criticApproved: result.critique?.approved,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lastAttempt = context.job.attempts >= context.job.maxAttempts;

    // While retries remain the task goes back to pending, so the queue owns
    // its state and the UI does not show a scary red row for thirty seconds
    // during a routine 429.
    updateTask(taskId, { status: lastAttempt ? 'failed' : 'pending', error: message }, context.db);
    // Only the attempt that gave up. A history full of "failed, retrying" for
    // a 429 that resolved itself is noise over the events that mattered.
    if (lastAttempt) recordEvent(taskId, 'failed', { detail: message, db: context.db });
    throw error;
  }
};
