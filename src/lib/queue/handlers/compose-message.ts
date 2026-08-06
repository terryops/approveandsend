import { getDb, type Db } from '../../db';
import { composeMessage } from '../../drafting/compose';
import { recordEvent } from '../../tasks/events';
import { getTask, updateTask } from '../../tasks/store';
import { recordDraft } from '../../tasks/versions';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';
import { enqueueForTranslation } from './translate-task';

/**
 * Writing the mail somebody asked the desk to send.
 *
 * Deliberately its own job rather than a branch inside `draft-reply`. The two
 * share almost none of their prompt — one is bounded by a customer's question
 * and the other by nothing at all — and the risk grading in the reply job has
 * no meaning here: there is no sentiment to read and no thread to be long.
 * What they do share is where they finish, which is a task awaiting review.
 */

export const COMPOSE_MESSAGE = 'compose-message';

export interface ComposeMessagePayload {
  taskId: string;
}

export function enqueueCompose(
  taskId: string,
  options: { priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    COMPOSE_MESSAGE,
    {
      payload: { taskId } satisfies ComposeMessagePayload,
      dedupeKey: `${COMPOSE_MESSAGE}:${taskId}`,
      // Ahead of the inbox. Somebody wrote this brief thirty seconds ago and
      // is watching the page; the overnight backlog is not watching anything.
      priority: options.priority ?? 3,
      maxAttempts: 3,
    },
    options.db ?? getDb(),
  );
}

export const composeMessageHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);
  if (task.status === 'sent' || task.status === 'dismissed') {
    return { skipped: task.status };
  }

  updateTask(taskId, { status: 'drafting', error: null }, context.db);

  try {
    const composed = await composeMessage(task, { db: context.db });
    if (!composed) throw new Error('The drafter returned no usable mail');

    updateTask(
      taskId,
      {
        status: 'awaiting_review',
        draft: composed.body,
        error: null,
        openedAt: null,
        // Only where the operator left it blank. A subject somebody typed is
        // a decision, and a model is not entitled to overrule it.
        ...(task.subject.trim() === '' && composed.subject ? { subject: composed.subject } : {}),
      },
      context.db,
    );

    recordEvent(taskId, 'drafted', { db: context.db });
    recordDraft(taskId, composed.body, { source: 'model', db: context.db });
    enqueueForTranslation(taskId, { db: context.db });

    return { composed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lastAttempt = context.job.attempts >= context.job.maxAttempts;

    updateTask(taskId, { status: lastAttempt ? 'failed' : 'pending', error: message }, context.db);
    if (lastAttempt) recordEvent(taskId, 'failed', { detail: message, db: context.db });
    throw error;
  }
};
